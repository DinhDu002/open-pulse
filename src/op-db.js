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
// Events
// ---------------------------------------------------------------------------

function withEventDefaults(evt) {
  return {
    detail: null, duration_ms: null, success: null,
    input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    working_directory: null, model: null, user_prompt: null,
    tool_input: null, tool_response: null, seq_num: null, prompt_id: null,
    ...evt,
  };
}

function insertEvent(db, evt) {
  db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num, prompt_id)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num, @prompt_id)
  `).run(withEventDefaults(evt));
}

function insertEventBatch(db, events) {
  const insert = db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num, prompt_id)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num, @prompt_id)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withEventDefaults(row));
  });
  tx(events);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function insertPrompt(db, p) {
  const result = db.prepare(`
    INSERT INTO prompts (session_id, prompt_text, seq_start, timestamp)
    VALUES (@session_id, @prompt_text, @seq_start, @timestamp)
  `).run({
    session_id: p.session_id,
    prompt_text: p.prompt_text,
    seq_start: p.seq_start,
    timestamp: p.timestamp,
  });
  return Number(result.lastInsertRowid);
}

function getLatestPromptForSession(db, sessionId) {
  return db.prepare(
    'SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId);
}

function updatePromptStats(db, promptId, { seq_end, cost, timestamp }) {
  db.prepare(`
    UPDATE prompts
    SET event_count = event_count + 1,
        total_cost_usd = total_cost_usd + @cost,
        seq_end = @seq_end,
        duration_ms = CAST(
          (julianday(@timestamp) - julianday(timestamp)) * 86400000 AS INTEGER
        )
    WHERE id = @id
  `).run({ id: promptId, seq_end, cost: cost || 0, timestamp });
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
  // If directory already exists under a different project_id, migrate instincts and remove old row
  if (proj.directory) {
    const old = db.prepare(
      'SELECT project_id FROM cl_projects WHERE directory = ? AND project_id != ?'
    ).get(proj.directory, proj.project_id);
    if (old) {
      db.prepare('UPDATE cl_instincts SET project_id = ? WHERE project_id = ?')
        .run(proj.project_id, old.project_id);
      db.prepare('DELETE FROM cl_projects WHERE project_id = ?').run(old.project_id);
    }
  }
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
// Instincts
// ---------------------------------------------------------------------------

function upsertInstinct(db, inst) {
  db.prepare(`
    INSERT INTO cl_instincts
      (instinct_id, project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
    VALUES
      (@instinct_id, @project_id, @category, @pattern, @confidence, @seen_count, @first_seen, @last_seen, @instinct)
    ON CONFLICT(project_id, instinct_id) DO UPDATE SET
      category   = excluded.category,
      pattern    = excluded.pattern,
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
  return { instinct_id: null, category: null, action_data: null, ...sugg };
}

const SUGGESTION_INSERT_SQL = `
  INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status, category, action_data)
  VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @instinct_id, @status, @category, @action_data)
  ON CONFLICT(id) DO UPDATE SET
    confidence  = excluded.confidence,
    description = excluded.description,
    evidence    = excluded.evidence,
    instinct_id = excluded.instinct_id,
    category    = excluded.category,
    action_data = excluded.action_data
`;

function insertSuggestion(db, sugg) {
  db.prepare(SUGGESTION_INSERT_SQL).run(withSuggestionDefaults(sugg));
}

function insertSuggestionBatch(db, suggestions) {
  const insert = db.prepare(SUGGESTION_INSERT_SQL);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withSuggestionDefaults(row));
  });
  tx(suggestions);
}

function querySuggestions(db, status, category) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM suggestions ${where} ORDER BY created_at DESC`).all(...params);
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
// Components
// ---------------------------------------------------------------------------

function upsertComponent(db, comp) {
  db.prepare(`
    INSERT INTO components
      (type, name, source, plugin, project, file_path, description, agent_class,
       hook_event, hook_matcher, hook_command, first_seen_at, last_seen_at)
    VALUES
      (@type, @name, @source, @plugin, @project, @file_path, @description, @agent_class,
       @hook_event, @hook_matcher, @hook_command, @first_seen_at, @last_seen_at)
    ON CONFLICT(type, name, source, COALESCE(plugin, ''), COALESCE(project, '')) DO UPDATE SET
      file_path    = excluded.file_path,
      description  = excluded.description,
      agent_class  = excluded.agent_class,
      hook_event   = excluded.hook_event,
      hook_matcher = excluded.hook_matcher,
      hook_command = excluded.hook_command,
      last_seen_at = excluded.last_seen_at
  `).run(comp);
}

function deleteComponentsNotSeenSince(db, cutoff) {
  db.prepare('DELETE FROM components WHERE last_seen_at < ?').run(cutoff);
}

function getComponentsByType(db, type) {
  return db.prepare('SELECT * FROM components WHERE type = ? ORDER BY name').all(type);
}

function getAllComponents(db) {
  return db.prepare('SELECT * FROM components ORDER BY type, name').all();
}

// ---------------------------------------------------------------------------
// Learning API — Instincts (filtered)
// ---------------------------------------------------------------------------

const INSTINCT_SORT_PRESETS = {
  confidence: 'confidence DESC, seen_count DESC, last_seen DESC',
  recent:     'last_seen DESC',
  seen:       'seen_count DESC, last_seen DESC',
  newest:     'first_seen DESC',
};

function queryInstinctsFiltered(db, { domain, source, project, category, confidence_min, confidence_max, search, sort, page, perPage } = {}) {
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

  const orderBy = INSTINCT_SORT_PRESETS[sort] || INSTINCT_SORT_PRESETS.confidence;

  const items = db.prepare(
    `SELECT * FROM cl_instincts ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
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

function getInstinctSuggestions(db, id) {
  const inst = db.prepare('SELECT instinct_id FROM cl_instincts WHERE id = ?').get(id);
  if (!inst || !inst.instinct_id) return [];
  return db.prepare(
    'SELECT * FROM suggestions WHERE instinct_id = ? ORDER BY created_at DESC'
  ).all(inst.instinct_id);
}

function getInstinct(db, id) {
  return db.prepare(
    `SELECT i.*, p.name AS project_name
     FROM cl_instincts i
     LEFT JOIN cl_projects p ON p.project_id = i.project_id
     WHERE i.id = ?`
  ).get(id) || null;
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

  const suggRows = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved'  THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
    FROM suggestions s
    JOIN cl_instincts i ON s.instinct_id = i.instinct_id
    WHERE i.project_id = ?
  `).get(projectId);

  const suggestion_counts = {
    pending: suggRows.pending || 0,
    approved: suggRows.approved || 0,
    dismissed: suggRows.dismissed || 0,
  };

  return { ...project, instinct_count, suggestion_counts };
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

function deleteProject(db, projectId) {
  const tx = db.transaction(() => {
    // Collect instinct_ids for suggestion cleanup
    const instinctIds = db.prepare(
      'SELECT instinct_id FROM cl_instincts WHERE project_id = ?'
    ).all(projectId).map(r => r.instinct_id).filter(Boolean);

    // Delete suggestions linked to project instincts
    if (instinctIds.length > 0) {
      const del = db.prepare('DELETE FROM suggestions WHERE instinct_id = ?');
      for (const iid of instinctIds) del.run(iid);
    }

    // Delete instincts
    db.prepare('DELETE FROM cl_instincts WHERE project_id = ?').run(projectId);

    // Delete kb_notes
    db.prepare('DELETE FROM kb_notes WHERE project_id = ?').run(projectId);

    // Delete vault hashes
    db.prepare('DELETE FROM kg_vault_hashes WHERE project_id = ?').run(projectId);

    // Delete the project row
    const result = db.prepare('DELETE FROM cl_projects WHERE project_id = ?').run(projectId);

    return { deleted: result.changes > 0 };
  });
  return tx();
}

// ---------------------------------------------------------------------------
// Learning API — Combined activity feed
// ---------------------------------------------------------------------------

function queryLearningActivity(db, days) {
  const d = days || 30;
  return db.prepare(`
    SELECT date(last_seen) AS date, COUNT(*) AS count
    FROM cl_instincts
    WHERE last_seen >= datetime('now', '-' || ? || ' days')
    GROUP BY date(last_seen)
    ORDER BY date ASC
  `).all(d);
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
// Knowledge Graph
// ---------------------------------------------------------------------------

function upsertKgNode(db, node) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_nodes (id, type, name, properties, created_at, updated_at)
    VALUES (@id, @type, @name, @properties, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      type       = excluded.type,
      name       = excluded.name,
      properties = excluded.properties,
      updated_at = @now
  `).run({ ...node, now });
}

function upsertKgNodeBatch(db, nodes) {
  const stmt = db.prepare(`
    INSERT INTO kg_nodes (id, type, name, properties, created_at, updated_at)
    VALUES (@id, @type, @name, @properties, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      type       = excluded.type,
      name       = excluded.name,
      properties = excluded.properties,
      updated_at = @now
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({ ...row, now });
  });
  tx(nodes);
}

function getKgNode(db, id) {
  return db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) || null;
}

function upsertKgEdge(db, edge) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_edges (source_id, target_id, relationship, weight, properties, valid_from, valid_to)
    VALUES (@source_id, @target_id, @relationship, @weight, @properties, @valid_from, @valid_to)
    ON CONFLICT(source_id, target_id, relationship) DO UPDATE SET
      weight     = kg_edges.weight + excluded.weight,
      properties = excluded.properties,
      valid_to   = excluded.valid_to
  `).run({
    properties: '{}', valid_from: now, valid_to: null,
    ...edge,
  });
}

function upsertKgEdgeBatch(db, edges) {
  const stmt = db.prepare(`
    INSERT INTO kg_edges (source_id, target_id, relationship, weight, properties, valid_from, valid_to)
    VALUES (@source_id, @target_id, @relationship, @weight, @properties, @valid_from, @valid_to)
    ON CONFLICT(source_id, target_id, relationship) DO UPDATE SET
      weight     = kg_edges.weight + excluded.weight,
      properties = excluded.properties,
      valid_to   = excluded.valid_to
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({
      properties: '{}', valid_from: now, valid_to: null,
      ...row,
    });
  });
  tx(edges);
}

function getKgEdges(db, nodeId) {
  return db.prepare(
    'SELECT * FROM kg_edges WHERE source_id = ? AND valid_to IS NULL'
  ).all(nodeId);
}

function getKgGraph(db, { type } = {}) {
  const conditions = [];
  const params = {};
  if (type) { conditions.push('n.type = @type'); params.type = type; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const nodes = db.prepare(`SELECT * FROM kg_nodes n ${where}`).all(params);
  const nodeIds = new Set(nodes.map(n => n.id));

  const edges = db.prepare(
    'SELECT * FROM kg_edges WHERE valid_to IS NULL'
  ).all().filter(e => nodeIds.has(e.source_id) || nodeIds.has(e.target_id));

  return { nodes, edges };
}

function getKgNodeDetail(db, id) {
  const node = db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id);
  if (!node) return null;
  const outgoing = db.prepare(
    'SELECT * FROM kg_edges WHERE source_id = ? AND valid_to IS NULL'
  ).all(id);
  const incoming = db.prepare(
    'SELECT * FROM kg_edges WHERE target_id = ? AND valid_to IS NULL'
  ).all(id);
  return { ...node, outgoing, incoming };
}

function upsertKgVaultHash(db, { project_id, file_path, content_hash }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_vault_hashes (project_id, file_path, content_hash, generated_at)
    VALUES (@project_id, @file_path, @content_hash, @now)
    ON CONFLICT(project_id, file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      generated_at = @now
  `).run({ project_id, file_path, content_hash, now });
}

function getKgVaultHash(db, project_id, file_path) {
  const row = db.prepare(
    'SELECT content_hash FROM kg_vault_hashes WHERE project_id = ? AND file_path = ?'
  ).get(project_id, file_path);
  return row ? row.content_hash : null;
}

function getKgVaultHashes(db, project_id) {
  return db.prepare(
    'SELECT file_path, content_hash FROM kg_vault_hashes WHERE project_id = ?'
  ).all(project_id);
}

function setKgSyncState(db, key, value) {
  db.prepare(`
    INSERT INTO kg_sync_state (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ key, value });
}

function getKgSyncState(db, key) {
  const row = db.prepare('SELECT value FROM kg_sync_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getKgStatus(db) {
  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get().c;
  const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_edges WHERE valid_to IS NULL').get().c;
  const lastSync = getKgSyncState(db, 'last_sync_at');
  const lastVaultGen = getKgSyncState(db, 'last_vault_gen_at');
  const lastEnrich = getKgSyncState(db, 'last_enrich_at');
  return { nodeCount, edgeCount, lastSync, lastVaultGen, lastEnrich };
}

// ---------------------------------------------------------------------------
// Knowledge Base Notes
// ---------------------------------------------------------------------------

function insertKbNote(db, note) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kb_notes (id, project_id, slug, title, body, tags, created_at, updated_at)
    VALUES (@id, @project_id, @slug, @title, @body, @tags, @created_at, @updated_at)
  `).run({ created_at: now, updated_at: now, body: '', tags: '[]', ...note });
}

function updateKbNote(db, id, fields) {
  const now = new Date().toISOString();
  const sets = ['updated_at = @updated_at'];
  const params = { id, updated_at: now };
  for (const key of ['title', 'slug', 'body', 'tags']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  db.prepare(`UPDATE kb_notes SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

function deleteKbNote(db, id) {
  db.prepare('DELETE FROM kb_notes WHERE id = ?').run(id);
}

function getKbNote(db, id) {
  return db.prepare('SELECT * FROM kb_notes WHERE id = ?').get(id) || null;
}

function getKbNoteBySlug(db, projectId, slug) {
  return db.prepare(
    'SELECT * FROM kb_notes WHERE project_id = ? AND slug = ?'
  ).get(projectId, slug) || null;
}

function queryKbNotes(db, { projectId, search, tag, page = 1, perPage = 20 } = {}) {
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 50);
  const conditions = [];
  const params = {};

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }
  if (search) {
    conditions.push('(title LIKE @search OR body LIKE @search)');
    params.search = `%${search}%`;
  }
  if (tag) {
    conditions.push("tags LIKE @tag");
    params.tag = `%"${tag}"%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM kb_notes ${where}`).get(params).c;
  const items = db.prepare(
    `SELECT * FROM kb_notes ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  return { items, total, page, perPage };
}

function getKbNoteBacklinks(db, projectId, slug) {
  const pattern = `%[[notes/${slug}]]%`;
  return db.prepare(
    'SELECT * FROM kb_notes WHERE project_id = ? AND body LIKE ?'
  ).all(projectId, pattern);
}

function getAllKbNoteSlugs(db, projectId) {
  return db.prepare(
    'SELECT slug FROM kb_notes WHERE project_id = ?'
  ).all(projectId).map(r => r.slug);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  insertEvent,
  insertEventBatch,
  insertPrompt,
  getLatestPromptForSession,
  updatePromptStats,
  upsertSession,
  upsertSessionBatch,
  updateSessionEnd,
  logError,
  upsertClProject,
  upsertInstinct,
  insertSuggestion,
  insertSuggestionBatch,
  querySuggestions,
  updateSuggestionStatus,
  insertScanResult,
  getLatestScan,
  getScanHistory,
  upsertComponent,
  deleteComponentsNotSeenSince,
  getComponentsByType,
  getAllComponents,
  queryInstinctsFiltered,
  getInstinct,
  getInstinctStats,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  deleteProject,
  queryLearningActivity,
  queryLearningRecent,
  upsertKgNode,
  upsertKgNodeBatch,
  getKgNode,
  upsertKgEdge,
  upsertKgEdgeBatch,
  getKgEdges,
  getKgGraph,
  getKgNodeDetail,
  upsertKgVaultHash,
  getKgVaultHash,
  getKgVaultHashes,
  setKgSyncState,
  getKgSyncState,
  getKgStatus,
  insertKbNote,
  updateKbNote,
  deleteKbNote,
  getKbNote,
  getKbNoteBySlug,
  queryKbNotes,
  getKbNoteBacklinks,
  getAllKbNoteSlugs,
};
