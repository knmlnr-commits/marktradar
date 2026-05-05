"""Role mapper covers all five canonical roles."""

import pytest

from marktradar.mapping import RoleMapper


@pytest.fixture
def mapper() -> RoleMapper:
    return RoleMapper(
        {
            "decider": ["CEO", "Bestuurder", "Managing Director"],
            "champion": ["Director Claims", "Manager Behandeling"],
            "influencer": ["CIO", "Manager IT", "CISO"],
            "gatekeeper": ["Inkoopmanager", "Office Manager"],
            "blocker": ["Compliance Officer", "DPO"],
        }
    )


def test_decider(mapper: RoleMapper):
    assert mapper.map_role("CEO") == "decider"
    assert mapper.map_role("CEO Europe") == "decider"


def test_champion(mapper: RoleMapper):
    assert mapper.map_role("Director Claims EMEA") == "champion"


def test_influencer(mapper: RoleMapper):
    assert mapper.map_role("CIO Group") == "influencer"
    assert mapper.map_role("CISO and Privacy Lead") == "influencer"


def test_gatekeeper(mapper: RoleMapper):
    assert mapper.map_role("Office Manager") == "gatekeeper"


def test_blocker(mapper: RoleMapper):
    assert mapper.map_role("Compliance Officer") == "blocker"


def test_unknown_falls_back_to_influencer(mapper: RoleMapper):
    assert mapper.map_role("Junior Analyst") == "influencer"


def test_empty_falls_back_to_influencer(mapper: RoleMapper):
    assert mapper.map_role("") == "influencer"
    assert mapper.map_role(None) == "influencer"


def test_decider_wins_over_influencer_when_hybrid(mapper: RoleMapper):
    """A 'CEO and CIO' wears two hats; decider wins because order matters."""
    assert mapper.map_role("CEO and CIO") == "decider"
