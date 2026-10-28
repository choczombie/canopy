"""
Unit tests for modular multi-database LegislationRepository operations.
"""
import os
import pytest
from src.repository import LegislationRepository

@pytest.fixture
def repo():
    acts_db = "data/acts.db"
    regs_db = "data/regs.db"
    if not os.path.exists(acts_db) or not os.path.exists(regs_db):
        pytest.skip("Modular databases not initialized.")
    return LegislationRepository(acts_db_path=acts_db, regs_db_path=regs_db)

def test_multi_db_acts_count(repo):
    acts = repo.get_acts()
    assert len(acts) >= 16
    categories = [a.get('category') for a in acts]
    assert categories.count('act') >= 11
    assert categories.count('regulation') >= 5

def test_portfolio_filtering(repo):
    transport = repo.get_acts(portfolio="transport")
    assert len(transport) >= 12
    commercial = repo.get_acts(portfolio="commercial")
    assert len(commercial) == 2

def test_hvnl_provision_lookup(repo):
    prov = repo.get_provision("heavy-vehicle-national-law", "s26C")
    assert prov is not None
    assert prov['identifier'] == "26C"
    assert "Primary duty" in prov['title']
    assert len(prov['breadcrumbs']) == 2
    assert prov['breadcrumbs'][0]['identifier'] == "Chapter 1A"

def test_regulation_provision_lookup(repo):
    prov = repo.get_provision("heavy-vehicle-general-regulation", "s1")
    assert prov is not None
    assert prov['identifier'] == "1"
    assert "Short title" in prov['title']

def test_cross_db_fts5_search(repo):
    # Search 'duty' should return hits from both acts.db and regs.db
    results = repo.search_provisions("duty", limit=10)
    assert len(results) > 0
    act_slugs = {r['act_slug'] for r in results}
    assert "heavy-vehicle-national-law" in act_slugs
