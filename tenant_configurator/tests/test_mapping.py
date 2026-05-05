"""Field mapping behaviour."""

from marktradar.mapping import FieldMapper


def test_basic_mapping_splits_klant_and_contact():
    mapper = FieldMapper(
        {
            "Bedrijf": "naam",
            "Land": "land",
            "Naam": "_contact.naam",
            "Email": "_contact.email",
            "Owner": "velden.account_owner",
        }
    )
    out = mapper.map_row(
        {
            "Bedrijf": "Allianz",
            "Land": "DE",
            "Naam": "Sophie de Vries",
            "Email": "sophie@allianz.de",
            "Owner": "Hugo Bos",
        }
    )
    assert out.klant_fields == {"naam": "Allianz", "land": "DE"}
    assert out.contact_fields == {"naam": "Sophie de Vries", "email": "sophie@allianz.de"}
    assert out.velden == {"account_owner": "Hugo Bos"}


def test_strips_whitespace_and_skips_empty():
    mapper = FieldMapper({"Bedrijf": "naam", "Land": "land"})
    out = mapper.map_row({"Bedrijf": "  Aegon  ", "Land": "   "})
    assert out.klant_fields == {"naam": "Aegon"}


def test_handles_missing_keys_gracefully():
    mapper = FieldMapper({"Bedrijf": "naam", "Land": "land"})
    out = mapper.map_row({"Bedrijf": "Generali"})
    assert out.klant_fields == {"naam": "Generali"}


def test_handles_diacritics_in_values():
    mapper = FieldMapper({"Bedrijf": "naam"})
    out = mapper.map_row({"Bedrijf": "Württembergische"})
    assert out.klant_fields == {"naam": "Württembergische"}


def test_unmapped_columns_dropped_silently():
    mapper = FieldMapper({"Bedrijf": "naam"})
    out = mapper.map_row(
        {"Bedrijf": "Aviva", "RandomNoise": "ignored", "OtherJunk": 42}
    )
    assert out.klant_fields == {"naam": "Aviva"}
    assert "RandomNoise" not in out.velden
