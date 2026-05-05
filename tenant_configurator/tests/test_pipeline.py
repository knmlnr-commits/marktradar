"""End-to-end pipeline tests; sample input -> JSON output."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest
import yaml

from marktradar.config import load_tenant_config
from marktradar.pipeline import run_pipeline
from marktradar.schema import Klant


def _write_minimal_tenant(tmp_path: Path, fixtures_dir: Path) -> Path:
    """Materialise the minimal-fixture tenant with a tiny instelling-list."""
    cfg_path = tmp_path / "config.yaml"
    raw = yaml.safe_load((fixtures_dir / "tenant_minimal.yaml").read_text())
    cfg_path.write_text(yaml.safe_dump(raw, sort_keys=False))
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "INSTELLING_LIJST.txt").write_text(
        "# id | naam | hoofdvestiging\n"
        "allianz | Allianz | Munich\n"
        "axa | AXA | Paris\n"
        "generali | Generali | Trieste\n"
        "zurich-insurance | Zurich Insurance | Zurich\n"
        "munich-re | Munich Re | Munich\n"
        "aegon | Aegon | The Hague\n"
        "asr | ASR | Utrecht\n"
        "achmea | Achmea | Zeist\n",
        encoding="utf-8",
    )
    return cfg_path


def test_e2e_xlsx_to_json(tmp_path: Path, fixtures_dir: Path, sample_xlsx: Path):
    cfg_path = _write_minimal_tenant(tmp_path, fixtures_dir)
    cfg = load_tenant_config(cfg_path)
    output_dir = tmp_path / "out"

    result = run_pipeline(
        cfg, sample_xlsx, base_dir=cfg_path.parent, write_output=True,
        output_dir=output_dir,
    )

    assert len(result.klanten) >= 5, f"Expected >=5 klantrecords, got {len(result.klanten)}"
    contact_count = sum(len(k.contactpersonen) for k in result.klanten)
    assert contact_count >= 10, f"Expected >=10 contactpersonen, got {contact_count}"

    assert result.output_path is not None and result.output_path.exists()
    payload = json.loads(result.output_path.read_text(encoding="utf-8"))
    assert payload["count"] == len(result.klanten)
    assert isinstance(payload["records"], list)

    # Every record validates back into Klant -> proves schema integrity.
    for rec in payload["records"]:
        Klant.model_validate(rec)


def test_dry_run_does_not_write(tmp_path: Path, fixtures_dir: Path, sample_xlsx: Path):
    cfg_path = _write_minimal_tenant(tmp_path, fixtures_dir)
    cfg = load_tenant_config(cfg_path)
    result = run_pipeline(
        cfg, sample_xlsx, base_dir=cfg_path.parent, write_output=False,
    )
    assert result.output_path is None
    assert len(result.klanten) >= 5


def test_csv_pipeline_with_zoho_export(tmp_path: Path, fixtures_dir: Path):
    cfg_path = _write_minimal_tenant(tmp_path, fixtures_dir)
    # Create a minimal csv that matches the test_csv adapter mapping.
    csv_path = tmp_path / "rows.csv"
    csv_path.write_text(
        "naam,land,functie,contact_naam,email\n"
        "Allianz,DE,CEO,Sophie de Vries,sophie@allianz.de\n"
        "AXA,FR,Director Claims,Lucas Bos,lucas@axa.fr\n"
        "Generali,IT,Manager IT,Anna Smit,anna@generali.it\n",
        encoding="utf-8",
    )
    cfg = load_tenant_config(cfg_path)
    result = run_pipeline(
        cfg, csv_path, base_dir=cfg_path.parent, write_output=False,
    )
    naam_set = {k.naam for k in result.klanten}
    assert "Allianz" in naam_set
    assert any(k.contactpersonen for k in result.klanten)


def test_freemail_downgrades_in_pipeline(tmp_path: Path, fixtures_dir: Path):
    """A row with a gmail address should produce a contact with vertrouwen 'laag'."""
    cfg_path = _write_minimal_tenant(tmp_path, fixtures_dir)
    csv_path = tmp_path / "rows.csv"
    csv_path.write_text(
        "naam,land,functie,contact_naam,email\n"
        "Allianz,DE,CEO,Sophie de Vries,sophie@gmail.com\n",
        encoding="utf-8",
    )
    cfg = load_tenant_config(cfg_path)
    result = run_pipeline(cfg, csv_path, base_dir=cfg_path.parent, write_output=False)
    contacts = [c for k in result.klanten for c in k.contactpersonen]
    assert contacts
    assert contacts[0].vertrouwen == "laag"  # default 'middel' -> downgrade


def test_unresolved_name_kept_with_slug_id(tmp_path: Path, fixtures_dir: Path):
    cfg_path = _write_minimal_tenant(tmp_path, fixtures_dir)
    csv_path = tmp_path / "rows.csv"
    csv_path.write_text(
        "naam,land,functie,contact_naam,email\n"
        "Totally Unknown Insurer Plc,GB,CEO,Jasper de Boer,jasper@unknown.com\n",
        encoding="utf-8",
    )
    cfg = load_tenant_config(cfg_path)
    result = run_pipeline(cfg, csv_path, base_dir=cfg_path.parent, write_output=False)
    assert len(result.klanten) == 1
    assert result.klanten[0].id != ""  # slug fallback applied
    assert "Totally Unknown Insurer Plc" in result.unresolved_names


def test_two_tenants_isolated(tmp_path: Path, project_root: Path):
    """Use the bundled van-ameyde and demo configs to prove tenant isolation."""
    va_cfg = load_tenant_config(project_root / "tenants" / "van-ameyde" / "config.yaml")
    demo_cfg = load_tenant_config(project_root / "tenants" / "demo" / "config.yaml")
    assert va_cfg.tenant_id == "van-ameyde"
    assert demo_cfg.tenant_id == "demo"
    # Different taxonomies prove the configs are independent.
    assert "Composite" in va_cfg.type_taxonomy
    assert "Standard" in demo_cfg.type_taxonomy
    assert va_cfg.contact_role_mapping["decider"] != demo_cfg.contact_role_mapping["decider"]


def test_demo_tenant_pipeline_runs(tmp_path: Path, project_root: Path):
    """Run the demo tenant end-to-end without code changes."""
    cfg = load_tenant_config(project_root / "tenants" / "demo" / "config.yaml")
    src = project_root / "tenants" / "demo" / "data" / "sample_demo.csv"
    result = run_pipeline(
        cfg,
        src,
        base_dir=project_root / "tenants" / "demo",
        write_output=False,
    )
    assert len(result.klanten) >= 3
    # Demo's freemail config downgrades gmail addresses; eva@gmail.com is in input.
    contacts = [c for k in result.klanten for c in k.contactpersonen]
    eva = next((c for c in contacts if c.naam == "Eva Beta"), None)
    assert eva is not None
    assert eva.vertrouwen in {"middel", "laag"}
