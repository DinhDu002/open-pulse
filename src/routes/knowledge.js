'use strict';

const {
  getKnowledgeEntry,
  queryKnowledgeEntries,
  getKnowledgeStats,
  deleteKnowledgeEntry,
  purgeKnowledgeEntries,
  updateKnowledgeEntry,
  insertEntryHistory,
} = require('../db/knowledge-entries');

const { scanProject } = require('../knowledge/scan');

module.exports = async function knowledgeRoutes(app, opts) {
  const { db, helpers, config } = opts;
  const { errorReply, parsePagination } = helpers;

  // ── Knowledge Entries ────────────────────────────────────────────────────

  // IMPORTANT: register /stats before /:id to avoid treating "stats" as :id
  app.get('/api/knowledge/entries/stats', async (req) => {
    const { project } = req.query;
    return getKnowledgeStats(db, project || undefined);
  });

  app.get('/api/knowledge/entries', async (req) => {
    const { project, category, status, search } = req.query;
    const { page, perPage } = parsePagination(req.query);
    return queryKnowledgeEntries(db, {
      projectId: project || undefined,
      category:  category || undefined,
      status:    status || undefined,
      search:    search || undefined,
      page,
      perPage,
    });
  });

  app.get('/api/knowledge/entries/:id', async (req, reply) => {
    const entry = getKnowledgeEntry(db, req.params.id);
    if (!entry) return errorReply(reply, 404, 'Entry not found');
    return entry;
  });

  app.put('/api/knowledge/entries/:id', async (req, reply) => {
    const existing = getKnowledgeEntry(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Entry not found');
    // Record snapshot of state before update
    insertEntryHistory(db, {
      entry_id: existing.id,
      change_type: 'updated',
      snapshot: { title: existing.title, body: existing.body, category: existing.category, status: existing.status },
    });
    const { title, body, tags, category } = req.body || {};
    const fields = {};
    if (title !== undefined)    fields.title    = title;
    if (body !== undefined)     fields.body     = body;
    if (tags !== undefined)     fields.tags     = tags;
    if (category !== undefined) fields.category = category;
    updateKnowledgeEntry(db, req.params.id, fields);
    return getKnowledgeEntry(db, req.params.id);
  });

  app.put('/api/knowledge/entries/:id/outdated', async (req, reply) => {
    const existing = getKnowledgeEntry(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Entry not found');
    // Record snapshot of state before status change
    insertEntryHistory(db, {
      entry_id: existing.id,
      change_type: 'status_changed',
      snapshot: { title: existing.title, body: existing.body, category: existing.category, status: existing.status },
    });
    const newStatus = existing.status === 'outdated' ? 'active' : 'outdated';
    updateKnowledgeEntry(db, req.params.id, { status: newStatus });
    return getKnowledgeEntry(db, req.params.id);
  });

  // IMPORTANT: register /purge before /:id to avoid "purge" being captured as :id
  app.delete('/api/knowledge/entries/purge', async (req, reply) => {
    const { project } = req.query;
    if (!project) return errorReply(reply, 400, 'project query parameter required');

    const purged = purgeKnowledgeEntries(db, project);

    // Also clear vault hashes so files get regenerated on next scan
    db.prepare('DELETE FROM kg_vault_hashes WHERE project_id = ?').run(project);

    return { purged };
  });

  app.delete('/api/knowledge/entries/:id', async (req, reply) => {
    const existing = getKnowledgeEntry(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Entry not found');
    deleteKnowledgeEntry(db, req.params.id);
    return { deleted: true };
  });

  // ── Scan ────────────────────────────────────────────────────────────────

  app.post('/api/knowledge/scan', async (req, reply) => {
    const { project_id, scan_files, patterns } = req.body || {};
    if (!project_id) return errorReply(reply, 400, 'project_id required');
    const result = await scanProject(db, project_id, {
      scanFiles: scan_files || config.knowledge_scan_files || ['README.md', 'package.json', 'CLAUDE.md'],
      patterns:  patterns  || config.knowledge_scan_patterns || [],
      model: config.knowledge_model || 'sonnet',
    });
    return result;
  });

  // ── Projects ────────────────────────────────────────────────────────────

  app.get('/api/knowledge/projects', async () => {
    const projects = db.prepare('SELECT * FROM cl_projects').all();
    return projects.map(p => {
      const entryCount = db.prepare(
        'SELECT COUNT(*) AS c FROM knowledge_entries WHERE project_id = ?'
      ).get(p.project_id).c;
      const vaultCount = db.prepare(
        'SELECT COUNT(*) AS c FROM kg_vault_hashes WHERE project_id = ?'
      ).get(p.project_id).c;
      return { ...p, entry_count: entryCount, vault_file_count: vaultCount };
    });
  });

  // ── Autocomplete ────────────────────────────────────────────────────────

  app.get('/api/knowledge/autocomplete', async (req) => {
    const { project, q } = req.query;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const results = [];

    // Active knowledge entry titles
    const { items } = queryKnowledgeEntries(db, {
      projectId: project || undefined,
      search:    q || undefined,
      status:    'active',
      perPage:   limit,
    });
    for (const entry of items) {
      results.push({ type: 'entry', value: `entries/${entry.id}`, label: entry.title });
    }

    return results.slice(0, limit);
  });
};
