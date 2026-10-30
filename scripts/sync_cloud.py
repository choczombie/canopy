"""
Canopy Legal — Cloud Export, D1 Sync, and Annotations Backup CLI
================================================================
Manages the lifecycle between local SQLite databases:
  - data/acts.db (Local Master -> Cloud Static & D1)
  - data/regs.db (Local Master -> Cloud Static & D1)
  - data/caselaw.db (Local Master -> Cloud Static & D1)
  - data/tl_vXX.db (Local Master -> Cloud Static & D1)
  - data/annotations.db (Bidirectional Cloud D1 <-> Local Sync + Versioned Backups)

Usage:
  py scripts/sync_cloud.py backup-annotations   # Save local & SQL backup in backups/annotations/
  py scripts/sync_cloud.py export               # Build ./dist static bundles & D1 SQL files
  py scripts/sync_cloud.py sync-annotations     # Two-way merge between Cloudflare D1 & local annotations.db
  py scripts/sync_cloud.py init-cloud           # Create D1 databases, patch wrangler.jsonc & push schemas
  py scripts/sync_cloud.py deploy               # Export, sync annotations, and deploy to Cloudflare Workers
"""

import os
import sys
import re
import json
import shutil
import sqlite3
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from src.repository import LegislationRepository
from src.lawpart_bridge import LawpartBridge
from src.citation_lexer import CitationLexer

DIST_DIR = ROOT_DIR / "dist"
STATIC_DATA_DIR = DIST_DIR / "static-data"
D1_DIR = DIST_DIR / "d1"
BACKUPS_DIR = ROOT_DIR / "backups" / "annotations"


def sql_literal(val) -> str:
    if val is None:
        return "NULL"
    if isinstance(val, (int, float)):
        return str(val)
    s = str(val).replace("'", "''")
    return f"'{s}'"


def find_npx_cmd() -> str:
    candidates = [
        r"C:\Program Files\nodejs\npx.cmd",
        "npx.cmd",
        "npx"
    ]
    for c in candidates:
        if shutil.which(c) or os.path.exists(c):
            return c
    return "npx"


def run_wrangler(args: list[str], capture: bool = False):
    npx = find_npx_cmd()
    local_wrangler = ROOT_DIR / "node_modules" / ".bin" / "wrangler.cmd"
    lpc_wrangler_dir = Path(r"C:\Users\nicho\AndroidStudioProjects\LPCgo\LPCGoWeb")

    if local_wrangler.exists():
        cmd = [str(local_wrangler)] + args
    elif (lpc_wrangler_dir / "node_modules" / "wrangler").exists():
        cmd = [npx, "--prefix", str(lpc_wrangler_dir), "wrangler"] + args
    else:
        cmd = [npx, "wrangler"] + args

    print(f"-> Running: {' '.join(cmd)}")
    return subprocess.run(
        cmd,
        cwd=str(ROOT_DIR),
        capture_output=capture,
        text=True,
        encoding="utf-8"
    )


def backup_annotations() -> dict:
    """
    Exports all rows from local data/annotations.db to:
      1. backups/annotations/latest_annotations.json (tracked in Git)
      2. backups/annotations/annotations_YYYYMMDD_HHMMSS.json
      3. backups/annotations/annotations_seed.sql (ready for D1 import)
    """
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    repo = LegislationRepository()

    with repo.get_connection("annotations") as conn:
        comm_rows = [dict(r) for r in conn.execute("SELECT * FROM commentary ORDER BY created_at ASC").fetchall()]
        cit_rows = [dict(r) for r in conn.execute("SELECT * FROM commentary_citations ORDER BY id ASC").fetchall()]

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    payload = {
        "exported_at_utc": datetime.now(timezone.utc).isoformat(),
        "total_commentary": len(comm_rows),
        "active_commentary": sum(1 for c in comm_rows if (c.get("status") or "active") == "active"),
        "total_citations": len(cit_rows),
        "commentary": comm_rows,
        "commentary_citations": cit_rows
    }

    latest_json = BACKUPS_DIR / "latest_annotations.json"
    ts_json = BACKUPS_DIR / f"annotations_{ts}.json"
    seed_sql = BACKUPS_DIR / "annotations_seed.sql"

    latest_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    ts_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    # Build idempotent SQL seed file for Cloudflare D1
    schema_sql = (ROOT_DIR / "src" / "annotations_schema.sql").read_text(encoding="utf-8")
    sql_lines = [
        "-- Canopy Legal: Annotations D1 Seed & Sync File",
        schema_sql,
        "DELETE FROM commentary_fts;",
        "DELETE FROM commentary_citations;"
    ]

    for c in comm_rows:
        cols = [
            "id", "target_type", "target_id", "target_paragraph_start", "target_paragraph_end",
            "author_tier", "author_id", "author_name", "author_role", "title",
            "body_markdown", "body_html", "visibility", "status", "version", "created_at", "updated_at"
        ]
        vals = ", ".join(sql_literal(c.get(k)) for k in cols)
        sql_lines.append(f"INSERT OR REPLACE INTO commentary ({', '.join(cols)}) VALUES ({vals});")
        if (c.get("status") or "active") == "active":
            sql_lines.append(
                f"INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name) "
                f"VALUES ({sql_literal(c['id'])}, {sql_literal(c['title'])}, {sql_literal(c['body_markdown'])}, {sql_literal(c['author_name'])});"
            )

    for cit in cit_rows:
        sql_lines.append(
            f"INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text, created_at) "
            f"VALUES ({sql_literal(cit['commentary_id'])}, {sql_literal(cit['citation_type'])}, "
            f"{sql_literal(cit['cited_target_id'])}, {sql_literal(cit['raw_text'])}, {sql_literal(cit.get('created_at'))});"
        )

    seed_sql.write_text("\n".join(sql_lines) + "\n", encoding="utf-8")
    print(f"[OK] Backed up {len(comm_rows)} commentary notes ({payload['active_commentary']} active) to {latest_json} and {seed_sql}")
    return payload


def sync_annotations():
    """
    Performs a two-way merge between Cloudflare D1 (canopy-annotations) and local data/annotations.db.
    1. Pulls remote commentary records from D1.
    2. Compares (id, version, updated_at) against local data/annotations.db.
    3. Merges newer cloud records into local annotations.db.
    4. Pushes newer local records up to Cloudflare D1.
    5. Saves a fresh local backup in backups/annotations/.
    """
    print("=== Step 1: Pre-sync local backup ===")
    backup_annotations()

    print("=== Step 2: Fetching live annotations from Cloudflare D1 (canopy-annotations) ===")
    res = run_wrangler(
        ["d1", "execute", "canopy-annotations", "--remote", "--command", "SELECT * FROM commentary", "--json"],
        capture=True
    )
    if res.returncode != 0:
        print("[WARN] Could not query remote D1 (ensure `npx wrangler login` and `init-cloud` have been run).")
        print(res.stderr or res.stdout)
        return

    try:
        parsed = json.loads(res.stdout)
        remote_rows = parsed[0].get("results", []) if isinstance(parsed, list) and parsed else []
    except Exception as e:
        print(f"[WARN] Could not parse D1 JSON response: {e}")
        return

    repo = LegislationRepository()
    lexer = CitationLexer()

    with repo.get_connection("annotations") as conn:
        local_rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM commentary").fetchall()}

        pulled_count = 0
        for rem in remote_rows:
            cid = rem["id"]
            loc = local_rows.get(cid)
            rem_ver = int(rem.get("version") or 1)
            loc_ver = int(loc.get("version") or 1) if loc else -1
            rem_upd = str(rem.get("updated_at") or "")
            loc_upd = str(loc.get("updated_at") or "") if loc else ""

            if not loc or rem_ver > loc_ver or (rem_ver == loc_ver and rem_upd > loc_upd):
                pulled_count += 1
                act_slug = rem["target_id"].split(":")[0] if (rem.get("target_type") == "provision" and ":" in str(rem.get("target_id"))) else None
                body_html, citations = lexer.compile_html(rem.get("body_markdown") or "", act_slug)
                conn.execute("""
                    INSERT OR REPLACE INTO commentary (
                        id, target_type, target_id, target_paragraph_start, target_paragraph_end,
                        author_tier, author_id, author_name, author_role, title,
                        body_markdown, body_html, visibility, status, version, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    cid, rem.get("target_type"), rem.get("target_id"),
                    rem.get("target_paragraph_start"), rem.get("target_paragraph_end"),
                    rem.get("author_tier"), rem.get("author_id"), rem.get("author_name"),
                    rem.get("author_role"), rem.get("title"), rem.get("body_markdown"),
                    body_html, rem.get("visibility", "public"), rem.get("status", "active"),
                    rem_ver, rem.get("created_at"), rem.get("updated_at")
                ))
                conn.execute("DELETE FROM commentary_fts WHERE commentary_id = ?", (cid,))
                conn.execute("DELETE FROM commentary_citations WHERE commentary_id = ?", (cid,))
                if (rem.get("status") or "active") == "active":
                    conn.execute(
                        "INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name) VALUES (?, ?, ?, ?)",
                        (cid, rem.get("title"), rem.get("body_markdown"), rem.get("author_name"))
                    )
                    for cit in citations:
                        conn.execute(
                            "INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text) VALUES (?, ?, ?, ?)",
                            (cid, cit["citation_type"], cit["target_id"], cit["raw_text"])
                        )
        conn.commit()

    print(f"[OK] Pulled {pulled_count} new/updated annotations from Cloudflare D1 into local data/annotations.db.")

    # Regenerate seed SQL with merged state and push to D1
    backup_annotations()
    seed_sql = BACKUPS_DIR / "annotations_seed.sql"
    print("=== Step 3: Pushing merged annotations state to Cloudflare D1 ===")
    push_res = run_wrangler(["d1", "execute", "canopy-annotations", "--remote", f"--file={seed_sql}"])
    if push_res.returncode == 0:
        print("[OK] Bidirectional annotations sync complete!")


def export_static_and_d1():
    """
    Builds ./dist for Cloudflare Workers deployment:
      1. Copies src/static/* -> dist/static/* and dist/index.html
      2. Exports static JSON bundles in dist/static-data/ (acts, stats, trees, provisions, cases)
      3. Exports D1 SQL files in dist/d1/ (annotations schema, reference FTS & lawparts)
    """
    print("=== Building ./dist for Cloudflare Workers + D1 ===")
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    D1_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy static SPA assets
    src_static = ROOT_DIR / "src" / "static"
    shutil.copytree(src_static, DIST_DIR / "static")
    shutil.copy2(src_static / "index.html", DIST_DIR / "index.html")
    for icon in ("favicon.ico", "favicon-32x32.png", "apple-touch-icon.png"):
        if (src_static / icon).exists():
            shutil.copy2(src_static / icon, DIST_DIR / icon)

    repo = LegislationRepository()
    lawpart_bridge = repo.lawpart_bridge

    # 2. Export acts.json & stats.json
    acts = repo.get_acts()
    (STATIC_DATA_DIR / "acts.json").write_text(json.dumps(acts, ensure_ascii=False), encoding="utf-8")

    acts_count = sum(1 for a in acts if (a.get("category") or "act") == "act")
    regs_count = sum(1 for a in acts if (a.get("category") or "act") == "regulation")
    total_provisions = sum(a.get("provision_count", 0) for a in acts if not a.get("is_virtual"))

    stats_payload = {
        "acts_count": acts_count,
        "regs_count": regs_count,
        "total_statutes": len(acts),
        "total_provisions": total_provisions,
        "portfolios": [
            {
                "id": "transport",
                "name": "Transport & Heavy Vehicle",
                "description": "National Heavy Vehicle Regulator (NHVR) applied law scheme and national regulations.",
                "badge": "National Scheme",
                "acts": [a for a in acts if a.get("portfolio") == "transport"]
            },
            {
                "id": "commercial",
                "name": "Commercial & Consumer",
                "description": "Foundational competition, consumer protection, and statutory trade practices.",
                "badge": "Commonwealth",
                "acts": [a for a in acts if a.get("portfolio") == "commercial"]
            },
            {
                "id": "financial",
                "name": "Financial Services, Superannuation & Banking",
                "description": "Commonwealth prudential statutory regimes governing superannuation entity covenants, banking executive accountability, insurance contract disclosures, and financial data collection.",
                "badge": "Commonwealth",
                "acts": [a for a in acts if a.get("portfolio") == "financial"]
            },
            {
                "id": "justice",
                "name": "Criminal, Sentencing & Administrative Review",
                "description": "Foundational NSW sentencing procedures, administrative decisions review, and judicial review statutes.",
                "badge": "New South Wales",
                "acts": [a for a in acts if a.get("portfolio") == "justice"]
            }
        ]
    }
    (STATIC_DATA_DIR / "stats.json").write_text(json.dumps(stats_payload, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] Exported {len(acts)} statutes metadata and platform stats.")

    # Pre-index citing cases by (act_slug, clean_section) for instant O(1) lookup
    citing_cases_by_prov = {}
    if os.path.exists(repo.caselaw_db_path):
        with repo.get_connection("caselaw") as c_conn:
            cit_rows = c_conn.execute("""
                SELECT sc.target_act_slug, sc.target_section, sc.paragraph_number, sc.raw_citation_text,
                       c.id, c.citation, c.mnc, c.title, c.court, c.judgment_date, c.bench,
                       c.catchwords, c.source_url, c.nsw_caselaw_url
                FROM case_statute_citations sc
                JOIN cases c ON sc.case_id = c.id
                ORDER BY c.judgment_date DESC
            """).fetchall()
            for r in cit_rows:
                rd = dict(r)
                act_s = rd.pop("target_act_slug")
                sec_s = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', str(rd.pop("target_section") or ""), flags=re.I).strip()
                lst = citing_cases_by_prov.setdefault((act_s, sec_s), [])
                if len(lst) < 50:
                    lst.append(rd)

    # 3. Export TOC trees & Act Provision/Node bundles
    trees_dir = STATIC_DATA_DIR / "trees"
    act_provs_dir = STATIC_DATA_DIR / "act-provisions"
    trees_dir.mkdir(parents=True, exist_ok=True)
    act_provs_dir.mkdir(parents=True, exist_ok=True)

    prov_heading_index = {}
    provisions_search_index = []

    for act in acts:
        slug = act["slug"]
        tree = repo.get_tree(slug)
        (trees_dir / f"{slug}.json").write_text(
            json.dumps({"act_slug": slug, "tree": tree}, ensure_ascii=False),
            encoding="utf-8"
        )

        is_acl = slug in ("australian-consumer-law", "acl")
        target_act_slug = "competition-and-consumer-act-2010" if is_acl else slug
        conn, _ = repo.get_connection_for_act(target_act_slug)

        provs_map = {}
        slug_aliases = {}
        nodes_map = {}
        with conn:
            comp = conn.execute(
                "SELECT id FROM compilations WHERE act_id = ? ORDER BY start_date DESC LIMIT 1",
                (target_act_slug,)
            ).fetchone()
            if comp:
                comp_id = comp["id"]
                raw_nodes = [
                    dict(r) for r in conn.execute(
                        "SELECT * FROM structural_nodes WHERE compilation_id = ? ORDER BY order_index ASC",
                        (comp_id,)
                    ).fetchall()
                ]
                node_by_id = {n["id"]: n for n in raw_nodes}

                def build_breadcrumbs(node_id):
                    b = []
                    curr = node_by_id.get(node_id)
                    while curr:
                        b.insert(0, {
                            "id": curr["id"],
                            "identifier": curr["identifier"],
                            "title": curr["title"],
                            "slug": curr["slug"],
                            "path_hierarchy": curr["path_hierarchy"],
                            "node_type": curr["node_type"],
                            "parent_node_id": curr["parent_node_id"]
                        })
                        curr = node_by_id.get(curr["parent_node_id"]) if curr.get("parent_node_id") else None
                    return b

                raw_provs = [
                    dict(r) for r in conn.execute(
                        "SELECT id, compilation_id, structural_node_id, provision_type, identifier, title, slug, full_slug, content_html, order_index FROM provisions WHERE compilation_id = ? ORDER BY order_index ASC",
                        (comp_id,)
                    ).fetchall()
                ]

                for p in raw_provs:
                    if is_acl and not str(p.get("full_slug", "")).startswith("schedule-2/"):
                        continue
                    sec_num = str(p.get("identifier", ""))
                    clean_sec = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', sec_num, flags=re.I).strip()
                    prov_heading_index[(slug, clean_sec)] = p.get("title", "")
                    if not is_acl:
                        provisions_search_index.append({
                            "provision_id": p["id"],
                            "act_slug": slug,
                            "act_title": act.get("short_title", ""),
                            "jurisdiction_id": act.get("jurisdiction_id", "nsw"),
                            "full_slug": p["full_slug"],
                            "identifier": sec_num,
                            "title": p.get("title", "")
                        })

                    offences = lawpart_bridge.get_offences_for_provision(slug, sec_num)
                    citing_cases = citing_cases_by_prov.get((slug, clean_sec), [])

                    p_obj = {
                        **p,
                        "act_title": act.get("short_title", ""),
                        "act_slug": slug,
                        "elements": [],
                        "breadcrumbs": build_breadcrumbs(p["structural_node_id"]),
                        "info": {
                            "lawparts": offences,
                            "count": len(offences),
                            "db_name": lawpart_bridge.db_name,
                            "cases": citing_cases,
                            "cases_count": len(citing_cases),
                            "commentary": [],
                            "referenced_by": []
                        }
                    }
                    f_slug = p["full_slug"]
                    b_slug = p["slug"]
                    provs_map[f_slug] = p_obj
                    if b_slug != f_slug:
                        slug_aliases[b_slug] = f_slug

                # Build structural node bundles using provision_slugs references (no HTML duplication)
                for n in raw_nodes:
                    if is_acl and "schedule-2" not in str(n.get("path_hierarchy", "")):
                        continue
                    path_h = n["path_hierarchy"]
                    desc_slugs = [
                        p["full_slug"]
                        for p in raw_provs
                        if (not is_acl or str(p.get("full_slug", "")).startswith("schedule-2/"))
                        and (
                            node_by_id.get(p["structural_node_id"], {}).get("path_hierarchy", "") == path_h
                            or node_by_id.get(p["structural_node_id"], {}).get("path_hierarchy", "").startswith(f"{path_h}/")
                        )
                    ]
                    n_bundle = {
                        "node": n,
                        "breadcrumbs": build_breadcrumbs(n["id"]),
                        "provision_slugs": desc_slugs
                    }
                    clean_key = n["slug"].strip("/")
                    nodes_map[clean_key] = n_bundle
                    if is_acl and clean_key.startswith("schedule-2/"):
                        nodes_map[clean_key[len("schedule-2/"):]] = n_bundle

        (act_provs_dir / f"{slug}.json").write_text(
            json.dumps({"act_slug": slug, "provisions": provs_map, "slug_aliases": slug_aliases, "nodes": nodes_map}, ensure_ascii=False),
            encoding="utf-8"
        )

    (STATIC_DATA_DIR / "provisions-index.json").write_text(
        json.dumps(provisions_search_index, ensure_ascii=False),
        encoding="utf-8"
    )
    if lawpart_bridge.db_path and os.path.exists(lawpart_bridge.db_path):
        lp_conn = sqlite3.connect(lawpart_bridge.db_path)
        lp_conn.row_factory = sqlite3.Row
        with lp_conn:
            lp_rows = [
                dict(r) for r in lp_conn.execute(
                    "SELECT lawpart_code, act_name, section, variant_description, max_fine_amount, max_fine_unit, max_gaol_months FROM offence_variants"
                ).fetchall()
            ]
        lp_conn.close()
        (STATIC_DATA_DIR / "lawparts-index.json").write_text(
            json.dumps(lp_rows, ensure_ascii=False),
            encoding="utf-8"
        )
    print(f"[OK] Exported {len(acts)} TOC trees, compact provision bundles, and static search indexes.")

    # 4. Bulk Export Caselaw list & individual Case JSON files
    cases_list = repo.get_cases(limit=5000)
    (STATIC_DATA_DIR / "cases-list.json").write_text(json.dumps(cases_list, ensure_ascii=False), encoding="utf-8")

    cases_dir = STATIC_DATA_DIR / "cases"
    cases_dir.mkdir(parents=True, exist_ok=True)

    if os.path.exists(repo.caselaw_db_path):
        from src.coram import parse_coram_bench
        act_title_map = {a.get("slug"): a.get("short_title") for a in acts}

        with repo.get_connection("caselaw") as c_conn:
            all_cases = {r["id"]: dict(r) for r in c_conn.execute("SELECT * FROM cases").fetchall()}

            paras_by_case = {}
            for r in c_conn.execute("SELECT case_id, paragraph_number, page_number, content_html FROM case_paragraphs ORDER BY case_id, paragraph_number ASC"):
                paras_by_case.setdefault(r["case_id"], []).append({
                    "paragraph_number": r["paragraph_number"],
                    "page_number": r["page_number"],
                    "content_html": r["content_html"]
                })

            stat_cites_by_case = {}
            for r in c_conn.execute("SELECT case_id, paragraph_number, target_act_slug, target_section, raw_citation_text FROM case_statute_citations"):
                stat_cites_by_case.setdefault(r["case_id"], []).append({
                    "paragraph_number": r["paragraph_number"],
                    "target_act_slug": r["target_act_slug"],
                    "target_section": r["target_section"],
                    "raw_citation_text": r["raw_citation_text"]
                })

            sources_by_case = {}
            for r in c_conn.execute("SELECT case_id, source_name, source_url, file_format, local_file_path, file_size_bytes, is_canonical_text FROM case_sources ORDER BY is_canonical_text DESC, id ASC"):
                sources_by_case.setdefault(r["case_id"], []).append({
                    "source_name": r["source_name"],
                    "source_url": r["source_url"],
                    "file_format": r["file_format"],
                    "local_file_path": r["local_file_path"],
                    "file_size_bytes": r["file_size_bytes"],
                    "is_canonical_text": r["is_canonical_text"]
                })

            prec_by_case = {}
            citing_by_target = {}
            for r in c_conn.execute("""
                SELECT cp.id, cp.case_id, cp.cited_case_title, cp.cited_case_citation, cp.target_case_id, cp.paragraph_number,
                       c.title as target_title, c.mnc as target_mnc, c.court as target_court, c.judgment_date as target_date
                FROM case_precedents cp
                LEFT JOIN cases c ON cp.target_case_id = c.id
                ORDER BY cp.paragraph_number ASC, cp.id ASC
            """):
                rd = dict(r)
                prec_by_case.setdefault(rd["case_id"], []).append(rd)
                if rd.get("target_case_id"):
                    citing_by_target.setdefault(rd["target_case_id"], []).append(rd)

            for c_slug, case_dict in all_cases.items():
                case_dict["paragraphs"] = paras_by_case.get(c_slug, [])
                case_dict["statute_citations"] = stat_cites_by_case.get(c_slug, [])
                case_dict["sources"] = sources_by_case.get(c_slug, [])

                # Citing decisions
                citing_map = {}
                for cr in citing_by_target.get(c_slug, []):
                    src_id = cr["case_id"]
                    src_case = all_cases.get(src_id)
                    if not src_case:
                        continue
                    if src_id not in citing_map:
                        citing_map[src_id] = {
                            "case_id": src_id,
                            "title": src_case.get("title") or src_case.get("citation"),
                            "mnc": src_case.get("mnc"),
                            "court": src_case.get("court"),
                            "judgment_date": src_case.get("judgment_date"),
                            "bench": src_case.get("bench"),
                            "paragraphs": []
                        }
                    if cr.get("paragraph_number"):
                        citing_map[src_id]["paragraphs"].append(cr["paragraph_number"])
                case_dict["citing_cases"] = list(citing_map.values())

                # Precedents cited
                prec_map = {}
                for pr in prec_by_case.get(c_slug, []):
                    cite = (pr.get("cited_case_citation") or "").strip()
                    title = (pr.get("cited_case_title") or "").strip()
                    key = cite or title
                    if not key:
                        continue
                    if key not in prec_map:
                        pr_copy = {k: v for k, v in pr.items() if k != "case_id"}
                        pr_copy["is_internal"] = bool(pr.get("target_case_id"))
                        pr_copy["paragraphs"] = [pr["paragraph_number"]] if pr.get("paragraph_number") else []
                        prec_map[key] = pr_copy
                    else:
                        if pr.get("paragraph_number") and pr["paragraph_number"] not in prec_map[key]["paragraphs"]:
                            prec_map[key]["paragraphs"].append(pr["paragraph_number"])
                case_dict["precedents_cited"] = list(prec_map.values())

                # Grouped statutory provisions
                grouped_stat = {}
                for sc in case_dict["statute_citations"]:
                    k = (sc["target_act_slug"], sc["target_section"])
                    g = grouped_stat.setdefault(k, {"count": 0, "paras": set()})
                    g["count"] += 1
                    if sc.get("paragraph_number") and str(sc["paragraph_number"]).isdigit():
                        g["paras"].add(int(sc["paragraph_number"]))

                statute_provisions = []
                for (a_slug, sec), g in sorted(grouped_stat.items(), key=lambda x: x[1]["count"], reverse=True):
                    clean_s = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', str(sec or ""), flags=re.I).strip()
                    heading = prov_heading_index.get((a_slug, clean_s), "")
                    a_title = act_title_map.get(a_slug) or " ".join(w.capitalize() for w in str(a_slug).split("-"))
                    statute_provisions.append({
                        "act_slug": a_slug,
                        "act_title": a_title,
                        "section": sec,
                        "heading": heading,
                        "is_ingested": (a_slug in act_title_map) or bool(heading),
                        "count": g["count"],
                        "paragraphs": sorted(list(g["paras"]))
                    })
                case_dict["statute_provisions"] = statute_provisions
                case_dict["commentary"] = []
                case_dict["referenced_by"] = []

                for json_field, default_val in [("judge_opinions", []), ("structured_pages", []), ("confidence_score", {})]:
                    raw_val = case_dict.get(json_field)
                    if raw_val and isinstance(raw_val, str):
                        try:
                            case_dict[json_field] = json.loads(raw_val)
                        except Exception:
                            case_dict[json_field] = default_val
                    elif not raw_val:
                        case_dict[json_field] = default_val

                case_dict["coram_list"] = parse_coram_bench(case_dict.get("bench"))
                case_dict["is_incomplete"] = bool(case_dict.get("is_incomplete")) or (len(case_dict["paragraphs"]) <= 2)

                (cases_dir / f"{c_slug}.json").write_text(json.dumps(case_dict, ensure_ascii=False), encoding="utf-8")

    print(f"[OK] Exported {len(cases_list)} full judicial decisions to {cases_dir}.")

    # 5. Export D1 SQL files (annotations & reference lawparts/FTS)
    backup_annotations()
    shutil.copy2(BACKUPS_DIR / "annotations_seed.sql", D1_DIR / "annotations_seed.sql")

    ref_schema_lines = [
        "-- Canopy Legal: Reference D1 Schema (Lawparts & Search)",
        """CREATE TABLE IF NOT EXISTS offence_variants (
            lawpart_code TEXT PRIMARY KEY,
            act_name TEXT,
            section TEXT,
            base_section TEXT,
            primary_subsection TEXT,
            paragraph TEXT,
            variant_description TEXT,
            max_fine_amount REAL,
            max_fine_unit TEXT,
            demerit_points INTEGER,
            demerit_points_double INTEGER,
            max_gaol_months INTEGER,
            disqual_min_months INTEGER,
            disqual_auto_months INTEGER,
            disqual_interlock_min_months INTEGER,
            interlock_min_months INTEGER,
            lawcodes_url TEXT,
            legis_url TEXT,
            valid_from TEXT,
            valid_to TEXT
        );""",
        "CREATE INDEX IF NOT EXISTS idx_ov_act_sec ON offence_variants(act_name, base_section);",
        """CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
            provision_id UNINDEXED,
            act_slug UNINDEXED,
            full_slug UNINDEXED,
            identifier,
            title,
            content_text,
            tokenize = 'porter unicode61'
        );"""
    ]
    (D1_DIR / "reference_schema.sql").write_text("\n".join(ref_schema_lines) + "\n", encoding="utf-8")
    print("[OK] Export complete! ./dist is ready for Cloudflare Workers deployment.")


def init_cloud():
    """Creates D1 databases in Cloudflare if needed, updates wrangler.jsonc, and initializes remote schemas."""
    wrangler_path = ROOT_DIR / "wrangler.jsonc"
    content = wrangler_path.read_text(encoding="utf-8")

    for db_name, placeholder in [
        ("canopy-annotations", "REPLACE_WITH_D1_ANNOTATIONS_ID"),
        ("canopy-reference", "REPLACE_WITH_D1_REFERENCE_ID")
    ]:
        if placeholder in content:
            print(f"=== Creating / Looking up D1 Database: {db_name} ===")
            res = run_wrangler(["d1", "create", db_name], capture=True)
            out = (res.stdout or "") + "\n" + (res.stderr or "")
            m = re.search(r'database_id\s*[=:]\s*"?([0-9a-fA-F-]{36})"?', out)
            if not m:
                # Database may already exist; list databases
                list_res = run_wrangler(["d1", "list", "--json"], capture=True)
                try:
                    dbs = json.loads(list_res.stdout)
                    for d in dbs:
                        if d.get("name") == db_name:
                            db_id = d.get("uuid")
                            content = content.replace(placeholder, db_id)
                            break
                except Exception:
                    pass
            else:
                db_id = m.group(1)
                content = content.replace(placeholder, db_id)

    wrangler_path.write_text(content, encoding="utf-8")
    backup_annotations()
    seed_sql = BACKUPS_DIR / "annotations_seed.sql"
    run_wrangler(["d1", "execute", "canopy-annotations", "--remote", f"--file={seed_sql}"])


def main():
    parser = argparse.ArgumentParser(description="Canopy Legal Cloud Sync & Deployment CLI")
    parser.add_argument(
        "action",
        choices=["backup-annotations", "sync-annotations", "export", "init-cloud", "deploy"],
        help="Action to perform"
    )
    args = parser.parse_args()

    if args.action == "backup-annotations":
        backup_annotations()
    elif args.action == "sync-annotations":
        sync_annotations()
    elif args.action == "export":
        export_static_and_d1()
    elif args.action == "init-cloud":
        init_cloud()
    elif args.action == "deploy":
        backup_annotations()
        export_static_and_d1()
        run_wrangler(["deploy"])


if __name__ == "__main__":
    main()

