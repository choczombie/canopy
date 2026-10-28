"""
Lawparts v15 Bridge Engine
===========================
Bridges statutory provisions in acts.db and regs.db with NSW police and RMS
Lawpart penalty notice offence codes, demerit points, fine amounts, and
disqualification penalties from tl_v15.db.
"""

import os
import re
import sqlite3
from typing import List, Dict, Optional, Any
from pathlib import Path

# Mapping of Canopy legal canonical slugs to tl_v15.db act_name values
CANONICAL_ACT_MAP = {
    "road-transport-act-2013": "Road Transport Act 2013",
    "road-rules-2014": "Road Rules 2014",
    "heavy-vehicle-national-law": "Heavy Vehicle National Law (NSW)",
    "road-transport-general-regulation-2021": "Road Transport (General) Regulation 2021",
    "road-transport-driver-licensing-regulation-2017": "Road Transport (Driver Licensing) Regulation 2017",
    "road-transport-vehicle-registration-regulation-2017": "Road Transport (Vehicle Registration) Regulation 2017",
    "roads-act-1993": "Roads Act 1993",
    "roads-regulation-2018": "Roads Regulation 2018",
    "marine-safety-act-1998": "Marine Safety Act 1998",
    "marine-safety-regulation-2016": "Marine Safety Regulation 2016",
    "passenger-transport-act-2014": "Passenger Transport Act 2014",
    "passenger-transport-general-regulation-2017": "Passenger Transport (General) Regulation 2017",
    "point-to-point-transport-act-2016": "Point to Point Transport (Taxis and Hire Vehicles) Act 2016",
    "point-to-point-transport-regulation-2017": "Point to Point Transport (Taxis and Hire Vehicles) Regulation 2017",
    "dangerous-goods-act-2008": "Dangerous Goods (Road and Rail Transport) Act 2008",
    "dangerous-goods-regulation-2022": "Dangerous Goods (Road and Rail Transport) Regulation 2022",
    "motor-dealers-and-repairers-act-2013": "Motor Dealers and Repairers Act 2013",
    "motor-accident-injuries-act-2017": "Motor Accident Injuries Act 2017",
    "driving-instructors-act-1992": "Driving Instructors Act 1992",
    "fines-act-1996": "Fines Act 1996",
    "lepra-2002": "Law Enforcement (Powers and Responsibilities) Act 2002",
    "crimes-act-1900": "Crimes Act 1900",
}


class LawpartBridge:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path: Path = self._discover_latest_db(db_path)
        match = re.search(r'tl_v(\d+)\.db$', str(self.db_path), re.I)
        self.version_num: int = int(match.group(1)) if match else 15
        self.db_version: str = f"v{self.version_num}"
        self.db_name: str = f"JudCom Lawparts {self.db_version}"

    @staticmethod
    def _discover_latest_db(explicit_path: Optional[str] = None) -> Path:
        """
        Discovers the highest numeric version of tl_vXX.db across data/ and parent directories.
        If explicit_path is provided and exists, uses it directly.
        """
        if explicit_path:
            p = Path(explicit_path)
            if p.exists():
                return p

        repo_root = Path(__file__).resolve().parent.parent
        search_dirs = [
            Path("data"),
            repo_root / "data",
            Path("."),
            repo_root,
            repo_root.parent,
        ]

        best_path: Optional[Path] = None
        best_version = -1

        for d in search_dirs:
            if not d.exists() or not d.is_dir():
                continue
            for candidate in d.glob("tl_v*.db"):
                m = re.search(r'tl_v(\d+)\.db$', candidate.name, re.I)
                ver = int(m.group(1)) if m else 0
                if ver > best_version:
                    best_version = ver
                    best_path = candidate

        if best_path:
            return best_path
        return Path(explicit_path or "data/tl_v15.db")

    def _get_connection(self) -> Optional[sqlite3.Connection]:
        if not self.db_path.exists():
            # Re-attempt discovery in case a newer tl_vXX.db was dropped in data/
            self.db_path = self._discover_latest_db()
            if not self.db_path.exists():
                return None
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def get_offences_for_provision(
        self,
        act_slug: str,
        provision_slug_or_num: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieves all Lawpart offence variants linked to a statutory provision.
        
        Args:
            act_slug: Canonical statute slug (e.g. 'road-transport-act-2013')
            provision_slug_or_num: Provision identifier (e.g. 's54', '54', 'rule20', '20')
            
        Returns:
            List of structured offence variant dictionaries.
        """
        conn = self._get_connection()
        if not conn:
            return []

        # Extract numeric base provision (e.g., 's54' -> '54', 'rule20' -> '20', 's54A' -> '54A')
        clean_num = re.sub(r'^(s|sec|rule|cl|clause)\s*', '', provision_slug_or_num, flags=re.I).strip()

        # Resolve act title in tl_v15.db
        act_title = CANONICAL_ACT_MAP.get(act_slug)
        if not act_title:
            # Fallback fuzzy match
            cur = conn.cursor()
            acts = [r[0] for r in cur.execute("SELECT DISTINCT act_name FROM offence_variants").fetchall()]
            slug_words = [w for w in act_slug.replace("-", " ").split() if len(w) > 2]
            for candidate in acts:
                if any(w.lower() in candidate.lower() for w in slug_words):
                    act_title = candidate
                    break

        if not act_title:
            conn.close()
            return []

        query = """
            SELECT 
                ov.lawpart_code,
                ov.act_name,
                ov.section,
                ov.base_section,
                ov.primary_subsection,
                ov.paragraph,
                ov.variant_description,
                ov.max_fine_amount,
                ov.max_fine_unit,
                ov.demerit_points,
                ov.demerit_points_double,
                ov.max_gaol_months,
                ov.disqual_min_months,
                ov.disqual_auto_months,
                ov.disqual_interlock_min_months,
                ov.interlock_min_months,
                ov.lawcodes_url,
                ov.legis_url,
                ov.valid_from,
                ov.valid_to
            FROM offence_variants ov
            WHERE ov.act_name = ? 
              AND (
                  ov.base_section = ? 
                  OR ov.section = ? 
                  OR ov.section LIKE ? 
                  OR ov.section LIKE ?
              )
            ORDER BY ov.base_section, ov.primary_subsection, ov.paragraph, ov.lawpart_code
        """

        like_pattern_parens = f"{clean_num}(%"
        like_pattern_space = f"{clean_num} %"

        with conn:
            cur = conn.cursor()
            rows = cur.execute(
                query,
                (act_title, clean_num, clean_num, like_pattern_parens, like_pattern_space)
            ).fetchall()

            # Gather category mappings for all retrieved lawpart codes
            lawpart_codes = [r["lawpart_code"] for r in rows]
            category_map = {}
            if lawpart_codes:
                placeholders = ",".join("?" for _ in lawpart_codes)
                cat_rows = cur.execute(f"""
                    SELECT m.lawpart_code, c.name
                    FROM offence_category_map m
                    JOIN offence_categories c ON m.category_id = c.id
                    WHERE m.lawpart_code IN ({placeholders})
                """, lawpart_codes).fetchall()
                for cr in cat_rows:
                    category_map.setdefault(cr["lawpart_code"], []).append(cr["name"])

        results = []
        for r in rows:
            lp_code = r["lawpart_code"]
            fine_amt = r["max_fine_amount"]
            fine_unit = r["max_fine_unit"] or "PU"
            calc_dollars = None
            if fine_amt is not None:
                if fine_unit == "PU":
                    calc_dollars = round(fine_amt * 110)
                else:
                    calc_dollars = round(fine_amt)

            clean_desc = (r["variant_description"] or "").replace("\u200b", "").strip()

            results.append({
                "lawpart_code": lp_code,
                "act_name": r["act_name"],
                "section": r["section"],
                "base_section": r["base_section"],
                "primary_subsection": r["primary_subsection"],
                "paragraph": r["paragraph"],
                "variant_description": clean_desc,
                "description": clean_desc,
                "max_fine_amount": fine_amt,
                "fine_amount": fine_amt,
                "max_fine_unit": fine_unit,
                "fine_unit": fine_unit,
                "calculated_fine_dollars": calc_dollars,
                "demerit_points": r["demerit_points"] if r["demerit_points"] is not None else 0,
                "demerit_points_double": r["demerit_points_double"] if r["demerit_points_double"] is not None else 0,
                "max_gaol_months": r["max_gaol_months"],
                "disqual_min_months": r["disqual_min_months"],
                "disqual_auto_months": r["disqual_auto_months"],
                "disqual_interlock_min_months": r["disqual_interlock_min_months"],
                "interlock_min_months": r["interlock_min_months"],
                "lawcodes_url": r["lawcodes_url"],
                "legis_url": r["legis_url"],
                "categories": category_map.get(lp_code, []),
                "valid_from": r["valid_from"],
                "valid_to": r["valid_to"],
            })

        conn.close()
        return results

    def search_lawparts(self, query: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Searches lawpart codes by code number, section reference, or keyword description."""
        conn = self._get_connection()
        if not conn:
            return []

        q = query.strip()
        with conn:
            cur = conn.cursor()
            cols = """
                lawpart_code, act_name, section, variant_description, max_fine_amount, max_fine_unit,
                demerit_points, demerit_points_double, max_gaol_months, disqual_min_months,
                disqual_auto_months, disqual_interlock_min_months, interlock_min_months, lawcodes_url
            """
            if q.isdigit():
                # Direct lawpart code lookup
                rows = cur.execute(f"""
                    SELECT {cols}
                    FROM offence_variants
                    WHERE lawpart_code LIKE ?
                    LIMIT ?
                """, (f"{q}%", limit)).fetchall()
            else:
                # Text / description search
                like_term = f"%{q}%"
                rows = cur.execute(f"""
                    SELECT {cols}
                    FROM offence_variants
                    WHERE variant_description LIKE ? OR section LIKE ?
                    LIMIT ?
                """, (like_term, like_term, limit)).fetchall()

        results = []
        for r in rows:
            clean_desc = (r["variant_description"] or "").replace("\u200b", "").strip()
            fine_amt = r["max_fine_amount"]
            fine_unit = r["max_fine_unit"] or "PU"
            calc_dollars = None
            if fine_amt is not None:
                if fine_unit == "PU":
                    calc_dollars = round(fine_amt * 110)
                else:
                    calc_dollars = round(fine_amt)

            results.append({
                "lawpart_code": r["lawpart_code"],
                "act_name": r["act_name"],
                "section": r["section"],
                "description": clean_desc,
                "variant_description": clean_desc,
                "fine_amount": fine_amt,
                "max_fine_amount": fine_amt,
                "fine_unit": fine_unit,
                "max_fine_unit": fine_unit,
                "calculated_fine_dollars": calc_dollars,
                "demerit_points": r["demerit_points"] or 0,
                "demerit_points_double": r["demerit_points_double"] or 0,
                "max_gaol_months": r["max_gaol_months"],
                "disqual_min_months": r["disqual_min_months"],
                "disqual_auto_months": r["disqual_auto_months"],
                "disqual_interlock_min_months": r["disqual_interlock_min_months"],
                "interlock_min_months": r["interlock_min_months"],
                "lawcodes_url": r["lawcodes_url"]
            })
        conn.close()
        return results
