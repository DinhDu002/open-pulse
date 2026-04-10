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
  seq_num             INTEGER,
  project_name        TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp   ON events (timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type        ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_name        ON events (name);
CREATE INDEX IF NOT EXISTS idx_events_session     ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_project     ON events (project_name);

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
  total_cost_usd       REAL    DEFAULT 0,
  rules_loaded         TEXT
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

CREATE TABLE IF NOT EXISTS scan_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at       TEXT    NOT NULL,
  report           TEXT,
  total_skills     INTEGER DEFAULT 0,
  total_agents     INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS auto_evolves (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  target_type       TEXT NOT NULL,
  confidence        REAL DEFAULT 0.05,
  observation_count INTEGER DEFAULT 1,
  rejection_count   INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',
  promoted_to       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  promoted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_evolves_status ON auto_evolves(status);
CREATE INDEX IF NOT EXISTS idx_auto_evolves_target ON auto_evolves(target_type);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id                TEXT PRIMARY KEY,
  review_date       TEXT NOT NULL,
  category          TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  target_type       TEXT,
  action            TEXT,
  confidence        REAL,
  reasoning         TEXT,
  status            TEXT DEFAULT 'pending',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_status ON daily_reviews(status);
`;

// ---------------------------------------------------------------------------
// createDb
// ---------------------------------------------------------------------------

function createDb(dbPath) {
  const db = new Database(dbPath || DEFAULT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(SCHEMA);
  // Drop legacy tables no longer used
  db.exec('DROP TABLE IF EXISTS cl_instincts');
  db.exec('DROP TABLE IF EXISTS suggestions');
  // Migrate existing databases: add columns that may not exist yet
  const migrations = [
    'ALTER TABLE events ADD COLUMN tool_input TEXT',
    'ALTER TABLE events ADD COLUMN tool_response TEXT',
    'ALTER TABLE events ADD COLUMN seq_num INTEGER',
    'ALTER TABLE sessions ADD COLUMN rules_loaded TEXT',
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
  // Drop legacy tables (no longer used)
  db.exec('DROP TABLE IF EXISTS cl_observations');
  db.exec('DROP TABLE IF EXISTS insights');

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
      db.prepare('DELETE FROM cl_projects WHERE project_id = ?').run(oldId);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_directory ON cl_projects(directory) WHERE directory IS NOT NULL');

  // Migrate: remove hook/rule components and hook-specific columns
  db.exec("DELETE FROM components WHERE type IN ('hook', 'rule')");
  const hasHookEvent = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('components') WHERE name = 'hook_event'"
  ).get();
  if (hasHookEvent.cnt > 0) {
    db.exec('ALTER TABLE components DROP COLUMN hook_event');
    db.exec('ALTER TABLE components DROP COLUMN hook_matcher');
    db.exec('ALTER TABLE components DROP COLUMN hook_command');
  }
  const hasTotalHooks = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('scan_results') WHERE name = 'total_hooks'"
  ).get();
  if (hasTotalHooks.cnt > 0) {
    db.exec('ALTER TABLE scan_results DROP COLUMN total_hooks');
    db.exec('ALTER TABLE scan_results DROP COLUMN total_rules');
  }

  // Migrate: fix empty agent names (general-purpose agents without subagent_type)
  db.exec("UPDATE events SET name = 'general-purpose' WHERE event_type = 'agent_spawn' AND name = ''");

  // Migrate: add project_name column to events
  const hasProjectName = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('events') WHERE name = 'project_name'"
  ).get();
  if (hasProjectName.cnt === 0) {
    db.exec('ALTER TABLE events ADD COLUMN project_name TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_name)');
  }

  // Backfill: exact match with cl_projects (safe to re-run; skips already-filled rows)
  db.exec(
    "UPDATE events SET project_name = (SELECT name FROM cl_projects WHERE directory = events.working_directory) WHERE working_directory IS NOT NULL AND project_name IS NULL"
  );

  // Backfill: basename fallback for unmatched
  const unmatched = db.prepare(
    "SELECT DISTINCT working_directory FROM events WHERE project_name IS NULL AND working_directory IS NOT NULL"
  ).all();
  const updateStmt = db.prepare(
    "UPDATE events SET project_name = @name WHERE working_directory = @dir AND project_name IS NULL"
  );
  for (const row of unmatched) {
    updateStmt.run({ name: path.basename(row.working_directory), dir: row.working_directory });
  }

  return db;
}

// ---------------------------------------------------------------------------
// Domain modules (re-exported for backwards compatibility)
// ---------------------------------------------------------------------------

const events = require('./db/events');
const sessions = require('./db/sessions');
const knowledge = require('./db/knowledge');
const components = require('./db/components');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...knowledge,
  ...components,
};
