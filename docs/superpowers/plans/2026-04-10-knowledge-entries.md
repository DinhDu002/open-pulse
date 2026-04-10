# Knowledge Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Knowledge Graph (kg_nodes/kg_edges) with a project-understanding system that extracts factual knowledge via LLM after every prompt and supports cold-start project scanning.

**Architecture:** Post-ingest hook calls Haiku to extract knowledge entries from prompt events, stores in `knowledge_entries` table, renders grouped markdown vault files per category. Cold-start scan reads key project files for initial bootstrap. KB Notes remain unchanged.

**Tech Stack:** Node.js, better-sqlite3, Fastify 5, Claude Haiku API (claude-haiku-4-5-20251001), vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-04-10-knowledge-entries-design.md`

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/db/knowledge-entries.js` | DB queries: insert, upsert, query, stats, delete for `knowledge_entries` |
| `src/op-knowledge.js` | Core logic: extract from prompt, scan project, render vault, merge/dedup |
| `test/op-knowledge.test.js` | Tests for DB queries, extraction, scan, vault, merge |

### Modified files

| File | Changes |
|---|---|
| `src/op-db.js` | Add `knowledge_entries` table in schema, migration to drop `kg_nodes`/`kg_edges` |
| `src/db/knowledge.js` | Remove KG node/edge exports, add re-exports from `knowledge-entries.js`, keep KB Note exports |
| `src/op-ingest.js` | Add post-ingest hook calling `extractKnowledgeFromPrompt` |
| `src/op-server.js` | Remove KG sync + vault timers, remove old imports |
| `src/routes/knowledge.js` | Rewrite: entries CRUD + scan + rebuilt autocomplete/discover, keep notes routes |
| `src/op-notes.js` | Remove `syncNoteToGraph` / `removeNoteFromGraph` |
| `public/modules/knowledge.js` | Rewrite UI: 3 tabs (Entries, Notes, Scan) |
| `CLAUDE.md` | Update architecture docs |

### Deleted files

| File | Reason |
|---|---|
| `src/op-knowledge-graph.js` | Replaced by `op-knowledge.js` |
| `src/op-knowledge-enricher.js` | Merged into extraction pipeline |
| `src/op-vault-generator.js` | Vault logic moved to `op-knowledge.js` |
| `test/op-knowledge-graph.test.js` | Replaced |
| `test/op-vault-generator.test.js` | Replaced |
| `test/op-knowledge-enricher.test.js` | Replaced |

---

## Task 1: Database schema + knowledge-entries DB module

**Files:**
- Modify: `src/op-db.js` (schema + migration)
- Create: `src/db/knowledge-entries.js`
- Modify: `src/db/knowledge.js` (re-exports)
- Test: `test/op-knowledge.test.js` (DB query tests)

- [ ] **Step 1: Write failing tests for knowledge_entries DB queries**

Create `test/op-knowledge.test.js` with tests for all DB functions:

```js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-knowledge-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('knowledge-entries DB', () => {
  let db, dbMod, ke;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbMod = require('../src/op-db');
    ke = require('../src/db/knowledge-entries');
    db = dbMod.createDb(TEST_DB);

    // Seed a project
    dbMod.upsertClProject(db, {
      project_id: 'proj-a', name: 'Project A', directory: '/proj/a',
      first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 2,
    });
  });

  after(() => { db.close(); fs.rmSync(TEST_DIR, { recursive: true, force: true }); });

  it('insertKnowledgeEntry inserts and returns entry', () => {
    const entry = ke.insertKnowledgeEntry(db, {
      project_id: 'proj-a',
      category: 'schema',
      title: 'events table stores hook events',
      body: 'The events table stores all hook events from Claude Code.',
      source_file: 'src/op-db.js',
      source_prompt_id: null,
      tags: ['database', 'events'],
    });
    assert.ok(entry.id.startsWith('ke-'));
    assert.equal(entry.category, 'schema');
    assert.equal(entry.status, 'active');
  });

  it('getKnowledgeEntry returns entry by id', () => {
    const all = ke.queryKnowledgeEntries(db, { projectId: 'proj-a' });
    const entry = ke.getKnowledgeEntry(db, all.items[0].id);
    assert.equal(entry.title, 'events table stores hook events');
  });

  it('upsertKnowledgeEntry updates existing entry with same project+title', () => {
    ke.upsertKnowledgeEntry(db, {
      project_id: 'proj-a',
      category: 'schema',
      title: 'events table stores hook events',
      body: 'Updated description with more detail.',
      source_file: 'src/op-db.js',
      tags: ['database'],
    });
    const all = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'schema' });
    assert.equal(all.items.length, 1);
    assert.ok(all.items[0].body.includes('Updated'));
  });

  it('queryKnowledgeEntries filters by category and status', () => {
    ke.insertKnowledgeEntry(db, {
      project_id: 'proj-a', category: 'stack',
      title: 'uses Fastify 5', body: 'Server framework is Fastify 5.',
    });
    const schema = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'schema' });
    assert.equal(schema.items.length, 1);
    const all = ke.queryKnowledgeEntries(db, { projectId: 'proj-a' });
    assert.equal(all.items.length, 2);
  });

  it('getKnowledgeStats returns counts by category and status', () => {
    const stats = ke.getKnowledgeStats(db, 'proj-a');
    assert.ok(stats.byCategory.some(c => c.category === 'schema'));
    assert.ok(stats.byStatus.some(s => s.status === 'active'));
  });

  it('markOutdated changes status to outdated', () => {
    const all = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'schema' });
    ke.markKnowledgeEntryOutdated(db, all.items[0].id);
    const entry = ke.getKnowledgeEntry(db, all.items[0].id);
    assert.equal(entry.status, 'outdated');
  });

  it('deleteKnowledgeEntry removes entry', () => {
    const all = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'stack' });
    ke.deleteKnowledgeEntry(db, all.items[0].id);
    const after2 = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'stack' });
    assert.equal(after2.items.length, 0);
  });

  it('getExistingTitles returns active titles for dedup', () => {
    ke.insertKnowledgeEntry(db, {
      project_id: 'proj-a', category: 'api',
      title: 'GET /api/health returns server status', body: 'Health endpoint.',
    });
    const titles = ke.getExistingTitles(db, 'proj-a');
    assert.ok(titles.includes('GET /api/health returns server status'));
    // outdated entries should NOT be in the list
    assert.ok(!titles.includes('events table stores hook events'));
  });

  it('queryKnowledgeEntries paginates correctly', () => {
    for (let i = 0; i < 5; i++) {
      ke.insertKnowledgeEntry(db, {
        project_id: 'proj-a', category: 'feature',
        title: `feature ${i}`, body: `Description ${i}`,
      });
    }
    const page1 = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'feature', page: 1, perPage: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.total, 5);
    const page3 = ke.queryKnowledgeEntries(db, { projectId: 'proj-a', category: 'feature', page: 3, perPage: 2 });
    assert.equal(page3.items.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-knowledge.test.js`
Expected: FAIL with `Cannot find module '../src/db/knowledge-entries'`

- [ ] **Step 3: Add `knowledge_entries` table to schema in `src/op-db.js`**

Add after the `kb_notes` indexes (after line 168), before `auto_evolves`:

```sql
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  source_file     TEXT,
  source_prompt_id TEXT,
  tags            TEXT DEFAULT '[]',
  status          TEXT DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ke_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_ke_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_ke_status ON knowledge_entries(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_project_title ON knowledge_entries(project_id, title);
```

- [ ] **Step 4: Create `src/db/knowledge-entries.js`**

```js
'use strict';

const crypto = require('crypto');

function makeId(title) {
  const hash = crypto.createHash('sha256').update(title).digest('hex').substring(0, 16);
  return `ke-${hash}`;
}

function insertKnowledgeEntry(db, entry) {
  const now = new Date().toISOString();
  const id = makeId(`${entry.project_id}::${entry.title}::${now}`);
  const tags = Array.isArray(entry.tags) ? JSON.stringify(entry.tags) : (entry.tags || '[]');
  db.prepare(`
    INSERT INTO knowledge_entries (id, project_id, category, title, body, source_file, source_prompt_id, tags, status, created_at, updated_at)
    VALUES (@id, @project_id, @category, @title, @body, @source_file, @source_prompt_id, @tags, 'active', @now, @now)
  `).run({
    id,
    project_id: entry.project_id,
    category: entry.category,
    title: entry.title,
    body: entry.body || '',
    source_file: entry.source_file || null,
    source_prompt_id: entry.source_prompt_id || null,
    tags,
    now,
  });
  return getKnowledgeEntry(db, id);
}

function upsertKnowledgeEntry(db, entry) {
  const now = new Date().toISOString();
  const tags = Array.isArray(entry.tags) ? JSON.stringify(entry.tags) : (entry.tags || '[]');
  const existing = db.prepare(
    'SELECT id FROM knowledge_entries WHERE project_id = ? AND title = ?'
  ).get(entry.project_id, entry.title);

  if (existing) {
    db.prepare(`
      UPDATE knowledge_entries
      SET body = @body, category = @category, source_file = @source_file,
          source_prompt_id = @source_prompt_id, tags = @tags, status = 'active', updated_at = @now
      WHERE id = @id
    `).run({
      id: existing.id,
      body: entry.body || '',
      category: entry.category,
      source_file: entry.source_file || null,
      source_prompt_id: entry.source_prompt_id || null,
      tags,
      now,
    });
    return getKnowledgeEntry(db, existing.id);
  }
  return insertKnowledgeEntry(db, entry);
}

function getKnowledgeEntry(db, id) {
  return db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) || null;
}

function queryKnowledgeEntries(db, opts = {}) {
  let { projectId, category, status, search, page = 1, perPage = 20 } = opts;
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 100);

  const conditions = [];
  const params = {};

  if (projectId) { conditions.push('project_id = @projectId'); params.projectId = projectId; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (status) { conditions.push('status = @status'); params.status = status; }
  if (search) { conditions.push('(title LIKE @search OR body LIKE @search)'); params.search = `%${search}%`; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM knowledge_entries ${where}`).get(params).c;
  const items = db.prepare(
    `SELECT * FROM knowledge_entries ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  return { items, total, page, perPage };
}

function getKnowledgeStats(db, projectId) {
  const conditions = [];
  const params = {};
  if (projectId) { conditions.push('project_id = @projectId'); params.projectId = projectId; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const byCategory = db.prepare(
    `SELECT category, COUNT(*) AS count FROM knowledge_entries ${where} GROUP BY category ORDER BY count DESC`
  ).all(params);
  const byStatus = db.prepare(
    `SELECT status, COUNT(*) AS count FROM knowledge_entries ${where} GROUP BY status ORDER BY count DESC`
  ).all(params);
  const byProject = db.prepare(
    `SELECT project_id, COUNT(*) AS count FROM knowledge_entries ${where} GROUP BY project_id ORDER BY count DESC`
  ).all(params);

  return { byCategory, byStatus, byProject };
}

function markKnowledgeEntryOutdated(db, id) {
  db.prepare("UPDATE knowledge_entries SET status = 'outdated', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

function deleteKnowledgeEntry(db, id) {
  db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
}

function getExistingTitles(db, projectId) {
  return db.prepare(
    "SELECT title FROM knowledge_entries WHERE project_id = ? AND status = 'active'"
  ).all(projectId).map(r => r.title);
}

function updateKnowledgeEntry(db, id, fields) {
  const now = new Date().toISOString();
  const sets = ['updated_at = @updated_at'];
  const params = { id, updated_at: now };
  for (const key of ['title', 'body', 'tags', 'category', 'status']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = key === 'tags' && Array.isArray(fields[key])
        ? JSON.stringify(fields[key])
        : fields[key];
    }
  }
  db.prepare(`UPDATE knowledge_entries SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

module.exports = {
  makeId,
  insertKnowledgeEntry,
  upsertKnowledgeEntry,
  getKnowledgeEntry,
  queryKnowledgeEntries,
  getKnowledgeStats,
  markKnowledgeEntryOutdated,
  deleteKnowledgeEntry,
  getExistingTitles,
  updateKnowledgeEntry,
};
```

- [ ] **Step 5: Update `src/db/knowledge.js` exports**

Remove all KG node/edge functions and exports: `upsertKgNode`, `upsertKgNodeBatch`, `getKgNode`, `upsertKgEdge`, `upsertKgEdgeBatch`, `getKgEdges`, `getKgGraph`, `getKgNodeDetail`, `getKgStatus`.

Keep: `upsertKgVaultHash`, `getKgVaultHash`, `getKgVaultHashes`, `setKgSyncState`, `getKgSyncState`, and all KB Note functions.

Add re-exports from `knowledge-entries.js`:

```js
const keModule = require('./knowledge-entries');

module.exports = {
  upsertKgVaultHash, getKgVaultHash, getKgVaultHashes,
  setKgSyncState, getKgSyncState,
  insertKbNote, updateKbNote, deleteKbNote, getKbNote, getKbNoteBySlug,
  queryKbNotes, getKbNoteBacklinks, getAllKbNoteSlugs,
  ...keModule,
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/op-knowledge.test.js`
Expected: All 8 tests PASS

- [ ] **Step 7: Run full test suite to check regressions**

Run: `npm test`
Expected: Old KG test files may fail (will be deleted in Task 5). All other tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/op-db.js src/db/knowledge-entries.js src/db/knowledge.js test/op-knowledge.test.js
git commit -m "feat: add knowledge_entries table and DB query module

Replace kg_nodes/kg_edges with knowledge_entries for project understanding.
New DB module with insert, upsert, query, stats, mark outdated, delete."
```

---

## Task 2: Core knowledge extraction module (`op-knowledge.js`)

**Files:**
- Create: `src/op-knowledge.js`
- Test: `test/op-knowledge.test.js` (add extraction + vault tests)

- [ ] **Step 1: Write failing tests for buildExtractPrompt, mergeOrUpdate, renderKnowledgeVault**

Append to `test/op-knowledge.test.js`:

```js
const knowledge = require('../src/op-knowledge');

describe('op-knowledge', () => {
  let db, dbMod, ke;
  const TEST_DIR2 = path.join(os.tmpdir(), `op-knowledge-core-test-${Date.now()}`);
  const TEST_DB2 = path.join(TEST_DIR2, 'test.db');
  const PROJ_DIR = path.join(TEST_DIR2, 'fake-project');

  before(() => {
    fs.mkdirSync(TEST_DIR2, { recursive: true });
    fs.mkdirSync(PROJ_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROJ_DIR, '.git'));
    dbMod = require('../src/op-db');
    ke = require('../src/db/knowledge-entries');
    db = dbMod.createDb(TEST_DB2);
    dbMod.upsertClProject(db, {
      project_id: 'proj-b', name: 'Project B', directory: PROJ_DIR,
      first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 1,
    });
  });

  after(() => { db.close(); fs.rmSync(TEST_DIR2, { recursive: true, force: true }); });

  describe('buildExtractPrompt', () => {
    it('includes project name and existing titles', () => {
      const prompt = knowledge.buildExtractPrompt('Project B', [
        { name: 'Read', event_type: 'tool_call', tool_input: '{"file_path":"/proj/b/src/app.js"}', tool_response: 'file content here' },
      ], ['existing entry title']);
      assert.ok(prompt.includes('Project B'));
      assert.ok(prompt.includes('existing entry title'));
      assert.ok(prompt.includes('Read'));
      assert.ok(prompt.includes('app.js'));
    });

    it('returns prompt even for empty events', () => {
      const prompt = knowledge.buildExtractPrompt('Proj', [], []);
      assert.ok(prompt.includes('Proj'));
    });
  });

  describe('buildScanPrompt', () => {
    it('includes file contents', () => {
      const prompt = knowledge.buildScanPrompt('Project B', {
        'README.md': '# My Project\nA cool project',
        'package.json': '{"name":"my-proj","dependencies":{}}',
      });
      assert.ok(prompt.includes('Project B'));
      assert.ok(prompt.includes('README.md'));
      assert.ok(prompt.includes('A cool project'));
    });
  });

  describe('mergeOrUpdate', () => {
    it('inserts new entries', () => {
      const result = knowledge.mergeOrUpdate(db, 'proj-b', [
        { category: 'domain', title: 'test domain entry', body: 'desc', source_file: null, tags: [] },
      ]);
      assert.equal(result.inserted, 1);
      assert.equal(result.updated, 0);
    });

    it('updates existing entries with same title', () => {
      const result = knowledge.mergeOrUpdate(db, 'proj-b', [
        { category: 'domain', title: 'test domain entry', body: 'updated desc', source_file: null, tags: [] },
      ]);
      assert.equal(result.inserted, 0);
      assert.equal(result.updated, 1);
    });
  });

  describe('renderKnowledgeVault', () => {
    it('creates category markdown files in .claude/knowledge/', () => {
      ke.insertKnowledgeEntry(db, { project_id: 'proj-b', category: 'stack', title: 'uses Node.js', body: 'Runtime is Node.js >= 20.' });
      ke.insertKnowledgeEntry(db, { project_id: 'proj-b', category: 'schema', title: 'users table', body: 'Stores user accounts.' });

      const result = knowledge.renderKnowledgeVault(db, 'proj-b');
      assert.ok(result.filesWritten > 0);

      const vaultDir = path.join(PROJ_DIR, '.claude', 'knowledge');
      assert.ok(fs.existsSync(path.join(vaultDir, 'stack.md')));
      assert.ok(fs.existsSync(path.join(vaultDir, 'schema.md')));
      assert.ok(fs.existsSync(path.join(vaultDir, 'index.md')));

      const stackContent = fs.readFileSync(path.join(vaultDir, 'stack.md'), 'utf8');
      assert.ok(stackContent.includes('uses Node.js'));
    });

    it('skips unchanged files (content-hash dedup)', () => {
      knowledge.renderKnowledgeVault(db, 'proj-b');
      const result2 = knowledge.renderKnowledgeVault(db, 'proj-b');
      assert.equal(result2.filesWritten, 0);
      assert.ok(result2.filesSkipped > 0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-knowledge.test.js`
Expected: FAIL with `Cannot find module '../src/op-knowledge'`

- [ ] **Step 3: Create `src/op-knowledge.js`**

Full implementation with: `buildExtractPrompt`, `buildScanPrompt`, `callHaiku`, `parseJsonResponse`, `mergeOrUpdate`, `extractKnowledgeFromPrompt`, `scanProject`, `renderKnowledgeVault`, `renderCategoryPage`, `renderIndexPage`.

Key implementation details:
- `formatEvent()` parses `tool_input` JSON to extract `file_path`, `command`, `pattern` fields for compact display
- `callHaiku()` uses `https` module (same pattern as `op-knowledge-enricher.js`)
- `parseJsonResponse()` extracts JSON array from LLM response text (regex `\[[\s\S]*\]`)
- `mergeOrUpdate()` uses `upsertKnowledgeEntry` — compares `created_at === updated_at` to count inserts vs updates
- `renderKnowledgeVault()` groups entries by category, renders one `.md` per category, uses `stableHash` + `kg_vault_hashes` for dedup
- `CATEGORY_FILES` maps category → filename (e.g., `feature` → `features.md`)
- `CATEGORY_TITLES` maps category → display title (e.g., `feature` → `Features & Business Logic`)

See spec for full code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-knowledge.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/op-knowledge.js test/op-knowledge.test.js
git commit -m "feat: add knowledge extraction, scan, and vault generation

Core module for extracting project knowledge from prompt events via Haiku,
cold-start project scanning, and rendering markdown vault files."
```

---

## Task 3: Ingest integration + remove old KG wiring

**Files:**
- Modify: `src/op-ingest.js` (add post-ingest hook)
- Modify: `src/op-server.js` (remove KG/vault timers, wire hook)
- Modify: `src/op-notes.js` (remove graph sync)
- Modify: `src/routes/knowledge.js` (remove graph sync from notes)

- [ ] **Step 1: Add post-ingest hook to `src/op-ingest.js`**

Add after existing requires at top of file:

```js
let _extractKnowledge = null;
let _knowledgeConfig = null;

function setKnowledgeHook(extractFn, config) {
  _extractKnowledge = extractFn;
  _knowledgeConfig = config;
}
```

Add after `updatePromptStatsAfterInsert(db, events);` (line 208), inside the `if (type === 'events')` block:

```js
      // Trigger knowledge extraction for new prompts (non-blocking)
      if (_extractKnowledge) {
        const promptIds = new Set(events.map(e => e.prompt_id).filter(Boolean));
        for (const pid of promptIds) {
          setImmediate(() => {
            _extractKnowledge(db, pid, _knowledgeConfig || {}).catch(() => {});
          });
        }
      }
```

Update exports to add `setKnowledgeHook`:

```js
module.exports = { ingestFile, ingestAll, setKnowledgeHook, MAX_RETRIES };
```

- [ ] **Step 2: Update `src/op-server.js`**

Remove imports:
```js
const { syncGraph } = require('./op-knowledge-graph');
const { generateAllVaults } = require('./op-vault-generator');
```

Add imports:
```js
const { extractKnowledgeFromPrompt } = require('./op-knowledge');
const { setKnowledgeHook } = require('./op-ingest');
```

After `const config = loadConfig();` inside `buildApp()`, add:

```js
  if (config.knowledge_enabled !== false) {
    setKnowledgeHook(extractKnowledgeFromPrompt, {
      maxTokens: config.knowledge_max_tokens ?? 1000,
      maxEvents: config.knowledge_max_events_per_prompt ?? 50,
    });
  }
```

Remove the KG sync timer (lines ~126-138) and vault generation timer (lines ~140-143).

- [ ] **Step 3: Remove graph sync from `src/op-notes.js`**

Delete functions `syncNoteToGraph` and `removeNoteFromGraph`. Remove them from exports. Keep all other functions.

- [ ] **Step 4: Remove graph sync calls from notes routes in `src/routes/knowledge.js`**

Remove import of `syncNoteToGraph`, `removeNoteFromGraph` from `../op-notes`.
Remove calls to `syncNoteToGraph(db, note)` in POST and PUT handlers.
Remove call to `removeNoteFromGraph(db, existing.slug)` in DELETE handler.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: Old KG/vault/enricher tests fail (expected). Other tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/op-ingest.js src/op-server.js src/op-notes.js src/routes/knowledge.js
git commit -m "feat: wire knowledge extraction to ingest pipeline

Post-ingest hook triggers Haiku extraction for each prompt.
Remove KG sync and vault generation timers.
Remove graph sync from notes CRUD."
```

---

## Task 4: Routes rewrite

**Files:**
- Modify: `src/routes/knowledge.js` (rewrite)
- Test: `test/op-knowledge.test.js` (add API tests)

- [ ] **Step 1: Write failing tests for knowledge entry endpoints**

Append to `test/op-knowledge.test.js`:

```js
describe('knowledge entry API routes', () => {
  let app;
  const API_DIR = path.join(os.tmpdir(), `op-knowledge-api-test-${Date.now()}`);
  const API_DB = path.join(API_DIR, 'test.db');

  before(async () => {
    fs.mkdirSync(path.join(API_DIR, 'data'), { recursive: true });
    process.env.OPEN_PULSE_DB = API_DB;
    process.env.OPEN_PULSE_DIR = API_DIR;
    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed project + entries via DB
    const apiDb = app.server ? null : null; // use API instead
    const ke2 = require('../src/db/knowledge-entries');
    const dbMod2 = require('../src/op-db');
    const db2 = dbMod2.createDb(API_DB);
    dbMod2.upsertClProject(db2, {
      project_id: 'api-proj', name: 'API Project', directory: API_DIR,
      first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 1,
    });
    ke2.insertKnowledgeEntry(db2, {
      project_id: 'api-proj', category: 'domain',
      title: 'test api domain', body: 'API domain desc',
    });
  });

  after(async () => {
    await app.close();
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    fs.rmSync(API_DIR, { recursive: true, force: true });
  });

  it('GET /api/knowledge/entries returns list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/entries?project=api-proj' });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.items);
    assert.ok(data.total >= 1);
  });

  it('GET /api/knowledge/entries/stats returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/entries/stats' });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.byCategory);
  });

  it('PUT /api/knowledge/entries/:id/outdated marks outdated', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/knowledge/entries?project=api-proj' });
    const list = JSON.parse(listRes.body);
    const id = list.items[0].id;
    const res = await app.inject({ method: 'PUT', url: `/api/knowledge/entries/${id}/outdated` });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'outdated');
  });

  it('GET /api/knowledge/autocomplete returns results', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/autocomplete?project=api-proj&q=domain' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "API routes"`
Expected: FAIL (old routes still in place)

- [ ] **Step 3: Rewrite `src/routes/knowledge.js`**

Full rewrite with: entries CRUD (stats, list, detail, update, outdated, delete), scan endpoint, autocomplete (entry titles + note slugs), discover, projects list (with entry_count), and all notes routes (unchanged logic, removed graph sync calls).

Key: register `/api/knowledge/entries/stats` BEFORE `/api/knowledge/entries/:id` (Fastify route ordering).

See spec for full route code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-knowledge.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/knowledge.js test/op-knowledge.test.js
git commit -m "feat: rewrite knowledge routes for entries CRUD + scan

Replace KG graph/sync/enrich routes with entries list, detail, edit,
mark outdated, delete. Add cold-start scan endpoint. Rebuild autocomplete.
Keep notes routes unchanged."
```

---

## Task 5: Delete old files + migration

**Files:**
- Delete: `src/op-knowledge-graph.js`, `src/op-knowledge-enricher.js`, `src/op-vault-generator.js`
- Delete: `test/op-knowledge-graph.test.js`, `test/op-vault-generator.test.js`, `test/op-knowledge-enricher.test.js`
- Modify: `src/op-db.js` (migration)

- [ ] **Step 1: Add migration to drop kg_nodes and kg_edges**

In `src/op-db.js`, add after the last migration block (~line 312):

```js
  // Migrate: drop kg_nodes and kg_edges (replaced by knowledge_entries)
  const hasKgNodes = db.prepare(
    "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='kg_nodes'"
  ).get();
  if (hasKgNodes.cnt > 0) {
    db.exec('DELETE FROM kg_edges');
    db.exec('DELETE FROM kg_nodes');
    db.exec('DROP TABLE IF EXISTS kg_edges');
    db.exec('DROP TABLE IF EXISTS kg_nodes');
  }
```

- [ ] **Step 2: Delete old files**

Delete: `src/op-knowledge-graph.js`, `src/op-knowledge-enricher.js`, `src/op-vault-generator.js`, `test/op-knowledge-graph.test.js`, `test/op-vault-generator.test.js`, `test/op-knowledge-enricher.test.js`.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS (old test files deleted)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove old Knowledge Graph system

Drop kg_nodes/kg_edges tables via migration.
Delete op-knowledge-graph.js, op-vault-generator.js, op-knowledge-enricher.js
and their test files. Replaced by knowledge_entries system."
```

---

## Task 6: Frontend UI rewrite

**Files:**
- Modify: `public/modules/knowledge.js` (full rewrite)

- [ ] **Step 1: Rewrite `public/modules/knowledge.js`**

3-tab layout:

**Tab 1 (Entries):** filter bar (project + category + status dropdowns), entry cards list (title, category badge, source_file, excerpt, timeAgo), click to expand detail with markdown preview, edit/outdated/delete buttons. Pagination.

**Tab 2 (Notes):** Copy current notes code unchanged (renderNotesList, renderNoteEditor, renderMarkdown, autocomplete).

**Tab 3 (Scan):** project table with entry count + last scan time + Scan button per project.

Category badge colors:
```js
const CATEGORY_COLORS = {
  domain: '#fdcb6e', stack: '#00b894', schema: '#6c5ce7',
  api: '#74b9ff', feature: '#e17055', architecture: '#00cec9',
  convention: '#636e72', decision: '#a29bfe', footgun: '#d63031',
  contract: '#0984e3', error_pattern: '#e84393',
};
```

Status badge colors: `{ active: '#00b894', outdated: '#e17055', merged: '#636e72' }`

DOM creation follows the exact same patterns as existing code (createElement, addEventListener, CSS-in-JS with style.cssText).

- [ ] **Step 2: Restart server + take Playwright screenshot**

Restart server, then verify rendering at `http://127.0.0.1:3827/#knowledge`.

- [ ] **Step 3: Commit**

```bash
git add public/modules/knowledge.js
git commit -m "feat: rewrite Knowledge UI with Entries, Notes, Scan tabs

Tab 1: Entries list with category/status filters, detail view, edit/delete.
Tab 2: Notes (unchanged).
Tab 3: Scan with cold-start scan button per project."
```

---

## Task 7: Config + CLAUDE.md + test fixes + final verification

**Files:**
- Modify: `config.json`
- Modify: `CLAUDE.md`
- Modify: test files with stale KG references

- [ ] **Step 1: Update `config.json`**

Remove: `knowledge_graph_interval_ms`, `knowledge_vault_interval_ms`, `knowledge_enrich_enabled`, `knowledge_pattern_min_occurrences`, `knowledge_session_lookback_days`, `knowledge_instinct_min_confidence`, `knowledge_vault_max_index_items`.

Add:
```json
"knowledge_enabled": true,
"knowledge_max_events_per_prompt": 50,
"knowledge_max_tokens": 1000,
"knowledge_scan_files": ["README.md", "package.json", "CLAUDE.md"],
"knowledge_scan_patterns": []
```

- [ ] **Step 2: Search and fix stale KG references in tests**

Search for references to removed entities in all test files:
- `knowledge/graph`, `knowledge/sync`, `knowledge/generate`, `knowledge/enrich`, `knowledge/status`, `knowledge/node`
- `syncNoteToGraph`, `removeNoteFromGraph`
- `kg_nodes`, `kg_edges`, `getKgGraph`, `getKgNode`, `upsertKgNode`

Update or remove each reference.

- [ ] **Step 3: Update `CLAUDE.md`**

Update Architecture Overview, Database Schema (replace kg_nodes/kg_edges with knowledge_entries), API Endpoints (replace KG endpoints with entries endpoints), Configuration (update keys), Key Design Decisions (add knowledge entries rationale, remove KG references).

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL tests PASS

- [ ] **Step 5: Restart server and verify endpoints**

```bash
# Verify API
curl -s http://127.0.0.1:3827/api/knowledge/entries/stats
curl -s http://127.0.0.1:3827/api/knowledge/projects
curl -s http://127.0.0.1:3827/api/health
```

- [ ] **Step 6: Take screenshot of final UI**

Verify `http://127.0.0.1:3827/#knowledge` renders correctly with 3 tabs.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md and config for knowledge entries system

Remove KG/vault/enricher references. Add knowledge_entries docs.
Update config keys. Fix stale test references."
```
