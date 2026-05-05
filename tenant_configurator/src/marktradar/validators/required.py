"""Required-field check; runs after mapping but before pydantic validation.

Pydantic itself will also reject missing required fields, but checking
here lets us produce friendlier Dutch error messages with the source
field that the tenant config refers to.
"""

from __future__ import annotations

from typing import Any


def check_required_fields(
    klant_fields: dict[str, Any], required: list[str]
) -> list[str]:
    """Return the list of missing required field names; empty list if OK."""
    missing: list[str] = []
    for fld in required:
        value = klant_fields.get(fld)
        if value is None or (isinstance(value, str) and value.strip() == ""):
            missing.append(fld)
    return missing
