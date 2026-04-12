'use strict';

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

function getProjectSummary(db, projectId) {
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project) return null;
  return { ...project, instinct_count: 0 };
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

function queryLearningActivity(db, days) {
  // cl_instincts has been dropped; return empty activity
  return [];
}

function queryLearningRecent(db, limit) {
  // cl_instincts and suggestions have been dropped; return empty list
  return [];
}

module.exports = {
  upsertClProject,
  getProjectSummary,
  deleteProject,
  queryLearningActivity,
  queryLearningRecent,
};
