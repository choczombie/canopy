# Agent Guide: Canopy (Frontend & Workspace)

## 1. Project Purpose & Boundaries
`Canopy` is the front-end legal workspace and FastAPI server for Canopy Legal. It delivers sub-second navigation, continuous statutory reading, atomic paragraph case viewing, universal omnibox search, Lawpart offence grids, and interactive user commentary.

### In Scope
- **Web Interface:** HTML5, CSS3 typography, and vanilla JS SPA (`src/static/`).
- **Layout Modes:**
  - Portal Mode (`.layout-portal`): Home landing (`#/`), Legislation directory (`#/browse/legislation`), Caselaw directory (`#/browse/caselaw`), and dedicated search page (`#/search`).
  - Workspace Mode (`.layout-workspace`): Tri-pane legal workbench (TOC tree on left, atomic provisions/continuous canvas in center, contextual intelligence drawer on right).
- **In-Reader Find Toolbar:** Non-destructive `TreeWalker` DOM search with match counters and navigation.
- **FastAPI Server:** REST endpoints (`/api/acts`, `/api/cases`, `/api/search`, `/api/commentary`).
- **Annotations Owner:** Read/write operations on `data/annotations.db` (practitioner notes, moderator commentary, AI synthesis).
- **Data Consumer:** Read-only access to `data/acts.db`, `data/regs.db`, `data/caselaw.db`, and `data/tl_v15.db`.

### Out of Scope (Do NOT implement here)
- **Scraping legislation or parsing QuILLS XML / FRL DOCX** (Belongs to `canopy-legislation`).
- **Scraping court decisions or parsing raw PDFs/DOCX** (Belongs to `canopy-caselaw`).

---

## 2. Quick Command Reference

```bash
# Run test suite
pytest

# Start local development server (with auto-reload)
uvicorn src.server:app --host 127.0.0.1 --port 8000 --reload

# Start via Python module
py -m uvicorn src.server:app --port 8000 --reload

# Backup local annotations to backups/annotations/ (JSON + D1 SQL seed)
py scripts/sync_cloud.py backup-annotations

# Two-way sync annotations between Cloudflare D1 (canopy-annotations) and local data/annotations.db
py scripts/sync_cloud.py sync-annotations

# Export static bundles & deploy live site to Cloudflare Workers
py scripts/sync_cloud.py deploy
```

---

## 3. Database Architecture

Canopy mounts 5 SQLite databases:
1. `data/acts.db` (Read-only): Primary statutes & hierarchical AST.
2. `data/regs.db` (Read-only): Subordinate regulations and rules.
3. `data/caselaw.db` (Read-only): Judgments, numbered paragraphs, citing cases.
4. `data/tl_v15.db` (Read-only): Lawparts offences, demerits, fines, disqualifications.
5. `data/annotations.db` (Read-Write): Tri-tier commentary store (`moderator`, `practitioner`, `ai`).

---

## 4. Key Rules for Agents
1. **Preserve Official Typography:** Use NSW Parliamentary Counsel typography rules defined in `src/static/style.css` (hanging indents, bold section titles, comparative notes).
2. **Read-Only Reference Data:** Never execute `INSERT`, `UPDATE`, or `DELETE` on `acts.db`, `regs.db`, or `caselaw.db`. All writes go to `annotations.db`.
3. **Responsive Dual Modes:** When toggling views in `app.js`, respect `.layout-portal` vs `.layout-workspace` classes on the `#app` root container.
4. **Fast Testing:** The test suite runs in under 1 second. Always verify with `pytest` before completing a task.

