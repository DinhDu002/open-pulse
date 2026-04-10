'use strict';

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
  // If directory already exists under a different project_id, remove old row
  if (proj.directory) {
    const old = db.prepare(
      'SELECT project_id FROM cl_projects WHERE directory = ? AND project_id != ?'
    ).get(proj.directory, proj.project_id);
    if (old) {
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
      session_count = excluded.session_count
  `).run(proj);
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

function updatePromptTokens(db, promptId, tokens) {
  db.prepare('UPDATE prompts SET total_tokens = @tokens WHERE id = @id')
    .run({ id: promptId, tokens });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function upsertComponent(db, comp) {
  db.prepare(`
    INSERT INTO components
      (type, name, source, plugin, project, file_path, description, agent_class,
       first_seen_at, last_seen_at)
    VALUES
      (@type, @name, @source, @plugin, @project, @file_path, @description, @agent_class,
       @first_seen_at, @last_seen_at)
    ON CONFLICT(type, name, source, COALESCE(plugin, ''), COALESCE(project, '')) DO UPDATE SET
      file_path    = excluded.file_path,
      description  = excluded.description,
      agent_class  = excluded.agent_class,
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
// Scan results
// ---------------------------------------------------------------------------

function insertScanResult(db, scan) {
  db.prepare(`
    INSERT INTO scan_results
      (scanned_at, report, total_skills, total_agents,
       issues_critical, issues_high, issues_medium, issues_low)
    VALUES
      (@scanned_at, @report, @total_skills, @total_agents,
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
// Learning API — Projects
// ---------------------------------------------------------------------------

function getProjectSummary(db, projectId) {
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project) return null;
  return { ...project, instinct_count: 0 };
}

function getProjectTimeline(db, projectId, weeks) {
  // cl_instincts has been dropped; return empty timeline
  return [];
}

function deleteProject(db, projectId) {
  const tx = db.transaction(() => {
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
  // cl_instincts has been dropped; return empty activity
  return [];
}

function queryLearningRecent(db, limit) {
  // cl_instincts and suggestions have been dropped; return empty list
  return [];
}

module.exports = {
  logError,
  upsertClProject,
  insertPrompt,
  getLatestPromptForSession,
  updatePromptStats,
  updatePromptTokens,
  upsertComponent,
  deleteComponentsNotSeenSince,
  getComponentsByType,
  getAllComponents,
  insertScanResult,
  getLatestScan,
  getScanHistory,
  getProjectSummary,
  getProjectTimeline,
  deleteProject,
  queryLearningActivity,
  queryLearningRecent,
};
