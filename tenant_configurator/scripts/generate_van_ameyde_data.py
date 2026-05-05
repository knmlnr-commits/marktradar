"""Generate dummy Van Ameyde tenant data; deterministic via fixed seed.

Produces:
  - tenants/van-ameyde/data/INSTELLING_LIJST.txt        (~150 insurers, pipe-format)
  - tenants/van-ameyde/data/VA_Systems_TAM_Europese_Verzekeraars.csv
  - tenants/van-ameyde/data/sample_zoho_export.csv
  - tenants/van-ameyde/data/sample_xls_contacts.xlsx
  - tests/fixtures/sample_input.xlsx                    (small, used by tests)

Run from the project root:
    python scripts/generate_van_ameyde_data.py
"""

from __future__ import annotations

import csv
import random
import re
import unicodedata
from pathlib import Path

import pandas as pd


SEED = 42

# Real European insurer names (publicly known) used as a plausible base; the
# rest of the data (contact names, emails, owners) is synthetic.
INSURER_BASE = [
    ("Allianz", "DE"), ("AXA", "FR"), ("Generali", "IT"), ("Zurich Insurance", "CH"),
    ("Munich Re", "DE"), ("Swiss Re", "CH"), ("Hannover Re", "DE"), ("SCOR", "FR"),
    ("Aegon", "NL"), ("NN Group", "NL"), ("Achmea", "NL"), ("ASR", "NL"),
    ("Talanx", "DE"), ("Mapfre", "ES"), ("Vienna Insurance Group", "AT"),
    ("Uniqa", "AT"), ("KBC", "BE"), ("Ageas", "BE"), ("Baloise", "CH"),
    ("Helvetia", "CH"), ("Tryg", "DK"), ("Topdanmark", "DK"), ("Sampo", "FI"),
    ("If P&C", "SE"), ("Trygg-Hansa", "SE"), ("Folksam", "SE"), ("Lansforsakringar", "SE"),
    ("Gjensidige", "NO"), ("Storebrand", "NO"), ("Ergo", "DE"), ("Provinzial", "DE"),
    ("Signal Iduna", "DE"), ("HUK-Coburg", "DE"), ("Wuerttembergische", "DE"),
    ("CNP Assurances", "FR"), ("Groupama", "FR"), ("Covea", "FR"), ("MACIF", "FR"),
    ("MAIF", "FR"), ("Matmut", "FR"), ("MMA", "FR"), ("Suravenir", "FR"),
    ("Aviva", "GB"), ("Legal & General", "GB"), ("Prudential UK", "GB"), ("RSA", "GB"),
    ("Direct Line", "GB"), ("Admiral Group", "GB"), ("Hiscox", "GB"), ("Beazley", "GB"),
    ("Lloyd's of London", "GB"), ("Catalana Occidente", "ES"), ("Mutua Madrilena", "ES"),
    ("Santalucia", "ES"), ("Sanitas", "ES"), ("Caser", "ES"), ("Reale Mutua", "IT"),
    ("Cattolica", "IT"), ("Unipol", "IT"), ("Poste Vita", "IT"), ("Vittoria Assicurazioni", "IT"),
    ("Ethias", "BE"), ("P&V", "BE"), ("DKV Belgium", "BE"), ("AG Insurance", "BE"),
    ("Belfius Insurance", "BE"), ("Univé", "NL"), ("Klaverblad", "NL"), ("ONVZ", "NL"),
    ("De Goudse", "NL"), ("TVM Verzekeringen", "NL"), ("Bovemij", "NL"),
    ("DAS", "NL"), ("Lippmann", "NL"), ("ABN AMRO Verzekeringen", "NL"),
    ("Centraal Beheer", "NL"), ("Allianz Trade", "FR"), ("Atradius", "NL"),
    ("Coface", "FR"), ("Markel", "GB"), ("ChubB", "CH"), ("AIG Europe", "LU"),
    ("Liberty Specialty Markets", "GB"), ("Sompo International", "GB"),
    ("Tokio Marine HCC", "ES"), ("MS Amlin", "GB"), ("QBE Europe", "BE"),
    ("Mitsui Sumitomo", "DE"), ("PZU", "PL"), ("Warta", "PL"), ("Compensa", "PL"),
    ("Generali Polska", "PL"), ("CSOB Pojistovna", "CZ"), ("Kooperativa", "CZ"),
    ("Slavia Insurance", "CZ"), ("OTP Garancia", "HU"), ("Groupama Hungary", "HU"),
    ("Triglav", "SI"), ("Sava Re", "SI"), ("Croatia osiguranje", "HR"),
    ("Allianz Zagreb", "HR"), ("Wiener Staedtische", "AT"), ("Donau Versicherung", "AT"),
]

TYPES = ["Composite", "Non-Life", "Life", "Reinsurer", "Health", "Specialty", "Marine"]

CONTACT_FUNCTIES = [
    ("CEO", "decider"),
    ("Voorzitter RvB", "decider"),
    ("Bestuurder", "decider"),
    ("Managing Director", "decider"),
    ("Director Claims", "champion"),
    ("Head of Claims", "champion"),
    ("Manager Behandeling", "champion"),
    ("Hoofd Behandelzaken", "champion"),
    ("Lid RvB", "champion"),
    ("CIO", "influencer"),
    ("Manager IT", "influencer"),
    ("IT Director", "influencer"),
    ("Innovation Manager", "influencer"),
    ("Kwaliteitsmanager", "influencer"),
    ("Procesmanager", "influencer"),
    ("Inkoopmanager", "gatekeeper"),
    ("Bestuurssecretaris", "gatekeeper"),
    ("Executive Assistant", "gatekeeper"),
    ("Office Manager", "gatekeeper"),
    ("Compliance Officer", "blocker"),
    ("DPO", "blocker"),
    ("Functionaris Gegevensbescherming", "blocker"),
]

VOORNAMEN = [
    "Sophie", "Lucas", "Emma", "Noah", "Eva", "Daan", "Lotte", "Thomas",
    "Anna", "Jasper", "Sara", "Sander", "Lara", "Tim", "Lisa", "Bram",
    "Iris", "Niels", "Floor", "Sven", "Pieter", "Marieke", "Hugo", "Laura",
    "Wouter", "Emma", "Stijn", "Maud", "Joris", "Sanne", "Marc", "Anouk",
]

ACHTERNAMEN = [
    "de Vries", "Jansen", "Bakker", "Visser", "Smit", "Meijer", "de Boer",
    "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks", "van Leeuwen",
    "Dekker", "Brouwer", "Schoonhoven", "van Dijk", "Hofman", "van der Berg",
    "Koster", "van den Heuvel", "Kuijpers", "Wagemans", "Schaap", "Boersma",
]

GROUP_NAMES = ["Allianz", "AXA", "Generali", "Zurich Insurance", "Munich Re"]


def slugify(value: str) -> str:
    nf = unicodedata.normalize("NFD", value)
    no_diacritics = "".join(c for c in nf if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9]+", "-", no_diacritics.lower()).strip("-")
    return slug


def build_insurer_universe(rng: random.Random) -> list[dict[str, str]]:
    """Build ~150 insurers by combining bases with subsidiaries and branches."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    countries_for_branches = ["NL", "BE", "DE", "FR", "ES", "IT", "AT", "PL", "CZ"]

    for base, country in INSURER_BASE:
        ident = slugify(f"{base} {country}")
        if ident in seen:
            continue
        seen.add(ident)
        out.append(
            {
                "id": ident,
                "naam": f"{base}",
                "hoofdvestiging": _city_for(country, rng),
                "land": country,
                "type": rng.choice(TYPES),
                "groep": base if base in GROUP_NAMES else "",
            }
        )

    # Add branches/subsidiaries for the big groups
    for group in GROUP_NAMES:
        for c in countries_for_branches:
            naam = f"{group} {c}"
            ident = slugify(naam)
            if ident in seen:
                continue
            seen.add(ident)
            out.append(
                {
                    "id": ident,
                    "naam": naam,
                    "hoofdvestiging": _city_for(c, rng),
                    "land": c,
                    "type": rng.choice(["Composite", "Non-Life", "Specialty"]),
                    "groep": group,
                }
            )

    # Pad to ~150 with named subsidiaries
    while len(out) < 150:
        idx = len(out)
        country = rng.choice(countries_for_branches)
        naam = f"Regional Insurer {idx}"
        ident = slugify(naam)
        if ident in seen:
            continue
        seen.add(ident)
        out.append(
            {
                "id": ident,
                "naam": naam,
                "hoofdvestiging": _city_for(country, rng),
                "land": country,
                "type": rng.choice(TYPES),
                "groep": "",
            }
        )
    return out


def _city_for(country: str, rng: random.Random) -> str:
    cities = {
        "NL": ["Amsterdam", "Rotterdam", "Den Haag", "Utrecht"],
        "DE": ["Munich", "Hannover", "Cologne", "Stuttgart", "Hamburg"],
        "FR": ["Paris", "Lyon", "Niort"],
        "GB": ["London", "Manchester", "Bristol"],
        "ES": ["Madrid", "Barcelona"],
        "IT": ["Trieste", "Milan", "Rome"],
        "BE": ["Brussels", "Antwerp"],
        "CH": ["Zurich", "Bern", "Basel"],
        "AT": ["Vienna", "Graz"],
        "DK": ["Copenhagen"], "SE": ["Stockholm"], "FI": ["Helsinki"], "NO": ["Oslo"],
        "PL": ["Warsaw"], "CZ": ["Prague"], "HU": ["Budapest"],
        "SI": ["Ljubljana"], "HR": ["Zagreb"], "LU": ["Luxembourg"],
    }
    return rng.choice(cities.get(country, ["Amsterdam"]))


def write_instelling_lijst(insurers: list[dict[str, str]], path: Path) -> None:
    lines = ["# id | naam | hoofdvestiging"]
    for r in insurers:
        lines.append(f"{r['id']} | {r['naam']} | {r['hoofdvestiging']}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_tam_csv(insurers: list[dict[str, str]], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "naam", "land", "hoofdvestiging", "type", "groep"])
        for r in insurers:
            w.writerow(
                [r["id"], r["naam"], r["land"], r["hoofdvestiging"], r["type"], r["groep"]]
            )


def write_zoho_export(
    insurers: list[dict[str, str]], path: Path, rng: random.Random
) -> None:
    """Approximate a ZOHO CRM Accounts export structure."""
    sampled = rng.sample(insurers, k=min(80, len(insurers)))
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(
            [
                "Account Name",
                "Billing Country",
                "Industry",
                "Parent Account",
                "Account Owner",
            ]
        )
        for r in sampled:
            owner = f"{rng.choice(VOORNAMEN)} {rng.choice(ACHTERNAMEN)}"
            w.writerow(
                [r["naam"], r["land"], r["type"], r["groep"] or "", owner]
            )


def write_xls_contacts(
    insurers: list[dict[str, str]], path: Path, rng: random.Random
) -> None:
    """Build a contacts xlsx; 3-5 contacts per ~80 sampled insurers."""
    sampled = rng.sample(insurers, k=min(80, len(insurers)))
    rows: list[dict[str, str]] = []
    for inst in sampled:
        n_contacts = rng.randint(3, 5)
        domain = slugify(inst["naam"]).replace("-", "")[:18] + ".com"
        for _ in range(n_contacts):
            functie, _rol = rng.choice(CONTACT_FUNCTIES)
            voornaam = rng.choice(VOORNAMEN)
            achternaam = rng.choice(ACHTERNAMEN)
            full = f"{voornaam} {achternaam}"
            email_local = (voornaam + "." + achternaam.replace(" ", "").replace("'", "")).lower()
            # Sprinkle a few free-mail addresses to exercise the GDPR rule.
            if rng.random() < 0.12:
                email = f"{email_local}@gmail.com"
            else:
                email = f"{email_local}@{domain}"
            rows.append(
                {
                    "Bedrijf": inst["naam"],
                    "Land": inst["land"],
                    "Functie": functie,
                    "Naam": full,
                    "Email": email,
                    "Telefoon zakelijk": f"+31 6 {rng.randint(10000000, 99999999)}",
                    "LinkedIn": f"https://linkedin.com/in/{slugify(full)}",
                }
            )
    df = pd.DataFrame(rows)
    df.to_excel(path, index=False, engine="openpyxl")


def main() -> None:
    rng = random.Random(SEED)
    project_root = Path(__file__).resolve().parents[1]
    data_dir = project_root / "tenants" / "van-ameyde" / "data"
    fixtures_dir = project_root / "tests" / "fixtures"
    data_dir.mkdir(parents=True, exist_ok=True)
    fixtures_dir.mkdir(parents=True, exist_ok=True)

    insurers = build_insurer_universe(rng)
    print(f"Generated {len(insurers)} insurers")

    write_instelling_lijst(insurers, data_dir / "INSTELLING_LIJST.txt")
    write_tam_csv(insurers, data_dir / "VA_Systems_TAM_Europese_Verzekeraars.csv")
    write_zoho_export(insurers, data_dir / "sample_zoho_export.csv", rng)
    write_xls_contacts(insurers, data_dir / "sample_xls_contacts.xlsx", rng)

    # Smaller fixture for tests: 8 insurers, 3 contacts each = 24 rows.
    fixture_insurers = insurers[:8]
    fixture_rng = random.Random(SEED + 1)
    fixture_rows: list[dict[str, str]] = []
    for inst in fixture_insurers:
        for _ in range(3):
            functie, _rol = fixture_rng.choice(CONTACT_FUNCTIES)
            voornaam = fixture_rng.choice(VOORNAMEN)
            achternaam = fixture_rng.choice(ACHTERNAMEN)
            full = f"{voornaam} {achternaam}"
            domain = slugify(inst["naam"]).replace("-", "")[:18] + ".com"
            local = (voornaam + "." + achternaam.replace(" ", "")).lower()
            fixture_rows.append(
                {
                    "Bedrijf": inst["naam"],
                    "Land": inst["land"],
                    "Functie": functie,
                    "Naam": full,
                    "Email": f"{local}@{domain}",
                    "Telefoon zakelijk": f"+31 6 {fixture_rng.randint(10000000, 99999999)}",
                    "LinkedIn": f"https://linkedin.com/in/{slugify(full)}",
                }
            )
    pd.DataFrame(fixture_rows).to_excel(
        fixtures_dir / "sample_input.xlsx", index=False, engine="openpyxl"
    )
    print("Files written under", data_dir)


if __name__ == "__main__":
    main()
