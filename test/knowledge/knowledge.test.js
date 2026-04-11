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
    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    const keModule = require('../../src/db/knowledge-entries');
    dbMod = { createDb, upsertClProject, ...keModule };
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

  it('upsertKnowledgeEntry matches existing entry case-insensitively', () => {
    // Insert with Title Case
    const first = dbMod.upsertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category: 'convention',
      title: 'Case Insensitive Upsert Test',
      body: 'Original body.',
    });

    // Wait 1ms to ensure updated_at differs
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }

    // Upsert with lowercase — should UPDATE, not INSERT
    const second = dbMod.upsertKnowledgeEntry(db, {
      project_id: 'proj-ke-test',
      category: 'convention',
      title: 'case insensitive upsert test',
      body: 'Updated body via case-variant title.',
    });

    // Should reuse the same id
    assert.equal(second.id, first.id, 'should match the same entry regardless of case');

    // DB should reflect the update
    const fetched = dbMod.getKnowledgeEntry(db, first.id);
    assert.equal(fetched.body, 'Updated body via case-variant title.');
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

    assert.ok(typeof stats.total === 'number', 'total should be a number');
    assert.ok(stats.total > 0, 'total should be > 0');
    assert.ok(Array.isArray(stats.by_category));
    assert.ok(Array.isArray(stats.by_status));
    assert.ok(Array.isArray(stats.by_project));

    // Should have at least 'database' and 'domain' categories
    const categories = stats.by_category.map(r => r.category);
    assert.ok(categories.includes('database'), 'should include database category');
    assert.ok(categories.includes('domain'), 'should include domain category');

    // Should have 'active' and 'outdated' statuses
    const statuses = stats.by_status.map(r => r.status);
    assert.ok(statuses.includes('active'), 'should include active status');
    assert.ok(statuses.includes('outdated'), 'should include outdated status');

    // by_project should list our project
    const projectIds = stats.by_project.map(r => r.project_id);
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

  // -------------------------------------------------------------------------
  // knowledge_entry_history
  // -------------------------------------------------------------------------

  describe('knowledge_entry_history', () => {
    it('insertEntryHistory records a snapshot and getEntryHistory retrieves it', () => {
      const entry = dbMod.insertKnowledgeEntry(db, {
        project_id: 'proj-ke-test',
        category: 'footgun',
        title: 'History Test Entry',
        body: 'Original body',
      });

      dbMod.insertEntryHistory(db, {
        entry_id: entry.id,
        change_type: 'created',
        snapshot: { title: entry.title, body: entry.body, category: entry.category, status: entry.status },
      });

      const history = dbMod.getEntryHistory(db, entry.id);
      assert.equal(history.length, 1);
      assert.equal(history[0].entry_id, entry.id);
      assert.equal(history[0].change_type, 'created');
      const snap = JSON.parse(history[0].snapshot);
      assert.equal(snap.title, 'History Test Entry');
      assert.equal(snap.body, 'Original body');
      assert.ok(history[0].changed_at);
    });

    it('getEntryHistory returns multiple snapshots in chronological order', () => {
      const entry = dbMod.insertKnowledgeEntry(db, {
        project_id: 'proj-ke-test',
        category: 'api',
        title: 'Multi History Entry',
        body: 'v1',
      });

      dbMod.insertEntryHistory(db, {
        entry_id: entry.id,
        change_type: 'created',
        snapshot: { title: 'Multi History Entry', body: 'v1', category: 'api', status: 'active' },
      });
      dbMod.insertEntryHistory(db, {
        entry_id: entry.id,
        change_type: 'updated',
        snapshot: { title: 'Multi History Entry', body: 'v2', category: 'api', status: 'active' },
      });

      const history = dbMod.getEntryHistory(db, entry.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].change_type, 'created');
      assert.equal(history[1].change_type, 'updated');
      assert.ok(history[0].changed_at <= history[1].changed_at);
    });

    it('getEntryHistory returns empty array for entry with no history', () => {
      const history = dbMod.getEntryHistory(db, 'nonexistent-id');
      assert.deepEqual(history, []);
    });
  });

  // -------------------------------------------------------------------------
  // buildExistingEntriesBlock
  // -------------------------------------------------------------------------

  describe('buildExistingEntriesBlock', () => {
    it('returns full body for entries matching affected files', () => {
      dbMod.insertKnowledgeEntry(db, {
        project_id: 'proj-ke-test',
        category: 'stack',
        title: 'Knowledge Extraction Uses Sonnet',
        body: 'When running extraction, the pipeline uses Haiku model. Consequence: cheaper but less accurate.',
        source_file: 'src/knowledge/extract.js',
      });
      dbMod.insertKnowledgeEntry(db, {
        project_id: 'proj-ke-test',
        category: 'architecture',
        title: 'Frontend serves static files',
        body: 'The frontend is served by Fastify static plugin from public/. Consequence: no CORS needed.',
        source_file: 'src/server.js',
      });

      const { buildExistingEntriesBlock } = require('../../src/knowledge/extract');
      const block = buildExistingEntriesBlock(db, 'proj-ke-test', ['src/knowledge/extract.js']);

      assert.ok(block.includes('Knowledge Extraction Uses Sonnet'));
      assert.ok(block.includes('Haiku model'));
      assert.ok(block.includes('UPDATE'));
      assert.ok(block.includes('Frontend serves static files'));
    });

    it('returns empty string when no entries exist', () => {
      const { buildExistingEntriesBlock } = require('../../src/knowledge/extract');
      const block = buildExistingEntriesBlock(db, 'nonexistent-project', []);
      assert.equal(block, '');
    });
  });
});

// =============================================================================
// op-knowledge module
// =============================================================================

describe('op-knowledge', () => {
  const { buildExtractPrompt, mergeOrUpdate, parseJsonResponse } = require('../../src/knowledge/extract');
  const { buildScanPrompt } = require('../../src/knowledge/scan');
  const { renderKnowledgeVault, renderCategoryPage, renderIndexPage, CATEGORY_FILES, CATEGORY_TITLES } = require('../../src/knowledge/vault');

  // ---------------------------------------------------------------------------
  // Shared test DB (separate from the knowledge_entries describe above)
  // ---------------------------------------------------------------------------

  let db, dbMod2;
  let TEST_REPO_DIR;

  before(() => {
    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');
    dbMod2 = { createDb, upsertClProject, insertKnowledgeEntry };

    // A second temp dir for this describe block's DB
    const dir2 = path.join(os.tmpdir(), `op-knowledge-mod-test-${Date.now()}`);
    fs.mkdirSync(dir2, { recursive: true });
    db = dbMod2.createDb(path.join(dir2, 'mod-test.db'));

    // Create a temp "git repo" dir for vault tests
    TEST_REPO_DIR = path.join(dir2, 'fake-repo');
    fs.mkdirSync(path.join(TEST_REPO_DIR, '.git'), { recursive: true });

    // Seed project pointing at the fake repo
    dbMod2.upsertClProject(db, {
      project_id:   'proj-km-test',
      name:         'KM Test Project',
      directory:    TEST_REPO_DIR,
      first_seen_at: '2026-04-10T00:00:00Z',
      last_seen_at:  '2026-04-10T00:00:00Z',
      session_count: 1,
    });
  });

  after(() => {
    if (db) db.close();
    if (TEST_REPO_DIR) fs.rmSync(path.dirname(TEST_REPO_DIR), { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // buildExtractPrompt
  // ---------------------------------------------------------------------------

  describe('buildExtractPrompt', () => {
    it('includes project name in the prompt', () => {
      const prompt = buildExtractPrompt('MyProject', [], []);
      assert.ok(prompt.includes('MyProject'), 'should include project name');
    });

    it('includes existing titles for dedup', () => {
      const prompt = buildExtractPrompt('Proj', [], ['Existing Title A', 'Existing Title B']);
      assert.ok(prompt.includes('Existing Title A'), 'should include existing title A');
      assert.ok(prompt.includes('Existing Title B'), 'should include existing title B');
    });

    it('includes event type and name', () => {
      const events = [
        { name: 'Read', event_type: 'tool_call', tool_input: null, tool_response: null },
      ];
      const prompt = buildExtractPrompt('Proj', events, []);
      assert.ok(prompt.includes('tool_call'), 'should include event type');
      assert.ok(prompt.includes('Read'), 'should include tool name');
    });

    it('extracts file_path from tool_input JSON', () => {
      const events = [
        {
          name: 'Read',
          event_type: 'tool_call',
          tool_input: JSON.stringify({ file_path: '/src/op-ingest.js' }),
          tool_response: 'file contents here',
        },
      ];
      const prompt = buildExtractPrompt('Proj', events, []);
      assert.ok(prompt.includes('/src/op-ingest.js'), 'should include file_path from tool_input JSON');
    });

    it('truncates tool_response to 300 chars', () => {
      const longResponse = 'x'.repeat(500);
      const events = [
        { name: 'Read', event_type: 'tool_call', tool_input: null, tool_response: longResponse },
      ];
      const prompt = buildExtractPrompt('Proj', events, []);
      // 300 chars of 'x' plus ellipsis should appear, not 500 chars
      assert.ok(prompt.includes('x'.repeat(300)), 'should include first 300 chars');
      assert.ok(!prompt.includes('x'.repeat(301)), 'should not include 301st char');
      assert.ok(prompt.includes('…'), 'should include truncation indicator');
    });

    it('includes command field from tool_input if no file_path', () => {
      const events = [
        {
          name: 'Bash',
          event_type: 'tool_call',
          tool_input: JSON.stringify({ command: 'npm test' }),
          tool_response: null,
        },
      ];
      const prompt = buildExtractPrompt('Proj', events, []);
      assert.ok(prompt.includes('npm test'), 'should include command from tool_input');
    });

    it('includes skill template content when skill file exists', () => {
      const prompt = buildExtractPrompt('Proj', [], []);
      assert.ok(prompt.includes('Entry JSON Schema'), 'should include skill template schema section');
      assert.ok(prompt.includes('Controlled Tag Vocabulary'), 'should include skill template tag section');
      assert.ok(prompt.includes('ENTRY FORMAT AND RULES'), 'should have format delimiter');
    });

    it('instructs case-insensitive dedup in rules', () => {
      const prompt = buildExtractPrompt('Proj', [], ['Existing Title']);
      assert.ok(prompt.includes('case-insensitive'), 'should mention case-insensitive comparison');
    });
  });

  // ---------------------------------------------------------------------------
  // buildScanPrompt
  // ---------------------------------------------------------------------------

  describe('buildScanPrompt', () => {
    it('includes project name', () => {
      const prompt = buildScanPrompt('ScanProj', {});
      assert.ok(prompt.includes('ScanProj'), 'should include project name');
    });

    it('includes file contents', () => {
      const files = {
        'README.md': '# My Project\nA cool thing.',
        'package.json': '{"name":"my-project"}',
      };
      const prompt = buildScanPrompt('ScanProj', files);
      assert.ok(prompt.includes('README.md'), 'should include README filename');
      assert.ok(prompt.includes('A cool thing.'), 'should include README content');
      assert.ok(prompt.includes('package.json'), 'should include package.json filename');
      assert.ok(prompt.includes('my-project'), 'should include package.json content');
    });

    it('requests JSON array output', () => {
      const prompt = buildScanPrompt('Proj', {});
      assert.ok(prompt.includes('JSON array'), 'should request JSON array');
    });

    it('includes existing titles when provided', () => {
      const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' }, ['Existing Entry A', 'Existing Entry B']);
      assert.ok(prompt.includes('Existing Entry A'), 'should include existing title A');
      assert.ok(prompt.includes('Existing Entry B'), 'should include existing title B');
      assert.ok(prompt.includes('avoid duplicating'), 'should instruct to avoid duplicates');
    });

    it('includes CLAUDE.md content when provided', () => {
      const claudeMd = '# Project Guide\n\n## Architecture\nHook -> JSONL -> DB';
      const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' }, [], claudeMd);
      assert.ok(prompt.includes('Hook -> JSONL -> DB'), 'should include CLAUDE.md content');
      assert.ok(prompt.includes('Already documented'), 'should label as already documented');
    });

    it('includes skill template content in scan prompt', () => {
      const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' });
      assert.ok(prompt.includes('Entry JSON Schema'), 'should include skill template schema section');
      assert.ok(prompt.includes('Controlled Tag Vocabulary'), 'should include skill template tag section');
      assert.ok(prompt.includes('ENTRY FORMAT AND RULES'), 'should have format delimiter');
    });
  });

  // ---------------------------------------------------------------------------
  // parseJsonResponse
  // ---------------------------------------------------------------------------

  describe('parseJsonResponse', () => {
    it('returns empty array for empty string', () => {
      assert.deepEqual(parseJsonResponse(''), []);
    });

    it('returns empty array when no JSON array found', () => {
      assert.deepEqual(parseJsonResponse('No JSON here'), []);
    });

    it('parses a valid JSON array', () => {
      const text = 'Some preamble\n[{"a":1},{"b":2}]\nsome trailing text';
      const result = parseJsonResponse(text);
      assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
    });

    it('returns empty array on malformed JSON', () => {
      const result = parseJsonResponse('[{invalid json}]');
      assert.deepEqual(result, []);
    });
  });

  // ---------------------------------------------------------------------------
  // mergeOrUpdate
  // ---------------------------------------------------------------------------

  describe('mergeOrUpdate', () => {
    it('inserts new entries and returns {inserted:1, updated:0}', () => {
      const entries = [
        {
          category:    'domain',
          title:       'Unique Merge Insert Test',
          body:        'This is the domain overview.',
          source_file: null,
          tags:        ['domain'],
        },
      ];
      const { inserted, updated } = mergeOrUpdate(db, 'proj-km-test', entries);
      assert.equal(inserted, 1, 'should insert 1');
      assert.equal(updated, 0, 'should update 0');
    });

    it('updates existing entries and returns {inserted:0, updated:1}', () => {
      // First insert
      mergeOrUpdate(db, 'proj-km-test', [
        { category: 'stack', title: 'Unique MoU Update Test', body: 'Original', tags: [] },
      ]);

      // Wait 1ms to ensure updated_at will differ from created_at
      const start = Date.now();
      while (Date.now() === start) { /* spin */ }

      // Now upsert again with different body
      const { inserted, updated } = mergeOrUpdate(db, 'proj-km-test', [
        { category: 'stack', title: 'Unique MoU Update Test', body: 'Updated body', tags: [] },
      ]);

      assert.equal(inserted, 0, 'should not insert');
      assert.equal(updated, 1, 'should update 1');
    });

    it('handles unknown category by falling back to domain', () => {
      const { inserted } = mergeOrUpdate(db, 'proj-km-test', [
        { category: 'unknown_cat', title: 'Unknown Category Test Entry', body: 'body', tags: [] },
      ]);
      assert.equal(inserted, 1);

      // Verify it was stored as 'domain'
      const row = db.prepare(
        "SELECT * FROM knowledge_entries WHERE title = 'Unknown Category Test Entry'"
      ).get();
      assert.ok(row, 'entry should exist');
      assert.equal(row.category, 'domain', 'should fall back to domain category');
    });
  });

  // ---------------------------------------------------------------------------
  // renderKnowledgeVault
  // ---------------------------------------------------------------------------

  describe('renderKnowledgeVault', () => {
    // Use a separate project for vault tests to avoid interference from mergeOrUpdate tests
    let VAULT_PROJ_DIR;

    before(() => {
      // Create a second "git repo" just for vault tests
      const tmpRoot = path.join(os.tmpdir(), `op-knowledge-vault-${Date.now()}`);
      VAULT_PROJ_DIR = path.join(tmpRoot, 'vault-repo');
      fs.mkdirSync(path.join(VAULT_PROJ_DIR, '.git'), { recursive: true });

      dbMod2.upsertClProject(db, {
        project_id:    'proj-vault-only',
        name:          'Vault Only Project',
        directory:     VAULT_PROJ_DIR,
        first_seen_at: '2026-04-10T00:00:00Z',
        last_seen_at:  '2026-04-10T00:00:00Z',
        session_count: 1,
      });

      // Insert entries in two categories
      dbMod2.insertKnowledgeEntry(db, {
        project_id: 'proj-vault-only',
        category:   'domain',
        title:      'Vault Domain Entry 1',
        body:       'Domain knowledge body.',
      });
      dbMod2.insertKnowledgeEntry(db, {
        project_id: 'proj-vault-only',
        category:   'stack',
        title:      'Vault Stack Entry 1',
        body:       'Stack knowledge body.',
      });
    });

    after(() => {
      if (VAULT_PROJ_DIR) {
        fs.rmSync(path.dirname(VAULT_PROJ_DIR), { recursive: true, force: true });
      }
    });

    it('creates category .md files in .claude/knowledge/', () => {
      const { filesWritten } = renderKnowledgeVault(db, 'proj-vault-only');
      assert.ok(filesWritten >= 2, `expected >= 2 files written, got ${filesWritten}`);

      const vaultDir = path.join(VAULT_PROJ_DIR, '.claude', 'knowledge');
      assert.ok(fs.existsSync(path.join(vaultDir, 'domain.md')), 'domain.md should exist');
      assert.ok(fs.existsSync(path.join(vaultDir, 'stack.md')), 'stack.md should exist');
    });

    it('creates index.md with category sections', () => {
      const vaultDir = path.join(VAULT_PROJ_DIR, '.claude', 'knowledge');
      const indexPath = path.join(vaultDir, 'index.md');
      assert.ok(fs.existsSync(indexPath), 'index.md should exist');

      const content = fs.readFileSync(indexPath, 'utf8');
      assert.ok(content.includes('Knowledge Base'), 'index should include project header');
    });

    it('category .md file contains entry titles and bodies', () => {
      const vaultDir = path.join(VAULT_PROJ_DIR, '.claude', 'knowledge');
      const domainContent = fs.readFileSync(path.join(vaultDir, 'domain.md'), 'utf8');
      assert.ok(domainContent.includes('Vault Domain Entry 1'), 'should include entry title');
      assert.ok(domainContent.includes('Domain knowledge body.'), 'should include entry body');
    });

    it('skips unchanged files on second run', () => {
      // Run again — no content changed
      const { filesWritten, filesSkipped } = renderKnowledgeVault(db, 'proj-vault-only');
      assert.equal(filesWritten, 0, 'should write 0 files (no changes)');
      assert.ok(filesSkipped >= 1, 'should skip at least 1 file');
    });

    it('skips projects without a .git directory', () => {
      // Create a non-git project
      const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
      fs.mkdirSync(nonGitDir, { recursive: true });

      dbMod2.upsertClProject(db, {
        project_id:   'proj-non-git',
        name:         'Non Git Project',
        directory:    nonGitDir,
        first_seen_at: '2026-04-10T00:00:00Z',
        last_seen_at:  '2026-04-10T00:00:00Z',
        session_count: 1,
      });

      const result = renderKnowledgeVault(db, 'proj-non-git');
      assert.equal(result.filesWritten, 0, 'should write 0 files for non-git project');
      assert.equal(result.filesSkipped, 0, 'should skip 0 files for non-git project');

      fs.rmSync(nonGitDir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // renderCategoryPage
  // ---------------------------------------------------------------------------

  describe('renderCategoryPage', () => {
    it('renders H2 sections for each entry', () => {
      const entries = [
        { title: 'Entry A', body: 'Body A', source_file: null, tags: '[]' },
        { title: 'Entry B', body: 'Body B', source_file: '/src/foo.js', tags: '["tag1"]' },
      ];
      const content = renderCategoryPage('domain', entries);
      assert.ok(content.includes('## Entry A'), 'should include Entry A as H2');
      assert.ok(content.includes('## Entry B'), 'should include Entry B as H2');
      assert.ok(content.includes('Body A'), 'should include body A');
      assert.ok(content.includes('/src/foo.js'), 'should include source_file');
      assert.ok(content.includes('`tag1`'), 'should include tags');
    });

    it('uses CATEGORY_TITLES for the page title', () => {
      const content = renderCategoryPage('footgun', []);
      assert.ok(content.includes('Footguns'), 'should use CATEGORY_TITLES display name');
    });
  });

  // ---------------------------------------------------------------------------
  // renderIndexPage
  // ---------------------------------------------------------------------------

  describe('renderIndexPage', () => {
    it('renders sections for each category', () => {
      const entriesByCategory = {
        domain:  [{ title: 'Domain One' }],
        stack:   [{ title: 'Stack One' }, { title: 'Stack Two' }],
      };
      const content = renderIndexPage('Test Project', entriesByCategory);
      assert.ok(content.includes('Test Project'), 'should include project name');
      assert.ok(content.includes('Domain One'), 'should include domain entry');
      assert.ok(content.includes('Stack One'), 'should include stack entry');
      assert.ok(content.includes('Stack Two'), 'should include stack entry 2');
    });

    it('renders empty message when no entries', () => {
      const content = renderIndexPage('Empty Project', {});
      assert.ok(content.includes('No knowledge entries yet'), 'should show empty message');
    });
  });

  // ---------------------------------------------------------------------------
  // CATEGORY_FILES / CATEGORY_TITLES constants
  // ---------------------------------------------------------------------------

  describe('constants', () => {
    it('CATEGORY_FILES maps every category to a .md filename', () => {
      for (const [cat, file] of Object.entries(CATEGORY_FILES)) {
        assert.ok(file.endsWith('.md'), `${cat} should map to a .md file`);
      }
    });

    it('CATEGORY_TITLES maps every category to a non-empty string', () => {
      for (const [cat, title] of Object.entries(CATEGORY_TITLES)) {
        assert.ok(typeof title === 'string' && title.length > 0, `${cat} should have a non-empty title`);
      }
    });
  });
});

// =============================================================================
// knowledge entry API routes
// =============================================================================

describe('knowledge entry API routes', () => {
  let app, db;
  const API_TEST_DIR = path.join(os.tmpdir(), `op-knowledge-api-test-${Date.now()}`);
  const API_TEST_DB  = path.join(API_TEST_DIR, 'api-test.db');

  let seededEntryId;

  before(async () => {
    fs.mkdirSync(path.join(API_TEST_DIR, 'data'),        { recursive: true });
    fs.mkdirSync(path.join(API_TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(API_TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(API_TEST_DIR, '.claude', 'agents'), { recursive: true });

    process.env.OPEN_PULSE_DB         = API_TEST_DB;
    process.env.OPEN_PULSE_DIR        = API_TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(API_TEST_DIR, '.claude');

    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    const { upsertClProject: upsertClProjectApi } = require('../../src/db/projects');
    const { insertKnowledgeEntry: insertKnowledgeEntryApi } = require('../../src/db/knowledge-entries');
    const dbMod = { upsertClProject: upsertClProjectApi, insertKnowledgeEntry: insertKnowledgeEntryApi };
    db = require('better-sqlite3')(API_TEST_DB);

    // Seed project
    dbMod.upsertClProject(db, {
      project_id:    'proj-api-test',
      name:          'API Test Project',
      directory:     API_TEST_DIR,
      first_seen_at: '2026-04-10T00:00:00Z',
      last_seen_at:  '2026-04-10T00:00:00Z',
      session_count: 1,
    });

    // Seed some entries
    const e1 = dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-api-test',
      category:   'domain',
      title:      'API Route Domain Entry',
      body:       'Domain knowledge for API tests.',
    });
    dbMod.insertKnowledgeEntry(db, {
      project_id: 'proj-api-test',
      category:   'stack',
      title:      'API Route Stack Entry',
      body:       'Stack knowledge for API tests.',
    });

    seededEntryId = e1.id;
  });

  after(async () => {
    if (db)  db.close();
    if (app) await app.close();
    fs.rmSync(API_TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
  });

  it('GET /api/knowledge/entries returns paginated list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/entries?project=proj-api-test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.items), 'items should be an array');
    assert.ok(body.total >= 2, `total should be >= 2, got ${body.total}`);
    assert.ok(typeof body.page === 'number', 'page should be a number');
    assert.ok(typeof body.perPage === 'number', 'perPage should be a number');
  });

  it('GET /api/knowledge/entries/stats returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/entries/stats?project=proj-api-test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.total === 'number', 'total should be a number');
    assert.ok(Array.isArray(body.by_category), 'by_category should be an array');
    assert.ok(Array.isArray(body.by_status),   'by_status should be an array');
    assert.ok(Array.isArray(body.by_project),  'by_project should be an array');
    const cats = body.by_category.map(r => r.category);
    assert.ok(cats.includes('domain'), 'should include domain category');
  });

  it('GET /api/knowledge/entries/:id returns single entry', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/knowledge/entries/${seededEntryId}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, seededEntryId);
    assert.equal(body.category, 'domain');
  });

  it('GET /api/knowledge/entries/:id returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/entries/ke-doesnotexist' });
    assert.equal(res.statusCode, 404);
  });

  it('PUT /api/knowledge/entries/:id/outdated marks entry outdated', async () => {
    const res = await app.inject({
      method: 'PUT',
      url:    `/api/knowledge/entries/${seededEntryId}/outdated`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'outdated');
  });

  it('PUT /api/knowledge/entries/:id updates fields', async () => {
    // Seed a fresh entry to update
    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');
    const fresh = insertKnowledgeEntry(db, {
      project_id: 'proj-api-test',
      category:   'stack',
      title:      'Entry To Update Via API',
      body:       'Original body.',
    });

    const res = await app.inject({
      method:  'PUT',
      url:     `/api/knowledge/entries/${fresh.id}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'Updated body via API.' }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.body, 'Updated body via API.');
    assert.equal(body.category, 'stack'); // unchanged
  });

  it('DELETE /api/knowledge/entries/:id removes entry', async () => {
    const { insertKnowledgeEntry: insertKE } = require('../../src/db/knowledge-entries');
    const toDelete = insertKE(db, {
      project_id: 'proj-api-test',
      category:   'domain',
      title:      'Entry To Delete Via API',
      body:       'Will be deleted.',
    });

    const res = await app.inject({ method: 'DELETE', url: `/api/knowledge/entries/${toDelete.id}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.deleted, true);

    // Confirm it's gone
    const check = await app.inject({ method: 'GET', url: `/api/knowledge/entries/${toDelete.id}` });
    assert.equal(check.statusCode, 404);
  });

  it('GET /api/knowledge/autocomplete returns results', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/knowledge/autocomplete?project=proj-api-test&q=API',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body), 'should return an array');
    // Should find entries with "API" in title
    const labels = body.map(r => r.label);
    assert.ok(labels.some(l => l.includes('API')), 'should include entries matching query');
  });

  it('GET /api/knowledge/projects returns projects with entry_count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/projects' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body), 'should return an array');
    const proj = body.find(p => p.project_id === 'proj-api-test');
    assert.ok(proj, 'should include our test project');
    assert.ok(typeof proj.entry_count === 'number', 'should have entry_count');
    assert.ok(typeof proj.vault_file_count === 'number', 'should have vault_file_count');
    assert.ok(proj.entry_count >= 1, `entry_count should be >= 1, got ${proj.entry_count}`);
  });

  it('DELETE /api/knowledge/entries/purge removes all entries for project', async () => {
    // First verify entries exist
    const before = await app.inject({ method: 'GET', url: '/api/knowledge/entries?project=proj-api-test' });
    const beforeBody = JSON.parse(before.body);
    assert.ok(beforeBody.total >= 1, 'should have entries before purge');

    // Purge
    const res = await app.inject({ method: 'DELETE', url: '/api/knowledge/entries/purge?project=proj-api-test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.purged === 'number');
    assert.ok(body.purged >= 1, 'should purge at least 1 entry');

    // Verify entries are gone
    const after = await app.inject({ method: 'GET', url: '/api/knowledge/entries?project=proj-api-test' });
    const afterBody = JSON.parse(after.body);
    assert.equal(afterBody.total, 0, 'should have 0 entries after purge');
  });

  it('DELETE /api/knowledge/entries/purge returns 400 without project param', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/knowledge/entries/purge' });
    assert.equal(res.statusCode, 400);
  });
});
