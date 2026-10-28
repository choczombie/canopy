"""
SQLite Database Repository for Legislation Nodes, Provisions, and FTS5 Search.
Supports modular multi-database architecture (data/acts.db, data/regs.db).
"""
import os
import glob
import re
import json
import sqlite3
from typing import List, Dict, Any, Optional, Tuple
import logging

from .models import CompilationAST, StructuralNode, ProvisionNode, ElementNode

logger = logging.getLogger(__name__)

SOURCE_URLS = {
    "competition-and-consumer-act-2010": "https://www.legislation.gov.au/C2004A00109/latest",
    "australian-consumer-law": "https://www.legislation.gov.au/C2004A00109/latest",
    "heavy-vehicle-national-law": "https://www.legislation.qld.gov.au/view/html/inforce/current/act-2012-hvnlq",
    "heavy-vehicle-general-regulation": "https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2013-0079",
    "heavy-vehicle-mass-dimension-and-loading-regulation": "https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2013-0077",
    "heavy-vehicle-vehicle-standards-regulation": "https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2013-0076",
    "heavy-vehicle-fatigue-management-regulation": "https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2013-0078",
    "marine-safety-dcv-act-2012": "https://www.legislation.gov.au/C2012A00121/latest",
    "road-vehicle-standards-act-2018": "https://www.legislation.gov.au/C2018A00163/latest",
    "navigation-act-2012": "https://www.legislation.gov.au/C2012A00128/latest",
    "air-navigation-act-1920": "https://www.legislation.gov.au/C1920A00050/latest",
    "transport-safety-investigation-act-2003": "https://www.legislation.gov.au/C2004A01102/latest",
    "shipping-registration-act-1981": "https://www.legislation.gov.au/C2004A02386/latest",
    "protection-of-sea-prevention-of-pollution-from-ships-act-1983": "https://www.legislation.gov.au/C2004A02758/latest",
    "superannuation-industry-supervision-act-1993": "https://www.legislation.gov.au/C2004A04633/latest",
    "banking-act-1959": "https://www.legislation.gov.au/C1959A00006/latest",
    "insurance-contracts-act-1984": "https://www.legislation.gov.au/C2004A02944/latest",
    "financial-sector-collection-of-data-act-2001": "https://www.legislation.gov.au/C2004A00871/latest"
}

def enrich_act_metadata(d: Dict[str, Any]) -> Dict[str, Any]:
    slug = d.get('slug', '')
    title = d.get('short_title', '')
    j_id = str(d.get('jurisdiction_id', 'cth')).lower()

    if j_id == 'cth' and not title.endswith('(CTH)'):
        d['short_title'] = f"{title} (CTH)"
    elif j_id in ('qld', 'national') and not ('(QLD)' in title or '(NAT)' in title):
        d['short_title'] = f"{title} (QLD)"
    elif j_id == 'nsw' and not title.endswith('(NSW)'):
        d['short_title'] = f"{title} (NSW)"

    if slug in SOURCE_URLS:
        d['source_url'] = SOURCE_URLS[slug]
    else:
        d['source_url'] = "https://www.legislation.gov.au"
    return d

class LegislationRepository:
    def __init__(
        self,
        acts_db_path: str = "data/acts.db",
        regs_db_path: str = "data/regs.db",
        caselaw_db_path: str = "data/caselaw.db",
        annotations_db_path: str = "data/annotations.db",
        db_path: Optional[str] = None
    ):
        """
        Initializes repository. If db_path is explicitly provided, acts and regs route to it.
        Uses data/caselaw.db for judgments, citations, and data/annotations.db for protected commentary.
        """
        if db_path:
            self.acts_db_path = db_path
            self.regs_db_path = db_path
            self.caselaw_db_path = db_path
            self.annotations_db_path = annotations_db_path
        else:
            self.acts_db_path = acts_db_path
            self.regs_db_path = regs_db_path
            self.caselaw_db_path = caselaw_db_path
            self.annotations_db_path = annotations_db_path

        os.makedirs(os.path.dirname(self.acts_db_path) or ".", exist_ok=True)
        os.makedirs(os.path.dirname(self.regs_db_path) or ".", exist_ok=True)
        os.makedirs(os.path.dirname(self.caselaw_db_path) or ".", exist_ok=True)
        os.makedirs(os.path.dirname(self.annotations_db_path) or ".", exist_ok=True)

        # Only initialize reference DB schemas when creating a new/empty database file
        if not os.path.exists(self.acts_db_path) or os.path.getsize(self.acts_db_path) == 0:
            self.init_db(self.acts_db_path)
        if self.regs_db_path != self.acts_db_path and (
            not os.path.exists(self.regs_db_path) or os.path.getsize(self.regs_db_path) == 0
        ):
            self.init_db(self.regs_db_path)

        from .lawpart_bridge import LawpartBridge
        self.lawpart_bridge = LawpartBridge()
        self.init_annotations_db()

    def get_connection(self, target: str = "acts") -> sqlite3.Connection:
        if target == "regs":
            path = self.regs_db_path
        elif target == "caselaw":
            path = self.caselaw_db_path
        elif target == "annotations":
            path = self.annotations_db_path
        else:
            path = self.acts_db_path
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def get_connection_for_act(self, act_slug: str) -> Tuple[sqlite3.Connection, str]:
        """Finds whether act exists in acts.db or regs.db and returns (conn, target_name)."""
        is_acl = (act_slug in ("australian-consumer-law", "acl"))
        lookup_slug = "competition-and-consumer-act-2010" if is_acl else act_slug

        # Check acts.db first
        with self.get_connection("acts") as conn:
            row = conn.execute("SELECT id FROM acts WHERE slug = ?", (lookup_slug,)).fetchone()
            if row:
                return self.get_connection("acts"), "acts"

        # Check regs.db
        if self.regs_db_path != self.acts_db_path:
            with self.get_connection("regs") as conn:
                row = conn.execute("SELECT id FROM acts WHERE slug = ?", (lookup_slug,)).fetchone()
                if row:
                    return self.get_connection("regs"), "regs"

        return self.get_connection("acts"), "acts"

    def init_db(self, path: str):
        """Creates tables, virtual FTS5 tables, indexes, and applies migrations."""
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        with open(schema_path, "r", encoding="utf-8") as f:
            schema_sql = f.read()

        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(schema_sql)

        # Apply schema migrations for existing databases
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(acts)")
        cols = [col[1] for col in cursor.fetchall()]
        if "category" not in cols:
            cursor.execute("ALTER TABLE acts ADD COLUMN category TEXT NOT NULL DEFAULT 'act'")
        if "portfolio" not in cols:
            cursor.execute("ALTER TABLE acts ADD COLUMN portfolio TEXT NOT NULL DEFAULT 'commercial'")

        # Ensure standard jurisdictions exist
        jurisdictions = [
            ('cth', 'Commonwealth of Australia', 'CTH'),
            ('national', 'National Applied Law Scheme', 'NAT'),
            ('qld', 'Queensland', 'QLD'),
            ('nsw', 'New South Wales', 'NSW'),
            ('vic', 'Victoria', 'VIC')
        ]
        for j_id, j_name, j_code in jurisdictions:
            cursor.execute("""
                INSERT OR IGNORE INTO jurisdictions (id, name, code)
                VALUES (?, ?, ?)
            """, (j_id, j_name, j_code))

        conn.commit()
        conn.close()

    def init_annotations_db(self):
        """Initializes data/annotations.db schema and migrates legacy commentary."""
        schema_path = os.path.join(os.path.dirname(__file__), "annotations_schema.sql")
        if os.path.exists(schema_path):
            with open(schema_path, "r", encoding="utf-8") as f:
                schema_sql = f.read()
            with self.get_connection("annotations") as conn:
                conn.executescript(schema_sql)
                conn.commit()

        # Migrate legacy commentary from caselaw.db if annotations.db commentary is empty
        if os.path.exists(self.caselaw_db_path):
            try:
                with self.get_connection("annotations") as a_conn:
                    count_row = a_conn.execute("SELECT COUNT(*) FROM commentary").fetchone()
                    count = count_row[0] if count_row else 0
                    if count == 0:
                        with self.get_connection("caselaw") as c_conn:
                            # Check if commentary table exists in caselaw.db
                            c_table = c_conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='commentary'").fetchone()
                            if c_table:
                                legacy_rows = c_conn.execute("SELECT * FROM commentary").fetchall()
                                from .citation_lexer import CitationLexer
                                lexer = CitationLexer()
                                for r in legacy_rows:
                                    rd = dict(r)
                                    cid = rd.get("id") or f"comm-{rd.get('target_id')}-legacy"
                                    t_type = rd.get("target_type") or "case"
                                    t_id = rd.get("target_id") or ""
                                    p_start = rd.get("target_paragraph_start")
                                    p_end = rd.get("target_paragraph_end")
                                    tier = rd.get("tier") or "practitioner"
                                    if tier == "tier1_judge": tier = "moderator"
                                    elif tier in ("tier2_editorial", "tier3_user"): tier = "practitioner"
                                    
                                    a_id = rd.get("author_id") or "system"
                                    a_name = rd.get("author_name") or "Editorial Note"
                                    title = rd.get("title") or "Annotation"
                                    body_md = rd.get("body_markdown") or ""
                                    body_html, citations = lexer.compile_html(body_md)

                                    a_conn.execute("""
                                        INSERT OR REPLACE INTO commentary (
                                            id, target_type, target_id, target_paragraph_start, target_paragraph_end,
                                            author_tier, author_id, author_name, title, body_markdown, body_html
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                    """, (cid, t_type, t_id, p_start, p_end, tier, a_id, a_name, title, body_md, body_html))

                                    a_conn.execute("""
                                        INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name)
                                        VALUES (?, ?, ?, ?)
                                    """, (cid, title, body_md, a_name))

                                    for cit in citations:
                                        a_conn.execute("""
                                            INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text)
                                            VALUES (?, ?, ?, ?)
                                        """, (cid, cit["citation_type"], cit["target_id"], cit["raw_text"]))

                                a_conn.commit()
            except Exception as e:
                logger.warning(f"Legacy commentary migration skipped: {e}")

    def save_compilation_ast(self, ast: CompilationAST) -> None:
        """
        Saves a complete CompilationAST into either acts.db or regs.db transactionally.
        """
        target = "regs" if ast.category == "regulation" else "acts"

        with self.get_connection(target) as conn:
            cursor = conn.cursor()

            # 1. Insert Master Act or Regulation
            cursor.execute("""
                INSERT INTO acts (id, jurisdiction_id, slug, short_title, year, act_number, is_virtual, category, portfolio)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(jurisdiction_id, slug) DO UPDATE SET
                    short_title=excluded.short_title,
                    year=excluded.year,
                    act_number=excluded.act_number,
                    category=excluded.category,
                    portfolio=excluded.portfolio
            """, (ast.act_slug, ast.jurisdiction_id, ast.act_slug, ast.act_title, ast.year, ast.act_number, ast.category, ast.portfolio))

            # 2. Insert Virtual Act for ACL if saving CCA
            if ast.act_slug == "competition-and-consumer-act-2010":
                cursor.execute("""
                    INSERT INTO acts (id, jurisdiction_id, slug, short_title, year, act_number, is_virtual, parent_act_id, category, portfolio)
                    VALUES ('australian-consumer-law', 'cth', 'australian-consumer-law', 'Australian Consumer Law (Schedule 2 CCA)', 2010, NULL, 1, ?, 'act', 'commercial')
                    ON CONFLICT(jurisdiction_id, slug) DO UPDATE SET
                        short_title=excluded.short_title,
                        category=excluded.category,
                        portfolio=excluded.portfolio
                """, (ast.act_slug,))

            # 3. Insert Compilation
            cursor.execute("""
                INSERT INTO compilations (id, act_id, compilation_id_frl, compilation_number, start_date, is_in_force)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    compilation_id_frl=excluded.compilation_id_frl,
                    compilation_number=excluded.compilation_number,
                    start_date=excluded.start_date
            """, (ast.compilation_id, ast.act_slug, ast.register_id, ast.compilation_number, ast.start_date))

            # Clean old records for clean idempotent runs
            cursor.execute("""
                DELETE FROM provision_elements 
                WHERE provision_id IN (SELECT id FROM provisions WHERE compilation_id = ?)
            """, (ast.compilation_id,))
            cursor.execute("DELETE FROM provisions WHERE compilation_id = ?", (ast.compilation_id,))
            cursor.execute("DELETE FROM structural_nodes WHERE compilation_id = ?", (ast.compilation_id,))
            cursor.execute("DELETE FROM provisions_fts WHERE act_slug = ?", (ast.act_slug,))

            # 4. Insert Structural Nodes (DFS recursive)
            def insert_node(node: StructuralNode):
                cursor.execute("""
                    INSERT INTO structural_nodes 
                    (id, compilation_id, parent_node_id, node_type, identifier, title, slug, path_hierarchy, order_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    node.id, node.compilation_id, node.parent_node_id, node.node_type,
                    node.identifier, node.title, node.slug, node.path_hierarchy, node.order_index
                ))
                for child in node.children:
                    insert_node(child)

            for root in ast.root_nodes:
                insert_node(root)

            # 5. Insert Provisions & Provision Elements & FTS5
            for prov in ast.all_provisions:
                cursor.execute("""
                    INSERT INTO provisions
                    (id, compilation_id, structural_node_id, provision_type, identifier, title, slug, full_slug, content_html, content_text, order_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    prov.id, prov.compilation_id, prov.structural_node_id, prov.provision_type,
                    prov.identifier, prov.title, prov.slug, prov.full_slug,
                    prov.content_html, prov.content_text, prov.order_index
                ))

                for el in prov.elements:
                    cursor.execute("""
                        INSERT INTO provision_elements
                        (id, provision_id, element_type, identifier, content_text, content_html, order_index)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (
                        el.id, el.provision_id, el.element_type, el.identifier,
                        el.content_text, el.content_html, el.order_index
                    ))

                # Populate FTS5 Virtual Table
                cursor.execute("""
                    INSERT INTO provisions_fts (provision_id, act_slug, full_slug, identifier, title, content_text)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    prov.id, ast.act_slug, prov.full_slug,
                    prov.identifier, prov.title, prov.content_text
                ))

            conn.commit()
            logger.info(f"Successfully saved {len(ast.all_provisions)} provisions and {len(ast.root_nodes)} structural roots into {target}.db.")

    def get_acts(self, portfolio: Optional[str] = None, category: Optional[str] = None) -> List[Dict[str, Any]]:
        """Returns list of available Acts and Regulations across all active databases with provision counts."""
        results = []
        seen_ids = set()

        targets = ["acts"]
        if self.regs_db_path != self.acts_db_path:
            targets.append("regs")

        for t in targets:
            with self.get_connection(t) as conn:
                # Pre-calculate provision counts per act
                count_map = {}
                try:
                    count_rows = conn.execute("""
                        SELECT c.act_id, COUNT(p.id) as prov_count
                        FROM compilations c
                        JOIN provisions p ON p.compilation_id = c.id
                        GROUP BY c.act_id
                    """).fetchall()
                    for cr in count_rows:
                        count_map[cr['act_id']] = cr['prov_count']
                except Exception:
                    pass

                query = "SELECT * FROM acts WHERE 1=1"
                params = []
                if portfolio:
                    query += " AND portfolio = ?"
                    params.append(portfolio)
                if category:
                    query += " AND category = ?"
                    params.append(category)
                query += " ORDER BY is_virtual ASC, short_title ASC"
                rows = conn.execute(query, params).fetchall()
                for r in rows:
                    d = enrich_act_metadata(dict(r))
                    if d['id'] not in seen_ids:
                        seen_ids.add(d['id'])
                        prov_count = count_map.get(d['id'], 0)
                        if d.get('is_virtual') and d.get('slug') in ('australian-consumer-law', 'acl'):
                            prov_count = 280
                        d['provision_count'] = prov_count
                        results.append(d)

        return results

    def get_act_by_slug(self, act_slug: str) -> Optional[Dict[str, Any]]:
        """Fetch act or regulation metadata."""
        conn, _ = self.get_connection_for_act(act_slug)
        with conn:
            row = conn.execute("SELECT * FROM acts WHERE slug = ?", (act_slug,)).fetchone()
            return enrich_act_metadata(dict(row)) if row else None

    def get_tree(self, act_slug: str) -> List[Dict[str, Any]]:
        """Returns hierarchical structural tree for an Act, Virtual Act, or Regulation."""
        is_acl = (act_slug in ("australian-consumer-law", "acl"))
        target_act_slug = "competition-and-consumer-act-2010" if is_acl else act_slug

        conn, _ = self.get_connection_for_act(target_act_slug)
        with conn:
            comp = conn.execute("SELECT id FROM compilations WHERE act_id = ? ORDER BY start_date DESC LIMIT 1", (target_act_slug,)).fetchone()
            if not comp:
                return []
            comp_id = comp['id']

            nodes = conn.execute("""
                SELECT id, parent_node_id, node_type, identifier, title, slug, path_hierarchy, order_index
                FROM structural_nodes
                WHERE compilation_id = ?
                ORDER BY order_index ASC
            """, (comp_id,)).fetchall()

            provisions = conn.execute("""
                SELECT id, structural_node_id, identifier, title, slug, full_slug, order_index
                FROM provisions
                WHERE compilation_id = ?
                ORDER BY order_index ASC
            """, (comp_id,)).fetchall()

        node_map: Dict[str, Dict[str, Any]] = {}
        for n in nodes:
            node_map[n['id']] = {
                **dict(n),
                'children': [],
                'provisions': []
            }

        for p in provisions:
            s_id = p['structural_node_id']
            if s_id in node_map:
                node_map[s_id]['provisions'].append(dict(p))

        roots = []
        for n in nodes:
            node_data = node_map[n['id']]
            p_id = n['parent_node_id']
            if p_id and p_id in node_map:
                node_map[p_id]['children'].append(node_data)
            else:
                roots.append(node_data)

        if is_acl:
            for r in roots:
                if 'schedule-2' in r['slug'].lower():
                    return [r]
            for r in roots:
                for c in r['children']:
                    if 'schedule-2' in c['slug'].lower():
                        return [c]

        return roots

    def get_provision(self, act_slug: str, full_slug: str) -> Optional[Dict[str, Any]]:
        """Retrieves a single provision with elements and breadcrumbs."""
        is_acl = (act_slug in ("australian-consumer-law", "acl"))
        target_act_slug = "competition-and-consumer-act-2010" if is_acl else act_slug

        lookup_slug = full_slug
        if is_acl and not lookup_slug.startswith("schedule-2/"):
            if lookup_slug.startswith("s"):
                lookup_slug = f"schedule-2/{lookup_slug}"
            else:
                lookup_slug = f"schedule-2/s{lookup_slug}"

        # Extract bare section number/slug (e.g. s26C from /s26C or s26C)
        bare_slug = lookup_slug.split('/')[-1]

        conn, _ = self.get_connection_for_act(target_act_slug)
        with conn:
            prov = conn.execute("""
                SELECT p.*, a.short_title as act_title, a.slug as act_slug
                FROM provisions p
                JOIN compilations c ON p.compilation_id = c.id
                JOIN acts a ON c.act_id = a.id
                WHERE a.slug = ? AND (p.full_slug = ? OR p.slug = ? OR p.slug = ? OR p.full_slug LIKE ?)
                ORDER BY CASE WHEN p.full_slug = ? THEN 1 WHEN p.slug = ? THEN 2 ELSE 3 END
                LIMIT 1
            """, (target_act_slug, lookup_slug, lookup_slug, bare_slug, f"%/{bare_slug}", lookup_slug, bare_slug)).fetchone()

            if not prov:
                return None

            prov_dict = dict(prov)

            elements = conn.execute("""
                SELECT * FROM provision_elements
                WHERE provision_id = ?
                ORDER BY order_index ASC
            """, (prov_dict['id'],)).fetchall()
            prov_dict['elements'] = [dict(e) for e in elements]

            node = conn.execute("""
                SELECT id, identifier, title, slug, path_hierarchy, node_type, parent_node_id
                FROM structural_nodes
                WHERE id = ?
            """, (prov_dict['structural_node_id'],)).fetchone()

            breadcrumbs = []
            curr = node
            while curr:
                breadcrumbs.insert(0, dict(curr))
                if curr['parent_node_id']:
                    curr = conn.execute("SELECT id, identifier, title, slug, path_hierarchy, node_type, parent_node_id FROM structural_nodes WHERE id = ?", (curr['parent_node_id'],)).fetchone()
                else:
                    curr = None

            prov_dict['breadcrumbs'] = breadcrumbs
            prov_dict['info'] = self.get_provision_info(prov_dict.get('act_title', ''), prov_dict.get('act_slug', ''), prov_dict.get('identifier', ''))
            return prov_dict

    def get_latest_tl_db_path(self) -> Optional[str]:
        path = self.lawpart_bridge.db_path
        return str(path) if path and path.exists() else None

    def get_provision_info(self, act_title: str, act_slug: str, identifier: str) -> Dict[str, Any]:
        clean_id = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', str(identifier), flags=re.I).strip()
        if not clean_id:
            return {
                "lawparts": [],
                "count": 0,
                "db_name": self.lawpart_bridge.db_name,
                "commentary": [],
                "referenced_by": []
            }

        results = self.lawpart_bridge.get_offences_for_provision(act_slug, clean_id)
        prefix = "r" if ("regulation" in act_slug or "rules" in act_slug) else "s"
        prov_target_id = f"{act_slug}:{prefix}{clean_id}"
        comm_data = self.get_commentary(target_type="provision", target_id=prov_target_id)

        return {
            "lawparts": results,
            "count": len(results),
            "db_name": self.lawpart_bridge.db_name,
            "commentary": comm_data.get("all", []),
            "referenced_by": comm_data.get("referenced_by", [])
        }

    def get_structural_node_content(self, act_slug: str, node_slug_or_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves a structural container with all descendant provisions rendered in sequential order."""
        is_acl = (act_slug in ("australian-consumer-law", "acl"))
        target_act_slug = "competition-and-consumer-act-2010" if is_acl else act_slug

        conn, _ = self.get_connection_for_act(target_act_slug)
        with conn:
            comp = conn.execute("SELECT id FROM compilations WHERE act_id = ? ORDER BY start_date DESC LIMIT 1", (target_act_slug,)).fetchone()
            if not comp:
                return None
            comp_id = comp['id']

            clean_slug = node_slug_or_id.strip('/')
            candidates = [clean_slug]
            if is_acl and not clean_slug.startswith("schedule-2"):
                candidates.insert(0, f"schedule-2/{clean_slug}")

            node = None
            for c in candidates:
                node = conn.execute("""
                    SELECT * FROM structural_nodes
                    WHERE compilation_id = ? AND (id = ? OR slug = ? OR path_hierarchy = ? OR path_hierarchy LIKE ? OR slug LIKE ?)
                    ORDER BY order_index ASC
                    LIMIT 1
                """, (comp_id, c, c, f"/{c}", f"%/{c}", f"%/{c}")).fetchone()
                if node:
                    break

            if not node:
                return None

            node_dict = dict(node)
            path = node_dict['path_hierarchy']

            prov_rows = conn.execute("""
                SELECT p.* FROM provisions p
                JOIN structural_nodes s ON p.structural_node_id = s.id
                WHERE s.compilation_id = ? AND (s.path_hierarchy = ? OR s.path_hierarchy LIKE ?)
                ORDER BY p.order_index ASC
            """, (comp_id, path, f"{path}/%")).fetchall()

            provisions = []
            for pr in prov_rows:
                pd = dict(pr)
                pd['elements'] = []
                provisions.append(pd)

            breadcrumbs = []
            curr = node_dict
            while curr:
                breadcrumbs.insert(0, curr)
                p_id = curr.get('parent_node_id')
                if p_id:
                    parent_row = conn.execute("SELECT * FROM structural_nodes WHERE id = ?", (p_id,)).fetchone()
                    curr = dict(parent_row) if parent_row else None
                else:
                    curr = None

            return {
                "node": node_dict,
                "breadcrumbs": breadcrumbs,
                "provisions": provisions
            }

    def get_provisions_by_node(self, structural_node_id: str) -> List[Dict[str, Any]]:
        """Retrieves all provisions under a specific structural node."""
        with self.get_connection("acts") as conn:
            rows = conn.execute("""
                SELECT * FROM provisions
                WHERE structural_node_id = ?
                ORDER BY order_index ASC
            """, (structural_node_id,)).fetchall()
            if rows:
                return [dict(r) for r in rows]

        if self.regs_db_path != self.acts_db_path:
            with self.get_connection("regs") as conn:
                rows = conn.execute("""
                    SELECT * FROM provisions
                    WHERE structural_node_id = ?
                    ORDER BY order_index ASC
                """, (structural_node_id,)).fetchall()
                return [dict(r) for r in rows]

        return []

    def search_provisions(self, query: str, act_slug: Optional[str] = None, limit: int = 40) -> List[Dict[str, Any]]:
        """Performs full-text search against provisions using SQLite FTS5 with BM25 ranking across Acts and Regs."""
        if not query or not query.strip():
            return []

        clean_q = re.sub(r'[^a-zA-Z0-9\s]', ' ', query).strip()
        if not clean_q:
            return []

        fts_query = " ".join([f'"{w}"*' for w in clean_q.split()])

        if act_slug:
            conn, _ = self.get_connection_for_act(act_slug)
            with conn:
                if act_slug in ('australian-consumer-law', 'acl'):
                    rows = conn.execute("""
                        SELECT fts.provision_id, fts.act_slug, fts.full_slug, fts.identifier, fts.title,
                               snippet(provisions_fts, 5, '<mark>', '</mark>', '...', 25) as snippet,
                               bm25(provisions_fts) as score
                        FROM provisions_fts fts
                        WHERE provisions_fts MATCH ? AND fts.full_slug LIKE 'schedule-2/%'
                        ORDER BY score
                        LIMIT ?
                    """, (fts_query, limit)).fetchall()
                else:
                    rows = conn.execute("""
                        SELECT fts.provision_id, fts.act_slug, fts.full_slug, fts.identifier, fts.title,
                               snippet(provisions_fts, 5, '<mark>', '</mark>', '...', 25) as snippet,
                               bm25(provisions_fts) as score
                        FROM provisions_fts fts
                        WHERE provisions_fts MATCH ? AND fts.act_slug = ?
                        ORDER BY score
                        LIMIT ?
                    """, (fts_query, act_slug, limit)).fetchall()
                return [dict(r) for r in rows]

        # Global search across both acts.db and regs.db
        all_results = []
        targets = ["acts"]
        if self.regs_db_path != self.acts_db_path:
            targets.append("regs")

        for t in targets:
            with self.get_connection(t) as conn:
                rows = conn.execute("""
                    SELECT fts.provision_id, fts.act_slug, fts.full_slug, fts.identifier, fts.title,
                           snippet(provisions_fts, 5, '<mark>', '</mark>', '...', 25) as snippet,
                           bm25(provisions_fts) as score
                    FROM provisions_fts fts
                    WHERE provisions_fts MATCH ?
                    ORDER BY score
                    LIMIT ?
                """, (fts_query, limit)).fetchall()
                all_results.extend([dict(r) for r in rows])

        # Sort by BM25 score (lower is better in FTS5)
        all_results.sort(key=lambda x: x.get('score', 0))
        return all_results[:limit]

    # --- CASELAW & MULTI-TIER COMMENTARY METHODS ---

    def get_cases(self, query: Optional[str] = None, court: Optional[str] = None, limit: int = 2000) -> List[Dict[str, Any]]:
        """Returns list of judgments with optional search query or court filtering."""
        if not os.path.exists(self.caselaw_db_path):
            return []
        with self.get_connection("caselaw") as conn:
            sql = """
                SELECT id, citation, mnc, title, court, jurisdiction, judgment_date, hearing_dates,
                       bench, catchwords, legislation_cited, parties, file_numbers,
                       source_url, nsw_caselaw_url, austlii_url, jade_url
                FROM cases WHERE 1=1
            """
            params = []
            if court:
                sql += " AND court LIKE ?"
                params.append(f"%{court}%")
            if query:
                sql += " AND (title LIKE ? OR citation LIKE ? OR catchwords LIKE ? OR parties LIKE ?)"
                params.extend([f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%"])
            sql += " ORDER BY judgment_date DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def search_cases_full_text(
        self,
        query: str,
        court: Optional[str] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        match_mode: str = "all",
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Searches judicial decisions across both metadata and full-text paragraphs via FTS5 BM25."""
        if not os.path.exists(self.caselaw_db_path) or not query or not query.strip():
            return []

        clean_q = re.sub(r'[^a-zA-Z0-9\s]', ' ', query).strip()
        if not clean_q:
            return []

        results = []
        seen_case_ids = set()

        with self.get_connection("caselaw") as conn:
            # 1. Metadata Matches (Title, Citation, MNC, Catchwords, Parties)
            meta_sql = """
                SELECT id, citation, mnc, title, court, jurisdiction, judgment_date, bench, catchwords,
                       source_url, nsw_caselaw_url, austlii_url, jade_url,
                       catchwords as snippet, NULL as paragraph_number, 0.0 as score
                FROM cases
                WHERE (title LIKE ? OR citation LIKE ? OR mnc LIKE ? OR catchwords LIKE ? OR parties LIKE ?)
            """
            meta_params = [f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%"]
            if court:
                meta_sql += " AND court LIKE ?"
                meta_params.append(f"%{court}%")
            if year_from:
                meta_sql += " AND CAST(substr(judgment_date, 1, 4) AS INT) >= ?"
                meta_params.append(year_from)
            if year_to:
                meta_sql += " AND CAST(substr(judgment_date, 1, 4) AS INT) <= ?"
                meta_params.append(year_to)

            meta_sql += " ORDER BY judgment_date DESC LIMIT ?"
            meta_params.append(limit)

            meta_rows = conn.execute(meta_sql, meta_params).fetchall()
            for r in meta_rows:
                d = dict(r)
                d["match_type"] = "title"
                results.append(d)
                seen_case_ids.add(d["id"])

            # 2. Paragraph Full-Text Search via FTS5
            if match_mode == "exact":
                fts_query = f'"{clean_q}"'
            else:
                fts_query = " ".join([f'"{w}"*' for w in clean_q.split()])

            try:
                fts_sql = """
                    SELECT f.case_id as id, f.paragraph_number,
                           c.citation, c.mnc, c.title, c.court, c.jurisdiction, c.judgment_date, c.bench, c.catchwords,
                           c.source_url, c.nsw_caselaw_url, c.austlii_url, c.jade_url,
                           snippet(case_paragraphs_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
                           bm25(case_paragraphs_fts) as score
                    FROM case_paragraphs_fts f
                    JOIN cases c ON f.case_id = c.id
                    WHERE case_paragraphs_fts MATCH ?
                """
                fts_params = [fts_query]
                if court:
                    fts_sql += " AND c.court LIKE ?"
                    fts_params.append(f"%{court}%")
                if year_from:
                    fts_sql += " AND CAST(substr(c.judgment_date, 1, 4) AS INT) >= ?"
                    fts_params.append(year_from)
                if year_to:
                    fts_sql += " AND CAST(substr(c.judgment_date, 1, 4) AS INT) <= ?"
                    fts_params.append(year_to)

                fts_sql += " ORDER BY score LIMIT ?"
                fts_params.append(limit * 2)

                fts_rows = conn.execute(fts_sql, fts_params).fetchall()
                for r in fts_rows:
                    d = dict(r)
                    if d["id"] not in seen_case_ids:
                        d["match_type"] = "paragraph"
                        results.append(d)
                        seen_case_ids.add(d["id"])
                        if len(results) >= limit:
                            break
            except Exception as e:
                logger.warning(f"Caselaw paragraph FTS error: {e}")

        return results[:limit]

    def search_unified(
        self,
        query: str,
        scope: str = "all",
        court: Optional[str] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        match_mode: str = "all",
        limit: int = 50
    ) -> Dict[str, Any]:
        """Unified search across caselaw, statutory provisions, and statutes."""
        import time
        t0 = time.time()
        
        include_cases = scope in ("all", "caselaw", "nsw-caselaw")
        include_provisions = scope in ("all", "legislation", "nsw-acts", "nsw-regs", "cth-acts", "cth-regs")
        
        cases = []
        if include_cases:
            case_court = court
            if scope == "nsw-caselaw" and not case_court:
                case_court = "NSW"
            cases = self.search_cases_full_text(
                query=query,
                court=case_court,
                year_from=year_from,
                year_to=year_to,
                match_mode=match_mode,
                limit=limit
            )

        provisions = []
        statutes = []
        if include_provisions:
            raw_provs = self.search_provisions(query=query, act_slug=None, limit=limit)
            all_acts = {a["slug"]: a for a in self.get_acts()}
            
            for p in raw_provs:
                act_slug = p.get("act_slug", "")
                act_meta = all_acts.get(act_slug, {})
                j_id = act_meta.get("jurisdiction_id", "").lower()
                cat = act_meta.get("category", "act").lower()
                
                if scope == "nsw-acts" and not (j_id == "nsw" and cat == "act"):
                    continue
                if scope == "nsw-regs" and not (j_id == "nsw" and cat == "regulation"):
                    continue
                if scope == "cth-acts" and not (j_id == "cth" and cat == "act"):
                    continue
                if scope == "cth-regs" and not (j_id == "cth" and cat == "regulation"):
                    continue
                    
                p["act_title"] = act_meta.get("short_title", act_slug.replace("-", " ").title())
                p["jurisdiction_id"] = j_id or ("nsw" if "nsw" in act_slug or "road" in act_slug else "cth")
                provisions.append(p)
                
            q_lower = query.lower()
            for a in self.get_acts():
                t = a.get("short_title", "").lower()
                if q_lower in t or q_lower in a.get("slug", ""):
                    statutes.append(a)

        elapsed = round((time.time() - t0) * 1000, 1)
        return {
            "query": query,
            "scope": scope,
            "total_count": len(cases) + len(provisions) + len(statutes),
            "time_ms": elapsed,
            "counts": {
                "all": len(cases) + len(provisions) + len(statutes),
                "cases": len(cases),
                "provisions": len(provisions),
                "statutes": len(statutes)
            },
            "cases": cases,
            "provisions": provisions[:limit],
            "statutes": statutes[:10]
        }

    def get_cases_citing_provision(self, act_slug: str, section_num: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Retrieves all judicial decisions citing a specific statutory provision."""
        if not os.path.exists(self.caselaw_db_path):
            return []
        import re
        clean_sec = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', section_num, flags=re.I).strip()
        with self.get_connection("caselaw") as conn:
            rows = conn.execute("""
                SELECT c.id, c.citation, c.mnc, c.title, c.court, c.judgment_date, c.bench,
                       c.catchwords, c.source_url, c.nsw_caselaw_url, sc.paragraph_number, sc.raw_citation_text
                FROM case_statute_citations sc
                JOIN cases c ON sc.case_id = c.id
                WHERE sc.target_act_slug = ? AND (sc.target_section = ? OR sc.target_section = ?)
                ORDER BY c.judgment_date DESC
                LIMIT ?
            """, (act_slug, clean_sec, section_num, limit)).fetchall()
            return [dict(r) for r in rows]

    def reconcile_precedents(self):
        """Populates target_case_id in case_precedents by matching MNC and parallel citations."""
        if not os.path.exists(self.caselaw_db_path):
            return
        try:
            with self.get_connection("caselaw") as conn:
                unlinked = conn.execute("SELECT count(*) FROM case_precedents WHERE target_case_id IS NULL AND cited_case_citation IS NOT NULL").fetchone()[0]
                if unlinked > 0:
                    conn.execute("""
                        UPDATE case_precedents
                        SET target_case_id = (
                            SELECT c.id FROM cases c
                            WHERE TRIM(LOWER(c.mnc)) = TRIM(LOWER(case_precedents.cited_case_citation))
                            LIMIT 1
                        )
                        WHERE target_case_id IS NULL AND cited_case_citation IS NOT NULL
                    """)
                    conn.execute("""
                        UPDATE case_precedents
                        SET target_case_id = (
                            SELECT cc.case_id FROM case_citations cc
                            WHERE TRIM(LOWER(cc.citation)) = TRIM(LOWER(case_precedents.cited_case_citation))
                            LIMIT 1
                        )
                        WHERE target_case_id IS NULL AND cited_case_citation IS NOT NULL
                    """)
                    conn.commit()
        except Exception:
            pass

    def get_case_by_slug(self, case_slug: str) -> Optional[Dict[str, Any]]:
        """Retrieves full case details including paragraph blocks, statutory citations, precedents, citing decisions, and commentary."""
        if not os.path.exists(self.caselaw_db_path):
            return None
        with self.get_connection("caselaw") as conn:
            row = conn.execute("SELECT * FROM cases WHERE id = ?", (case_slug,)).fetchone()
            if not row:
                return None
            case_dict = dict(row)
            mnc = case_dict.get("mnc") or ""

            # Retrieve paragraphs with authentic page_number
            p_rows = conn.execute("SELECT paragraph_number, page_number, content_text, content_html FROM case_paragraphs WHERE case_id = ? ORDER BY paragraph_number ASC", (case_slug,)).fetchall()
            case_dict["paragraphs"] = [dict(p) for p in p_rows]

            # 1. Statutory citations (raw)
            c_rows = conn.execute("SELECT paragraph_number, target_act_slug, target_section, raw_citation_text FROM case_statute_citations WHERE case_id = ?", (case_slug,)).fetchall()
            case_dict["statute_citations"] = [dict(c) for c in c_rows]

            # 2. Citing decisions (cases citing this case)
            citing_rows = conn.execute("""
                SELECT cp.case_id, cp.paragraph_number, c.title, c.citation, c.mnc, c.court, c.judgment_date, c.bench
                FROM case_precedents cp
                JOIN cases c ON cp.case_id = c.id
                WHERE cp.target_case_id = ? OR (cp.cited_case_citation IS NOT NULL AND cp.cited_case_citation != '' AND cp.cited_case_citation = ?)
                ORDER BY c.judgment_date DESC
            """, (case_slug, mnc)).fetchall()
            
            citing_map = {}
            for cr in citing_rows:
                cid = cr["case_id"]
                if cid not in citing_map:
                    citing_map[cid] = {
                        "case_id": cid,
                        "title": cr["title"] or cr["citation"],
                        "mnc": cr["mnc"],
                        "court": cr["court"],
                        "judgment_date": cr["judgment_date"],
                        "bench": cr["bench"],
                        "paragraphs": []
                    }
                if cr["paragraph_number"]:
                    citing_map[cid]["paragraphs"].append(cr["paragraph_number"])
            case_dict["citing_cases"] = list(citing_map.values())

            # 3. Precedents cited by this case (deduplicated with paragraph mentions)
            prec_rows = conn.execute("""
                SELECT cp.id, cp.cited_case_title, cp.cited_case_citation, cp.target_case_id, cp.paragraph_number,
                       c.title as target_title, c.mnc as target_mnc, c.court as target_court, c.judgment_date as target_date
                FROM case_precedents cp
                LEFT JOIN cases c ON cp.target_case_id = c.id
                WHERE cp.case_id = ?
                ORDER BY cp.paragraph_number ASC, cp.id ASC
            """, (case_slug,)).fetchall()
            
            precedents_map = {}
            for pr in prec_rows:
                pd = dict(pr)
                cite = (pd.get("cited_case_citation") or "").strip()
                title = (pd.get("cited_case_title") or "").strip()
                key = cite or title
                if not key:
                    continue
                if key not in precedents_map:
                    pd["is_internal"] = bool(pd.get("target_case_id"))
                    pd["paragraphs"] = []
                    if pd.get("paragraph_number"):
                        pd["paragraphs"].append(pd["paragraph_number"])
                    precedents_map[key] = pd
                else:
                    if pd.get("paragraph_number") and pd["paragraph_number"] not in precedents_map[key]["paragraphs"]:
                        precedents_map[key]["paragraphs"].append(pd["paragraph_number"])
                    if pd.get("target_case_id") and not precedents_map[key].get("target_case_id"):
                        precedents_map[key]["target_case_id"] = pd["target_case_id"]
                        precedents_map[key]["is_internal"] = True
                        precedents_map[key]["target_title"] = pd.get("target_title")
                        precedents_map[key]["target_mnc"] = pd.get("target_mnc")
                        precedents_map[key]["target_court"] = pd.get("target_court")
                        precedents_map[key]["target_date"] = pd.get("target_date")

            for key, pdata in precedents_map.items():
                cite = pdata.get("cited_case_citation")
                if cite and len(cite) >= 6:
                    for p in case_dict.get("paragraphs", []):
                        pnum = p.get("paragraph_number")
                        ptext = p.get("content_text", "")
                        if pnum and cite in ptext and pnum not in pdata["paragraphs"]:
                            pdata["paragraphs"].append(pnum)
                pdata["paragraphs"].sort()

            case_dict["precedents_cited"] = list(precedents_map.values())

            # 4. Specific statutory provisions grouped
            all_acts = self.get_acts()
            act_title_map = {a.get("slug"): a.get("short_title") for a in all_acts}

            statute_rows = conn.execute("""
                SELECT target_act_slug, target_section, count(*) as count, GROUP_CONCAT(paragraph_number) as paragraphs
                FROM case_statute_citations
                WHERE case_id = ?
                GROUP BY target_act_slug, target_section
                ORDER BY count DESC
            """, (case_slug,)).fetchall()
            
            statute_provisions = []
            for sr in statute_rows:
                act_slug = sr["target_act_slug"]
                sec = sr["target_section"]
                heading = ""
                # Attempt lookup in repository for heading
                prov = self.get_provision(act_slug, f"s{sec}") or self.get_provision(act_slug, f"r{sec}") or self.get_provision(act_slug, str(sec))
                if prov:
                    heading = prov.get("title", "")
                
                paras = [int(p) for p in (sr["paragraphs"] or "").split(",") if p and p.strip().isdigit()]
                
                act_title = act_title_map.get(act_slug) or (prov.get("act_title") if prov else "")
                if not act_title:
                    act_title = " ".join(w.capitalize() for w in act_slug.split("-"))
                is_ingested = (act_slug in act_title_map) or bool(prov)

                statute_provisions.append({
                    "act_slug": act_slug,
                    "act_title": act_title,
                    "section": sec,
                    "heading": heading,
                    "is_ingested": is_ingested,
                    "count": sr["count"],
                    "paragraphs": sorted(list(set(paras)))
                })
            case_dict["statute_provisions"] = statute_provisions

            # 5. Ingested instruments mentioned in legislation_cited
            raw_leg = case_dict.get("legislation_cited") or ""
            matched_instruments = []
            if raw_leg:
                raw_lower = raw_leg.lower()
                for a in all_acts:
                    st = a.get("short_title", "")
                    if st and st.lower() in raw_lower:
                        matched_instruments.append({
                            "slug": a.get("slug"),
                            "title": st,
                            "category": a.get("category", "act"),
                            "jurisdiction_id": a.get("jurisdiction_id", "nsw")
                        })
            # 5b. Retrieve registered sources (HTML, PDF, DOCX from case_sources)
            s_rows = conn.execute("""
                SELECT source_name, source_url, file_format, local_file_path, file_size_bytes, is_canonical_text
                FROM case_sources WHERE case_id = ? ORDER BY is_canonical_text DESC, id ASC
            """, (case_slug,)).fetchall()
            case_dict["sources"] = [dict(s) for s in s_rows]

            # 6. Retrieve commentary and inbound cross-citation backlinks
            comm_bundle = self.get_commentary(target_type="case", target_id=case_slug)
            case_dict["commentary"] = comm_bundle.get("all", [])
            case_dict["referenced_by"] = comm_bundle.get("referenced_by", [])

            # 7. Coram list and opinions parsing
            opinions_raw = case_dict.get("judge_opinions")
            if opinions_raw and isinstance(opinions_raw, str):
                try:
                    case_dict["judge_opinions"] = json.loads(opinions_raw)
                except Exception:
                    case_dict["judge_opinions"] = []
            elif not opinions_raw:
                case_dict["judge_opinions"] = []

            # 8. Parse structured_pages and confidence_score
            pages_raw = case_dict.get("structured_pages")
            if pages_raw and isinstance(pages_raw, str):
                try:
                    case_dict["structured_pages"] = json.loads(pages_raw)
                except Exception:
                    case_dict["structured_pages"] = []
            elif not pages_raw:
                case_dict["structured_pages"] = []

            conf_raw = case_dict.get("confidence_score")
            if conf_raw and isinstance(conf_raw, str):
                try:
                    case_dict["confidence_score"] = json.loads(conf_raw)
                except Exception:
                    case_dict["confidence_score"] = {}
            elif not conf_raw:
                case_dict["confidence_score"] = {}

            from .coram import parse_coram_bench
            case_dict["coram_list"] = parse_coram_bench(case_dict.get("bench"))
            case_dict["is_incomplete"] = bool(case_dict.get("is_incomplete")) or (len(case_dict.get("paragraphs", [])) <= 2)

            return case_dict

    def get_commentary(
        self,
        target_type: str,
        target_id: str,
        tier: Optional[str] = None,
        paragraph: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Retrieves active commentary records and inbound cross-citations from data/annotations.db.
        Returns grouped dictionary strictly per Rule 5.1:
        { total_count, case_level: [...], paragraph_level: [...], all: [...], referenced_by: [...] }
        """
        if not os.path.exists(self.annotations_db_path):
            return {
                "target_type": target_type,
                "target_id": target_id,
                "total_count": 0,
                "case_level": [],
                "paragraph_level": [],
                "all": [],
                "referenced_by": []
            }

        # Normalize target_id: section-level resolution (e.g. s53(3) -> s53)
        normalized_id = target_id
        if target_type == "provision" and ":" in target_id:
            act_part, sec_part = target_id.split(":", 1)
            from .citation_lexer import extract_base_section
            clean_sec = extract_base_section(sec_part.lstrip("sr"))
            prefix = "r" if ("regulation" in act_part or "rules" in act_part) else "s"
            normalized_id = f"{act_part}:{prefix}{clean_sec}"

        query = """
            SELECT * FROM commentary
            WHERE target_type = ?
              AND (target_id = ? OR target_id = ?)
              AND COALESCE(status, 'active') = 'active'
        """
        params: List[Any] = [target_type, target_id, normalized_id]

        if tier and tier != "all":
            tier_norm = "moderator" if ("1" in tier or "mod" in tier) else ("ai" if "ai" in tier else "practitioner")
            query += " AND author_tier = ?"
            params.append(tier_norm)

        if paragraph:
            query += " AND (target_paragraph_start <= ? AND (target_paragraph_end >= ? OR target_paragraph_end IS NULL))"
            params.extend([paragraph, paragraph])

        query += " ORDER BY CASE WHEN target_paragraph_start IS NULL THEN 0 ELSE 1 END ASC, target_paragraph_start ASC, created_at ASC"

        referenced_by = []
        with self.get_connection("annotations") as conn:
            rows = conn.execute(query, params).fetchall()
            items = [dict(r) for r in rows]

            # Also fetch inbound cross-citation backlinks (notes on other targets that cite this target)
            try:
                backlink_rows = conn.execute("""
                    SELECT DISTINCT c.*, cc.raw_text as cited_as
                    FROM commentary_citations cc
                    JOIN commentary c ON cc.commentary_id = c.id
                    WHERE (cc.cited_target_id = ? OR cc.cited_target_id = ?)
                      AND COALESCE(c.status, 'active') = 'active'
                      AND c.target_id != ? AND c.target_id != ?
                    ORDER BY c.created_at DESC
                """, (target_id, normalized_id, target_id, normalized_id)).fetchall()
                referenced_by = [dict(r) for r in backlink_rows]
            except Exception:
                referenced_by = []

        case_level = [c for c in items if not c.get("target_paragraph_start")]
        paragraph_level = [c for c in items if c.get("target_paragraph_start")]

        return {
            "target_type": target_type,
            "target_id": target_id,
            "total_count": len(items),
            "case_level": case_level,
            "paragraph_level": paragraph_level,
            "all": items,
            "referenced_by": referenced_by
        }

    def get_commentary_by_id(self, comment_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves a single commentary record by ID."""
        if not os.path.exists(self.annotations_db_path):
            return None
        with self.get_connection("annotations") as conn:
            row = conn.execute("SELECT * FROM commentary WHERE id = ?", (comment_id,)).fetchone()
            return dict(row) if row else None

    def add_commentary(
        self,
        target_type: str,
        target_id: str,
        title: str,
        body_markdown: str,
        author_name: str = "Practitioner",
        author_tier: str = "practitioner",
        author_id: str = "user_local",
        author_role: Optional[str] = None,
        target_paragraph_start: Optional[int] = None,
        target_paragraph_end: Optional[int] = None,
        visibility: str = "public",
        current_act_slug: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Creates a new commentary record in data/annotations.db,
        runs CitationLexer to compile rich HTML with paragraph jumps & citations,
        and indexes outbound citations in commentary_citations and commentary_fts.
        """
        import uuid
        comm_id = f"comm-{uuid.uuid4().hex[:12]}"

        # Normalize tier name
        if author_tier.startswith("tier1"):
            author_tier = "moderator"
        elif author_tier.startswith("tier3") or author_tier.startswith("tier2"):
            author_tier = "practitioner"
        elif author_tier.lower() in ("ai", "ai_notation"):
            author_tier = "ai"

        if target_paragraph_start and not target_paragraph_end:
            target_paragraph_end = target_paragraph_start

        # Normalize target_id for provisions (Section-Level Resolution Rule)
        normalized_id = target_id
        if target_type == "provision" and ":" in target_id:
            act_part, sec_part = target_id.split(":", 1)
            from .citation_lexer import extract_base_section
            clean_sec = extract_base_section(sec_part.lstrip("sr"))
            prefix = "r" if ("regulation" in act_part or "rules" in act_part) else "s"
            normalized_id = f"{act_part}:{prefix}{clean_sec}"
            if not current_act_slug:
                current_act_slug = act_part

        from .citation_lexer import CitationLexer
        lexer = CitationLexer()
        body_html, citations = lexer.compile_html(body_markdown, current_act_slug)
        effective_role = author_role or ("AI Notation" if author_tier == "ai" else "Practitioner")

        with self.get_connection("annotations") as conn:
            conn.execute("""
                INSERT INTO commentary (
                    id, target_type, target_id, target_paragraph_start, target_paragraph_end,
                    author_tier, author_id, author_name, author_role, title,
                    body_markdown, body_html, visibility, status, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
            """, (
                comm_id, target_type, normalized_id, target_paragraph_start, target_paragraph_end,
                author_tier, author_id, author_name, effective_role,
                title, body_markdown, body_html, visibility
            ))

            # Populate FTS
            conn.execute("""
                INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name)
                VALUES (?, ?, ?, ?)
            """, (comm_id, title, body_markdown, author_name))

            # Populate citations index
            for cit in citations:
                conn.execute("""
                    INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text)
                    VALUES (?, ?, ?, ?)
                """, (comm_id, cit["citation_type"], cit["target_id"], cit["raw_text"]))

            conn.commit()

        return {
            "id": comm_id,
            "target_type": target_type,
            "target_id": normalized_id,
            "target_paragraph_start": target_paragraph_start,
            "target_paragraph_end": target_paragraph_end,
            "author_tier": author_tier,
            "author_id": author_id,
            "author_name": author_name,
            "author_role": effective_role,
            "title": title,
            "body_markdown": body_markdown,
            "body_html": body_html,
            "version": 1,
            "citations": citations
        }

    def update_commentary(
        self,
        comment_id: str,
        title: str,
        body_markdown: str,
        author_name: Optional[str] = None,
        author_tier: Optional[str] = None,
        author_id: Optional[str] = None,
        author_role: Optional[str] = None,
        target_paragraph_start: Optional[int] = None,
        target_paragraph_end: Optional[int] = None,
        visibility: Optional[str] = None,
        current_act_slug: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Updates an existing commentary record in data/annotations.db,
        re-runs CitationLexer, refreshes commentary_fts and commentary_citations,
        and increments version & updated_at.
        """
        existing = self.get_commentary_by_id(comment_id)
        if not existing or existing.get("status") == "archived":
            return None

        eff_tier = author_tier or existing.get("author_tier") or "practitioner"
        if eff_tier.startswith("tier1"):
            eff_tier = "moderator"
        elif eff_tier.startswith("tier3") or eff_tier.startswith("tier2"):
            eff_tier = "practitioner"
        elif eff_tier.lower() in ("ai", "ai_notation"):
            eff_tier = "ai"

        eff_name = author_name or existing.get("author_name") or "Practitioner"
        eff_author_id = author_id or existing.get("author_id") or "user_local"
        eff_role = author_role if author_role is not None else existing.get("author_role")
        eff_vis = visibility or existing.get("visibility") or "public"

        if target_paragraph_start and not target_paragraph_end:
            target_paragraph_end = target_paragraph_start

        target_id = existing.get("target_id", "")
        if not current_act_slug and existing.get("target_type") == "provision" and ":" in target_id:
            current_act_slug = target_id.split(":", 1)[0]

        from .citation_lexer import CitationLexer
        lexer = CitationLexer()
        body_html, citations = lexer.compile_html(body_markdown, current_act_slug)
        new_version = int(existing.get("version") or 1) + 1

        with self.get_connection("annotations") as conn:
            conn.execute("""
                UPDATE commentary
                SET title = ?,
                    body_markdown = ?,
                    body_html = ?,
                    author_tier = ?,
                    author_id = ?,
                    author_name = ?,
                    author_role = ?,
                    target_paragraph_start = ?,
                    target_paragraph_end = ?,
                    visibility = ?,
                    version = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (
                title, body_markdown, body_html, eff_tier, eff_author_id, eff_name, eff_role,
                target_paragraph_start, target_paragraph_end, eff_vis, new_version, comment_id
            ))

            # Refresh FTS
            conn.execute("DELETE FROM commentary_fts WHERE commentary_id = ?", (comment_id,))
            conn.execute("""
                INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name)
                VALUES (?, ?, ?, ?)
            """, (comment_id, title, body_markdown, eff_name))

            # Refresh outbound citations
            conn.execute("DELETE FROM commentary_citations WHERE commentary_id = ?", (comment_id,))
            for cit in citations:
                conn.execute("""
                    INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text)
                    VALUES (?, ?, ?, ?)
                """, (comment_id, cit["citation_type"], cit["target_id"], cit["raw_text"]))

            conn.commit()

        return {
            "id": comment_id,
            "target_type": existing.get("target_type"),
            "target_id": target_id,
            "target_paragraph_start": target_paragraph_start,
            "target_paragraph_end": target_paragraph_end,
            "author_tier": eff_tier,
            "author_id": eff_author_id,
            "author_name": eff_name,
            "author_role": eff_role,
            "title": title,
            "body_markdown": body_markdown,
            "body_html": body_html,
            "version": new_version,
            "citations": citations
        }

    def delete_commentary(self, comment_id: str, hard: bool = False) -> bool:
        """
        Soft-deletes a commentary entry (status = 'archived') so deletions sync cleanly
        between Cloudflare D1 and local data/annotations.db, while purging FTS and citation rows.
        """
        with self.get_connection("annotations") as conn:
            if hard:
                cur = conn.execute("DELETE FROM commentary WHERE id = ?", (comment_id,))
            else:
                cur = conn.execute("""
                    UPDATE commentary
                    SET status = 'archived',
                        version = COALESCE(version, 1) + 1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND COALESCE(status, 'active') = 'active'
                """, (comment_id,))
            conn.execute("DELETE FROM commentary_fts WHERE commentary_id = ?", (comment_id,))
            conn.execute("DELETE FROM commentary_citations WHERE commentary_id = ?", (comment_id,))
            conn.commit()
            return cur.rowcount > 0

    def search_commentary(self, query: str, limit: int = 15) -> List[Dict[str, Any]]:
        """Full-text search across active commentary notes."""
        if not os.path.exists(self.annotations_db_path) or not query.strip():
            return []
        with self.get_connection("annotations") as conn:
            rows = conn.execute("""
                SELECT c.*
                FROM commentary_fts f
                JOIN commentary c ON f.commentary_id = c.id
                WHERE commentary_fts MATCH ?
                  AND COALESCE(c.status, 'active') = 'active'
                ORDER BY rank
                LIMIT ?
            """, (query, limit)).fetchall()
            return [dict(r) for r in rows]
