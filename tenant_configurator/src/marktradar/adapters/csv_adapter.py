"""CSV adapter using pandas for robust delimiter and encoding handling."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .base import SourceAdapter, SourceRow


class CsvAdapter(SourceAdapter):
    bron_type_default = "csv-import"

    def read(self, path: Path) -> list[SourceRow]:
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"CSV-bestand niet gevonden: {path}")
        # dtype=str so numeric-looking ids stay as strings; pandas otherwise
        # coerces e.g. "00123" to int 123 and we lose leading zeros.
        df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])
        rows: list[SourceRow] = []
        for record in df.to_dict(orient="records"):
            cleaned = {k: (v if pd.notna(v) else None) for k, v in record.items()}
            rows.append(cleaned)
        return rows
