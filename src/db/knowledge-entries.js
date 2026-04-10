'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(projectId, title) {
  const now = Date.now();
  const hash = crypto
    .createHash('sha256')
    .update(`${projectId}::${title}::${now}`)
    .digest('hex')
    .slice(0, 16);
  return `ke-${hash}`;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return JSON.stringify(tags);
  if (typeof tags === 'string') return tags;
  return '[]';
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

function insertKnowledgeEntry(db, entry) {
  const now = new Date().toISOString();
  const id = entry.id || makeId(entry.project_id, entry.title);
  const row = {
    id,
    project_id:       entry.project_id,
    category:         entry.category,
    title:            entry.title,
    body:             entry.body || '',
    source_file:      entry.source_file || null,
    source_prompt_id: entry.source_prompt_id || null,
    tags:             normalizeTags(entry.tags),
    status:           entry.status || 'active',
    created_at:       entry.created_at || now,
    updated_at:       entry.updated_at || now,
  };
  db.prepare(`
    INSERT INTO knowledge_entries
      (id, project_id, category, title, body, source_file, source_prompt_id,
       tags, status, created_at, updated_at)
    VALUES
      (@id, @project_id, @category, @title, @body, @source_file, @source_prompt_id,
       @tags, @status, @created_at, @updated_at)
  `).run(row);
  return row;
}

// ---------------------------------------------------------------------------
// Upsert — update by (project_id, title) if exists, insert otherwise
// ---------------------------------------------------------------------------

function upsertKnowledgeEntry(db, entry) {
  const existing = db.prepare(
    'SELECT * FROM knowledge_entries WHERE project_id = @project_id AND title = @title COLLATE NOCASE'
  ).get({ project_id: entry.project_id, title: entry.title });

  if (existing) {
    const now = new Date().toISOString();
    const params = {
      id:               existing.id,
      body:             entry.body !== undefined ? entry.body : existing.body,
      category:         entry.category !== undefined ? entry.category : existing.category,
      source_file:      entry.source_file !== undefined ? entry.source_file : existing.source_file,
      source_prompt_id: entry.source_prompt_id !== undefined ? entry.source_prompt_id : existing.source_prompt_id,
      tags:             entry.tags !== undefined ? normalizeTags(entry.tags) : existing.tags,
      status:           entry.status !== undefined ? entry.status : existing.status,
      updated_at:       now,
    };
    db.prepare(`
      UPDATE knowledge_entries SET
        body             = @body,
        category         = @category,
        source_file      = @source_file,
        source_prompt_id = @source_prompt_id,
        tags             = @tags,
        status           = @status,
        updated_at       = @updated_at
      WHERE id = @id
    `).run(params);
    return { ...existing, ...params };
  }

  return insertKnowledgeEntry(db, entry);
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

function getKnowledgeEntry(db, id) {
  return db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) || null;
}

// ---------------------------------------------------------------------------
// Query (paginated + filters)
// ---------------------------------------------------------------------------

function queryKnowledgeEntries(db, opts = {}) {
  const { projectId, category, status, search } = opts;
  let { page = 1, perPage = 20 } = opts;
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 100);

  const conditions = [];
  const params = {};

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }
  if (category) {
    conditions.push('category = @category');
    params.category = category;
  }
  if (status) {
    conditions.push('status = @status');
    params.status = status;
  }
  if (search) {
    conditions.push('(title LIKE @search OR body LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM knowledge_entries ${where}`).get(params).c;
  const items = db.prepare(
    `SELECT * FROM knowledge_entries ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  return { items, total, page, perPage };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function getKnowledgeStats(db, projectId) {
  const params = projectId ? { projectId } : {};
  const where = projectId ? 'WHERE project_id = @projectId' : '';

  const byCategory = db.prepare(
    `SELECT category, COUNT(*) AS count FROM knowledge_entries ${where} GROUP BY category`
  ).all(params);

  const byStatus = db.prepare(
    `SELECT status, COUNT(*) AS count FROM knowledge_entries ${where} GROUP BY status`
  ).all(params);

  const byProject = db.prepare(
    'SELECT project_id, COUNT(*) AS count FROM knowledge_entries GROUP BY project_id'
  ).all();

  return { byCategory, byStatus, byProject };
}

// ---------------------------------------------------------------------------
// Status mutations
// ---------------------------------------------------------------------------

function markKnowledgeEntryOutdated(db, id) {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE knowledge_entries SET status = @status, updated_at = @updated_at WHERE id = @id'
  ).run({ id, status: 'outdated', updated_at: now });
}

function deleteKnowledgeEntry(db, id) {
  db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
}

function purgeKnowledgeEntries(db, projectId) {
  const result = db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(projectId);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Helpers for dedup
// ---------------------------------------------------------------------------

function getExistingTitles(db, projectId) {
  return db.prepare(
    "SELECT title FROM knowledge_entries WHERE project_id = ? AND status = 'active'"
  ).all(projectId).map(r => r.title);
}

// ---------------------------------------------------------------------------
// Update specific fields
// ---------------------------------------------------------------------------

function updateKnowledgeEntry(db, id, fields) {
  const now = new Date().toISOString();
  const allowed = ['body', 'category', 'title', 'source_file', 'source_prompt_id', 'tags', 'status'];
  const sets = ['updated_at = @updated_at'];
  const params = { id, updated_at: now };

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = key === 'tags' ? normalizeTags(fields[key]) : fields[key];
    }
  }

  db.prepare(`UPDATE knowledge_entries SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  makeId,
  insertKnowledgeEntry,
  upsertKnowledgeEntry,
  getKnowledgeEntry,
  queryKnowledgeEntries,
  getKnowledgeStats,
  markKnowledgeEntryOutdated,
  deleteKnowledgeEntry,
  purgeKnowledgeEntries,
  getExistingTitles,
  updateKnowledgeEntry,
};
