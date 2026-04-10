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

module.exports = {
  logError,
  upsertComponent,
  deleteComponentsNotSeenSince,
  getComponentsByType,
  getAllComponents,
};
