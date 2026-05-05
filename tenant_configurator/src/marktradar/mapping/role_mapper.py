"""Map a free-text job title to a canonical contact role.

Strategy: a config-driven dict of `rol -> [substrings]`. We do
case-insensitive substring matching. Order matters: first hit wins.
The standard taxonomy decider/champion/influencer/gatekeeper/blocker
follows a hierarchy from most decision-power to most obstructive, so
checking in that order makes a CIO who is also a 'Director Claims'
land on champion (the higher-impact role) only if the config lists
'Director Claims' under champion, otherwise on influencer.
"""

from __future__ import annotations

from typing import Optional

DEFAULT_ROLE_ORDER = ["decider", "champion", "influencer", "gatekeeper", "blocker"]


class RoleMapper:
    def __init__(self, mapping: dict[str, list[str]]):
        # Normalise to lowercase substrings for matching.
        self._mapping: dict[str, list[str]] = {
            rol: [s.lower().strip() for s in substrings if s.strip()]
            for rol, substrings in mapping.items()
        }

    def map_role(self, functie: Optional[str]) -> str:
        """Return the canonical rol; defaults to 'influencer' on no match."""
        if not functie:
            return "influencer"
        target = functie.lower()
        for rol in DEFAULT_ROLE_ORDER:
            for fragment in self._mapping.get(rol, []):
                if fragment in target:
                    return rol
        return "influencer"
