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

// =============================================================================
// op-knowledge module
// =============================================================================

describe('op-knowledge', () => {
  const {
    buildExtractPrompt,
    buildScanPrompt,
    mergeOrUpdate,
    renderKnowledgeVault,
    renderCategoryPage,
    renderIndexPage,
    parseJsonResponse,
    CATEGORY_FILES,
    CATEGORY_TITLES,
  } = require('../src/op-knowledge');

  // ---------------------------------------------------------------------------
  // Shared test DB (separate from the knowledge_entries describe above)
  // ---------------------------------------------------------------------------

  let db, dbMod2;
  let TEST_REPO_DIR;

  before(() => {
    dbMod2 = require('../src/op-db');

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
