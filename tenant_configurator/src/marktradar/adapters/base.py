"""Abstract base class for source adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Iterator


SourceRow = dict[str, Any]


class SourceAdapter(ABC):
    """Read raw rows from a single source file.

    Each adapter returns a list of dicts where keys are the source column
    names exactly as written in the file. Field mapping happens later in
    the pipeline (FieldMapper) so adapters stay simple and uniform.
    """

    bron_type_default: str = "manual"

    @abstractmethod
    def read(self, path: Path) -> list[SourceRow]:
        """Return the raw rows from `path`."""
        raise NotImplementedError

    def iter_rows(self, path: Path) -> Iterator[SourceRow]:
        """Convenience iterator wrapper around read()."""
        for row in self.read(path):
            yield row
