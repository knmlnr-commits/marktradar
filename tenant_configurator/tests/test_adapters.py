"""All three adapters return the same semantic shape for equivalent inputs."""

import csv
import json
from pathlib import Path

import pandas as pd

from marktradar.adapters import CsvAdapter, JsonAdapter, XlsxAdapter, adapter_for_path


SEMANTIC_ROW = {
    "naam": "Allianz",
    "land": "DE",
    "functie": "CEO",
    "contact_naam": "Sophie de Vries",
    "email": "sophie@allianz.de",
}


def test_csv_adapter_reads_rows(tmp_path: Path):
    path = tmp_path / "in.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(SEMANTIC_ROW))
        w.writeheader()
        w.writerow(SEMANTIC_ROW)
    rows = CsvAdapter().read(path)
    assert rows == [SEMANTIC_ROW]


def test_xlsx_adapter_reads_rows(tmp_path: Path):
    path = tmp_path / "in.xlsx"
    pd.DataFrame([SEMANTIC_ROW]).to_excel(path, index=False, engine="openpyxl")
    rows = XlsxAdapter().read(path)
    assert rows == [SEMANTIC_ROW]


def test_json_adapter_reads_array(tmp_path: Path):
    path = tmp_path / "in.json"
    path.write_text(json.dumps([SEMANTIC_ROW]), encoding="utf-8")
    rows = JsonAdapter().read(path)
    assert rows == [SEMANTIC_ROW]


def test_json_adapter_reads_records_wrapper(tmp_path: Path):
    path = tmp_path / "in.json"
    path.write_text(json.dumps({"records": [SEMANTIC_ROW]}), encoding="utf-8")
    rows = JsonAdapter().read(path)
    assert rows == [SEMANTIC_ROW]


def test_adapter_for_path_resolves_extension(tmp_path: Path):
    csv_path = tmp_path / "x.csv"
    csv_path.write_text("a\n1\n")
    xlsx_path = tmp_path / "x.xlsx"
    pd.DataFrame([{"a": 1}]).to_excel(xlsx_path, index=False, engine="openpyxl")
    json_path = tmp_path / "x.json"
    json_path.write_text("[]")
    assert isinstance(adapter_for_path(str(csv_path)), CsvAdapter)
    assert isinstance(adapter_for_path(str(xlsx_path)), XlsxAdapter)
    assert isinstance(adapter_for_path(str(json_path)), JsonAdapter)


def test_adapter_for_path_rejects_unknown(tmp_path: Path):
    import pytest
    p = tmp_path / "x.txt"
    p.write_text("foo")
    with pytest.raises(ValueError):
        adapter_for_path(str(p))
