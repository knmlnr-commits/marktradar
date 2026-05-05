"""CLI entrypoints: marktradar-ingest + marktradar-init-tenant."""

from __future__ import annotations

import json
from pathlib import Path

import click
import yaml

from .config import load_tenant_config, find_tenant_config
from .pipeline import run_pipeline


@click.command(name="marktradar-ingest")
@click.option("--tenant", required=True, help="Tenant-id zoals geregistreerd onder tenants/<id>/.")
@click.option(
    "--source",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Pad naar het bron-bestand (xlsx, csv of json).",
)
@click.option("--adapter", default=None, help="Optioneel: adapter-id forceren (uit tenant-config).")
@click.option(
    "--base-dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=None,
    help="Tenant-root; default ./tenants.",
)
@click.option("--dry-run", is_flag=True, help="Valideer maar schrijf niets.")
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Override pad voor de output-JSON.",
)
def ingest_command(
    tenant: str,
    source: Path,
    adapter: str | None,
    base_dir: Path | None,
    dry_run: bool,
    output_dir: Path | None,
) -> None:
    """Voer de ingestie-pipeline uit voor een tenant."""
    base = base_dir or Path("tenants")
    config_path = find_tenant_config(tenant, base_dir=base)
    config = load_tenant_config(config_path)
    tenant_dir = config_path.parent

    click.echo(f"Tenant: {config.tenant_naam} ({config.tenant_id})")
    click.echo(f"Bron:   {source}")

    result = run_pipeline(
        config,
        source,
        adapter_id=adapter,
        base_dir=tenant_dir,
        write_output=not dry_run,
        output_dir=output_dir,
    )

    click.echo(f"Klanten verwerkt: {len(result.klanten)}")
    contact_count = sum(len(k.contactpersonen) for k in result.klanten)
    click.echo(f"Contactpersonen:  {contact_count}")
    if result.skipped:
        click.echo(f"Overgeslagen rijen: {len(result.skipped)}")
    if result.fuzzy_matches:
        click.echo(f"Fuzzy matches:    {len(result.fuzzy_matches)}")
    if result.unresolved_names:
        click.echo(
            f"Onopgeloste namen: {len(result.unresolved_names)} (eerste 5: "
            f"{result.unresolved_names[:5]})"
        )

    if dry_run:
        click.echo("Dry-run; geen output weggeschreven.")
    elif result.output_path:
        click.echo(f"Output geschreven: {result.output_path}")


@click.command(name="marktradar-init-tenant")
@click.option("--id", "tenant_id", required=True, help="Korte tenant-id, bv. 'demo'.")
@click.option("--naam", required=True, help="Volledige tenant-naam.")
@click.option(
    "--base-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default="tenants",
    help="Root-folder voor tenant-configs; default ./tenants.",
)
def init_tenant_command(tenant_id: str, naam: str, base_dir: Path) -> None:
    """Scaffold een nieuwe tenant-folder met een minimaal config-template."""
    base = Path(base_dir)
    target = base / tenant_id
    if target.exists():
        raise click.ClickException(f"Tenant-folder bestaat al: {target}")
    (target / "data").mkdir(parents=True, exist_ok=True)

    template = {
        "tenant_id": tenant_id,
        "tenant_naam": naam,
        "klant_terminologie": "klant",
        "markt": "TBD",
        "customer_definition": {
            "required_fields": ["naam", "land"],
            "custom_fields": [],
        },
        "type_taxonomy": [],
        "instelling_referentie": {
            "pad": "data/INSTELLING_LIJST.txt",
            "format": "pipe",
            "fuzzy_threshold": 0.85,
        },
        "source_adapters": [
            {
                "id": "default_csv",
                "type": "csv",
                "field_mapping": {
                    "naam": "naam",
                    "land": "land",
                    "type": "type",
                },
                "default_status": "prospect",
            }
        ],
        "contact_role_mapping": {
            "decider": ["CEO", "Bestuurder"],
            "champion": ["Manager", "Director"],
            "influencer": ["Specialist"],
            "gatekeeper": ["Inkoop"],
            "blocker": ["Compliance"],
        },
        "gdpr": {
            "freemail_domeinen": ["gmail.com", "hotmail.com", "outlook.com"],
            "freemail_actie": "verlaag_vertrouwen",
            "prive_telefoon_actie": "verwijder",
        },
        "output": {
            "format": "json",
            "pad": f"output/klantbeeld_{tenant_id}_{{timestamp}}.json",
            "pretty": True,
        },
    }
    (target / "config.yaml").write_text(
        yaml.safe_dump(template, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    click.echo(f"Tenant-skelet aangemaakt: {target}")
    click.echo("Volgende stappen:")
    click.echo(f"  1. Vul {target}/data/INSTELLING_LIJST.txt met je referentie-lijst")
    click.echo(f"  2. Pas {target}/config.yaml aan voor je markt")
    click.echo(f"  3. Run: marktradar-ingest --tenant {tenant_id} --source <bestand>")
