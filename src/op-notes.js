'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(title) {
  return title
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-');            // collapse multiple hyphens
}

function slugifyUnique(title, existingSlugs) {
  const base = slugify(title);
  if (!existingSlugs.includes(base)) return base;
  let i = 2;
  while (existingSlugs.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------------------------------------------------------------------------
// Backlink extraction
// ---------------------------------------------------------------------------

function extractBacklinks(body) {
  const matches = body.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  const seen = new Set();
  const result = [];
  for (const m of matches) {
    const ref = m.slice(2, -2);
    if (!seen.has(ref)) {
      seen.add(ref);
      result.push(ref);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Disk sync
// ---------------------------------------------------------------------------

function syncNoteToDisk(projectDir, note) {
  const notesDir = path.join(projectDir, '.claude', 'knowledge', 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  const tags = typeof note.tags === 'string' ? JSON.parse(note.tags) : note.tags;
  const tagsYaml = tags.length
    ? 'tags: [' + tags.join(', ') + ']'
    : 'tags: []';

  const content = [
    '---',
    'type: note',
    `title: ${note.title}`,
    tagsYaml,
    `created_at: ${note.created_at}`,
    `updated_at: ${note.updated_at}`,
    '---',
    '',
    note.body,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(notesDir, `${note.slug}.md`), content, 'utf8');
}

function deleteNoteFromDisk(projectDir, slug) {
  const filePath = path.join(projectDir, '.claude', 'knowledge', 'notes', `${slug}.md`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function discoverRelevantContent(db, projectId, context) {
  const contextTokens = tokenize(context);
  if (contextTokens.length === 0) return [];

  const dbMod = require('./op-db');
  const results = [];

  // Score notes
  const { items: allNotes } = dbMod.queryKbNotes(db, { projectId, page: 1, perPage: 1000 });
  for (const note of allNotes) {
    let score = 0;
    const titleTokens = tokenize(note.title);
    const bodyTokens = tokenize(note.body);
    const tags = typeof note.tags === 'string' ? JSON.parse(note.tags) : note.tags;

    for (const ct of contextTokens) {
      if (titleTokens.some(t => t.includes(ct) || ct.includes(t))) score += 2;
      if (bodyTokens.some(t => t.includes(ct) || ct.includes(t))) score += 1;
      if (tags.some(t => t.toLowerCase().includes(ct))) score += 3;
    }
    if (score > 0) {
      results.push({
        type: 'note',
        id: note.id,
        title: note.title,
        excerpt: note.body.slice(0, 150),
        score,
        path: `notes/${note.slug}.md`,
      });
    }
  }

  // Score auto-generated kg_nodes
  const { nodes } = dbMod.getKgGraph(db);
  for (const node of nodes) {
    let score = 0;
    const nameTokens = tokenize(node.name);
    for (const ct of contextTokens) {
      if (nameTokens.some(t => t.includes(ct) || ct.includes(t))) score += 2;
    }
    if (score > 0) {
      results.push({
        type: node.type,
        id: node.id,
        title: node.name,
        excerpt: '',
        score,
        path: `${node.type}s/${node.name}.md`,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  slugify,
  slugifyUnique,
  extractBacklinks,
  syncNoteToDisk,
  deleteNoteFromDisk,
  discoverRelevantContent,
};
