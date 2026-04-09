# Unified Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace dual `cl_instincts` + `suggestions` tables with a unified `insights` entity. Single DB module, single API, single frontend module.

**Architecture:** New `insights` table with `source` discriminator (observer/daily_analysis/manual). Auto-classify `target_type` via keyword matching. Unified feedback loop (validate/reject with confidence scoring). Clean break — drop old tables.

**Tech Stack:** Node.js, better-sqlite3, node:test, vanilla JS ES modules

---

### File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/db/insights.js` | Insight CRUD, query, stats, batch insert |
| Create | `src/routes/insights.js` | Unified API endpoints |
| Create | `public/modules/learning-insights.js` | Unified list + detail UI |
| Modify | `src/op-db.js` | Add insights schema, drop old tables, re-export |
| Modify | `src/op-ingest.js` | Replace suggestions type with insights |
| Modify | `src/op-sync.js` | Sync instinct files into insights table |
| Modify | `src/op-server.js` | Register new routes plugin |
| Modify | `public/modules/learning.js` | Route to learning-insights module |
| Modify | `scripts/op-suggestion-agent.js` | Output insights instead of suggestions |
| Modify | `public/modules/router.js` | Update route definitions |
| Delete | `src/db/instincts.js` | Replaced by insights.js |
| Delete | `src/db/suggestions.js` | Replaced by insights.js |
| Delete | `src/routes/instincts.js` | Replaced by insights routes |
| Delete | `src/routes/suggestions.js` | Replaced by insights routes |
| Delete | `public/modules/learning-suggestions.js` | Already deleted in git status |

---

### Task 1: Create insights DB module

**Files:**
- Create: `src/db/insights.js`
- Modify: `src/op-db.js` — add schema + re-export
- Test: `test/op-db.test.js` (add insights tests)

- [ ] **Step 1: Write failing tests**

Add to `test/op-db.test.js`:

```javascript
describe('insights', () => {
  it('upsertInsight inserts new insight', () => {
    const { upsertInsight } = require('../src/db/insights');
    upsertInsight(db, {
      id: 'test-insight-1',
      source: 'observer',
      category: 'workflow',
      target_type: 'rule',
      title: 'Always run tests before commit',
      description: 'Pattern detected: user runs tests before every commit',
      confidence: 0.3,
      project_id: null,
    });
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get('test-insight-1');
    assert.ok(row);
    assert.equal(row.source, 'observer');
    assert.equal(row.confidence, 0.3);
    assert.equal(row.status, 'active');
    assert.equal(row.observation_count, 1);
  });

  it('upsertInsight increments observation_count on conflict', () => {
    const { upsertInsight } = require('../src/db/insights');
    upsertInsight(db, {
      id: 'test-insight-2', source: 'observer', category: 'workflow',
      title: 'Lint after edit', description: 'Runs linter after editing', confidence: 0.3,
    });
    upsertInsight(db, {
      id: 'test-insight-2', source: 'observer', category: 'workflow',
      title: 'Lint after edit', description: 'Runs linter after editing', confidence: 0.35,
    });
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get('test-insight-2');
    assert.equal(row.observation_count, 2);
    assert.equal(row.confidence, 0.35);
  });

  it('queryInsights filters by source and status', () => {
    const { upsertInsight, queryInsights } = require('../src/db/insights');
    upsertInsight(db, { id: 'qi-1', source: 'observer', category: 'workflow', title: 'A', description: 'a', confidence: 0.5 });
    upsertInsight(db, { id: 'qi-2', source: 'daily_analysis', category: 'cleanup', title: 'B', description: 'b', confidence: 0.6 });
    const obsOnly = queryInsights(db, { source: 'observer' });
    assert.ok(obsOnly.rows.every(r => r.source === 'observer'));
    const all = queryInsights(db, {});
    assert.ok(all.rows.length >= 2);
  });

  it('updateInsightFeedback adjusts confidence and counts', () => {
    const { upsertInsight, updateInsightFeedback } = require('../src/db/insights');
    upsertInsight(db, { id: 'fb-1', source: 'observer', category: 'testing', title: 'T', description: 'd', confidence: 0.5 });
    updateInsightFeedback(db, 'fb-1', 'validate');
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get('fb-1');
    assert.equal(row.confidence, 0.65);
    assert.equal(row.validation_count, 1);
  });

  it('updateInsightFeedback archives after 3 rejections', () => {
    const { upsertInsight, updateInsightFeedback } = require('../src/db/insights');
    upsertInsight(db, { id: 'rej-1', source: 'observer', category: 'testing', title: 'Bad', description: 'd', confidence: 0.5 });
    updateInsightFeedback(db, 'rej-1', 'reject');
    updateInsightFeedback(db, 'rej-1', 'reject');
    updateInsightFeedback(db, 'rej-1', 'reject');
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get('rej-1');
    assert.equal(row.status, 'archived');
    assert.equal(row.rejection_count, 3);
  });

  it('classifyTargetType returns correct type from keywords', () => {
    const { classifyTargetType } = require('../src/db/insights');
    assert.equal(classifyTargetType('Always run lint before commit'), 'rule');
    assert.equal(classifyTargetType('Automatically format after every edit'), 'hook');
    assert.equal(classifyTargetType('Multi-step deployment procedure for production'), 'skill');
    assert.equal(classifyTargetType('The auth module has 3 endpoints'), 'knowledge');
    assert.equal(classifyTargetType('Something ambiguous here'), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-db.test.js`
Expected: FAIL — insights module does not exist yet.

- [ ] **Step 3: Add insights table to schema in op-db.js**

In `src/op-db.js`, add to the SCHEMA string (after kb_notes table):

```sql
CREATE TABLE IF NOT EXISTS insights (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  category          TEXT NOT NULL,
  target_type       TEXT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  confidence        REAL DEFAULT 0.3,
  observation_count INTEGER DEFAULT 1,
  validation_count  INTEGER DEFAULT 0,
  rejection_count   INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',
  action_data       TEXT,
  promoted_to       TEXT,
  project_id        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_source ON insights(source);
CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);
CREATE INDEX IF NOT EXISTS idx_insights_target ON insights(target_type);
CREATE INDEX IF NOT EXISTS idx_insights_project ON insights(project_id);
```

Add insights module to the re-exports:

```javascript
const insights = require('./db/insights');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...instincts,  // keep for now, remove in Task 5
  ...suggestions, // keep for now, remove in Task 5
  ...insights,
  ...knowledge,
  ...components,
};
```

- [ ] **Step 4: Implement insights DB module**

Create `src/db/insights.js` with these functions:
- `classifyTargetType(text)` — keyword matching for rule/hook/skill/agent/knowledge
- `upsertInsight(db, insight)` — INSERT with ON CONFLICT increment observation_count
- `upsertInsightBatch(db, insights)` — transactional batch upsert
- `queryInsights(db, filters)` — paginated query with source/status/category/target_type/search filters
- `getInsight(db, id)` — single row fetch
- `updateInsightFeedback(db, id, action)` — validate (+0.15) or reject (-0.2), auto-archive at 3 rejections
- `updateInsightStatus(db, id, status, promotedTo)` — change status + promoted_to
- `updateInsightActionData(db, id, actionData)` — update action_data JSON
- `deleteInsight(db, id)` — hard delete
- `getInsightStats(db)` — counts by source, status, target_type

Classification rules:
- `rule`: /always/i, /never/i, /must/i, /should always/i, /don't/i, /do not/i, /avoid/i
- `hook`: /automatically/i, /every time/i, /after .+ (do|run|execute)/i, /before .+ (do|run|execute)/i, /on each/i
- `skill`: /procedure/i, /step-by-step/i, /workflow/i, /guide/i, /checklist/i
- `agent`: /delegate/i, /specialized agent/i, /subagent/i, /isolat/i
- `knowledge`: /has \d+/i, /contains/i, /located at/i, /relationship between/i, /fact/i
- Default: null (ambiguous)

Confidence clamping: min 0.0, max 0.95.

- [ ] **Step 5: Run tests**

Run: `node --test test/op-db.test.js`
Expected: All PASS including new insights tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/insights.js src/op-db.js test/op-db.test.js
git commit -m "feat: add insights DB module with unified schema"
```

---

### Task 2: Create insights API routes

**Files:**
- Create: `src/routes/insights.js`
- Modify: `src/op-server.js` — register new routes
- Test: `test/op-server.test.js` (add insights endpoint tests)

- [ ] **Step 1: Write failing tests**

Add to `test/op-server.test.js`:

```javascript
describe('insights API', () => {
  it('GET /api/insights returns paginated list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/insights' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.rows));
    assert.ok(typeof body.total === 'number');
  });

  it('PUT /api/insights/:id/validate increases confidence', async () => {
    const { upsertInsight } = require('../src/db/insights');
    upsertInsight(db, { id: 'val-test', source: 'observer', category: 'workflow', title: 'Test', description: 'test', confidence: 0.5 });
    const res = await app.inject({ method: 'PUT', url: '/api/insights/val-test/validate' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.confidence, 0.65);
  });

  it('PUT /api/insights/:id/reject decreases confidence', async () => {
    const { upsertInsight } = require('../src/db/insights');
    upsertInsight(db, { id: 'rej-test', source: 'observer', category: 'workflow', title: 'Test', description: 'test', confidence: 0.5 });
    const res = await app.inject({ method: 'PUT', url: '/api/insights/rej-test/reject' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.confidence, 0.3);
    assert.equal(body.rejection_count, 1);
  });

  it('GET /api/insights/:id returns single insight', async () => {
    const { upsertInsight } = require('../src/db/insights');
    upsertInsight(db, { id: 'get-test', source: 'daily_analysis', category: 'cleanup', title: 'Clean unused', description: 'Remove dead code', confidence: 0.7 });
    const res = await app.inject({ method: 'GET', url: '/api/insights/get-test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, 'get-test');
    assert.equal(body.source, 'daily_analysis');
  });

  it('GET /api/insights?source=observer filters by source', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/insights?source=observer' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.rows.every(r => r.source === 'observer'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-server.test.js`
Expected: FAIL — 404 on /api/insights routes.

- [ ] **Step 3: Create insights routes**

Create `src/routes/insights.js` with these endpoints:
- `GET /api/insights` — paginated list with source/status/category/target_type/search filters
- `GET /api/insights/stats` — counts by source, status, target_type
- `GET /api/insights/:id` — single insight (parse action_data JSON)
- `PUT /api/insights/:id/validate` — validate (+0.15)
- `PUT /api/insights/:id/reject` — reject (-0.2)
- `PUT /api/insights/:id/status` — update status + promoted_to
- `PUT /api/insights/:id/action-data` — update action_data
- `DELETE /api/insights/:id` — delete

Use `errorReply` and `parsePagination` from `../op-helpers`.
Import insight functions from `../op-db`.

IMPORTANT: Register static routes (`/api/insights/stats`) BEFORE dynamic routes (`/api/insights/:id`) to prevent Fastify param collision.

- [ ] **Step 4: Register routes in op-server.js**

In `src/op-server.js`, add:

```javascript
const insightsRoutes = require('./routes/insights');
```

In `buildApp`, register after existing routes:

```javascript
insightsRoutes(app, { db });
```

- [ ] **Step 5: Run tests**

Run: `node --test test/op-server.test.js`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/insights.js src/op-server.js test/op-server.test.js
git commit -m "feat: add insights API routes"
```

---

### Task 3: Update sync to write insights instead of instincts

**Files:**
- Modify: `src/op-sync.js`

- [ ] **Step 1: Read current syncInstinctsToDb implementation**

Read `src/op-sync.js` and understand how it walks the filesystem, parses YAML frontmatter, and calls `upsertInstinct`.

- [ ] **Step 2: Replace upsertInstinct with upsertInsight**

Change the import from `upsertInstinct` to `upsertInsight`.

In the function body, map instinct fields to insight fields:

```javascript
upsertInsight(db, {
  id: frontmatter.id || filename,
  source: 'observer',
  category: frontmatter.domain || frontmatter.category || 'general',
  target_type: null,
  title: frontmatter.trigger || frontmatter.id || filename,
  description: bodyContent,
  confidence: frontmatter.confidence || 0.3,
  project_id: projectId || null,
});
```

- [ ] **Step 3: Verify sync works**

Run: `npm run reset-db`
Then: `node -e "const db = require('./src/op-db').createDb(); require('./src/op-sync').syncAll(db); const n = db.prepare('SELECT COUNT(*) as n FROM insights').get().n; console.log('insights:', n); db.close()"`
Expected: insights count > 0.

- [ ] **Step 4: Commit**

```bash
git add src/op-sync.js
git commit -m "refactor: sync instinct files into insights table"
```

---

### Task 4: Update suggestion agent to write insights

**Files:**
- Modify: `scripts/op-suggestion-agent.js`
- Modify: `src/op-ingest.js` — replace suggestions type with insights

- [ ] **Step 1: Update suggestion agent imports and output**

In `scripts/op-suggestion-agent.js`:

Replace `insertSuggestionBatch` import with `upsertInsightBatch`.

Map suggestion output to insight format:

```javascript
const insights = parsedSuggestions.map(s => ({
  id: s.id,
  source: 'daily_analysis',
  category: s.category || s.type || 'general',
  target_type: null,
  title: s.action_summary || s.description.slice(0, 100),
  description: s.description,
  confidence: s.confidence || 0.5,
  action_data: JSON.stringify(s.action_data || null),
  project_id: null,
}));
upsertInsightBatch(db, insights);
```

Also update any `querySuggestions` references to `queryInsights`.

- [ ] **Step 2: Update ingest to handle insights.jsonl**

In `src/op-ingest.js`:

Change `ingestAll` loop from `['events', 'suggestions']` to `['events', 'insights']`.

Replace the `type === 'suggestions'` branch in `processContent` with `type === 'insights'`:

```javascript
} else if (type === 'insights') {
  const { upsertInsightBatch } = require('./op-db');
  upsertInsightBatch(db, rows.map(normaliseInsight));
}
```

Add `normaliseInsight` function:

```javascript
function normaliseInsight(raw) {
  return {
    id:          raw.id          ?? null,
    source:      raw.source      ?? 'manual',
    category:    raw.category    ?? 'general',
    target_type: raw.target_type ?? null,
    title:       raw.title       ?? (raw.description || '').slice(0, 100),
    description: raw.description ?? '',
    confidence:  raw.confidence  ?? 0.3,
    action_data: typeof raw.action_data === 'string'
                   ? raw.action_data
                   : JSON.stringify(raw.action_data ?? null),
    project_id:  raw.project_id  ?? null,
  };
}
```

Remove `normaliseSuggestion` function.

- [ ] **Step 3: Update ingest tests**

In `test/op-ingest.test.js`:

Replace the `'ingestFile processes suggestions.jsonl into DB'` test with:

```javascript
it('ingestFile processes insights.jsonl into DB', () => {
  const filePath = path.join(TEST_DIR, 'data', 'insights.jsonl');
  const insight = {
    id: 'insight-ingest-1', source: 'daily_analysis', category: 'optimization',
    title: 'Optimize query', description: 'Database query can be optimized', confidence: 0.7,
  };
  fs.writeFileSync(filePath, JSON.stringify(insight) + '\n');
  const result = ingest.ingestFile(db, filePath, 'insights');
  assert.equal(result.processed, 1);
  const rows = db.prepare('SELECT * FROM insights WHERE id = ?').all('insight-ingest-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'daily_analysis');
});
```

Remove the suggestion upsert test if it exists.

Update `beforeEach` to clean `insights.jsonl` instead of `suggestions.jsonl`.

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/op-suggestion-agent.js src/op-ingest.js test/op-ingest.test.js
git commit -m "refactor: suggestion agent and ingest output insights instead of suggestions"
```

---

### Task 5: Drop old tables and modules

**Files:**
- Modify: `src/op-db.js` — drop old tables, remove re-exports
- Delete: `src/db/instincts.js`, `src/db/suggestions.js`
- Delete: `src/routes/instincts.js`, `src/routes/suggestions.js`
- Modify: `src/op-server.js` — remove old route registrations

- [ ] **Step 1: Add drop statements to createDb**

In `src/op-db.js`, after `db.exec(SCHEMA)`, add:

```javascript
db.exec('DROP TABLE IF EXISTS cl_instincts');
db.exec('DROP TABLE IF EXISTS suggestions');
```

Remove `cl_instincts` and `suggestions` CREATE TABLE blocks from SCHEMA string.
Remove corresponding CREATE INDEX statements.
Remove all migration code referencing these tables.

- [ ] **Step 2: Remove old module imports and re-exports**

In `src/op-db.js`:

```javascript
// Remove these:
const instincts = require('./db/instincts');
const suggestions = require('./db/suggestions');
// And from module.exports, remove:
// ...instincts,
// ...suggestions,
```

- [ ] **Step 3: Delete old files**

Delete: `src/db/instincts.js`, `src/db/suggestions.js`, `src/routes/instincts.js`, `src/routes/suggestions.js`

- [ ] **Step 4: Update op-server.js**

Remove old route imports and registrations for instincts and suggestions routes.

- [ ] **Step 5: Update op-ingest.js imports**

Remove `insertSuggestionBatch` from the import if still referenced.

- [ ] **Step 6: Fix remaining references**

Search and fix any remaining references:

```bash
grep -rn 'instincts\|suggestions\|insertSuggestion\|upsertInstinct\|querySuggestions\|queryInstincts' src/ --include='*.js' | grep -v node_modules | grep -v insights
```

- [ ] **Step 7: Run tests and fix failures**

Run: `node --test`
Fix any test failures. Remove/update tests referencing old modules.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: drop cl_instincts and suggestions tables, remove old modules"
```

---

### Task 6: Create unified insights frontend module

**Files:**
- Create: `public/modules/learning-insights.js`
- Modify: `public/modules/learning.js`
- Modify: `public/modules/router.js` (if needed)

- [ ] **Step 1: Create learning-insights.js**

Create `public/modules/learning-insights.js` with:

**`renderList(el, state)`** — List view:
- Filter bar: source (all/observer/daily_analysis), status (active/promoted/executed/archived/reverted), target_type, search input
- Summary cards: total active, promoted, executed counts
- Insight cards: title, source badge (colored), category badge, target_type badge, confidence bar, validate/reject buttons
- Pagination controls
- Calls `GET /api/insights` with query params

**`renderDetail(el, id)`** — Detail view:
- Header: title, source/category/target_type badges
- Metadata: confidence (editable bar), observation_count, validation/rejection counts, dates
- Action buttons: Validate, Reject
- Action data section (if present): description, what_changes, implementation_steps, claude_prompt with copy button
- Status badge (active/promoted/executed/archived/reverted)
- Revert button (only if status=promoted)
- Delete button
- Calls `GET /api/insights/:id`

Use existing patterns from the codebase:
- Import `{ get, put, del }` from `./api.js`
- Match existing CSS classes from `index.html` (dark theme, cards, badges)
- Reference `learning-instincts.js` for confidence bar HTML pattern
- Reference `learning-suggestions.js` for action data rendering pattern

Badge colors by source:
- observer: `badge-info` (blue)
- daily_analysis: `badge-warning` (orange)
- manual: `badge-secondary` (gray)

Badge colors by target_type:
- rule: red, hook: purple, skill: green, agent: blue, knowledge: gray

- [ ] **Step 2: Update learning.js**

Change SECTIONS array to use single insights module:

```javascript
const SECTIONS = [
  { key: 'insights', label: 'Insights', loader: () => import('./learning-insights.js') },
];
```

Remove references to learning-instincts and learning-suggestions loaders.

- [ ] **Step 3: Update router.js if needed**

Check for any direct references to old learning sub-modules and update.

- [ ] **Step 4: Take screenshot to verify UI**

Start server, open browser, navigate to learning page. Verify list and detail views render correctly.

- [ ] **Step 5: Commit**

```bash
git add public/modules/learning-insights.js public/modules/learning.js public/modules/router.js
git commit -m "feat: unified insights frontend module"
```

---

### Task 7: Final cleanup and verification

**Files:**
- Modify: `test/op-learning-api.test.js` — update endpoint tests
- Modify: `CLAUDE.md` — update schema and API docs
- Various: fix remaining broken references

- [ ] **Step 1: Update learning API tests**

Replace instinct/suggestion endpoint tests with insights tests:
- GET /api/insights
- GET /api/insights/:id
- PUT /api/insights/:id/validate
- PUT /api/insights/:id/reject
- GET /api/insights/stats

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 3: Reset DB and integration test**

```bash
npm run reset-db
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/health
curl -s http://127.0.0.1:3827/api/insights
kill %1
```

- [ ] **Step 4: Update CLAUDE.md**

In Database Schema table:
- Remove `cl_instincts` and `suggestions` rows
- Add: `insights | Unified learned patterns + suggestions | id, source, category, target_type, confidence, status, action_data`

In API Endpoints table:
- Remove all `/api/instincts/*` and `/api/suggestions/*` rows
- Add insights endpoints

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update tests, docs, and cleanup for unified insights"
```

---

### Summary of Changes

| File | Action | Lines (est.) |
|---|---|---|
| `src/db/insights.js` | Create | ~160 |
| `src/routes/insights.js` | Create | ~80 |
| `public/modules/learning-insights.js` | Create | ~450 |
| `src/op-db.js` | Modify | ~30 changed |
| `src/op-ingest.js` | Modify | ~20 changed |
| `src/op-sync.js` | Modify | ~15 changed |
| `src/op-server.js` | Modify | ~10 changed |
| `public/modules/learning.js` | Modify | ~10 changed |
| `scripts/op-suggestion-agent.js` | Modify | ~30 changed |
| `src/db/instincts.js` | Delete | -113 |
| `src/db/suggestions.js` | Delete | -70 |
| `src/routes/instincts.js` | Delete | -266 |
| `src/routes/suggestions.js` | Delete | -195 |
| Tests | Modify | ~100 changed |
