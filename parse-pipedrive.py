#!/usr/bin/env python3
"""
Parser voor de PipeDrive-extract (text-formaat) naar gestructureerde JSON.
Leest stdin of een bestand, schrijft JSON naar stdout.
"""
import re
import json
import sys
from pathlib import Path


def parse_extract(text: str) -> dict:
    # Splits in secties via "=" * 70+
    parts = re.split(r"={70,}\nSECTIE \d+ (?:[—-] )?(.+?)\n={70,}", text)
    # parts = [pre, sec1_name, sec1_body, sec2_name, sec2_body, sec3_name, sec3_body]
    sections = {}
    for i in range(1, len(parts), 2):
        sections[parts[i].strip()] = parts[i + 1] if i + 1 < len(parts) else ""

    org_text = next((sections[k] for k in sections if k.startswith("ORGANISAT")), "")
    prod_text = next((sections[k] for k in sections if k.startswith("PRODUCTEN")), "")
    ungrouped_text = next(
        (sections[k] for k in sections if "ONGEKOPPELDE" in k or "NIET-GEKOPPELDE" in k),
        "",
    )

    return {
        "orgs": parse_orgs(org_text),
        "products": parse_products(prod_text),
        "ungrouped": parse_ungrouped(ungrouped_text),
    }


def parse_orgs(text: str) -> list:
    blocks = re.split(r"\n(?=--- ORG #\d+:)", text)
    orgs = []
    for block in blocks:
        block = block.strip()
        if not block.startswith("--- ORG"):
            continue
        org = parse_org_block(block)
        if org:
            orgs.append(org)
    return orgs


def parse_org_block(block: str) -> dict:
    lines = block.split("\n")
    header = lines[0]
    m = re.match(r"--- ORG #(\d+):\s+(.+?)\s+---\s*$", header)
    if not m:
        return None
    org = {
        "id": int(m.group(1)),
        "naam": m.group(2).strip(),
        "header": {},
        "deals": [],
        "leads": [],
        "contacten": [],
        "notities": [],
        "activiteiten": [],
        "bestanden": [],
    }

    # Two passes:
    # 1) header lines (no leading 2-space indent) until first "  XYZ (n):" section
    # 2) section blocks
    i = 1
    while i < len(lines):
        line = lines[i]
        if re.match(r"^\s\s(DEALS|LEADS|CONTACTEN|NOTITIES|ACTIVITEITEN|BESTANDEN)\s*\(\d+\):", line):
            break
        if line.strip():
            kv = line.split(":", 1)
            if len(kv) == 2:
                key = kv[0].strip()
                val = kv[1].strip()
                org["header"][key] = val
        i += 1

    # Parse remaining as sections
    state = None
    current = None
    while i < len(lines):
        line = lines[i]
        sec = re.match(r"^\s\s(DEALS|LEADS|CONTACTEN|NOTITIES|ACTIVITEITEN|BESTANDEN)\s*\((\d+)\):", line)
        if sec:
            if current and state:
                org[state.lower()].append(current)
                current = None
            state = sec.group(1)
            i += 1
            continue
        # New item: "  · " (2-space indent + middot)
        item_start = re.match(r"^\s\s· (.+)", line)
        if item_start:
            if current and state:
                org[state.lower()].append(current)
            current = {"raw_first_line": item_start.group(1).strip()}
            i += 1
            continue
        # Continuation lines have deeper indent
        if current is not None:
            stripped = line.strip()
            if stripped:
                if "raw_lines" not in current:
                    current["raw_lines"] = []
                current["raw_lines"].append(stripped)
        i += 1

    if current and state:
        org[state.lower()].append(current)

    # Post-process each item-list type
    for d in org["deals"]:
        post_process_deal(d)
    for l in org["leads"]:
        post_process_lead(l)
    for c in org["contacten"]:
        post_process_contact(c)
    for n in org["notities"]:
        post_process_notitie(n)
    for a in org["activiteiten"]:
        post_process_activiteit(a)
    for b in org["bestanden"]:
        post_process_bestand(b)

    return org


def kv_from_lines(lines):
    out = {}
    for ln in lines:
        if ":" in ln:
            k, v = ln.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def post_process_deal(d):
    # raw_first_line: "#56 \"Alliade lead\""
    m = re.match(r'#(\d+)\s+"(.+?)"\s*$', d["raw_first_line"])
    if m:
        d["dealId"] = int(m.group(1))
        d["titel"] = m.group(2)
    kv = kv_from_lines(d.get("raw_lines", []))
    d.update(kv)


def post_process_lead(l):
    # raw_first_line: "\"Alliade deal\""
    m = re.match(r'"(.+?)"\s*$', l["raw_first_line"])
    if m:
        l["titel"] = m.group(1)
    kv = kv_from_lines(l.get("raw_lines", []))
    l.update(kv)


def post_process_contact(c):
    # raw_first_line: "Naam | functie=X | email=... | tel-werk=..."
    raw = c["raw_first_line"]
    parts = [p.strip() for p in raw.split("|")]
    c["naam"] = parts[0]
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            c[k.strip()] = v.strip()
    kv = kv_from_lines(c.get("raw_lines", []))
    c.update(kv)


def post_process_notitie(n):
    # raw_first_line: "[2025-02-11] Jeff Lafranca | contact: X | deal: Y"
    raw = n["raw_first_line"]
    m = re.match(r"\[([\d-]+)\]\s+(.+)", raw)
    if m:
        n["datum"] = m.group(1)
        rest = m.group(2)
        parts = [p.strip() for p in rest.split("|")]
        n["gebruiker"] = parts[0]
        for p in parts[1:]:
            if ":" in p:
                k, v = p.split(":", 1)
                n[k.strip()] = v.strip()
    n["tekst"] = " ".join(n.get("raw_lines", []))


def post_process_activiteit(a):
    raw = a["raw_first_line"]
    m = re.match(r"\[([\d-]+)\]\s+(.+?):\s*\"(.+?)\"\s*$", raw)
    if m:
        a["datum"] = m.group(1)
        a["type"] = m.group(2)
        a["onderwerp"] = m.group(3)
    a["beschrijving"] = " ".join(a.get("raw_lines", []))


def post_process_bestand(b):
    raw = b["raw_first_line"]
    m = re.match(r"\[([\d-]+)\]\s+(.+?)(?:\s+\(deal:\s*(.+?)\))?\s*$", raw)
    if m:
        b["datum"] = m.group(1)
        b["bestand"] = m.group(2).strip()
        if m.group(3):
            b["dealTitel"] = m.group(3).strip()


def parse_products(text: str) -> list:
    blocks = re.split(r"\n(?=  ·\s+\[)", text)
    products = []
    for block in blocks:
        block = block.strip()
        if not block.startswith("·"):
            continue
        m = re.match(r"·\s+\[(.+?)\]\s+(.+)", block)
        if not m:
            continue
        prod = {"productcode": m.group(1).strip(), "naam": m.group(2).split("\n")[0].strip()}
        for ln in block.split("\n")[1:]:
            ln = ln.strip()
            if ":" not in ln:
                continue
            k, v = ln.split(":", 1)
            k = k.strip()
            v = v.strip()
            if k == "Categorie":
                prod["categorie"] = v
            elif k == "Eenheid":
                prod["eenheid"] = v
            elif k == "Prijs":
                # "2.5 EUR | Frequentie: Per maand"
                pmatch = re.match(r"([\d.]+)\s+EUR(?:\s*\|\s*Frequentie:\s*(.+))?", v)
                if pmatch:
                    prod["prijs"] = float(pmatch.group(1))
                    if pmatch.group(2):
                        prod["frequentie"] = pmatch.group(2).strip()
            elif k == "Eigenaar":
                prod["eigenaar"] = v
            elif k == "Beschrijving":
                prod["beschrijving"] = v
        products.append(prod)
    return products


def parse_ungrouped(text: str) -> dict:
    out = {"contacten": [], "activiteiten_zonder_org": 0}
    cm = re.search(r"CONTACTEN ZONDER ORGANISATIE \((\d+)\):\n(.*?)(?=\nACTIVITEITEN|\Z)", text, re.DOTALL)
    if cm:
        for line in cm.group(2).split("\n"):
            line = line.strip()
            if line.startswith("·"):
                line = line[1:].strip()
                parts = [p.strip() for p in line.split("|")]
                rec = {"naam": parts[0]}
                for p in parts[1:]:
                    if "=" in p:
                        k, v = p.split("=", 1)
                        rec[k.strip()] = v.strip()
                out["contacten"].append(rec)
    am = re.search(r"ACTIVITEITEN ZONDER ORG[^:]*:\s*(\d+)", text)
    if am:
        out["activiteiten_zonder_org"] = int(am.group(1))
    return out


def main():
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        text = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()
    data = parse_extract(text)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
