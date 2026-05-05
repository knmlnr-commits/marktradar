"""GDPR-style validation rules for contact records.

Two checks per the tenant config:
  - Free-mail addresses (e.g. gmail.com): action `verlaag_vertrouwen`
    drops the trust score one step (hoog -> middel -> laag); action
    `verwijder_email` clears the email field; action `geen` is a no-op.
  - Phone numbers without explicit 'zakelijk' marker: action
    `verwijder` clears the phone number; action `behouden` is a no-op.
"""

from __future__ import annotations

from typing import Any


VERTROUWEN_DOWNGRADE = {"hoog": "middel", "middel": "laag", "laag": "laag"}


class GdprValidator:
    def __init__(
        self,
        freemail_domeinen: list[str],
        freemail_actie: str,
        prive_telefoon_actie: str,
    ):
        self.freemail_domeinen = {d.lower().strip() for d in freemail_domeinen}
        self.freemail_actie = freemail_actie
        self.prive_telefoon_actie = prive_telefoon_actie

    def is_freemail(self, email: str | None) -> bool:
        if not email or "@" not in email:
            return False
        domain = email.split("@", 1)[1].lower().strip()
        return domain in self.freemail_domeinen

    def apply_to_contact(self, contact: dict[str, Any]) -> dict[str, Any]:
        """Mutate-and-return a contact dict per the configured rules.

        Phone-rule: we only carry a number through when the source row
        explicitly tagged it as zakelijk (work). The xls/csv adapter's
        contact namespace uses the column header verbatim, so the
        tenant config decides whether 'Telefoon zakelijk' or another
        column flows into `_contact.telefoon`. Any phone that arrives
        here is therefore already filtered upstream; the rule here is
        the safety net for ambiguous flows (default: clear).
        """
        c = dict(contact)
        email = c.get("email")
        if email and self.is_freemail(email):
            if self.freemail_actie == "verlaag_vertrouwen":
                current = c.get("vertrouwen") or "middel"
                c["vertrouwen"] = VERTROUWEN_DOWNGRADE.get(current, "laag")
            elif self.freemail_actie == "verwijder_email":
                c["email"] = None
        # Phone: if upstream did not mark it zakelijk we drop it under the
        # default 'verwijder' setting.
        if c.get("telefoon") and self.prive_telefoon_actie == "verwijder":
            if not c.get("_telefoon_zakelijk"):
                c["telefoon"] = None
        c.pop("_telefoon_zakelijk", None)
        return c
