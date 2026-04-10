'use strict';

const path = require('path');
const fs = require('fs');
const {
  getKgStatus,
  getKgGraph,
  getKgNodeDetail,
  insertKbNote,
  updateKbNote,
  deleteKbNote,
  getKbNote,
  getKbNoteBySlug,
  queryKbNotes,
  getKbNoteBacklinks,
  getAllKbNoteSlugs,
} = require('../op-db');
const { syncGraph } = require('../op-knowledge-graph');
const {
  slugify,
  slugifyUnique,
  extractBacklinks,
  syncNoteToDisk,
  deleteNoteFromDisk,
  discoverRelevantContent,
} = require('../op-notes');
const { generateAllVaults } = require('../op-vault-generator');

module.exports = async function knowledgeRoutes(app, opts) {
  const { db, config, helpers } = opts;
  const { errorReply } = helpers;

  // ── Knowledge Graph ─────────────────────────────────────────────────────

  app.get('/api/knowledge/status', async () => {
    return getKgStatus(db);
  });

  app.get('/api/knowledge/projects', async () => {
    const projects = db.prepare('SELECT * FROM cl_projects').all();
    return projects.map(p => {
      const vaultCount = db.prepare(
        'SELECT COUNT(*) AS c FROM kg_vault_hashes WHERE project_id = ?'
      ).get(p.project_id).c;
      return { ...p, vault_file_count: vaultCount };
    });
  });

  app.get('/api/knowledge/graph', async (request) => {
    const { type } = request.query;
    return getKgGraph(db, { type });
  });

  app.get('/api/knowledge/config', async () => {
    return {
      knowledge_graph_interval_ms: config.knowledge_graph_interval_ms ?? 300000,
      knowledge_vault_interval_ms: config.knowledge_vault_interval_ms ?? 900000,
      knowledge_enrich_enabled: config.knowledge_enrich_enabled ?? false,
      knowledge_pattern_min_occurrences: config.knowledge_pattern_min_occurrences ?? 5,
      knowledge_session_lookback_days: config.knowledge_session_lookback_days ?? 30,
      knowledge_instinct_min_confidence: config.knowledge_instinct_min_confidence ?? 0.3,
    };
  });

  app.get('/api/knowledge/autocomplete', async (req) => {
    const { project, q } = req.query;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const results = [];
    // Note slugs
    if (project) {
      const slugs = getAllKbNoteSlugs(db, project);
      for (const s of slugs) {
        if (!q || s.includes(q.toLowerCase())) {
          results.push({ type: 'note', value: `notes/${s}`, label: s });
        }
      }
    }
    // Auto-node names from kg_nodes
    const { nodes } = getKgGraph(db);
    for (const n of nodes) {
      if (!q || n.name.toLowerCase().includes(q.toLowerCase()) || n.id.toLowerCase().includes(q.toLowerCase())) {
        const vaultPath = `${n.type}s/${n.name}`;
        results.push({ type: n.type, value: vaultPath, label: n.name });
      }
    }
    return results.slice(0, limit);
  });

  app.get('/api/knowledge/discover', async (req, reply) => {
    const { project, context } = req.query;
    if (!project || !context) return errorReply(reply, 400, 'project and context required');
    return discoverRelevantContent(db, project, context);
  });

  app.get('/api/knowledge/node/:id', async (request, reply) => {
    const { id } = request.params;
    const decoded = decodeURIComponent(id);
    const detail = getKgNodeDetail(db, decoded);
    if (!detail) return errorReply(reply, 404, 'Node not found');
    return detail;
  });

  app.post('/api/knowledge/sync', async () => {
    const result = syncGraph(db, {
      sessionLookbackDays: config.knowledge_session_lookback_days ?? 30,
      instinctMinConfidence: config.knowledge_instinct_min_confidence ?? 0.3,
      minTriggerCount: config.knowledge_pattern_min_occurrences ?? 5,
    });
    return result;
  });

  app.post('/api/knowledge/generate', async (request) => {
    const { project } = request.query || {};
    if (project) {
      const { generateVault } = require('../op-vault-generator');
      return generateVault(db, project);
    }
    return generateAllVaults(db);
  });

  app.post('/api/knowledge/enrich', async () => {
    try {
      const { enrichNodes } = require('../op-knowledge-enricher');
      const result = await enrichNodes(db, {});
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Knowledge Base Notes ────────────────────────────────────────────────

  app.get('/api/knowledge/notes', async (req) => {
    const { project, search, tag, page, per_page } = req.query;
    return queryKbNotes(db, {
      projectId: project || undefined,
      search: search || undefined,
      tag: tag || undefined,
      page: parseInt(page) || 1,
      perPage: parseInt(per_page) || 20,
    });
  });

  app.post('/api/knowledge/notes', async (req, reply) => {
    const { project_id, title, body, tags } = req.body;
    if (!project_id || !title) return errorReply(reply, 400, 'project_id and title required');
    const existingSlugs = getAllKbNoteSlugs(db, project_id);
    const slug = slugifyUnique(title, existingSlugs);
    const id = `note:${crypto.randomUUID()}`;
    const tagsJson = typeof tags === 'string' ? tags : JSON.stringify(tags || []);
    insertKbNote(db, { id, project_id, slug, title, body: body || '', tags: tagsJson });
    const note = getKbNote(db, id);
    // Sync to disk
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(project_id);
    if (project?.directory) syncNoteToDisk(project.directory, note);
    return note;
  });

  app.get('/api/knowledge/notes/:id/backlinks', async (req, reply) => {
    const note = getKbNote(db, req.params.id);
    if (!note) return errorReply(reply, 404, 'Not found');
    return getKbNoteBacklinks(db, note.project_id, note.slug);
  });

  app.get('/api/knowledge/notes/:id', async (req, reply) => {
    const note = getKbNote(db, req.params.id);
    if (!note) return errorReply(reply, 404, 'Not found');
    const backlinks = getKbNoteBacklinks(db, note.project_id, note.slug);
    const refs = extractBacklinks(note.body);
    return { ...note, backlinks, references: refs };
  });

  app.put('/api/knowledge/notes/:id', async (req, reply) => {
    const existing = getKbNote(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Not found');
    const { title, body, tags } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (body !== undefined) fields.body = body;
    if (tags !== undefined) fields.tags = typeof tags === 'string' ? tags : JSON.stringify(tags);
    if (title !== undefined && title !== existing.title) {
      const existingSlugs = getAllKbNoteSlugs(db, existing.project_id).filter(s => s !== existing.slug);
      fields.slug = slugifyUnique(title, existingSlugs);
      // Remove old disk file
      const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
      if (project?.directory) deleteNoteFromDisk(project.directory, existing.slug);
    }
    updateKbNote(db, req.params.id, fields);
    const updated = getKbNote(db, req.params.id);
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
    if (project?.directory) syncNoteToDisk(project.directory, updated);
    return updated;
  });

  app.delete('/api/knowledge/notes/:id', async (req, reply) => {
    const existing = getKbNote(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Not found');
    deleteKbNote(db, req.params.id);
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
    if (project?.directory) deleteNoteFromDisk(project.directory, existing.slug);
    return { deleted: true };
  });
};
