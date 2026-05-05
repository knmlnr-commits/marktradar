"""Canonical klantbeeld schema.

The ingestion pipeline normalises every source row to these models so the
downstream output is uniform across tenants and adapters.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl


ContactRol = Literal["decider", "champion", "influencer", "gatekeeper", "blocker"]
ContactBronType = Literal[
    "xls-import",
    "csv-import",
    "crm-export",
    "manual",
    "linkedin",
    "json-import",
]
Vertrouwen = Literal["hoog", "middel", "laag"]
KlantStatus = Literal["customer", "prospect", "suspect", "inactive"]


class Contactpersoon(BaseModel):
    """Single contact person attached to a Klant."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    naam: str
    functie: str
    rol: ContactRol
    email: Optional[EmailStr] = None
    telefoon: Optional[str] = None
    linkedin: Optional[HttpUrl] = None
    bron_type: ContactBronType
    vertrouwen: Vertrouwen = "middel"
    geverifieerd: date
    notitie: Optional[str] = None


class Klant(BaseModel):
    """Canonical customer record. Per-tenant customisation lives in `velden`."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    naam: str
    land: str = Field(min_length=2, max_length=2, description="ISO-3166-1 alpha-2")
    type: str
    groep: Optional[str] = None
    tier: Optional[Literal[1, 2, 3]] = None
    status: KlantStatus
    velden: dict[str, Any] = Field(default_factory=dict)
    bronnen: list[str] = Field(default_factory=list)
    contactpersonen: list[Contactpersoon] = Field(default_factory=list)
    laatste_update: datetime
