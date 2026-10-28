"""
Unit tests for Legislation SQLite Repository and FTS5 search.
"""
import os
import pytest
from src.repository import LegislationRepository

@pytest.fixture
def repo():
    db_path = "data/acts.db"
    if not os.path.exists(db_path):
        pytest.skip("acts.db not found. Ingest first.")
    return LegislationRepository(acts_db_path=db_path)

def test_get_acts(repo):
    acts = repo.get_acts()
    assert len(acts) >= 2
    slugs = [a['slug'] for a in acts]
    assert 'competition-and-consumer-act-2010' in slugs
    assert 'australian-consumer-law' in slugs

def test_get_acl_tree(repo):
    tree = repo.get_tree("australian-consumer-law")
    assert len(tree) >= 1
    root = tree[0]
    assert "Schedule 2" in root['identifier']
    assert len(root['children']) >= 5  # Chapters 1..5

def test_get_provision_s18(repo):
    prov = repo.get_provision("australian-consumer-law", "s18")
    assert prov is not None
    assert prov['identifier'] == "18"
    assert "Misleading or deceptive conduct" in prov['title']
    assert len(prov['elements']) >= 2
    assert len(prov['breadcrumbs']) >= 2

def test_fts5_search(repo):
    results = repo.search_provisions("misleading or deceptive", act_slug="australian-consumer-law")
    assert len(results) > 0
    first = results[0]
    assert first['identifier'] == "18"
    assert "<mark>" in first['snippet']
