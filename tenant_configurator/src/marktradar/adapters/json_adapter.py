"""JSON adapter; expects a top-level array of objects."""

from __future__ import annotations

import json
from pathlib import Path

from .base import SourceAdapter, SourceRow


class JsonAdapter(SourceAdapter):
    bron_type_default = "json-import"

    def read(self, path: Path) -> list[SourceRow]:
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"JSON-bestand niet gevonden: {path}")
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            data = data.get("rows") or data.get("records") or [data]
        if not isinstance(data, list):
            raise ValueError(
                f"JSON-bestand moet een array opleveren (of object met 'rows'/'records' sleutel): {path}"
            )
        return [dict(item) for item in data]
