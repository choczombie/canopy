-- Commentary and Annotations Protected Store
-- SQLite Schema for data/annotations.db

CREATE TABLE IF NOT EXISTS commentary (
    id TEXT PRIMARY KEY,                       -- UUID v4 string
    target_type TEXT NOT NULL,                 -- 'case', 'case_paragraph', 'provision', 'offence'
    target_id TEXT NOT NULL,                   -- Canonical ID (e.g. '2014-nswca-161', 'road-transport-act-2013:s53')
    target_paragraph_start INTEGER,            -- NULL for case/provision; integer for paragraph
    target_paragraph_end INTEGER,              -- Same as start for single para; higher for range
    author_tier TEXT NOT NULL,                 -- 'moderator', 'practitioner', 'ai'
    author_id TEXT NOT NULL,                   -- User ID / 'system' / 'editorial_board'
    author_name TEXT NOT NULL,                 -- Display name (e.g. 'Nick C.', 'Editorial Board')
    author_role TEXT,                          -- e.g. 'Barrister', 'Solicitor', 'AI Notation'
    title TEXT NOT NULL,                       -- Commentary headline
    body_markdown TEXT NOT NULL,               -- Raw markdown containing [N] and citations
    body_html TEXT NOT NULL,                   -- Sanitized, pre-compiled HTML with resolved links
    visibility TEXT DEFAULT 'public',          -- 'private', 'team', 'public'
    status TEXT DEFAULT 'active',              -- 'active', 'archived', 'flagged'
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commentary_target 
    ON commentary(target_type, target_id, target_paragraph_start);

CREATE INDEX IF NOT EXISTS idx_commentary_author 
    ON commentary(author_id, visibility);

CREATE INDEX IF NOT EXISTS idx_commentary_tier 
    ON commentary(author_tier);

CREATE TABLE IF NOT EXISTS commentary_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    commentary_id TEXT NOT NULL REFERENCES commentary(id) ON DELETE CASCADE,
    citation_type TEXT NOT NULL,               -- 'case', 'statute', 'regulation', 'offence'
    cited_target_id TEXT NOT NULL,             -- Target ID / URL slug
    raw_text TEXT NOT NULL,                    -- Raw citation snippet (e.g. '[2014] NSWCA 161' or 'RTA s 53')
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_citations_target 
    ON commentary_citations(citation_type, cited_target_id);

CREATE VIRTUAL TABLE IF NOT EXISTS commentary_fts USING fts5(
    commentary_id UNINDEXED,
    title,
    body_markdown,
    author_name,
    tokenize = 'porter unicode61'
);
