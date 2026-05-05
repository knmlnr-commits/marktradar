"""Source adapters: read raw rows from XLSX, CSV, or JSON."""

from .base import SourceAdapter, SourceRow
from .csv_adapter import CsvAdapter
from .json_adapter import JsonAdapter
from .xlsx_adapter import XlsxAdapter


def adapter_for_type(adapter_type: str) -> SourceAdapter:
    """Factory: pick an adapter instance based on the config 'type' value."""
    mapping = {
        "csv": CsvAdapter(),
        "xlsx": XlsxAdapter(),
        "json": JsonAdapter(),
    }
    if adapter_type not in mapping:
        raise ValueError(
            f"Onbekend adapter-type '{adapter_type}'; beschikbaar: {sorted(mapping)}"
        )
    return mapping[adapter_type]


def adapter_for_path(path: str) -> SourceAdapter:
    """Factory: pick an adapter based on the file extension."""
    lower = str(path).lower()
    if lower.endswith(".xlsx") or lower.endswith(".xlsm"):
        return XlsxAdapter()
    if lower.endswith(".csv"):
        return CsvAdapter()
    if lower.endswith(".json"):
        return JsonAdapter()
    raise ValueError(
        f"Kan geen adapter afleiden uit pad '{path}'; gebruik .xlsx, .csv of .json"
    )


__all__ = [
    "SourceAdapter",
    "SourceRow",
    "CsvAdapter",
    "JsonAdapter",
    "XlsxAdapter",
    "adapter_for_type",
    "adapter_for_path",
]
