"""Five-stage ingestion pipeline; deterministic, no LLM.

  1. Load: tenant config (YAML) + reference instelling list.
  2. Read: instantiate adapter (config-driven or extension-driven).
  3. Map: apply field_mapping to translate source rows into klant + contact.
  4. Resolve: match `naam` -> canonical instelling id via fuzzy matching.
  5. Validate + Write: pydantic validation + GDPR rules + JSON output.

Multiple source rows for the same instelling id are merged into a single
Klant record, with their contactpersonen deduplicated by (naam, functie).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError

from .adapters import SourceAdapter, adapter_for_path, adapter_for_type
from .config import SourceAdapterConfig, TenantConfig
from .mapping import FieldMapper, InstellingResolver, RoleMapper
from .output import JsonWriter
from .schema import Contactpersoon, Klant
from .validators import GdprValidator, check_required_fields


logger = logging.getLogger("marktradar.pipeline")


@dataclass
class PipelineResult:
    klanten: list[Klant] = field(default_factory=list)
    output_path: Optional[Path] = None
    skipped: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    fuzzy_matches: list[dict[str, Any]] = field(default_factory=list)
    unresolved_names: list[str] = field(default_factory=list)


def _slug_id_from_naam(naam: str) -> str:
    """Fallback id when no canonical instelling match was found."""
    import re
    import unicodedata

    nf = unicodedata.normalize("NFD", naam)
    no_diacritics = "".join(c for c in nf if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9]+", "-", no_diacritics.lower()).strip("-")
    return slug or "onbekend"


def _build_resolver(config: TenantConfig, base_dir: Path) -> Optional[InstellingResolver]:
    if not config.instelling_referentie:
        return None
    ref = config.instelling_referentie
    ref_path = (base_dir / ref.pad).resolve()
    if ref.format == "pipe":
        return InstellingResolver.from_pipe_file(ref_path, fuzzy_threshold=ref.fuzzy_threshold)
    return InstellingResolver.from_csv_file(ref_path, fuzzy_threshold=ref.fuzzy_threshold)


def _resolve_adapter(
    config: TenantConfig, source: Path, adapter_id: Optional[str]
) -> tuple[SourceAdapter, SourceAdapterConfig]:
    """Pick the SourceAdapter + matching config entry."""
    if adapter_id:
        match = next(
            (a for a in config.source_adapters if a.id == adapter_id), None
        )
        if not match:
            raise ValueError(
                f"Adapter '{adapter_id}' niet gevonden in tenant-config; "
                f"beschikbaar: {[a.id for a in config.source_adapters]}"
            )
        return adapter_for_type(match.type), match
    instance = adapter_for_path(str(source))
    type_key = "xlsx" if isinstance(instance, type(adapter_for_type("xlsx"))) else None
    # Pick first config-entry with the matching adapter type, else build a
    # minimal default with just the field_mapping empty.
    inferred_type = (
        "xlsx" if str(source).lower().endswith((".xlsx", ".xlsm"))
        else "csv" if str(source).lower().endswith(".csv")
        else "json"
    )
    match = next(
        (a for a in config.source_adapters if a.type == inferred_type), None
    )
    if match:
        return adapter_for_type(match.type), match
    # No config-entry; build a defaulted one so the pipeline can still try.
    fallback = SourceAdapterConfig(
        id=f"auto-{inferred_type}",
        type=inferred_type,  # type: ignore[arg-type]
        field_mapping={},
        default_status="prospect",
    )
    return instance, fallback


def _merge_contact(
    target: list[Contactpersoon], new_contact: Contactpersoon
) -> None:
    """Add a contact unless an equivalent one already exists."""
    key = (new_contact.naam.lower(), new_contact.functie.lower())
    for existing in target:
        if (existing.naam.lower(), existing.functie.lower()) == key:
            return
    target.append(new_contact)


def run_pipeline(
    config: TenantConfig,
    source: Path,
    *,
    adapter_id: Optional[str] = None,
    base_dir: Optional[Path] = None,
    write_output: bool = True,
    output_dir: Optional[Path] = None,
) -> PipelineResult:
    """Run all five stages and return aggregated result."""
    source = Path(source)
    base_dir = Path(base_dir) if base_dir else source.parent
    result = PipelineResult()

    adapter, adapter_cfg = _resolve_adapter(config, source, adapter_id)
    rows = adapter.read(source)
    field_mapper = FieldMapper(adapter_cfg.field_mapping)
    role_mapper = RoleMapper(config.contact_role_mapping)
    resolver = _build_resolver(config, base_dir)
    gdpr = GdprValidator(
        freemail_domeinen=config.gdpr.freemail_domeinen,
        freemail_actie=config.gdpr.freemail_actie,
        prive_telefoon_actie=config.gdpr.prive_telefoon_actie,
    )

    klanten_index: dict[str, Klant] = {}
    bron_label = source.name
    today = datetime.now(timezone.utc).date()
    now = datetime.now(timezone.utc)

    # Default custom-field values are pre-applied so output is consistent.
    custom_defaults: dict[str, Any] = {}
    for cf in config.customer_definition.custom_fields:
        if cf.default is not None:
            custom_defaults[cf.id] = cf.default

    for row_idx, row in enumerate(rows):
        mapped = field_mapper.map_row(row)
        klant_fields = mapped.klant_fields
        if not klant_fields.get("naam"):
            result.skipped.append({"row": row_idx, "reden": "geen naam"})
            continue

        missing = check_required_fields(klant_fields, config.customer_definition.required_fields)
        if missing:
            result.skipped.append(
                {"row": row_idx, "reden": "ontbrekende velden", "velden": missing}
            )
            continue

        # Resolve canonical id.
        match_id: Optional[str] = None
        if resolver:
            match = resolver.resolve(klant_fields["naam"])
            if match.id:
                match_id = match.id
                if match.method == "fuzzy" and match.score < 1.0:
                    result.fuzzy_matches.append(
                        {
                            "input": klant_fields["naam"],
                            "matched": match.naam,
                            "score": round(match.score, 3),
                        }
                    )
            else:
                result.unresolved_names.append(klant_fields["naam"])
        klant_id = match_id or _slug_id_from_naam(klant_fields["naam"])

        # Build or fetch the Klant.
        existing = klanten_index.get(klant_id)
        if existing is None:
            try:
                klant = Klant(
                    id=klant_id,
                    naam=klant_fields["naam"],
                    land=klant_fields.get("land", "NL"),
                    type=klant_fields.get("type", "Onbekend"),
                    groep=klant_fields.get("groep"),
                    tier=klant_fields.get("tier"),
                    status=klant_fields.get("status", adapter_cfg.default_status),
                    velden={**custom_defaults, **mapped.velden},
                    bronnen=[bron_label],
                    contactpersonen=[],
                    laatste_update=now,
                )
            except ValidationError as exc:
                result.skipped.append(
                    {"row": row_idx, "reden": "schema-validatie", "fout": str(exc)}
                )
                continue
            klanten_index[klant_id] = klant
            existing = klant
        else:
            # Merge: ensure source label is recorded; merge custom fields in.
            if bron_label not in existing.bronnen:
                existing.bronnen.append(bron_label)
            for k, v in mapped.velden.items():
                existing.velden[k] = v

        # Build a Contactpersoon if the source row had any contact info.
        if mapped.contact_fields:
            cf = mapped.contact_fields
            functie = cf.get("functie", "Onbekend")
            rol = role_mapper.map_role(functie)
            contact_dict = {
                "naam": cf.get("naam", "").strip() if cf.get("naam") else "",
                "functie": functie,
                "rol": rol,
                "email": cf.get("email"),
                "telefoon": cf.get("telefoon"),
                "linkedin": cf.get("linkedin"),
                "bron_type": adapter.bron_type_default,
                "vertrouwen": cf.get("vertrouwen", "middel"),
                "geverifieerd": today,
                "notitie": cf.get("notitie"),
                "_telefoon_zakelijk": True,
            }
            contact_dict = gdpr.apply_to_contact(contact_dict)
            if not contact_dict["naam"]:
                continue
            try:
                contact = Contactpersoon(**{k: v for k, v in contact_dict.items() if not k.startswith("_")})
            except ValidationError as exc:
                result.warnings.append(
                    f"Contact in rij {row_idx} ongeldig en overgeslagen: {exc}"
                )
                continue
            _merge_contact(existing.contactpersonen, contact)

    result.klanten = list(klanten_index.values())

    if write_output:
        writer = JsonWriter(config.output.pad, config.output.pretty)
        out_path = writer.render_path(config.tenant_id)
        if output_dir:
            out_path = Path(output_dir) / out_path.name
        result.output_path = writer.write(result.klanten, out_path)

    return result
