import os
import pytest
from src.repository import LegislationRepository

def test_case_intel_precedents_and_statutes():
    if not os.path.exists("data/caselaw.db"):
        pytest.skip("caselaw.db not found.")
    repo = LegislationRepository()
    c = repo.get_case_by_slug('2014-nswca-161')
    assert c is not None
    assert "title" in c
    assert isinstance(c.get("citing_cases"), list)
    assert isinstance(c.get("precedents_cited"), list)

    c2 = repo.get_case_by_slug('2021-nswsc-97')
    assert c2 is not None
    assert len(c2.get("statute_provisions", [])) > 0

