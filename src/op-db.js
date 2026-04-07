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
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  // Migrate: add instinct_id to cl_observations if missing
  const colCheck = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('cl_observations') WHERE name = 'instinct_id'"
  ).get();
  if (colCheck.cnt === 0) {
    db.exec('ALTER TABLE cl_observations ADD COLUMN instinct_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cl_observations_instinct ON cl_observations(instinct_id)');
  }
  return db;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function withEventDefaults(evt) {
  return {
    tool_input: null, tool_response: null, seq_num: null,
    ...evt,
  };
}

function insertEvent(db, evt) {
  db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num)
  `).run(withEventDefaults(evt));
}

function insertEventBatch(db, events) {
  const insert = db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withEventDefaults(row));
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

function withSuggestionDefaults(sugg) {
  return { instinct_id: null, ...sugg };
}

function insertSuggestion(db, sugg) {
  db.prepare(`
    INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status)
    VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @instinct_id, @status)
    ON CONFLICT(id) DO UPDATE SET
      confidence  = excluded.confidence,
      description = excluded.description,
      evidence    = excluded.evidence,
      instinct_id = excluded.instinct_id
  `).run(withSuggestionDefaults(sugg));
}

function insertSuggestionBatch(db, suggestions) {
  const insert = db.prepare(`
    INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status)
    VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @instinct_id, @status)
    ON CONFLICT(id) DO UPDATE SET
      confidence  = excluded.confidence,
      description = excluded.description,
      evidence    = excluded.evidence,
      instinct_id = excluded.instinct_id
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withSuggestionDefaults(row));
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
// Learning API — Observations
// ---------------------------------------------------------------------------

function queryObservations(db, { project, category, from, to, instinct_id, search, page, perPage } = {}) {
  const conditions = [];
  const params = {};

  if (project) { conditions.push('project_id = @project'); params.project = project; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (from) { conditions.push('observed_at >= @from'); params.from = from; }
  if (to) { conditions.push('observed_at <= @to'); params.to = to; }
  if (instinct_id != null) { conditions.push('instinct_id = @instinct_id'); params.instinct_id = instinct_id; }
  if (search) { conditions.push('observation LIKE @search'); params.search = `%${search}%`; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cl_observations ${where}`).get(params).cnt;

  const p = Math.max(1, page || 1);
  const pp = Math.min(50, Math.max(1, perPage || 20));
  const offset = (p - 1) * pp;

  const items = db.prepare(
    `SELECT * FROM cl_observations ${where} ORDER BY observed_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: pp, offset });

  return { items, total, page: p, per_page: pp };
}

function getObservation(db, id) {
  return db.prepare('SELECT * FROM cl_observations WHERE id = ?').get(id) || null;
}

function queryObservationActivity(db, days) {
  const d = days || 30;
  return db.prepare(`
    SELECT date(observed_at) AS date, COUNT(*) AS count
    FROM cl_observations
    WHERE observed_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date(observed_at)
    ORDER BY date ASC
  `).all(d);
}

// ---------------------------------------------------------------------------
// Learning API — Instincts (filtered)
// ---------------------------------------------------------------------------

function queryInstinctsFiltered(db, { domain, source, project, category, confidence_min, confidence_max, search, page, perPage } = {}) {
  const conditions = [];
  const params = {};

  if (project) { conditions.push('project_id = @project'); params.project = project; }
  // domain and category both map to the category column; domain takes precedence
  const cat = domain || category;
  if (cat) { conditions.push('category = @cat'); params.cat = cat; }
  // source is reserved for future use — no-op for now
  if (confidence_min != null) { conditions.push('confidence >= @confidence_min'); params.confidence_min = confidence_min; }
  if (confidence_max != null) { conditions.push('confidence <= @confidence_max'); params.confidence_max = confidence_max; }
  if (search) {
    conditions.push('(pattern LIKE @search OR instinct LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cl_instincts ${where}`).get(params).cnt;

  const p = Math.max(1, page || 1);
  const pp = Math.min(50, Math.max(1, perPage || 20));
  const offset = (p - 1) * pp;

  const items = db.prepare(
    `SELECT * FROM cl_instincts ${where} ORDER BY last_seen DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: pp, offset });

  return { items, total, page: p, per_page: pp };
}

function getInstinctStats(db) {
  const byDomain = db.prepare(`
    SELECT category AS domain, COUNT(*) AS count
    FROM cl_instincts
    GROUP BY category
    ORDER BY count DESC
  `).all();

  const rawDist = db.prepare(`
    SELECT
      CASE
        WHEN confidence < 0.3  THEN 'low'
        WHEN confidence < 0.6  THEN 'medium'
        ELSE 'high'
      END AS bucket,
      COUNT(*) AS count
    FROM cl_instincts
    GROUP BY bucket
  `).all();

  return { byDomain, confidenceDistribution: rawDist };
}

function getInstinctObservations(db, instinctId) {
  return db.prepare(
    'SELECT * FROM cl_observations WHERE instinct_id = ? ORDER BY observed_at DESC'
  ).all(instinctId);
}

function getInstinctSuggestions(db, instinctId) {
  return db.prepare(
    'SELECT * FROM suggestions WHERE instinct_id = ? ORDER BY created_at DESC'
  ).all(String(instinctId));
}

function updateInstinct(db, id, { confidence }) {
  const clamped = Math.min(0.95, Math.max(0.0, confidence));
  db.prepare('UPDATE cl_instincts SET confidence = ? WHERE id = ?').run(clamped, id);
}

function deleteInstinct(db, id) {
  db.prepare('DELETE FROM cl_instincts WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Learning API — Projects
// ---------------------------------------------------------------------------

function getProjectSummary(db, projectId) {
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project) return null;

  const instinct_count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM cl_instincts WHERE project_id = ?'
  ).get(projectId).cnt;

  const observation_count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM cl_observations WHERE project_id = ?'
  ).get(projectId).cnt;

  const suggRows = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved'  THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
    FROM suggestions s
    JOIN cl_instincts i ON s.instinct_id = CAST(i.id AS TEXT)
    WHERE i.project_id = ?
  `).get(projectId);

  const suggestion_counts = {
    pending: suggRows.pending || 0,
    approved: suggRows.approved || 0,
    dismissed: suggRows.dismissed || 0,
  };

  return { ...project, instinct_count, observation_count, suggestion_counts };
}

function getProjectTimeline(db, projectId, weeks) {
  const w = weeks || 8;
  return db.prepare(`
    SELECT
      strftime('%Y-W%W', last_seen) AS week,
      COUNT(*) AS instinct_count,
      AVG(confidence) AS avg_confidence
    FROM cl_instincts
    WHERE project_id = ?
      AND last_seen >= datetime('now', '-' || ? || ' * 7 days')
    GROUP BY week
    ORDER BY week ASC
  `).all(projectId, w);
}

// ---------------------------------------------------------------------------
// Learning API — Combined activity feed
// ---------------------------------------------------------------------------

function queryLearningActivity(db, days) {
  const d = days || 30;
  return db.prepare(`
    SELECT date, SUM(count) AS count
    FROM (
      SELECT date(observed_at) AS date, COUNT(*) AS count
      FROM cl_observations
      WHERE observed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY date(observed_at)
      UNION ALL
      SELECT date(last_seen) AS date, COUNT(*) AS count
      FROM cl_instincts
      WHERE last_seen >= datetime('now', '-' || ? || ' days')
      GROUP BY date(last_seen)
    ) combined
    GROUP BY date
    ORDER BY date ASC
  `).all(d, d);
}

function queryLearningRecent(db, limit) {
  const l = limit || 20;
  return db.prepare(`
    SELECT * FROM (
      SELECT
        'instinct'  AS kind,
        id,
        last_seen   AS timestamp,
        pattern     AS title,
        confidence,
        category
      FROM cl_instincts
      UNION ALL
      SELECT
        'suggestion' AS kind,
        id,
        created_at   AS timestamp,
        description  AS title,
        confidence,
        type         AS category
      FROM suggestions
    ) combined
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(l);
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
  queryObservations,
  getObservation,
  queryObservationActivity,
  queryInstinctsFiltered,
  getInstinctStats,
  getInstinctObservations,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  queryLearningActivity,
  queryLearningRecent,
};
