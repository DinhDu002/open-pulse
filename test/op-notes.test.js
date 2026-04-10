'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-notes-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const PROJ_DIR = path.join(TEST_DIR, 'fake-project');

describe('op-notes', () => {
  let db, dbMod, notes;

  before(() => {
    fs.mkdirSync(PROJ_DIR, { recursive: true });
    dbMod = require('../src/op-db');
    notes = require('../src/op-notes');
    db = dbMod.createDb(TEST_DB);

    // Seed a project so notes have a valid project_id
    dbMod.upsertClProject(db, {
      project_id: 'proj-test',
      name: 'Test Project',
      directory: PROJ_DIR,
      first_seen_at: '2026-04-08T00:00:00Z',
      last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 1,
    });

  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // --- slugify ---

  it('slugify converts title to URL-safe slug', () => {
    assert.equal(notes.slugify('API Patterns'), 'api-patterns');
    assert.equal(notes.slugify('Hello  World!'), 'hello-world');
    assert.equal(notes.slugify('  Trim Me  '), 'trim-me');
    assert.equal(notes.slugify('Tiếng Việt có dấu'), 'tieng-viet-co-dau');
    assert.equal(notes.slugify('a--b--c'), 'a-b-c');
  });

  // --- extractBacklinks ---

  it('extractBacklinks extracts [[...]] references from markdown', () => {
    const body = 'Use [[tools/Read]] and [[notes/api-patterns]] for reference. Also see [[component:code-reviewer]].';
    const links = notes.extractBacklinks(body);
    assert.deepEqual(links, ['tools/Read', 'notes/api-patterns', 'component:code-reviewer']);
  });

  it('extractBacklinks returns empty array for no backlinks', () => {
    assert.deepEqual(notes.extractBacklinks('No links here'), []);
  });

  it('extractBacklinks deduplicates repeated links', () => {
    const body = '[[tools/Read]] and again [[tools/Read]]';
    const links = notes.extractBacklinks(body);
    assert.deepEqual(links, ['tools/Read']);
  });

  // --- CRUD via DB functions ---

  it('insertKbNote + getKbNote round-trip', () => {
    const note = {
      id: 'note:test-1',
      project_id: 'proj-test',
      slug: 'api-patterns',
      title: 'API Patterns',
      body: '# API Patterns\n\nSome content with [[tools/Read]].',
      tags: JSON.stringify(['api', 'architecture']),
    };
    dbMod.insertKbNote(db, note);
    const fetched = dbMod.getKbNote(db, 'note:test-1');
    assert.equal(fetched.title, 'API Patterns');
    assert.equal(fetched.slug, 'api-patterns');
    assert.equal(fetched.project_id, 'proj-test');
    assert.ok(fetched.created_at);
    assert.ok(fetched.updated_at);
  });

  it('getKbNoteBySlug finds note by project + slug', () => {
    const fetched = dbMod.getKbNoteBySlug(db, 'proj-test', 'api-patterns');
    assert.equal(fetched.id, 'note:test-1');
    assert.equal(fetched.title, 'API Patterns');
  });

  it('updateKbNote updates fields', () => {
    dbMod.updateKbNote(db, 'note:test-1', {
      title: 'API Patterns v2',
      body: '# Updated\n\nNew content.',
      tags: JSON.stringify(['api']),
    });
    const fetched = dbMod.getKbNote(db, 'note:test-1');
    assert.equal(fetched.title, 'API Patterns v2');
    assert.ok(fetched.body.includes('Updated'));
  });

  it('queryKbNotes returns paginated results with search', () => {
    // Insert a second note
    dbMod.insertKbNote(db, {
      id: 'note:test-2',
      project_id: 'proj-test',
      slug: 'deployment-guide',
      title: 'Deployment Guide',
      body: '# Deployment\n\nHow to deploy.',
      tags: JSON.stringify(['ops']),
    });

    // Query all for project
    const all = dbMod.queryKbNotes(db, { projectId: 'proj-test', page: 1, perPage: 10 });
    assert.equal(all.total, 2);
    assert.equal(all.items.length, 2);

    // Search by keyword
    const searched = dbMod.queryKbNotes(db, { projectId: 'proj-test', search: 'deploy', page: 1, perPage: 10 });
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0].slug, 'deployment-guide');

    // Filter by tag
    const tagged = dbMod.queryKbNotes(db, { projectId: 'proj-test', tag: 'api', page: 1, perPage: 10 });
    assert.equal(tagged.total, 1);
    assert.equal(tagged.items[0].slug, 'api-patterns');
  });

  it('queryKbNotes paginates correctly', () => {
    const page1 = dbMod.queryKbNotes(db, { projectId: 'proj-test', page: 1, perPage: 1 });
    assert.equal(page1.items.length, 1);
    assert.equal(page1.total, 2);

    const page2 = dbMod.queryKbNotes(db, { projectId: 'proj-test', page: 2, perPage: 1 });
    assert.equal(page2.items.length, 1);
    assert.notEqual(page1.items[0].id, page2.items[0].id);
  });

  it('getKbNoteBacklinks finds notes linking to a slug', () => {
    // note:test-1 body contains [[tools/Read]] — not a note backlink
    // Insert a note that links to api-patterns
    dbMod.insertKbNote(db, {
      id: 'note:test-3',
      project_id: 'proj-test',
      slug: 'overview',
      title: 'Overview',
      body: 'See [[notes/api-patterns]] for API details.',
      tags: '[]',
    });

    const backlinks = dbMod.getKbNoteBacklinks(db, 'proj-test', 'api-patterns');
    assert.equal(backlinks.length, 1);
    assert.equal(backlinks[0].slug, 'overview');
  });

  it('getAllKbNoteSlugs returns all slugs for a project', () => {
    const slugs = dbMod.getAllKbNoteSlugs(db, 'proj-test');
    assert.ok(slugs.includes('api-patterns'));
    assert.ok(slugs.includes('deployment-guide'));
    assert.ok(slugs.includes('overview'));
  });

  it('deleteKbNote removes the note', () => {
    dbMod.deleteKbNote(db, 'note:test-3');
    const fetched = dbMod.getKbNote(db, 'note:test-3');
    assert.equal(fetched, null);
  });

  // --- Disk sync ---

  it('syncNoteToDisk writes .md file with correct frontmatter', () => {
    const note = dbMod.getKbNote(db, 'note:test-1');
    notes.syncNoteToDisk(PROJ_DIR, note);

    const filePath = path.join(PROJ_DIR, '.claude', 'knowledge', 'notes', 'api-patterns.md');
    assert.ok(fs.existsSync(filePath), 'file should exist');

    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('type: note'), 'should have type frontmatter');
    assert.ok(content.includes('title: API Patterns v2'), 'should have title');
    assert.ok(content.includes('tags:'), 'should have tags');
    assert.ok(content.includes('# Updated'), 'should have body content');
  });

  it('deleteNoteFromDisk removes the .md file', () => {
    notes.deleteNoteFromDisk(PROJ_DIR, 'api-patterns');
    const filePath = path.join(PROJ_DIR, '.claude', 'knowledge', 'notes', 'api-patterns.md');
    assert.ok(!fs.existsSync(filePath), 'file should be removed');
  });

  // --- Discovery ---

  it('discoverRelevantContent returns scored results matching context', () => {
    // Ensure note:test-1 still exists (was updated, not deleted from DB)
    const results = notes.discoverRelevantContent(db, 'proj-test', 'API patterns deployment');
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, 'should be sorted by score desc');
    }
    // Should find notes matching keywords
    const slugs = results.map(r => r.title);
    assert.ok(slugs.some(s => s.includes('API') || s.includes('Deployment')));
  });

  // --- Slug collision ---

  it('slugify handles collision with existing slugs via suffix', () => {
    const existing = ['api-patterns', 'api-patterns-2'];
    const slug = notes.slugifyUnique('API Patterns', existing);
    assert.equal(slug, 'api-patterns-3');
  });

  it('slugifyUnique returns base slug when no collision', () => {
    const slug = notes.slugifyUnique('Brand New Note', []);
    assert.equal(slug, 'brand-new-note');
  });
});
