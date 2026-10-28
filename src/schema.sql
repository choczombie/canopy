-- SQLite Schema for Project LexNSW-Fed
PRAGMA foreign_keys = ON;

-- Core Jurisdiction Reference
CREATE TABLE IF NOT EXISTS jurisdictions (
    id TEXT PRIMARY KEY,               -- 'cth', 'nsw', 'vic'
    name TEXT NOT NULL,                -- 'Commonwealth of Australia'
    code TEXT NOT NULL UNIQUE          -- 'CTH'
);

-- Master Acts & Regulations Metadata
CREATE TABLE IF NOT EXISTS acts (
    id TEXT PRIMARY KEY,               -- 'competition-and-consumer-act-2010', 'heavy-vehicle-national-law'
    jurisdiction_id TEXT NOT NULL REFERENCES jurisdictions(id),
    slug TEXT NOT NULL,                -- 'competition-and-consumer-act-2010'
    short_title TEXT NOT NULL,         -- 'Competition and Consumer Act 2010'
    long_title TEXT,
    year INTEGER NOT NULL,
    act_number INTEGER,
    is_virtual BOOLEAN DEFAULT 0,      -- 1 for virtual aliased Acts like ACL
    parent_act_id TEXT REFERENCES acts(id),
    category TEXT NOT NULL DEFAULT 'act',           -- 'act' or 'regulation'
    portfolio TEXT NOT NULL DEFAULT 'commercial',    -- 'commercial', 'transport', 'financial'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(jurisdiction_id, slug)
);

-- Compilation Records (Snapshots in time)
CREATE TABLE IF NOT EXISTS compilations (
    id TEXT PRIMARY KEY,               -- 'comp-cca-2010-latest'
    act_id TEXT NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
    compilation_id_frl TEXT,           -- Federal Register Register ID (e.g. C2026C00323)
    compilation_number TEXT,
    start_date DATE NOT NULL,
    end_date DATE,                     -- NULL if currently in force
    is_in_force BOOLEAN NOT NULL DEFAULT 1,
    source_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Structural Containers (Chapter, Part, Division, Subdivision, Schedule)
CREATE TABLE IF NOT EXISTS structural_nodes (
    id TEXT PRIMARY KEY,
    compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
    parent_node_id TEXT REFERENCES structural_nodes(id),
    node_type TEXT NOT NULL,           -- 'schedule', 'chapter', 'part', 'division', 'subdivision'
    identifier TEXT NOT NULL,          -- 'Schedule 2', 'Chapter 2', 'Part 2-1'
    title TEXT NOT NULL,               -- 'General protections'
    slug TEXT NOT NULL,                -- 'schedule-2/chapter-2/part-2-1'
    path_hierarchy TEXT NOT NULL,      -- '/schedule-2/chapter-2/part-2-1'
    order_index INTEGER NOT NULL
);

-- Atomic Provisions (Sections, Clauses, Rules)
CREATE TABLE IF NOT EXISTS provisions (
    id TEXT PRIMARY KEY,
    compilation_id TEXT NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
    structural_node_id TEXT NOT NULL REFERENCES structural_nodes(id),
    provision_type TEXT NOT NULL,      -- 'section', 'clause', 'rule'
    identifier TEXT NOT NULL,          -- '18', '45', '51AAA'
    title TEXT NOT NULL,               -- 'Misleading or deceptive conduct'
    slug TEXT NOT NULL,                -- 's18'
    full_slug TEXT NOT NULL,           -- 'schedule-2/s18' or 's18'
    content_html TEXT NOT NULL,
    content_text TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    UNIQUE(compilation_id, full_slug)
);

-- Granular Elements (Subsections, Paragraphs) for pinpoint deep-linking
CREATE TABLE IF NOT EXISTS provision_elements (
    id TEXT PRIMARY KEY,
    provision_id TEXT NOT NULL REFERENCES provisions(id) ON DELETE CASCADE,
    element_type TEXT NOT NULL,        -- 'subsection', 'paragraph', 'subparagraph', 'note', 'penalty', 'heading'
    identifier TEXT,                   -- '(1)', '(a)', '(i)'
    content_text TEXT NOT NULL,
    content_html TEXT NOT NULL,
    order_index INTEGER NOT NULL
);

-- Full-Text Search Virtual Table (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
    provision_id UNINDEXED,
    act_slug UNINDEXED,
    full_slug UNINDEXED,
    identifier,
    title,
    content_text,
    tokenize = 'porter unicode61'
);

-- Extensible Annotation & Commentary Layer
CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    provision_id TEXT NOT NULL REFERENCES provisions(id) ON DELETE CASCADE,
    element_id TEXT REFERENCES provision_elements(id),
    target_anchor TEXT,
    annotation_type TEXT NOT NULL,     -- 'case_law', 'statutory_note', 'accc_guideline', 'personal_note'
    title TEXT NOT NULL,
    citation TEXT,
    body_markdown TEXT NOT NULL,
    author_type TEXT NOT NULL DEFAULT 'system',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cross-Statute References
CREATE TABLE IF NOT EXISTS cross_references (
    id TEXT PRIMARY KEY,
    source_provision_id TEXT NOT NULL REFERENCES provisions(id) ON DELETE CASCADE,
    target_jurisdiction TEXT NOT NULL,
    target_act_slug TEXT NOT NULL,
    target_provision_slug TEXT,
    raw_citation_text TEXT NOT NULL,
    confidence_score REAL DEFAULT 1.0
);

-- Indexes for sub-millisecond lookups
CREATE INDEX IF NOT EXISTS idx_struct_comp_parent ON structural_nodes(compilation_id, parent_node_id);
CREATE INDEX IF NOT EXISTS idx_struct_slug ON structural_nodes(slug);
CREATE INDEX IF NOT EXISTS idx_prov_comp_slug ON provisions(compilation_id, full_slug);
CREATE INDEX IF NOT EXISTS idx_prov_struct ON provisions(structural_node_id);
CREATE INDEX IF NOT EXISTS idx_elem_prov ON provision_elements(provision_id);
