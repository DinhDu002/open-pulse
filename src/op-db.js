'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'open-pulse.db');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp           TEXT    NOT NULL,
  session_id          TEXT,
  event_type          TEXT    NOT NULL,
  name                TEXT,
  detail              TEXT,
  duration_ms         INTEGER,
  success             INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  estimated_cost_usd  REAL,
  working_directory   TEXT,
  model               TEXT,
  user_prompt         TEXT,
  tool_input          TEXT,
  tool_response       TEXT,
  seq_num             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp   ON events (timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type        ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_name        ON events (name);
CREATE INDEX IF NOT EXISTS idx_events_session     ON events (session_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT    NOT NULL UNIQUE,
  started_at           TEXT    NOT NULL,
  ended_at             TEXT,
  working_directory    TEXT,
  model                TEXT,
  total_tool_calls     INTEGER DEFAULT 0,
  total_skill_invokes  INTEGER DEFAULT 0,
  total_agent_spawns   INTEGER DEFAULT 0,
  total_input_tokens   INTEGER DEFAULT 0,
  total_output_tokens  INTEGER DEFAULT 0,
  total_cost_usd       REAL    DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prompts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  prompt_text     TEXT    NOT NULL,
  seq_start       INTEGER NOT NULL,
  seq_end         INTEGER,
  timestamp       TEXT    NOT NULL,
  event_count     INTEGER DEFAULT 0,
  total_cost_usd  REAL    DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_timestamp ON prompts(timestamp);

CREATE TABLE IF NOT EXISTS collector_errors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  hook_type      TEXT,
  error_message  TEXT,
  raw_input      TEXT
);

CREATE TABLE IF NOT EXISTS cl_projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT    NOT NULL UNIQUE,
  name            TEXT,
  directory       TEXT,
  first_seen_at   TEXT,
  last_seen_at    TEXT,
  session_count   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cl_instincts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instinct_id   TEXT,
  project_id    TEXT,
  category      TEXT,
  pattern       TEXT,
  confidence    REAL    DEFAULT 0,
  seen_count    INTEGER DEFAULT 1,
  first_seen    TEXT,
  last_seen     TEXT,
  instinct      TEXT
);

CREATE INDEX IF NOT EXISTS idx_instincts_project ON cl_instincts (project_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id            TEXT    PRIMARY KEY,
  created_at    TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  confidence    REAL    DEFAULT 0,
  description   TEXT,
  evidence      TEXT,
  instinct_id   TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  resolved_at   TEXT,
  resolved_by   TEXT
);

CREATE TABLE IF NOT EXISTS scan_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at       TEXT    NOT NULL,
  report           TEXT,
  total_skills     INTEGER DEFAULT 0,
  total_agents     INTEGER DEFAULT 0,
  total_hooks      INTEGER DEFAULT 0,
  total_rules      INTEGER DEFAULT 0,
  issues_critical  INTEGER DEFAULT 0,
  issues_high      INTEGER DEFAULT 0,
  issues_medium    INTEGER DEFAULT 0,
  issues_low       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS components (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  plugin        TEXT,
  project       TEXT,
  file_path     TEXT,
  description   TEXT,
  agent_class   TEXT,
  hook_event    TEXT,
  hook_matcher  TEXT,
  hook_command  TEXT,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_components_dedup
  ON components (type, name, source, COALESCE(plugin, ''), COALESCE(project, ''));
CREATE INDEX IF NOT EXISTS idx_components_type   ON components (type);
CREATE INDEX IF NOT EXISTS idx_components_source ON components (source);

CREATE TABLE IF NOT EXISTS kg_nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  properties  TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);

CREATE TABLE IF NOT EXISTS kg_edges (
  source_id     TEXT NOT NULL REFERENCES kg_nodes(id),
  target_id     TEXT NOT NULL REFERENCES kg_nodes(id),
  relationship  TEXT NOT NULL,
  weight        REAL DEFAULT 1.0,
  properties    TEXT DEFAULT '{}',
  valid_from    TEXT,
  valid_to      TEXT,
  PRIMARY KEY (source_id, target_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_rel    ON kg_edges(relationship);

CREATE TABLE IF NOT EXISTS kg_vault_hashes (
  project_id    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE TABLE IF NOT EXISTS kg_sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_notes_project_slug ON kb_notes(project_id, slug);
CREATE INDEX IF NOT EXISTS idx_kb_notes_project ON kb_notes(project_id);
`;

// ---------------------------------------------------------------------------
// createDb
// ---------------------------------------------------------------------------

function createDb(dbPath) {
  const db = new Database(dbPath || DEFAULT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(SCHEMA);
  // Migrate existing databases: add columns that may not exist yet
  const migrations = [
    'ALTER TABLE events ADD COLUMN tool_input TEXT',
    'ALTER TABLE events ADD COLUMN tool_response TEXT',
    'ALTER TABLE events ADD COLUMN seq_num INTEGER',
    'ALTER TABLE suggestions ADD COLUMN instinct_id TEXT',
    'ALTER TABLE suggestions ADD COLUMN category TEXT',
    'ALTER TABLE suggestions ADD COLUMN action_data TEXT',
    'ALTER TABLE suggestions ADD COLUMN description_vi TEXT',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  // Migration: add prompt_id to events
  try {
    db.prepare('SELECT prompt_id FROM events LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE events ADD COLUMN prompt_id INTEGER REFERENCES prompts(id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_prompt ON events(prompt_id)');
  }
  // Drop legacy cl_observations table (no longer used)
  db.exec('DROP TABLE IF EXISTS cl_observations');
  // Migrate: add instinct_id to cl_instincts for dedup
  const hasInstinctIdCol = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('cl_instincts') WHERE name = 'instinct_id'"
  ).get();
  if (hasInstinctIdCol.cnt === 0) {
    db.exec('ALTER TABLE cl_instincts ADD COLUMN instinct_id TEXT');
    db.exec('DELETE FROM cl_instincts');  // stale duplicates; repopulated by syncAll on startup
  }
  // Always ensure unique index exists (fresh DBs have column from SCHEMA, migrated DBs from ALTER)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_instincts_dedup ON cl_instincts(project_id, instinct_id)');

  // Migrate: add instinct_vi column for cached Vietnamese translation
  const hasInstinctVi = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('cl_instincts') WHERE name = 'instinct_vi'"
  ).get();
  if (hasInstinctVi.cnt === 0) {
    db.exec('ALTER TABLE cl_instincts ADD COLUMN instinct_vi TEXT');
  }

  // Migrate: dedup cl_projects by directory, add unique index
  const dupes = db.prepare(`
    SELECT directory, GROUP_CONCAT(project_id) AS pids, COUNT(*) AS cnt
    FROM cl_projects
    WHERE directory IS NOT NULL
    GROUP BY directory
    HAVING cnt > 1
  `).all();
  for (const dup of dupes) {
    const pids = dup.pids.split(',');
    // Keep the row with latest last_seen_at
    const keeper = db.prepare(
      `SELECT project_id FROM cl_projects WHERE directory = ? ORDER BY last_seen_at DESC LIMIT 1`
    ).get(dup.directory);
    const keepId = keeper.project_id;
    const removeIds = pids.filter(p => p !== keepId);
    for (const oldId of removeIds) {
      db.prepare('UPDATE cl_instincts SET project_id = ? WHERE project_id = ?').run(keepId, oldId);
      db.prepare('DELETE FROM cl_projects WHERE project_id = ?').run(oldId);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_directory ON cl_projects(directory) WHERE directory IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_suggestions_category ON suggestions(category)');

  return db;
}

// ---------------------------------------------------------------------------
// Domain modules (re-exported for backwards compatibility)
// ---------------------------------------------------------------------------

const events = require('./db/events');
const sessions = require('./db/sessions');
const instincts = require('./db/instincts');
const suggestions = require('./db/suggestions');
const knowledge = require('./db/knowledge');
const components = require('./db/components');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...instincts,
  ...suggestions,
  ...knowledge,
  ...components,
};
