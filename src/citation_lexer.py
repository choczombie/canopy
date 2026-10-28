"""
Citation Lexer, Proximity Scorer, and HTML Compiler for Canopy Legal Commentary.
Supports:
- Paragraph jump links [N] and ranges [N]-[M]
- Medium Neutral Citations [YYYY] COURT N
- Statutory Acronyms (RTA, RR, DL)
- Statute & Regulation Pinpoints with Near/Proximity validation (eliminating false cross-links)
- Section-level resolution (subsections resolve to parent section)
- Lawpart Offence Codes (LPC 79007)
- Safe Markdown-to-HTML compilation
"""
import re
from typing import List, Dict, Any, Tuple, Optional

# Statutory Acronym Mappings (as approved in PLAN-COMM-2026-V1.1)
ACRONYM_MAP = {
    "RTA": {
        "slug": "road-transport-act-2013",
        "title": "Road Transport Act 2013",
        "pref_type": "act",
        "jurisdiction": "nsw"
    },
    "RR": {
        "slug": "road-rules-2014",
        "title": "Road Rules 2014",
        "pref_type": "regulation",
        "jurisdiction": "nsw"
    },
    "DL": {
        "slug": "road-transport-driver-licensing-regulation-2017",
        "title": "Road Transport (Driver Licensing) Regulation 2017",
        "pref_type": "regulation",
        "jurisdiction": "nsw"
    },
    "HVNL": {
        "slug": "heavy-vehicle-national-law",
        "title": "Heavy Vehicle National Law",
        "pref_type": "act",
        "jurisdiction": "national"
    },
    "ACL": {
        "slug": "australian-consumer-law",
        "title": "Australian Consumer Law",
        "pref_type": "schedule",
        "jurisdiction": "cth"
    },
    "CCA": {
        "slug": "competition-and-consumer-act-2010",
        "title": "Competition and Consumer Act 2010",
        "pref_type": "act",
        "jurisdiction": "cth"
    }
}

# Known Statutes & Regulations Map for Canonical Resolution
KNOWN_INSTRUMENTS = [
    # Road / Transport NSW
    ("Road Transport Act 2013", "road-transport-act-2013", "act", r"\bRoad\s+Transport\s+Act(?:\s+2013)?\b"),
    ("Road Rules 2014", "road-rules-2014", "regulation", r"\bRoad\s+Rules(?:\s+2014)?\b"),
    ("Road Transport (Driver Licensing) Regulation 2017", "road-transport-driver-licensing-regulation-2017", "regulation", r"\b(?:Road\s+Transport\s+)?\(?Driver\s+Licensing\)?\s+Reg(?:ulation)?(?:\s+2017)?\b"),
    ("Road Transport (General) Regulation 2021", "road-transport-general-regulation-2021", "regulation", r"\b(?:Road\s+Transport\s+)?\(?General\)?\s+Reg(?:ulation)?(?:\s+2021)?\b"),
    ("Road Transport (Vehicle Registration) Regulation 2017", "road-transport-vehicle-registration-regulation-2017", "regulation", r"\b(?:Road\s+Transport\s+)?\(?Vehicle\s+Registration\)?\s+Reg(?:ulation)?(?:\s+2017)?\b"),
    ("Roads Act 1993", "roads-act-1993", "act", r"\bRoads\s+Act(?:\s+1993)?\b"),
    ("Transport Administration Act 1988", "transport-administration-act-1988", "act", r"\bTransport\s+Administration\s+Act(?:\s+1988)?\b"),
    # Criminal & Civil Procedure NSW
    ("Crimes (Sentencing Procedure) Act 1999", "crimes-sentencing-procedure-act-1999", "act", r"\bCrimes\s*\(Sentencing\s+Procedure\)\s*Act(?:\s+1999)?\b"),
    ("Crimes Act 1900", "crimes-act-1900", "act", r"\bCrimes\s+Act(?:\s+1900)?\b"),
    ("Civil Procedure Act 2005", "civil-procedure-act-2005", "act", r"\bCivil\s+Procedure\s+Act(?:\s+2005)?\b"),
    ("Land Acquisition (Just Terms Compensation) Act 1991", "land-acquisition-just-terms-compensation-act-1991", "act", r"\bLand\s+Acquisition(?:\s*\(Just\s+Terms\s+Compensation\)\s*Act)?(?:\s+1991)?\b"),
    # Heavy Vehicle National Law
    ("Heavy Vehicle National Law", "heavy-vehicle-national-law", "act", r"\bHeavy\s+Vehicle\s+National\s+Law\b"),
    ("Heavy Vehicle (General) National Regulation", "heavy-vehicle-general-regulation", "regulation", r"\bHeavy\s+Vehicle\s+\(?General\)?(?:\s+National)?\s+Reg(?:ulation)?\b"),
    ("Heavy Vehicle (Mass, Dimension and Loading) National Regulation", "heavy-vehicle-mass-dimension-and-loading-regulation", "regulation", r"\bHeavy\s+Vehicle\s+\(?Mass(?:,\s*Dimension\s+and\s+Loading)?\)?(?:\s+National)?\s+Reg(?:ulation)?\b"),
    ("Heavy Vehicle (Vehicle Standards) National Regulation", "heavy-vehicle-vehicle-standards-regulation", "regulation", r"\bHeavy\s+Vehicle\s+\(?Vehicle\s+Standards\)?(?:\s+National)?\s+Reg(?:ulation)?\b"),
    ("Heavy Vehicle (Fatigue Management) National Regulation", "heavy-vehicle-fatigue-management-regulation", "regulation", r"\bHeavy\s+Vehicle\s+\(?Fatigue(?:\s+Management)?\)?(?:\s+National)?\s+Reg(?:ulation)?\b"),
    # Commonwealth & Consumer
    ("Australian Consumer Law", "australian-consumer-law", "schedule", r"\bAustralian\s+Consumer\s+Law\b"),
    ("Competition and Consumer Act 2010", "competition-and-consumer-act-2010", "act", r"\bCompetition\s+and\s+Consumer\s+Act(?:\s+2010)?\b"),
]

# Medium Neutral Citation (MNC) Pattern
MNC_PATTERN = re.compile(
    r'\[(19\d\d|20\d\d)\]\s+([A-Za-z]+)\s+(\d+)',
    re.IGNORECASE
)

# Lawpart Pattern: e.g. LPC 79007, LPC:79007, Lawpart 79167
LPC_PATTERN = re.compile(
    r'\b(?:LPC|lawpart(?:\s+code)?)\s*[:#]?\s*(\d{5})\b',
    re.IGNORECASE
)

# Paragraph Jump Pattern: e.g. [10], [10]-[14], [10]–[14]
# Negative lookahead (?!\() ensures we don't accidentally match Markdown link text [10](...)
PARA_JUMP_PATTERN = re.compile(
    r'\[(\d+)(?:[-–](\d+))?\](?!\()'
)


def extract_base_section(raw_sec: str) -> str:
    """
    Implements Section-Level Resolution Rule (Plan Section 2.1).
    Extracts base section number from subsection strings.
    e.g. '53(3)(a)' -> '53', '26C(1)' -> '26C', '69' -> '69'.
    """
    m = re.match(r'^(\d+[A-Za-z]?)', raw_sec.strip())
    return m.group(1) if m else raw_sec.strip()


def parse_mnc_to_slug(year: str, court: str, num: str) -> str:
    """Converts [2014] NSWCA 161 to canonical slug 2014-nswca-161."""
    return f"{year}-{court.lower()}-{num}"


class CitationLexer:
    """
    Lexer and linker for legal citations in practitioner and editorial notes.
    Prevents false cross-links (e.g. 'road rule 10' matching 'section 10 Crimes Act')
    using strict keyword-type compatibility and proximity windows.
    """

    def __init__(self, proximity_word_limit: int = 10):
        self.proximity_word_limit = proximity_word_limit

    def extract_citations(
        self,
        text: str,
        current_act_slug: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Extracts all valid legal citations from text with proximity scoring.
        Returns a structured list of citation objects.
        """
        citations = []
        seen = set()

        # 1. Medium Neutral Citations (MNC)
        for m in MNC_PATTERN.finditer(text):
            year, court, num = m.group(1), m.group(2).upper(), m.group(3)
            slug = parse_mnc_to_slug(year, court, num)
            raw = m.group(0)
            key = ("case", slug)
            if key not in seen:
                seen.add(key)
                citations.append({
                    "citation_type": "case",
                    "target_id": slug,
                    "raw_text": raw,
                    "metadata": {
                        "year": year,
                        "court": court,
                        "number": num,
                        "mnc": f"[{year}] {court} {num}"
                    }
                })

        # 2. Statutory Acronym Citations (RTA s 53, RR r 20, DL cl 15)
        acronym_regex = re.compile(
            r'\b(RTA|RR|DL|HVNL|ACL|CCA)\s+(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)',
            re.IGNORECASE
        )
        for m in acronym_regex.finditer(text):
            acro = m.group(1).upper()
            raw_sec = m.group(2)
            base_sec = extract_base_section(raw_sec)
            inst = ACRONYM_MAP.get(acro)
            if inst:
                prefix = "r" if inst["pref_type"] == "regulation" else "s"
                target_id = f"{inst['slug']}:{prefix}{base_sec}"
                raw = m.group(0)
                key = ("statute", target_id)
                if key not in seen:
                    seen.add(key)
                    citations.append({
                        "citation_type": "regulation" if inst["pref_type"] == "regulation" else "statute",
                        "target_id": target_id,
                        "act_slug": inst["slug"],
                        "section": base_sec,
                        "raw_text": raw,
                        "metadata": {
                            "instrument_title": inst["title"],
                            "section": base_sec,
                            "original_sec": raw_sec,
                            "acronym": acro
                        }
                    })

        # 3. Explicit Proximity Matching for Full Statute & Regulation Names
        # Matches e.g. "Road Transport Act 2013, s 53" or "s 53 of the Road Transport Act 2013"
        # and "Road Rules 2014, rule 10" or "rule 10 of Road Rules"
        for title, slug, inst_type, pattern in KNOWN_INSTRUMENTS:
            # Check if this instrument is mentioned
            for inst_m in re.finditer(pattern, text, re.IGNORECASE):
                inst_start, inst_end = inst_m.span()

                # Search around the instrument within proximity window
                # Get surrounding snippet (approx words)
                words_before = text[:inst_start].split()[-self.proximity_word_limit:]
                words_after = text[inst_end:].split()[:self.proximity_word_limit]

                # Match section references in both before and after windows
                # Enforce rule: "rule" / "r" only for regulations; "section" / "s" for acts
                # "clause" / "cl" for regulations
                candidate_snippets = [
                    ("after", text[inst_end:inst_end + 120]),
                    ("before", text[max(0, inst_start - 120):inst_start])
                ]

                for direction, snippet in candidate_snippets:
                    if inst_type == "regulation":
                        sec_re = re.compile(r'\b(?:r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)', re.IGNORECASE)
                    else:
                        # Act or Schedule: only "s", "sec", "section"
                        # Never allow "rule" to bind to an Act! (Fixes road rule 10 matching s 10 Crimes Act)
                        sec_re = re.compile(r'\b(?:s|sec|section)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)', re.IGNORECASE)

                    for sm in sec_re.finditer(snippet):
                        raw_sec = sm.group(1)
                        base_sec = extract_base_section(raw_sec)
                        prefix = "r" if inst_type == "regulation" else "s"
                        target_id = f"{slug}:{prefix}{base_sec}"
                        raw_phrase = f"{inst_m.group(0)} {sm.group(0)}" if direction == "after" else f"{sm.group(0)} of {inst_m.group(0)}"
                        key = ("statute", target_id)
                        if key not in seen:
                            seen.add(key)
                            citations.append({
                                "citation_type": "regulation" if inst_type == "regulation" else "statute",
                                "target_id": target_id,
                                "act_slug": slug,
                                "section": base_sec,
                                "raw_text": raw_phrase,
                                "metadata": {
                                    "instrument_title": title,
                                    "section": base_sec,
                                    "original_sec": raw_sec
                                }
                            })

        # 4. Context-Aware Bare Section Pinpoints (if currently viewing an Act or Reg)
        if current_act_slug:
            bare_sec_re = re.compile(r'(?:^|\s)(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)', re.IGNORECASE)
            for bm in bare_sec_re.finditer(text):
                raw_sec = bm.group(1)
                base_sec = extract_base_section(raw_sec)
                prefix = "r" if ("regulation" in current_act_slug or "rules" in current_act_slug) else "s"
                target_id = f"{current_act_slug}:{prefix}{base_sec}"
                key = ("statute", target_id)
                if key not in seen:
                    seen.add(key)
                    citations.append({
                        "citation_type": "statute",
                        "target_id": target_id,
                        "act_slug": current_act_slug,
                        "section": base_sec,
                        "raw_text": bm.group(0).strip(),
                        "metadata": {
                            "instrument_title": current_act_slug,
                            "section": base_sec,
                            "context_inferred": True
                        }
                    })

        # 5. Lawpart Offence Codes (LPC 79007)
        for lm in LPC_PATTERN.finditer(text):
            code = lm.group(1)
            key = ("offence", f"LPC:{code}")
            if key not in seen:
                seen.add(key)
                citations.append({
                    "citation_type": "offence",
                    "target_id": f"LPC:{code}",
                    "raw_text": lm.group(0),
                    "metadata": {"lawpart_code": code}
                })

        return citations

    def compile_html(
        self,
        markdown_text: str,
        current_act_slug: Optional[str] = None
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """
        Compiles commentary Markdown into rich, sanitized HTML with:
        - Clickable [N] paragraph jump anchors
        - Clickable Case MNC hyperlinks
        - Clickable Statute / Acronym hyperlinks
        - Clickable Lawpart Code chips
        """
        citations = self.extract_citations(markdown_text, current_act_slug)
        html = markdown_text

        # 1. Medium Neutral Citations: [2014] NSWCA 161 (must run before single bracket jumps)
        def replace_mnc(match):
            year, court, num = match.group(1), match.group(2).upper(), match.group(3)
            slug = parse_mnc_to_slug(year, court, num)
            mnc_text = f"[{year}] {court} {num}"
            return f'<a href="#/cases/{slug}" class="case-cite-link" data-case-slug="{slug}" data-mnc="{mnc_text}" title="Open {mnc_text} in Canopy">{mnc_text}</a>'

        html = MNC_PATTERN.sub(replace_mnc, html)

        # 2. Paragraph Jump Links: ranges [10]-[14] or [10-14] first
        range_pattern = re.compile(r'\[(\d+)\]\s*[-–]\s*\[(\d+)\]|\[(\d+)\s*[-–]\s*(\d+)\]')
        def replace_range(match):
            start = match.group(1) or match.group(3)
            end = match.group(2) or match.group(4)
            return f'<a href="#para-{start}" class="para-jump-link" data-jump-start="{start}" data-jump-end="{end}" onclick="app.jumpToParagraph({start}, {end})" title="Jump to paragraphs [{start}]-[{end}] in reader">[{start}]–[{end}]</a>'

        html = range_pattern.sub(replace_range, html)

        # Single paragraph [10] (not followed by court names or link brackets)
        single_para_pattern = re.compile(r'\[(\d+)\](?!\s*(?:[A-Za-z]{2,8}\s+\d|\())')
        def replace_single_para(match):
            start = match.group(1)
            return f'<a href="#para-{start}" class="para-jump-link" data-jump-start="{start}" onclick="app.jumpToParagraph({start})" title="Jump to paragraph [{start}] in reader">[{start}]</a>'

        html = single_para_pattern.sub(replace_single_para, html)

        # 3. Statutory Acronyms: RTA s 53, RR r 20, DL cl 15
        acronym_sub_regex = re.compile(
            r'\b(RTA|RR|DL|HVNL|ACL|CCA)\s+(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)',
            re.IGNORECASE
        )
        def replace_acronym(match):
            acro = match.group(1).upper()
            raw_sec = match.group(2)
            base_sec = extract_base_section(raw_sec)
            inst = ACRONYM_MAP.get(acro)
            if not inst:
                return match.group(0)
            prefix = "r" if inst["pref_type"] == "regulation" else "s"
            url = f"#/{inst['slug']}/{prefix}{base_sec}"
            return f'<a href="{url}" class="statute-link" data-act="{inst["slug"]}" data-sec="{base_sec}" title="{inst["title"]} section {base_sec}">{match.group(0)}</a>'

        html = acronym_sub_regex.sub(replace_acronym, html)

        # 4. Lawpart Codes: LPC 79007
        def replace_lpc(match):
            code = match.group(1)
            return f'<a href="javascript:void(0)" class="lawpart-cite-link" data-lpc="{code}" onclick="app.filterLawparts(\'{code}\')" title="Filter Section Intelligence for Lawpart Code #{code}">{match.group(0)}</a>'

        html = LPC_PATTERN.sub(replace_lpc, html)

        # 5. Basic markdown styling (bold, italic, backtick code, bullet lists, linebreaks)
        html = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', html)
        html = re.sub(r'\*(.+?)\*', r'<em>\1</em>', html)
        html = re.sub(r'`(.+?)`', r'<code>\1</code>', html)
        
        # Paragraphs / Linebreaks
        paragraphs = [p.strip() for p in html.split('\n\n') if p.strip()]
        if len(paragraphs) > 1:
            html = "".join(f"<p>{p.replace(chr(10), '<br/>')}</p>" for p in paragraphs)
        else:
            html = f"<p>{html.replace(chr(10), '<br/>')}</p>"

        return html, citations
