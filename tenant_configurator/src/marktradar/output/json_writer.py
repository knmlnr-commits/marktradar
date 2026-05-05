"""Serialise the canonical klantbeeld to JSON on disk."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Iterable

from ..schema import Klant


class JsonWriter:
    """Write a list of Klant records as JSON; honours the tenant output config."""

    def __init__(self, pad_template: str, pretty: bool = True):
        self.pad_template = pad_template
        self.pretty = pretty

    def render_path(self, tenant_id: str, when: datetime | None = None) -> Path:
        when = when or datetime.utcnow()
        return Path(
            self.pad_template.format(
                tenant_id=tenant_id,
                timestamp=when.strftime("%Y%m%dT%H%M%S"),
            )
        )

    def write(self, klanten: Iterable[Klant], path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        records = [k.model_dump(mode="json") for k in klanten]
        payload = {"records": records, "count": len(records)}
        with path.open("w", encoding="utf-8") as fh:
            if self.pretty:
                json.dump(payload, fh, ensure_ascii=False, indent=2, default=str)
            else:
                json.dump(payload, fh, ensure_ascii=False, default=str)
        return path
