"""Resolve a free-text customer name to a canonical instelling id.

Lookup strategy:
  1. Exact case-insensitive match on the canonical naam.
  2. Slug-normalised exact match (strips diacritics, lowercases, collapses
     whitespace) so 'Allianz NL' and 'allianz-nl' both find 'allianz-nl'.
  3. RapidFuzz token_set_ratio match; only accept if score >= threshold.

Returns an InstellingMatch with the matched id, the matched naam, the
score (1.0 for exact), and a flag indicating whether the match is below
threshold (in which case `id` is None).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from rapidfuzz import fuzz, process


@dataclass
class InstellingMatch:
    id: Optional[str]
    naam: Optional[str]
    score: float
    method: str  # "exact" | "slug" | "fuzzy" | "none"


def _slugify(value: str) -> str:
    """Lowercase, strip diacritics, replace non-alnum with single dash."""
    nf = unicodedata.normalize("NFD", value)
    no_diacritics = "".join(c for c in nf if not unicodedata.combining(c))
    lower = no_diacritics.lower()
    collapsed = re.sub(r"[^a-z0-9]+", "-", lower).strip("-")
    return collapsed


class InstellingResolver:
    """Match free-text names against a canonical reference list."""

    def __init__(
        self,
        records: list[dict[str, str]],
        fuzzy_threshold: float = 0.85,
    ):
        # records: [{"id": str, "naam": str, "hoofdvestiging": str|None}]
        self._records = list(records)
        self._by_naam_lower = {r["naam"].lower(): r for r in self._records if r.get("naam")}
        self._by_slug = {_slugify(r["naam"]): r for r in self._records if r.get("naam")}
        self._naam_choices = [r["naam"] for r in self._records if r.get("naam")]
        self._fuzzy_threshold = fuzzy_threshold

    @classmethod
    def from_pipe_file(
        cls, path: Path, fuzzy_threshold: float = 0.85
    ) -> "InstellingResolver":
        """Load `id | naam | hoofdvestiging` lines into the resolver.

        Lines starting with '#' are comments; blank lines are skipped.
        """
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Instelling-lijst niet gevonden: {path}")
        records: list[dict[str, str]] = []
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [p.strip() for p in line.split("|")]
                if len(parts) < 2:
                    continue
                records.append(
                    {
                        "id": parts[0],
                        "naam": parts[1],
                        "hoofdvestiging": parts[2] if len(parts) > 2 else None,
                    }
                )
        return cls(records, fuzzy_threshold=fuzzy_threshold)

    @classmethod
    def from_csv_file(
        cls, path: Path, fuzzy_threshold: float = 0.85
    ) -> "InstellingResolver":
        import pandas as pd

        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Instelling-lijst niet gevonden: {path}")
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
        records = []
        for record in df.to_dict(orient="records"):
            naam = record.get("naam") or record.get("Naam") or record.get("name")
            if not naam:
                continue
            ident = record.get("id") or _slugify(naam)
            hoofd = record.get("hoofdvestiging") or record.get("Hoofdvestiging")
            records.append({"id": ident, "naam": naam, "hoofdvestiging": hoofd})
        return cls(records, fuzzy_threshold=fuzzy_threshold)

    def resolve(self, naam: str) -> InstellingMatch:
        if not naam:
            return InstellingMatch(id=None, naam=None, score=0.0, method="none")
        cleaned = naam.strip()
        # Stage 1: exact case-insensitive
        hit = self._by_naam_lower.get(cleaned.lower())
        if hit:
            return InstellingMatch(
                id=hit["id"], naam=hit["naam"], score=1.0, method="exact"
            )
        # Stage 2: slug match
        slug = _slugify(cleaned)
        if slug and slug in self._by_slug:
            hit = self._by_slug[slug]
            return InstellingMatch(
                id=hit["id"], naam=hit["naam"], score=1.0, method="slug"
            )
        # Stage 3: fuzzy via rapidfuzz token_set_ratio
        if not self._naam_choices:
            return InstellingMatch(id=None, naam=None, score=0.0, method="none")
        best = process.extractOne(
            cleaned,
            self._naam_choices,
            scorer=fuzz.token_set_ratio,
            score_cutoff=0,
        )
        if best is None:
            return InstellingMatch(id=None, naam=None, score=0.0, method="none")
        match_naam, raw_score, _idx = best
        score = raw_score / 100.0
        if score < self._fuzzy_threshold:
            return InstellingMatch(
                id=None, naam=match_naam, score=score, method="fuzzy"
            )
        record = self._by_naam_lower[match_naam.lower()]
        return InstellingMatch(
            id=record["id"], naam=record["naam"], score=score, method="fuzzy"
        )
