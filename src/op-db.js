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
  user_prompt         TEXT
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

CREATE TABLE IF NOT EXISTS cl_observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at   TEXT    NOT NULL,
  project_id    TEXT,
  session_id    TEXT,
  category      TEXT,
  observation   TEXT,
  raw_context   TEXT
);

CREATE INDEX IF NOT EXISTS idx_observations_project ON cl_observations (project_id);
CREATE INDEX IF NOT EXISTS idx_observations_session ON cl_observations (session_id);

CREATE TABLE IF NOT EXISTS cl_instincts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id           TEXT    PRIMARY KEY,
  created_at   TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  confidence   REAL    DEFAULT 0,
  description  TEXT,
  evidence     TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',
  resolved_at  TEXT,
  resolved_by  TEXT
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
`;

// ---------------------------------------------------------------------------
// createDb
// ---------------------------------------------------------------------------

function createDb(dbPath) {
  const db = new Database(dbPath || DEFAULT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function insertEvent(db, evt) {
  db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt)
  `).run(evt);
}

function insertEventBatch(db, events) {
  const insert = db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });
  tx(events);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function upsertSession(db, sess) {
  db.prepare(`
    INSERT INTO sessions (session_id, started_at, working_directory, model)
    VALUES (@session_id, @started_at, @working_directory, @model)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at        = excluded.started_at,
      working_directory = excluded.working_directory,
      model             = excluded.model
  `).run(sess);
}

function upsertSessionBatch(db, sessions) {
  const upsert = db.prepare(`
    INSERT INTO sessions (session_id, started_at, working_directory, model)
    VALUES (@session_id, @started_at, @working_directory, @model)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at        = excluded.started_at,
      working_directory = excluded.working_directory,
      model             = excluded.model
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });
  tx(sessions);
}

function updateSessionEnd(db, data) {
  db.prepare(`
    UPDATE sessions SET
      ended_at             = @ended_at,
      total_tool_calls     = @total_tool_calls,
      total_skill_invokes  = @total_skill_invokes,
      total_agent_spawns   = @total_agent_spawns,
      total_input_tokens   = @total_input_tokens,
      total_output_tokens  = @total_output_tokens,
      total_cost_usd       = @total_cost_usd
    WHERE session_id = @session_id
  `).run(data);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function logError(db, err) {
  db.prepare(`
    INSERT INTO collector_errors (hook_type, error_message, raw_input)
    VALUES (@hook_type, @error_message, @raw_input)
  `).run(err);
}

// ---------------------------------------------------------------------------
// CL Projects
// ---------------------------------------------------------------------------

function upsertClProject(db, proj) {
  db.prepare(`
    INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
    VALUES (@project_id, @name, @directory, @first_seen_at, @last_seen_at, @session_count)
    ON CONFLICT(project_id) DO UPDATE SET
      name          = excluded.name,
      directory     = excluded.directory,
      last_seen_at  = excluded.last_seen_at,
      session_count = session_count + 1
  `).run(proj);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function insertObservation(db, obs) {
  db.prepare(`
    INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context)
    VALUES (@observed_at, @project_id, @session_id, @category, @observation, @raw_context)
  `).run(obs);
}

// ---------------------------------------------------------------------------
// Instincts
// ---------------------------------------------------------------------------

function upsertInstinct(db, inst) {
  db.prepare(`
    INSERT INTO cl_instincts
      (project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
    VALUES
      (@project_id, @category, @pattern, @confidence, @seen_count, @first_seen, @last_seen, @instinct)
    ON CONFLICT DO UPDATE SET
      confidence = excluded.confidence,
      seen_count = seen_count + 1,
      last_seen  = excluded.last_seen,
      instinct   = excluded.instinct
  `).run(inst);
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function insertSuggestion(db, sugg) {
  db.prepare(`
    INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, status)
    VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @status)
    ON CONFLICT(id) DO UPDATE SET
      confidence  = excluded.confidence,
      description = excluded.description,
      evidence    = excluded.evidence,
      status      = excluded.status
  `).run(sugg);
}

function insertSuggestionBatch(db, suggestions) {
  const insert = db.prepare(`
    INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, status)
    VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @status)
    ON CONFLICT(id) DO UPDATE SET
      confidence  = excluded.confidence,
      description = excluded.description,
      evidence    = excluded.evidence,
      status      = excluded.status
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });
  tx(suggestions);
}

function querySuggestions(db, status) {
  if (status) {
    return db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM suggestions ORDER BY created_at DESC').all();
}

function updateSuggestionStatus(db, id, status, resolvedBy) {
  db.prepare(`
    UPDATE suggestions SET
      status      = ?,
      resolved_at = datetime('now'),
      resolved_by = ?
    WHERE id = ?
  `).run(status, resolvedBy, id);
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

function insertScanResult(db, scan) {
  db.prepare(`
    INSERT INTO scan_results
      (scanned_at, report, total_skills, total_agents, total_hooks, total_rules,
       issues_critical, issues_high, issues_medium, issues_low)
    VALUES
      (@scanned_at, @report, @total_skills, @total_agents, @total_hooks, @total_rules,
       @issues_critical, @issues_high, @issues_medium, @issues_low)
  `).run(scan);
}

function getLatestScan(db) {
  return db.prepare('SELECT * FROM scan_results ORDER BY scanned_at DESC LIMIT 1').get();
}

function getScanHistory(db, limit) {
  return db.prepare('SELECT * FROM scan_results ORDER BY scanned_at DESC LIMIT ?').all(limit || 10);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  insertEvent,
  insertEventBatch,
  upsertSession,
  upsertSessionBatch,
  updateSessionEnd,
  logError,
  upsertClProject,
  insertObservation,
  upsertInstinct,
  insertSuggestion,
  insertSuggestionBatch,
  querySuggestions,
  updateSuggestionStatus,
  insertScanResult,
  getLatestScan,
  getScanHistory,
};
