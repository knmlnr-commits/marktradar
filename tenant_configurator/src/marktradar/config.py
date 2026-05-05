"""Tenant config loader.

Loads the per-tenant YAML config and validates it via pydantic. Failing fast
on invalid config beats silent misbehaviour later in the pipeline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class CustomFieldDef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: Literal["string", "boolean", "enum", "number", "date"]
    label: str
    values: Optional[list[str]] = None
    default: Optional[Any] = None


class CustomerDefinitionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    required_fields: list[str] = Field(default_factory=lambda: ["naam"])
    custom_fields: list[CustomFieldDef] = Field(default_factory=list)


class InstellingReferentieConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pad: str
    format: Literal["pipe", "csv"] = "pipe"
    fuzzy_threshold: float = Field(default=0.85, ge=0, le=1)


class SourceAdapterConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: Literal["csv", "xlsx", "json"]
    pad_pattern: Optional[str] = None
    field_mapping: dict[str, str] = Field(default_factory=dict)
    default_status: Literal["customer", "prospect", "suspect", "inactive"] = "prospect"


class GdprConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    freemail_domeinen: list[str] = Field(default_factory=list)
    freemail_actie: Literal["verlaag_vertrouwen", "verwijder_email", "geen"] = (
        "verlaag_vertrouwen"
    )
    prive_telefoon_actie: Literal["verwijder", "behouden"] = "verwijder"


class OutputConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["json"] = "json"
    pad: str = "output/klantbeeld_{tenant_id}_{timestamp}.json"
    pretty: bool = True


class TenantConfig(BaseModel):
    """Full tenant config; matches the YAML structure 1:1."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    tenant_id: str
    tenant_naam: str
    klant_terminologie: str = "klant"
    markt: Optional[str] = None
    customer_definition: CustomerDefinitionConfig
    type_taxonomy: list[str] = Field(default_factory=list)
    instelling_referentie: Optional[InstellingReferentieConfig] = None
    source_adapters: list[SourceAdapterConfig] = Field(default_factory=list)
    contact_role_mapping: dict[str, list[str]] = Field(default_factory=dict)
    gdpr: GdprConfig = Field(default_factory=GdprConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)

    @model_validator(mode="after")
    def _validate_role_keys(self) -> "TenantConfig":
        valid = {"decider", "champion", "influencer", "gatekeeper", "blocker"}
        unknown = set(self.contact_role_mapping.keys()) - valid
        if unknown:
            raise ValueError(
                f"Onbekende rol-keys in contact_role_mapping: {sorted(unknown)}; "
                f"toegestaan: {sorted(valid)}"
            )
        return self


def load_tenant_config(config_path: Path) -> TenantConfig:
    """Load + validate a tenant YAML config. Raises on invalid input."""
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Tenant config niet gevonden: {config_path}")
    with config_path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    return TenantConfig.model_validate(raw)


def find_tenant_config(tenant_id: str, base_dir: Optional[Path] = None) -> Path:
    """Resolve the YAML path for a tenant id; defaults to ./tenants/<id>/config.yaml."""
    base = Path(base_dir) if base_dir else Path("tenants")
    candidate = base / tenant_id / "config.yaml"
    if not candidate.exists():
        raise FileNotFoundError(
            f"Geen config gevonden voor tenant '{tenant_id}'; verwacht: {candidate}"
        )
    return candidate
