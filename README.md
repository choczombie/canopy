# Canopy Legal Workspace

Modern, high-performance legislation, caselaw, and regulatory intelligence platform.

Part of the **Canopy Legal** suite.

## Architecture

- **`src/static/`**: Unified Web SPA (Portal Landing, Tri-Pane Workbench, Dedicated Search, Lawpart Pills).
- **`src/server.py`**: FastAPI server providing sub-10ms REST APIs.
- **`src/repository.py`**: Multi-database query engine with unified FTS5 search across statutes, regulations, and caselaw.
- **`src/lawpart_bridge.py`**: Lawpart penalty notice offence codes and demerit points.
- **`data/`**: Read-only reference databases (`acts.db`, `regs.db`, `caselaw.db`, `tl_v15.db`) and read/write `annotations.db`.

See `AGENT.md` for AI agent instructions and development commands.

