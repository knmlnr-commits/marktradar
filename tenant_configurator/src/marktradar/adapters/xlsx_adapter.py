"""XLSX adapter using openpyxl-backed pandas reader."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .base import SourceAdapter, SourceRow


class XlsxAdapter(SourceAdapter):
    bron_type_default = "xls-import"

    def read(self, path: Path) -> list[SourceRow]:
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"XLSX-bestand niet gevonden: {path}")
        df = pd.read_excel(path, dtype=str, engine="openpyxl", keep_default_na=False)
        rows: list[SourceRow] = []
        for record in df.to_dict(orient="records"):
            cleaned = {k: (v if pd.notna(v) and v != "" else None) for k, v in record.items()}
            rows.append(cleaned)
        return rows
