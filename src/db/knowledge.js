'use strict';

// ---------------------------------------------------------------------------
// Vault hash helpers (kg_vault_hashes table — reused by knowledge entries)
// ---------------------------------------------------------------------------

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

const keModule = require('./knowledge-entries');

module.exports = {
  upsertKgVaultHash,
  getKgVaultHash,
  getKgVaultHashes,
  setKgSyncState,
  getKgSyncState,
  insertKbNote,
  updateKbNote,
  deleteKbNote,
  getKbNote,
  getKbNoteBySlug,
  queryKbNotes,
  getKbNoteBacklinks,
  getAllKbNoteSlugs,
  ...keModule,
};
