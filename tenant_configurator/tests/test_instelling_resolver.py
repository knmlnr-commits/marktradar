"""Instelling resolver: exact, slug, fuzzy."""

from pathlib import Path

import pytest

from marktradar.mapping import InstellingResolver


@pytest.fixture
def resolver(insurer_pipe_file: Path) -> InstellingResolver:
    return InstellingResolver.from_pipe_file(insurer_pipe_file, fuzzy_threshold=0.85)


def test_exact_match(resolver: InstellingResolver):
    m = resolver.resolve("Allianz")
    assert m.id == "allianz"
    assert m.score == 1.0
    assert m.method == "exact"


def test_case_insensitive_exact(resolver: InstellingResolver):
    m = resolver.resolve("allianz")
    assert m.id == "allianz"
    assert m.method == "exact"


def test_slug_match_strips_diacritics(insurer_pipe_file: Path, tmp_path: Path):
    extra = tmp_path / "with_diacritics.txt"
    extra.write_text(
        insurer_pipe_file.read_text() + "wuerttembergische | Württembergische | Stuttgart\n",
        encoding="utf-8",
    )
    res = InstellingResolver.from_pipe_file(extra)
    m = res.resolve("Wurttembergische")  # no umlaut
    assert m.id == "wuerttembergische"


def test_fuzzy_match_above_threshold(resolver: InstellingResolver):
    m = resolver.resolve("Allianzz")  # one extra char
    assert m.id == "allianz"
    assert m.method == "fuzzy"
    assert m.score >= 0.85


def test_fuzzy_match_below_threshold_returns_no_id(resolver: InstellingResolver):
    m = resolver.resolve("Totally Unrelated GmbH")
    assert m.id is None
    assert m.method in {"fuzzy", "none"}


def test_unknown_returns_none(resolver: InstellingResolver):
    m = resolver.resolve("")
    assert m.id is None
    assert m.method == "none"


def test_low_threshold_accepts_more(insurer_pipe_file: Path):
    res = InstellingResolver.from_pipe_file(insurer_pipe_file, fuzzy_threshold=0.5)
    m = res.resolve("Allianz Life")
    # token_set_ratio collapses tokens; match should be high.
    assert m.id == "allianz"
