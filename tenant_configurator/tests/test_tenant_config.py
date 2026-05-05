"""TenantConfig loader + init-command scaffolding + ingest CLI smoke test."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner

from marktradar.cli import ingest_command, init_tenant_command
from marktradar.config import load_tenant_config


def test_load_minimal_config(minimal_config_path: Path):
    cfg = load_tenant_config(minimal_config_path)
    assert cfg.tenant_id == "minimal"
    assert cfg.tenant_naam == "Minimal Test Tenant"
    assert {a.id for a in cfg.source_adapters} == {"test_xlsx", "test_csv", "test_json"}


def test_unknown_role_key_rejected(tmp_path: Path):
    bad_yaml = tmp_path / "bad.yaml"
    bad_yaml.write_text(
        yaml.safe_dump(
            {
                "tenant_id": "x",
                "tenant_naam": "Bad",
                "customer_definition": {"required_fields": ["naam"], "custom_fields": []},
                "contact_role_mapping": {"super_decider": ["CEO"]},
            },
            sort_keys=False,
        )
    )
    with pytest.raises(ValueError):
        load_tenant_config(bad_yaml)


def test_init_tenant_scaffolds_yaml(tmp_path: Path):
    runner = CliRunner()
    result = runner.invoke(
        init_tenant_command,
        ["--id", "newtenant", "--naam", "New Tenant BV", "--base-dir", str(tmp_path)],
    )
    assert result.exit_code == 0, result.output
    config_path = tmp_path / "newtenant" / "config.yaml"
    assert config_path.exists()
    cfg = load_tenant_config(config_path)
    assert cfg.tenant_id == "newtenant"
    assert cfg.tenant_naam == "New Tenant BV"


def test_init_tenant_refuses_existing(tmp_path: Path):
    runner = CliRunner()
    (tmp_path / "existing").mkdir()
    result = runner.invoke(
        init_tenant_command,
        ["--id", "existing", "--naam", "X", "--base-dir", str(tmp_path)],
    )
    assert result.exit_code != 0
    assert "bestaat al" in result.output


def _materialise_minimal_tenant(tmp_path: Path, fixtures_dir: Path) -> Path:
    """Copy the minimal-fixture config + a small instelling-list to tmp_path."""
    base = tmp_path / "tenants_root"
    target = base / "minimal"
    (target / "data").mkdir(parents=True)
    raw = yaml.safe_load((fixtures_dir / "tenant_minimal.yaml").read_text())
    (target / "config.yaml").write_text(yaml.safe_dump(raw, sort_keys=False))
    (target / "data" / "INSTELLING_LIJST.txt").write_text(
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
    return base


def test_ingest_command_dry_run(tmp_path: Path, fixtures_dir: Path, sample_xlsx: Path):
    base = _materialise_minimal_tenant(tmp_path, fixtures_dir)
    runner = CliRunner()
    result = runner.invoke(
        ingest_command,
        [
            "--tenant", "minimal",
            "--source", str(sample_xlsx),
            "--base-dir", str(base),
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Dry-run" in result.output
    assert "Klanten verwerkt:" in result.output


def test_ingest_command_writes_output(
    tmp_path: Path, fixtures_dir: Path, sample_xlsx: Path
):
    base = _materialise_minimal_tenant(tmp_path, fixtures_dir)
    out_dir = tmp_path / "ingest_out"
    runner = CliRunner()
    result = runner.invoke(
        ingest_command,
        [
            "--tenant", "minimal",
            "--source", str(sample_xlsx),
            "--base-dir", str(base),
            "--output-dir", str(out_dir),
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Output geschreven:" in result.output
    out_files = list(out_dir.glob("*.json"))
    assert len(out_files) == 1


def test_ingest_command_explicit_adapter(
    tmp_path: Path, fixtures_dir: Path
):
    base = _materialise_minimal_tenant(tmp_path, fixtures_dir)
    csv_path = tmp_path / "rows.csv"
    csv_path.write_text(
        "naam,land,functie,contact_naam,email\n"
        "Allianz,DE,CEO,Sophie de Vries,sophie@allianz.de\n",
        encoding="utf-8",
    )
    runner = CliRunner()
    result = runner.invoke(
        ingest_command,
        [
            "--tenant", "minimal",
            "--source", str(csv_path),
            "--adapter", "test_csv",
            "--base-dir", str(base),
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Klanten verwerkt: 1" in result.output
