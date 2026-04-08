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

module.exports = {
  logError,
  upsertClProject,
  insertPrompt,
  getLatestPromptForSession,
  updatePromptStats,
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
