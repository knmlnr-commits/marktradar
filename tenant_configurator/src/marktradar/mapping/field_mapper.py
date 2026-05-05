"""Configuration-driven field mapping.

Translates source-row keys (column names in the input file) to canonical
schema field paths. Two namespaces:

  - keys without a prefix populate the Klant record (e.g. `naam`, `land`).
  - keys with a `_contact.` prefix populate a Contactpersoon attached to
    the same row (e.g. `_contact.naam`, `_contact.email`).
  - keys with a `velden.` prefix populate the customer-record `velden` dict.

Unmapped source columns are silently dropped, which is the desired
behaviour: tenant config is the single source of truth for what we keep.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MappedRow:
    """Output of FieldMapper.map_row(): klant fields plus optional contact."""

    klant_fields: dict[str, Any] = field(default_factory=dict)
    velden: dict[str, Any] = field(default_factory=dict)
    contact_fields: dict[str, Any] = field(default_factory=dict)


class FieldMapper:
    """Apply a source-to-canonical field mapping to one row."""

    def __init__(self, field_mapping: dict[str, str]):
        self.field_mapping = dict(field_mapping)

    def map_row(self, row: dict[str, Any]) -> MappedRow:
        out = MappedRow()
        for src_key, target in self.field_mapping.items():
            if src_key not in row:
                continue
            value = row[src_key]
            if value is None:
                continue
            if isinstance(value, str):
                value = value.strip()
                if value == "":
                    continue
            if target.startswith("_contact."):
                out.contact_fields[target.split(".", 1)[1]] = value
            elif target.startswith("velden."):
                out.velden[target.split(".", 1)[1]] = value
            else:
                out.klant_fields[target] = value
        return out
