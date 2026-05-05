"""GDPR validator: freemail downgrade + private-phone removal."""

from datetime import date

from marktradar.validators import GdprValidator


def _gdpr(actie: str = "verlaag_vertrouwen", phone_actie: str = "verwijder") -> GdprValidator:
    return GdprValidator(
        freemail_domeinen=["gmail.com", "hotmail.com"],
        freemail_actie=actie,
        prive_telefoon_actie=phone_actie,
    )


def test_freemail_downgrades_one_step():
    g = _gdpr()
    out = g.apply_to_contact({"email": "a@gmail.com", "vertrouwen": "hoog"})
    assert out["vertrouwen"] == "middel"

    out = g.apply_to_contact({"email": "a@gmail.com", "vertrouwen": "middel"})
    assert out["vertrouwen"] == "laag"

    out = g.apply_to_contact({"email": "a@gmail.com", "vertrouwen": "laag"})
    assert out["vertrouwen"] == "laag"  # cannot drop below laag


def test_freemail_remove_email_action():
    g = _gdpr(actie="verwijder_email")
    out = g.apply_to_contact({"email": "a@gmail.com", "vertrouwen": "hoog"})
    assert out["email"] is None
    assert out["vertrouwen"] == "hoog"  # not modified by this action


def test_freemail_geen_action_is_noop():
    g = _gdpr(actie="geen")
    out = g.apply_to_contact({"email": "a@gmail.com", "vertrouwen": "hoog"})
    assert out["email"] == "a@gmail.com"
    assert out["vertrouwen"] == "hoog"


def test_business_email_not_affected():
    g = _gdpr()
    out = g.apply_to_contact({"email": "a@allianz.de", "vertrouwen": "hoog"})
    assert out["email"] == "a@allianz.de"
    assert out["vertrouwen"] == "hoog"


def test_phone_removed_when_not_zakelijk():
    g = _gdpr()
    out = g.apply_to_contact({"telefoon": "+31 6 1234 5678"})
    assert out["telefoon"] is None


def test_phone_kept_when_zakelijk_flag_set():
    g = _gdpr()
    out = g.apply_to_contact(
        {"telefoon": "+31 20 555 0123", "_telefoon_zakelijk": True}
    )
    assert out["telefoon"] == "+31 20 555 0123"
    assert "_telefoon_zakelijk" not in out


def test_phone_kept_when_action_behouden():
    g = _gdpr(phone_actie="behouden")
    out = g.apply_to_contact({"telefoon": "+31 6 1234 5678"})
    assert out["telefoon"] == "+31 6 1234 5678"
