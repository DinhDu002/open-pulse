'use strict';

const crypto = require('crypto');

const {
  getKnowledgeEntry,
  queryKnowledgeEntries,
  getKnowledgeStats,
  markKnowledgeEntryOutdated,
  deleteKnowledgeEntry,
  updateKnowledgeEntry,
} = require('../db/knowledge-entries');

const { scanProject } = require('../op-knowledge');

const {
  getAllKbNoteSlugs,
  insertKbNote,
  updateKbNote,
  deleteKbNote,
  getKbNote,
  queryKbNotes,
  getKbNoteBacklinks,
} = require('../op-db');

const {
  slugify,
  slugifyUnique,
  extractBacklinks,
  syncNoteToDisk,
  deleteNoteFromDisk,
  discoverRelevantContent,
} = require('../op-notes');

module.exports = async function knowledgeRoutes(app, opts) {
  const { db, helpers } = opts;
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
    markKnowledgeEntryOutdated(db, req.params.id);
    return getKnowledgeEntry(db, req.params.id);
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
      scanFiles: scan_files || [],
      patterns:  patterns  || [],
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

    // KB note slugs
    if (project) {
      const slugs = getAllKbNoteSlugs(db, project);
      for (const s of slugs) {
        if (!q || s.includes(q.toLowerCase())) {
          results.push({ type: 'note', value: `notes/${s}`, label: s });
        }
      }
    }

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

  // ── Discover ────────────────────────────────────────────────────────────

  app.get('/api/knowledge/discover', async (req, reply) => {
    const { project, context } = req.query;
    if (!project || !context) return errorReply(reply, 400, 'project and context required');
    return discoverRelevantContent(db, project, context);
  });

  // ── Knowledge Base Notes ────────────────────────────────────────────────

  app.get('/api/knowledge/notes', async (req) => {
    const { project, search, tag, page, per_page } = req.query;
    return queryKbNotes(db, {
      projectId: project || undefined,
      search:    search  || undefined,
      tag:       tag     || undefined,
      page:      parseInt(page) || 1,
      perPage:   parseInt(per_page) || 20,
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
    if (body !== undefined)  fields.body  = body;
    if (tags !== undefined)  fields.tags  = typeof tags === 'string' ? tags : JSON.stringify(tags);
    if (title !== undefined && title !== existing.title) {
      const existingSlugs = getAllKbNoteSlugs(db, existing.project_id).filter(s => s !== existing.slug);
      fields.slug = slugifyUnique(title, existingSlugs);
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
