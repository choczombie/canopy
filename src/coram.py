"""
Coram & Judicial Bench Normalizer for Australian Courts & Tribunals.
Parses bench strings into canonical judicial names, distinguishes appellate
composition from tribunal members, and handles titles (CJ, JA, AJA, J, DCJ, Magistrate).
"""
import re
from typing import List, Optional

def clean_unicode(text: str) -> str:
    """Standardizes dashes, spaces, and quotes in legal text."""
    if not text:
        return ""
    t = text
    t = t.replace('\u2013', '-').replace('\u2014', '--').replace('\u2015', '--')
    t = t.replace('\u2018', "'").replace('\u2019', "'")
    t = t.replace('\u201c', '"').replace('\u201d', '"')
    t = t.replace('\u00a0', ' ')
    return t

def format_judge_name(name: str) -> str:
    """Formats capitalization, post-nominals, and Scottish surnames."""
    parts = name.split()
    fixed = []
    for p in parts:
        if p.upper() in ('SC', 'KC', 'QC', 'AO', 'AM', 'AC', 'OAM', 'PSM'):
            fixed.append(p.upper())
        elif re.match(r'^Mc[A-Za-z]', p):
            fixed.append('Mc' + p[2:].capitalize())
        elif p.isupper() and len(p) > 2:
            fixed.append(p.capitalize())
        elif len(p) == 1 and p.isalpha():
            fixed.append(p.upper())
        else:
            fixed.append(p)
    return ' '.join(fixed)

def parse_coram_bench(bench_str: Optional[str]) -> List[str]:
    """
    Parses bench string into individual formatted judicial names or tribunal members.
    Distinguishes tribunal members (Dr J Lucy, Senior Member X) from appellate judges
    and preserves judicial designations (CJ at CL, DCJ, Magistrate).
    """
    if not bench_str:
        return []
    raw = bench_str.strip()
    raw = re.sub(r'\s+', ' ', raw)

    # 1. Check if Tribunal / Commission bench or Member designation
    is_tribunal = (
        any(term in raw.lower() for term in ['member', 'president', 'deputy president', 'tribunal', 'commissioner'])
        or raw.startswith('Dr ')
        or bool(re.search(r'\b(NCAT|ADT|IRComm)\b', raw, re.I))
    )

    if is_tribunal:
        cleaned = re.sub(
            r',\s*(Judicial\s+Member|Non-Judicial\s+Member|Senior\s+Member|Principal\s+Member|Member|Deputy\s+President|President)\b',
            r' (\1)',
            raw,
            flags=re.I
        )
        parts = re.split(r';\s*|\s+AND\s+|\s+and\s+', cleaned)
        members = []
        for p in parts:
            p_clean = p.strip().strip(';,.- ')
            if p_clean and p_clean.lower() not in ('court', 'tribunal', 'appeal'):
                members.append(p_clean)
        if members:
            return members

    # 2. Check for trailing AJJA/JJA/JJ/etc.
    m_jja = re.search(r'^(.*?)\s+(AJJA|AJA|JJA|JJ|Acting Judges|Judges of Appeal)\s*$', raw, re.I)
    default_suffix = 'JA'
    if m_jja:
        raw_names = m_jja.group(1)
        suffix = m_jja.group(2).upper()
        if 'AJJA' in suffix or 'ACTING' in suffix:
            default_suffix = 'AJA'
        elif 'JA' in suffix:
            default_suffix = 'JA'
        else:
            default_suffix = 'J'
    else:
        raw_names = raw

    # Standardize delimiters
    raw_names = re.sub(r';\s*', ', ', raw_names)
    raw_names = re.sub(r'\b(AP|P|CJ|ACJ|DCJ|AJA|AJJA|JA)\b\s+(?=[A-Z])', r'\1, ', raw_names)

    parts = re.split(r',\s*|\s+AND\s+|\s+and\s+|\s*&\s*', raw_names)

    expanded = []
    for p in parts:
        p_clean = p.strip()
        if not p_clean:
            continue
        words = p_clean.split()
        if len(words) > 1 and m_jja and not any(re.search(r'\b(P|CJ|ACJ|AP|DCJ|AJA|AJJA|JA|J)\b', w, re.I) for w in words):
            expanded.extend(words)
        else:
            expanded.append(p_clean)

    judges = []
    for p in expanded:
        p_clean = p.strip().strip(';,.- ')
        p_clean = re.sub(r'^(and|or)\s+', '', p_clean, flags=re.I).strip()
        p_clean = re.sub(r'\s+at\s+\[?\d+\]?', '', p_clean, flags=re.I).strip()
        if not p_clean or p_clean.upper() in ('AJJA', 'AJA', 'JJA', 'JJ', 'COURT', 'APPEAL'):
            continue

        # Compound titles like 'CJ at CL' or 'CJ in Eq'
        compound_m = re.search(r'\b(CJ\s+(?:at|in)\s+[A-Za-z]+)\b', p_clean, re.I)
        if compound_m:
            t = compound_m.group(1)
            name_only = re.sub(r'\b(CJ\s+(?:at|in)\s+[A-Za-z]+)\b', '', p_clean, flags=re.I).strip()
            judges.append(f"{format_judge_name(name_only)} {t}")
            continue

        title_m = re.search(r'\b(P|CJ|ACJ|AP|DCJ|LCJ|AJA|AJJA|JA|J|Magistrate)\b', p_clean, re.I)
        if title_m:
            t = title_m.group(1).upper()
            if t == 'AJJA':
                t = 'AJA'
            name_only = re.sub(r'\b(P|CJ|ACJ|AP|DCJ|LCJ|AJA|AJJA|JA|J|Magistrate)\b', '', p_clean, flags=re.I).strip()
            if t.lower() == 'magistrate':
                judges.append(f"Magistrate {format_judge_name(name_only)}")
            else:
                judges.append(f"{format_judge_name(name_only)} {t}")
        else:
            judges.append(f"{format_judge_name(p_clean)} {default_suffix}")

    return judges

def match_judge_speaker(line_text: str, coram_judges: List[str]) -> Optional[str]:
    """Detects whether a paragraph or heading introduces an opinion by a judge on the coram."""
    clean_line = clean_unicode(line_text).strip()
    if not clean_line or len(clean_line) > 120:
        return None

    # Check for direct matches like 'BASTEN JA:' or 'BASTEN JA.' or 'BASTEN JA'
    for judge in coram_judges:
        surname = judge.split()[0]
        # E.g. 'BASTEN JA', 'Basten JA'
        pattern = rf'^{re.escape(surname)}\s+(?:P|CJ|JA|AJA|J|DCJ|Magistrate)[:\.\s-]*$'
        if re.search(pattern, clean_line, re.I):
            return judge
        if clean_line.upper().startswith(f"{surname.upper()} "):
            return judge

    # Check for "JUDGMENT OF ..."
    m_opinion = re.search(r'(?:REASONS FOR JUDGMENT OF|JUDGMENT OF|OPINION OF)\s+([A-Z\s]+)', clean_line, re.I)
    if m_opinion:
        matched_text = m_opinion.group(1).upper()
        for judge in coram_judges:
            surname = judge.split()[0].upper()
            if surname in matched_text:
                return judge

    return None

