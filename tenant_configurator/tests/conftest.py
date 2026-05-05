"""Shared pytest fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest


FIXTURES_DIR = Path(__file__).parent / "fixtures"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def project_root() -> Path:
    return PROJECT_ROOT


@pytest.fixture
def minimal_config_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "tenant_minimal.yaml"


@pytest.fixture
def sample_xlsx(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_input.xlsx"


@pytest.fixture
def insurer_pipe_file(tmp_path: Path) -> Path:
    """Tiny pipe-formatted instelling list used by mapping/pipeline tests."""
    path = tmp_path / "INSTELLING_LIJST.txt"
    path.write_text(
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
    return path
