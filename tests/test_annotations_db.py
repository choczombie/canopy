"""
Unit tests for data/annotations.db protected store, commentary operations,
Rule 5.1 ordering, and automated citation linking.
"""
import pytest
from src.repository import LegislationRepository

@pytest.fixture
def repo(tmp_path):
    ann_db = str(tmp_path / "test_annotations.db")
    case_db = str(tmp_path / "test_caselaw.db")
    acts_db = str(tmp_path / "test_acts.db")
    return LegislationRepository(
        acts_db_path=acts_db,
        regs_db_path=acts_db,
        caselaw_db_path=case_db,
        annotations_db_path=ann_db
    )

def test_commentary_lifecycle_and_ordering(repo):
    # 1. Add paragraph-level note for [45]
    c_p45 = repo.add_commentary(
        target_type="case",
        target_id="2014-nswca-161",
        title="Ratio Decidendi on Disturbance",
        body_markdown="In [45], the Court affirmed that RTA s 53 does not permit offset.",
        author_name="Counsel A",
        author_tier="practitioner",
        target_paragraph_start=45
    )
    assert c_p45["id"].startswith("comm-")
    assert "para-jump-link" in c_p45["body_html"]
    assert "road-transport-act-2013/s53" in c_p45["body_html"]

    # 2. Add case-level note
    c_case = repo.add_commentary(
        target_type="case",
        target_id="2014-nswca-161",
        title="Appellate Summary",
        body_markdown="Lead decision regarding valuation principles under RTA s 54.",
        author_name="Editorial Board",
        author_tier="moderator",
        target_paragraph_start=None
    )

    # 3. Add earlier paragraph-level note for [12]
    c_p12 = repo.add_commentary(
        target_type="case",
        target_id="2014-nswca-161",
        title="Evidentiary Ruling",
        body_markdown="In [12], admissibility of survey maps was upheld.",
        author_name="Counsel B",
        author_tier="practitioner",
        target_paragraph_start=12
    )

    # 4. Fetch commentary for 2014-nswca-161
    res = repo.get_commentary(target_type="case", target_id="2014-nswca-161")
    assert res["total_count"] == 3

    # Rule 5.1.1: Case-level commentary MUST be listed first
    assert len(res["case_level"]) == 1
    assert res["case_level"][0]["title"] == "Appellate Summary"

    # Rule 5.1.2: Paragraph-level commentary strictly sorted by target_paragraph_start ASC
    assert len(res["paragraph_level"]) == 2
    assert res["paragraph_level"][0]["target_paragraph_start"] == 12
    assert res["paragraph_level"][1]["target_paragraph_start"] == 45

    # 5. Test tier filtering
    mod_res = repo.get_commentary(target_type="case", target_id="2014-nswca-161", tier="moderator")
    assert mod_res["total_count"] == 1
    assert mod_res["all"][0]["author_tier"] == "moderator"

    # 6. Test cross-citation inbound backlink (referenced_by)
    # c_p45 on 2014-nswca-161 cited 'RTA s 53' -> road-transport-act-2013:s53
    s53_comm = repo.get_commentary(target_type="provision", target_id="road-transport-act-2013:s53")
    assert len(s53_comm["referenced_by"]) == 1
    assert s53_comm["referenced_by"][0]["id"] == c_p45["id"]
    assert s53_comm["referenced_by"][0]["target_id"] == "2014-nswca-161"

    # 7. Test editing commentary (update_commentary) & re-indexing citations
    updated = repo.update_commentary(
        comment_id=c_p45["id"],
        title="Updated Ratio on Disturbance & Licensing",
        body_markdown="In [45]-[47], the Court linked RTA s 55 and [2021] NSWSC 97.",
        author_name="Counsel A (Edited)",
        author_tier="moderator",
        author_id="cf:user-123",
        target_paragraph_start=45,
        target_paragraph_end=47
    )
    assert updated is not None
    assert updated["version"] == 2
    assert updated["author_id"] == "cf:user-123"
    assert updated["target_paragraph_end"] == 47
    assert "road-transport-act-2013/s55" in updated["body_html"]

    # Old citation to s 53 should be replaced by s 55 and 2021-nswsc-97
    s53_after_edit = repo.get_commentary(target_type="provision", target_id="road-transport-act-2013:s53")
    assert len(s53_after_edit["referenced_by"]) == 0
    s55_after_edit = repo.get_commentary(target_type="provision", target_id="road-transport-act-2013:s55")
    assert len(s55_after_edit["referenced_by"]) == 1
    assert s55_after_edit["referenced_by"][0]["title"] == "Updated Ratio on Disturbance & Licensing"

    # 8. Test soft-delete (preserves tombstone for sync, removes from active & backlinks)
    assert repo.delete_commentary(c_p12["id"]) is True
    res_after = repo.get_commentary(target_type="case", target_id="2014-nswca-161")
    assert res_after["total_count"] == 2
    tombstone = repo.get_commentary_by_id(c_p12["id"])
    assert tombstone is not None
    assert tombstone["status"] == "archived"
