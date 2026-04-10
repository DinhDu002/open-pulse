'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-knowledge-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('knowledge_entries', () => {
  let db, dbMod;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbMod = require('../src/op-db');
    db = dbMod.createDb(TEST_DB);

    // Seed a project so entries have a valid project_id
    dbMod.upsertClProject(db, {
      project_id: 'proj-ke-test',
      name: 'KE Test Project',
      directory: TEST_DIR,
      first_seen_at: '2026-04-10T00:00:00Z',
      last_seen_at: '2026-04-10T00:00:00Z',
      session_count: 1,
    });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // insertKnowledgeEntry
  // -------------------------------------------------------------------------

  it('insertKnowledgeEntry inserts and returns entry with correct id prefix and default status', () => {
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Project Domain Overview',
      body:       'This project manages car rental bookings.',
    });

    assert.ok(entry.id.startsWith('ke-'), `id should start with 'ke-', got: ${entry.id}`);
    assert.equal(entry.project_id, 'proj-ke-test');
    assert.equal(entry.category, 'domain');
    assert.equal(entry.title, 'Project Domain Overview');
    assert.equal(entry.status, 'active');
    assert.ok(entry.created_at);
    assert.ok(entry.updated_at);
  });

  // -------------------------------------------------------------------------
  // getKnowledgeEntry
  // -------------------------------------------------------------------------

  it('getKnowledgeEntry returns entry by id', () => {
    const inserted = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'tech-stack',
      title:      'Tech Stack Overview',
      body:       'Node.js, SQLite, Fastify.',
    });

    const fetched = dbMod.getKnowledgeEntry(db, inserted.id);
    assert.ok(fetched, 'should return a row');
    assert.equal(fetched.id, inserted.id);
    assert.equal(fetched.title, 'Tech Stack Overview');
    assert.equal(fetched.category, 'tech-stack');
  });

  it('getKnowledgeEntry returns null for unknown id', () => {
    const result = dbMod.getKnowledgeEntry(db, 'ke-doesnotexist');
    assert.equal(result, null);
  });

  // -------------------------------------------------------------------------
  // upsertKnowledgeEntry
  // -------------------------------------------------------------------------

  it('upsertKnowledgeEntry inserts when no existing entry matches project+title', () => {
    const entry = dbMod.upsertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'api',
      title:      'REST API Purpose',
      body:       'Serves mobile app and web dashboard.',
    });

    assert.ok(entry.id.startsWith('ke-'));
    assert.equal(entry.category, 'api');
    const fetched = dbMod.getKnowledgeEntry(db, entry.id);
    assert.ok(fetched);
    assert.equal(fetched.title, 'REST API Purpose');
  });

  it('upsertKnowledgeEntry updates existing entry with same project+title', () => {
    // Insert initial entry
    const first = dbMod.upsertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Business Rules',
      body:       'Original body.',
    });

    // Upsert with same project_id + title, different body
    const second = dbMod.upsertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Business Rules',
      body:       'Updated body with more detail.',
    });

    // Should reuse the same id
    assert.equal(second.id, first.id);

    // DB should reflect the update
    const fetched = dbMod.getKnowledgeEntry(db, first.id);
    assert.equal(fetched.body, 'Updated body with more detail.');
  });

  // -------------------------------------------------------------------------
  // queryKnowledgeEntries
  // -------------------------------------------------------------------------

  it('queryKnowledgeEntries filters by category', () => {
    // Insert a couple more entries with distinct categories
    dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'database',
      title:      'DB Schema Overview',
      body:       'events table stores tool events.',
    });
    dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'database',
      title:      'DB Indexes',
      body:       'Index on timestamp and session_id.',
    });

    const result = dbMod.queryKnowledgeEntries(db, {
      projectId: 'proj-ke-test',
      category:  'database',
    });

    assert.ok(result.total >= 2, `expected >= 2 database entries, got ${result.total}`);
    assert.ok(result.items.every(e => e.category === 'database'));
  });

  it('queryKnowledgeEntries filters by status', () => {
    // Insert an outdated entry
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Old Domain Fact',
      body:       'This is outdated.',
      status:     'outdated',
    });

    const activeResult = dbMod.queryKnowledgeEntries(db, {
      projectId: 'proj-ke-test',
      status:    'active',
    });
    const outdatedResult = dbMod.queryKnowledgeEntries(db, {
      projectId: 'proj-ke-test',
      status:    'outdated',
    });

    assert.ok(activeResult.items.every(e => e.status === 'active'));
    assert.ok(outdatedResult.items.every(e => e.status === 'outdated'));
    assert.ok(outdatedResult.total >= 1);
    assert.ok(outdatedResult.items.some(e => e.id === entry.id));
  });

  it('queryKnowledgeEntries paginates correctly', () => {
    // We have several entries by now; paginate with perPage=2
    const page1 = dbMod.queryKnowledgeEntries(db, {
      projectId: 'proj-ke-test',
      page:      1,
      perPage:   2,
    });
    const page2 = dbMod.queryKnowledgeEntries(db, {
      projectId: 'proj-ke-test',
      page:      2,
      perPage:   2,
    });

    assert.equal(page1.items.length, 2);
    assert.equal(page1.page, 1);
    assert.equal(page1.perPage, 2);
    assert.ok(page1.total >= 2);

    // Page 2 should have different items than page 1
    const page1Ids = new Set(page1.items.map(e => e.id));
    for (const item of page2.items) {
      assert.ok(!page1Ids.has(item.id), 'page2 should not contain page1 items');
    }
  });

  it('queryKnowledgeEntries clamps page and perPage to safe bounds', () => {
    // page < 1 → clamp to 1
    const r1 = dbMod.queryKnowledgeEntries(db, { page: -5, perPage: 10 });
    assert.equal(r1.page, 1);

    // perPage > 100 → clamp to 100
    const r2 = dbMod.queryKnowledgeEntries(db, { page: 1, perPage: 999 });
    assert.equal(r2.perPage, 100);

    // perPage < 1 → clamp to 1
    const r3 = dbMod.queryKnowledgeEntries(db, { page: 1, perPage: 0 });
    assert.equal(r3.perPage, 1);
  });

  // -------------------------------------------------------------------------
  // getKnowledgeStats
  // -------------------------------------------------------------------------

  it('getKnowledgeStats returns counts by category and status', () => {
    const stats = dbMod.getKnowledgeStats(db, 'proj-ke-test');

    assert.ok(Array.isArray(stats.byCategory));
    assert.ok(Array.isArray(stats.byStatus));
    assert.ok(Array.isArray(stats.byProject));

    // Should have at least 'database' and 'domain' categories
    const categories = stats.byCategory.map(r => r.category);
    assert.ok(categories.includes('database'), 'should include database category');
    assert.ok(categories.includes('domain'), 'should include domain category');

    // Should have 'active' and 'outdated' statuses
    const statuses = stats.byStatus.map(r => r.status);
    assert.ok(statuses.includes('active'), 'should include active status');
    assert.ok(statuses.includes('outdated'), 'should include outdated status');

    // byProject should list our project
    const projectIds = stats.byProject.map(r => r.project_id);
    assert.ok(projectIds.includes('proj-ke-test'));
  });

  // -------------------------------------------------------------------------
  // markKnowledgeEntryOutdated
  // -------------------------------------------------------------------------

  it('markKnowledgeEntryOutdated changes status to outdated', () => {
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'api',
      title:      'API to Mark Outdated',
      body:       'Will be deprecated.',
    });

    assert.equal(entry.status, 'active');

    dbMod.markKnowledgeEntryOutdated(db, entry.id);

    const fetched = dbMod.getKnowledgeEntry(db, entry.id);
    assert.equal(fetched.status, 'outdated');
    assert.ok(fetched.updated_at >= entry.updated_at);
  });

  // -------------------------------------------------------------------------
  // deleteKnowledgeEntry
  // -------------------------------------------------------------------------

  it('deleteKnowledgeEntry removes entry from DB', () => {
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'tech-stack',
      title:      'Entry to Delete',
      body:       'Temporary entry.',
    });

    dbMod.deleteKnowledgeEntry(db, entry.id);

    const fetched = dbMod.getKnowledgeEntry(db, entry.id);
    assert.equal(fetched, null);
  });

  // -------------------------------------------------------------------------
  // getExistingTitles
  // -------------------------------------------------------------------------

  it('getExistingTitles returns active titles only (not outdated)', () => {
    // Insert one active and one outdated entry
    const active = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Active Domain Fact',
      body:       'Still relevant.',
    });
    const outdated = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Outdated Domain Fact',
      body:       'No longer relevant.',
      status:     'outdated',
    });

    const titles = dbMod.getExistingTitles(db, 'proj-ke-test');

    assert.ok(Array.isArray(titles));
    assert.ok(titles.includes('Active Domain Fact'), 'should include active title');
    assert.ok(!titles.includes('Outdated Domain Fact'), 'should not include outdated title');

    // Cleanup
    dbMod.deleteKnowledgeEntry(db, active.id);
    dbMod.deleteKnowledgeEntry(db, outdated.id);
  });

  // -------------------------------------------------------------------------
  // updateKnowledgeEntry
  // -------------------------------------------------------------------------

  it('updateKnowledgeEntry updates specific fields without touching others', () => {
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'domain',
      title:      'Entry to Update',
      body:       'Original body.',
      tags:       ['original'],
    });

    dbMod.updateKnowledgeEntry(db, entry.id, {
      body: 'Updated body.',
      tags: ['updated', 'v2'],
    });

    const fetched = dbMod.getKnowledgeEntry(db, entry.id);
    assert.equal(fetched.body, 'Updated body.');
    assert.equal(fetched.tags, JSON.stringify(['updated', 'v2']));
    // Category unchanged
    assert.equal(fetched.category, 'domain');
    // Title unchanged
    assert.equal(fetched.title, 'Entry to Update');
  });

  // -------------------------------------------------------------------------
  // Tags stored as JSON
  // -------------------------------------------------------------------------

  it('insertKnowledgeEntry stores tags as JSON string (array input)', () => {
    const entry = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category:   'tech-stack',
      title:      'Tags Array Test',
      body:       'Testing tag storage.',
      tags:       ['nodejs', 'sqlite'],
    });

    const fetched = dbMod.getKnowledgeEntry(db, entry.id);
    assert.equal(fetched.tags, JSON.stringify(['nodejs', 'sqlite']));
  });
});
