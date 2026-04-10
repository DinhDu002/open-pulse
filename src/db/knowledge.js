'use strict';

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

const keModule = require('./knowledge-entries');

module.exports = {
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
  ...keModule,
};
