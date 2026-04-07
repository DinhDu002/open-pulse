# CL Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comprehensive Learning page and Dashboard widget to visualize and manage Continuous Learning data (instincts, observations, projects, suggestions).

**Architecture:** New backend query functions in `op-db.js` + new API endpoints in `op-server.js` + new frontend module `learning.js` (split into sub-modules per section) + Dashboard widget extension. TDD approach: tests first for all backend work.

**Tech Stack:** Node.js, Fastify, better-sqlite3, vanilla JS ES modules, Chart.js 4

**Spec:** `docs/superpowers/specs/2026-04-07-cl-dashboard-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `test/op-learning-api.test.js` | Tests for all new/modified CL API endpoints |
| `public/modules/learning.js` | Learning page orchestrator: mount/unmount, sidebar, sub-route dispatch |
| `public/modules/learning-instincts.js` | Instincts list view (filters, charts) + detail view (metadata, content, related) |
| `public/modules/learning-observations.js` | Observations list view (filters, activity chart) + detail view |
| `public/modules/learning-projects.js` | Projects list view (comparison charts) + drill-down view |
| `public/modules/learning-suggestions.js` | Suggestion history: filters, summary cards, approve/dismiss |

### Modified Files

| File | Changes |
|---|---|
| `src/op-db.js` | Add `instinct_id` column migration, 12 new query functions |
| `src/op-server.js` | Add 12 new endpoints, enhance 3 existing endpoints |
| `public/index.html` | Add "Learning" nav link, add CSS for learning layout |
| `public/modules/router.js` | Add `learning` route entry |
| `public/modules/dashboard.js` | Add CL summary widget at bottom |

---

## Task 1: DB Schema Migration + Query Functions

**Files:**
- Modify: `src/op-db.js`
- Test: `test/op-learning-api.test.js` (create)

### Step 1: Write tests for new DB query functions

- [ ] **Step 1.1: Create test file with DB setup and observation queries tests**

```javascript
// test/op-learning-api.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  createDb,
  queryObservations,
  getObservation,
  queryObservationActivity,
  queryInstinctsFiltered,
  getInstinctStats,
  getInstinctObservations,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  queryLearningActivity,
  queryLearningRecent,
} = require('../src/op-db');

describe('CL Learning API - DB queries', () => {
  let db;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-learn-'));
    db = createDb(path.join(tmpDir, 'test.db'));

    // Seed cl_projects
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
      VALUES ('proj1', 'open-pulse', '/home/op', '2026-04-01T00:00:00Z', '2026-04-07T00:00:00Z', 10)`).run();

    // Seed cl_instincts
    db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
      VALUES ('proj1', 'workflow', 'read before edit', 0.7, 6, '2026-04-01', '2026-04-06', 'Always read first')`).run();
    db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
      VALUES ('proj1', 'testing', 'test first', 0.85, 12, '2026-04-01', '2026-04-06', 'Write test before fix')`).run();
    db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
      VALUES (NULL, 'security', 'no secrets', 0.9, 3, '2026-04-02', '2026-04-05', 'Never hardcode secrets')`).run();

    // Seed cl_observations (instinct_id column must exist after migration)
    const instinct1Id = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read before edit').id;
    db.prepare(`INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES ('2026-04-06T14:00:00Z', 'proj1', 'sess1', 'workflow', 'Read then edit detected', '{"seq":1}', ?)`).run(instinct1Id);
    db.prepare(`INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES ('2026-04-06T15:00:00Z', 'proj1', 'sess1', 'testing', 'Test-first pattern', '{"seq":2}', NULL)`).run();
    db.prepare(`INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES ('2026-04-05T10:00:00Z', 'proj1', 'sess2', 'workflow', 'Another read-edit', NULL, ?)`).run(instinct1Id);

    // Seed suggestions
    db.prepare(`INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status)
      VALUES ('sug1', '2026-04-06T12:00:00Z', 'hook', 0.72, 'Create auto-format hook', '[]', ?, 'pending')`).run(instinct1Id);
    db.prepare(`INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status, resolved_at)
      VALUES ('sug2', '2026-04-03T10:00:00Z', 'rule', 0.8, 'Add immutable rule', '[]', ?, 'approved', '2026-04-04T10:00:00Z')`).run(instinct1Id);
  });

  after(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe('queryObservations', () => {
    it('returns all observations paginated', () => {
      const result = queryObservations(db, { page: 1, perPage: 10 });
      assert.equal(result.total, 3);
      assert.equal(result.items.length, 3);
      assert.equal(result.page, 1);
    });

    it('filters by project', () => {
      const result = queryObservations(db, { project: 'proj1', page: 1, perPage: 10 });
      assert.equal(result.total, 3);
    });

    it('filters by category', () => {
      const result = queryObservations(db, { category: 'workflow', page: 1, perPage: 10 });
      assert.equal(result.total, 2);
    });

    it('filters by instinct_id', () => {
      const instId = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read before edit').id;
      const result = queryObservations(db, { instinct_id: instId, page: 1, perPage: 10 });
      assert.equal(result.total, 2);
    });

    it('paginates correctly', () => {
      const result = queryObservations(db, { page: 2, perPage: 2 });
      assert.equal(result.total, 3);
      assert.equal(result.items.length, 1);
      assert.equal(result.page, 2);
    });
  });

  describe('getObservation', () => {
    it('returns single observation by id', () => {
      const all = queryObservations(db, { page: 1, perPage: 1 });
      const obs = getObservation(db, all.items[0].id);
      assert.ok(obs);
      assert.ok(obs.observation);
    });

    it('returns undefined for missing id', () => {
      const obs = getObservation(db, 99999);
      assert.equal(obs, undefined);
    });
  });

  describe('queryObservationActivity', () => {
    it('returns daily observation counts', () => {
      const activity = queryObservationActivity(db, 7);
      assert.ok(Array.isArray(activity));
      assert.ok(activity.length > 0);
      assert.ok(activity[0].date);
      assert.ok(typeof activity[0].count === 'number');
    });
  });

  describe('queryInstinctsFiltered', () => {
    it('returns all instincts paginated', () => {
      const result = queryInstinctsFiltered(db, { page: 1, perPage: 10 });
      assert.equal(result.total, 3);
      assert.equal(result.items.length, 3);
    });

    it('filters by domain/category', () => {
      const result = queryInstinctsFiltered(db, { domain: 'workflow', page: 1, perPage: 10 });
      assert.equal(result.total, 1);
    });

    it('filters by project', () => {
      const result = queryInstinctsFiltered(db, { project: 'proj1', page: 1, perPage: 10 });
      assert.equal(result.total, 2);
    });

    it('filters by confidence range', () => {
      const result = queryInstinctsFiltered(db, { confidence_min: 0.8, page: 1, perPage: 10 });
      assert.equal(result.total, 2); // 0.85 and 0.9
    });

    it('searches by text', () => {
      const result = queryInstinctsFiltered(db, { search: 'secret', page: 1, perPage: 10 });
      assert.equal(result.total, 1);
    });
  });

  describe('getInstinctStats', () => {
    it('returns domain breakdown and confidence distribution', () => {
      const stats = getInstinctStats(db);
      assert.ok(stats.byDomain);
      assert.ok(stats.confidenceDistribution);
    });
  });

  describe('getInstinctObservations', () => {
    it('returns observations for an instinct', () => {
      const instId = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read before edit').id;
      const obs = getInstinctObservations(db, instId);
      assert.equal(obs.length, 2);
    });
  });

  describe('getInstinctSuggestions', () => {
    it('returns suggestions for an instinct', () => {
      const instId = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read before edit').id;
      const sugs = getInstinctSuggestions(db, instId);
      assert.equal(sugs.length, 2);
    });
  });

  describe('updateInstinct', () => {
    it('updates confidence', () => {
      const instId = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('no secrets').id;
      updateInstinct(db, instId, { confidence: 0.5 });
      const inst = db.prepare('SELECT confidence FROM cl_instincts WHERE id = ?').get(instId);
      assert.equal(inst.confidence, 0.5);
    });
  });

  describe('deleteInstinct', () => {
    it('deletes an instinct by id', () => {
      db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, instinct)
        VALUES ('proj1', 'test', 'deleteme', 0.1, 'temp')`).run();
      const inst = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('deleteme');
      deleteInstinct(db, inst.id);
      const gone = db.prepare('SELECT id FROM cl_instincts WHERE id = ?').get(inst.id);
      assert.equal(gone, undefined);
    });
  });

  describe('getProjectSummary', () => {
    it('returns project with counts', () => {
      const summary = getProjectSummary(db, 'proj1');
      assert.equal(summary.name, 'open-pulse');
      assert.ok(typeof summary.instinct_count === 'number');
      assert.ok(typeof summary.observation_count === 'number');
    });

    it('returns undefined for unknown project', () => {
      const summary = getProjectSummary(db, 'nonexistent');
      assert.equal(summary, undefined);
    });
  });

  describe('getProjectTimeline', () => {
    it('returns weekly data points', () => {
      const timeline = getProjectTimeline(db, 'proj1', 4);
      assert.ok(Array.isArray(timeline));
    });
  });

  describe('queryLearningActivity', () => {
    it('returns daily combined activity', () => {
      const activity = queryLearningActivity(db, 7);
      assert.ok(Array.isArray(activity));
      assert.ok(activity[0].date);
    });
  });

  describe('queryLearningRecent', () => {
    it('returns mixed recent items', () => {
      const recent = queryLearningRecent(db, 5);
      assert.ok(Array.isArray(recent));
      assert.ok(recent.length > 0);
      assert.ok(recent[0].kind); // 'instinct' or 'suggestion'
    });
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `node --test test/op-learning-api.test.js`
Expected: FAIL — functions not exported from `op-db.js`

### Step 2: Implement DB migration and query functions

- [ ] **Step 2.1: Add `instinct_id` column migration to schema init**

In `src/op-db.js`, in the `createDb` function, after existing `CREATE TABLE cl_observations`, add migration:

```javascript
// Migration: add instinct_id to cl_observations
const colCheck = db.prepare(
  "SELECT COUNT(*) AS cnt FROM pragma_table_info('cl_observations') WHERE name = 'instinct_id'"
).get();
if (colCheck.cnt === 0) {
  db.exec('ALTER TABLE cl_observations ADD COLUMN instinct_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cl_observations_instinct ON cl_observations(instinct_id)');
}
```

- [ ] **Step 2.2: Implement `queryObservations`**

```javascript
function queryObservations(db, { project, category, from, to, instinct_id, search, page = 1, perPage = 20 } = {}) {
  const conditions = [];
  const params = {};
  if (project) { conditions.push('project_id = @project'); params.project = project; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (from) { conditions.push('observed_at >= @from'); params.from = from; }
  if (to) { conditions.push('observed_at <= @to'); params.to = to; }
  if (instinct_id) { conditions.push('instinct_id = @instinct_id'); params.instinct_id = instinct_id; }
  if (search) { conditions.push('observation LIKE @search'); params.search = '%' + search + '%'; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cl_observations ${where}`).get(params).cnt;
  const offset = (page - 1) * perPage;
  const items = db.prepare(
    `SELECT * FROM cl_observations ${where} ORDER BY observed_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset });

  return { items, total, page, per_page: perPage };
}
```

- [ ] **Step 2.3: Implement `getObservation`**

```javascript
function getObservation(db, id) {
  return db.prepare('SELECT * FROM cl_observations WHERE id = ?').get(id);
}
```

- [ ] **Step 2.4: Implement `queryObservationActivity`**

```javascript
function queryObservationActivity(db, days = 7) {
  return db.prepare(`
    SELECT date(observed_at) AS date, COUNT(*) AS count
    FROM cl_observations
    WHERE observed_at >= date('now', '-' || ? || ' days')
    GROUP BY date(observed_at)
    ORDER BY date ASC
  `).all(days);
}
```

- [ ] **Step 2.5: Implement `queryInstinctsFiltered`**

```javascript
function queryInstinctsFiltered(db, { domain, source, project, confidence_min, confidence_max, search, page = 1, perPage = 20 } = {}) {
  const conditions = [];
  const params = {};
  if (domain) { conditions.push('category = @domain'); params.domain = domain; }
  if (project) { conditions.push('project_id = @project'); params.project = project; }
  if (confidence_min != null) { conditions.push('confidence >= @confidence_min'); params.confidence_min = confidence_min; }
  if (confidence_max != null) { conditions.push('confidence <= @confidence_max'); params.confidence_max = confidence_max; }
  if (search) { conditions.push('(pattern LIKE @search OR instinct LIKE @search)'); params.search = '%' + search + '%'; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cl_instincts ${where}`).get(params).cnt;
  const offset = (page - 1) * perPage;
  const items = db.prepare(
    `SELECT * FROM cl_instincts ${where} ORDER BY confidence DESC, last_seen DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset });

  return { items, total, page, per_page: perPage };
}
```

- [ ] **Step 2.6: Implement `getInstinctStats`**

```javascript
function getInstinctStats(db) {
  const byDomain = db.prepare(
    'SELECT category AS domain, COUNT(*) AS count FROM cl_instincts GROUP BY category ORDER BY count DESC'
  ).all();

  const confidenceDistribution = db.prepare(`
    SELECT
      CASE
        WHEN confidence < 0.3 THEN 'low'
        WHEN confidence < 0.6 THEN 'medium'
        ELSE 'high'
      END AS bucket,
      COUNT(*) AS count
    FROM cl_instincts
    GROUP BY bucket
  `).all();

  return { byDomain, confidenceDistribution };
}
```

- [ ] **Step 2.7: Implement `getInstinctObservations` and `getInstinctSuggestions`**

```javascript
function getInstinctObservations(db, instinctId) {
  return db.prepare(
    'SELECT * FROM cl_observations WHERE instinct_id = ? ORDER BY observed_at DESC'
  ).all(instinctId);
}

function getInstinctSuggestions(db, instinctId) {
  return db.prepare(
    'SELECT * FROM suggestions WHERE instinct_id = ? ORDER BY created_at DESC'
  ).all(instinctId);
}
```

- [ ] **Step 2.8: Implement `updateInstinct` and `deleteInstinct`**

```javascript
function updateInstinct(db, id, { confidence }) {
  if (confidence != null) {
    const clamped = Math.max(0.0, Math.min(0.95, confidence));
    db.prepare('UPDATE cl_instincts SET confidence = ? WHERE id = ?').run(clamped, id);
  }
}

function deleteInstinct(db, id) {
  db.prepare('DELETE FROM cl_instincts WHERE id = ?').run(id);
}
```

- [ ] **Step 2.9: Implement `getProjectSummary`**

```javascript
function getProjectSummary(db, projectId) {
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
  if (!project) return undefined;

  const instinct_count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM cl_instincts WHERE project_id = ?'
  ).get(projectId).cnt;
  const observation_count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM cl_observations WHERE project_id = ?'
  ).get(projectId).cnt;
  const suggestion_counts = db.prepare(`
    SELECT s.status, COUNT(*) AS cnt FROM suggestions s
    JOIN cl_instincts i ON s.instinct_id = i.id
    WHERE i.project_id = ?
    GROUP BY status
  `).all(projectId);

  return { ...project, instinct_count, observation_count, suggestion_counts };
}
```

- [ ] **Step 2.10: Implement `getProjectTimeline`**

```javascript
function getProjectTimeline(db, projectId, weeks = 8) {
  return db.prepare(`
    SELECT
      date(last_seen, 'weekday 0', '-6 days') AS week_start,
      COUNT(*) AS instinct_count,
      AVG(confidence) AS avg_confidence
    FROM cl_instincts
    WHERE project_id = ? AND last_seen >= date('now', '-' || ? || ' days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all(projectId, weeks * 7);
}
```

- [ ] **Step 2.11: Implement `queryLearningActivity`**

```javascript
function queryLearningActivity(db, days = 7) {
  return db.prepare(`
    SELECT date AS date, SUM(count) AS count FROM (
      SELECT date(observed_at) AS date, COUNT(*) AS count
      FROM cl_observations
      WHERE observed_at >= date('now', '-' || @days || ' days')
      GROUP BY date(observed_at)
      UNION ALL
      SELECT date(last_seen) AS date, COUNT(*) AS count
      FROM cl_instincts
      WHERE last_seen >= date('now', '-' || @days || ' days')
      GROUP BY date(last_seen)
    ) combined
    GROUP BY date
    ORDER BY date ASC
  `).all({ days });
}
```

- [ ] **Step 2.12: Implement `queryLearningRecent`**

```javascript
function queryLearningRecent(db, limit = 5) {
  return db.prepare(`
    SELECT * FROM (
      SELECT 'instinct' AS kind, id, last_seen AS timestamp, pattern AS title, confidence, category
      FROM cl_instincts
      UNION ALL
      SELECT 'suggestion' AS kind, id, created_at AS timestamp, description AS title, confidence, type AS category
      FROM suggestions
    ) combined
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);
}
```

- [ ] **Step 2.13: Add all new functions to module.exports**

In the `module.exports` block at the bottom of `src/op-db.js`, add:

```javascript
  queryObservations,
  getObservation,
  queryObservationActivity,
  queryInstinctsFiltered,
  getInstinctStats,
  getInstinctObservations,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  queryLearningActivity,
  queryLearningRecent,
```

- [ ] **Step 2.14: Run tests to verify they pass**

Run: `node --test test/op-learning-api.test.js`
Expected: All tests PASS

- [ ] **Step 2.15: Run existing tests to check for regressions**

Run: `npm test`
Expected: All 87+ tests PASS

- [ ] **Step 2.16: Commit**

```bash
git add src/op-db.js test/op-learning-api.test.js
git commit -m "feat: CL learning DB queries + instinct_id migration

Add 12 new query functions for observations, instincts (filtered),
projects (summary, timeline), and learning dashboard widget.
Migration adds instinct_id column to cl_observations."
```

---

## Task 2: Observations API Endpoints

**Files:**
- Modify: `src/op-server.js`
- Test: `test/op-learning-api.test.js` (extend)

### Step 1: Write API tests for observations endpoints

- [ ] **Step 1.1: Add observations API tests**

Append to `test/op-learning-api.test.js` a new describe block that starts a Fastify test server. Follow the pattern in `test/op-server.test.js` for server setup.

```javascript
describe('CL Learning API - HTTP endpoints', () => {
  let app;
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-learn-http-'));
    const dbPath = path.join(tmpDir, 'test.db');
    process.env.OPEN_PULSE_DB = dbPath;
    process.env.OPEN_PULSE_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'data'));

    // Create server with timers disabled
    const { buildServer } = require('../src/op-server');
    app = buildServer({ disableTimers: true });
    await app.ready();

    // Seed test data
    const db = app.db;
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
      VALUES ('proj1', 'test-proj', '/tmp/test', '2026-04-01T00:00:00Z', '2026-04-07T00:00:00Z', 5)`).run();
    db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
      VALUES ('proj1', 'workflow', 'read first', 0.7, 6, '2026-04-01', '2026-04-06', 'Read before edit')`).run();
    const instId = db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read first').id;
    db.prepare(`INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES ('2026-04-06T14:00:00Z', 'proj1', 'sess1', 'workflow', 'Read-edit pattern', '{"key":"val"}', ?)`).run(instId);
    db.prepare(`INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES ('2026-04-05T10:00:00Z', 'proj1', 'sess2', 'testing', 'Test first', NULL, NULL)`).run();
    db.prepare(`INSERT INTO suggestions (id, created_at, type, confidence, description, instinct_id, status)
      VALUES ('s1', '2026-04-06T12:00:00Z', 'hook', 0.72, 'Auto-format hook', ?, 'pending')`).run(instId);
  });

  after(async () => {
    await app.close();
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe('GET /api/observations', () => {
    it('returns paginated observations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/observations' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.total, 2);
      assert.ok(Array.isArray(body.items));
    });

    it('filters by category', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/observations?category=workflow' });
      const body = JSON.parse(res.payload);
      assert.equal(body.total, 1);
    });

    it('filters by project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/observations?project=proj1' });
      const body = JSON.parse(res.payload);
      assert.equal(body.total, 2);
    });
  });

  describe('GET /api/observations/:id', () => {
    it('returns single observation', async () => {
      const list = await app.inject({ method: 'GET', url: '/api/observations?per_page=1' });
      const id = JSON.parse(list.payload).items[0].id;
      const res = await app.inject({ method: 'GET', url: `/api/observations/${id}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.observation);
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/observations/99999' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /api/observations/activity', () => {
    it('returns daily counts', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/observations/activity?days=7' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `node --test test/op-learning-api.test.js`
Expected: FAIL — endpoints not registered, `buildServer` not exported

### Step 2: Implement observations endpoints

- [ ] **Step 2.1: Export `buildServer` from `op-server.js`**

The existing server in `op-server.js` creates the Fastify app inline. Refactor the app creation into a `buildServer({ disableTimers })` function and export it, while keeping the existing start behavior. At the bottom, keep `if (require.main === module) { buildServer().listen(...) }`.

Check `test/op-server.test.js` for how it currently creates the server — it may already use a similar pattern. Adapt accordingly.

- [ ] **Step 2.2: Add observations endpoints to `op-server.js`**

After the existing CL endpoints section (~line 943), add:

```javascript
const { queryObservations, getObservation, queryObservationActivity } = require('./op-db');

app.get('/api/observations', async (request) => {
  const { project, category, from, to, instinct_id, search, page, per_page } = request.query;
  return queryObservations(db, {
    project, category, from, to, instinct_id, search,
    page: Math.max(1, parseInt(page) || 1),
    perPage: Math.min(50, Math.max(1, parseInt(per_page) || 20)),
  });
});

app.get('/api/observations/activity', async (request) => {
  const days = Math.max(1, parseInt(request.query.days) || 7);
  return queryObservationActivity(db, days);
});

app.get('/api/observations/:id', async (request) => {
  const obs = getObservation(db, parseInt(request.params.id));
  if (!obs) return request.server.httpErrors.notFound('Observation not found');
  return obs;
});
```

Note: `/api/observations/activity` must be registered BEFORE `/api/observations/:id` to avoid `:id` matching "activity".

- [ ] **Step 2.3: Run tests to verify they pass**

Run: `node --test test/op-learning-api.test.js`
Expected: All tests PASS

- [ ] **Step 2.4: Run full test suite for regressions**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/op-server.js test/op-learning-api.test.js
git commit -m "feat: observations API endpoints

GET /api/observations (paginated, filtered)
GET /api/observations/:id (single)
GET /api/observations/activity (daily counts)"
```

---

## Task 3: Enhanced Instincts API

**Files:**
- Modify: `src/op-server.js`
- Test: `test/op-learning-api.test.js` (extend)

### Step 1: Write tests

- [ ] **Step 1.1: Add instinct API tests**

Append to the HTTP test describe block:

```javascript
  describe('GET /api/instincts (enhanced)', () => {
    it('returns filtered paginated instincts', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/instincts?domain=workflow' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.total != null);
      assert.ok(Array.isArray(body.items));
    });

    it('filters by confidence range', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/instincts?confidence_min=0.7' });
      const body = JSON.parse(res.payload);
      assert.ok(body.items.every(i => i.confidence >= 0.7));
    });

    it('searches by text', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/instincts?search=read' });
      const body = JSON.parse(res.payload);
      assert.ok(body.total >= 1);
    });
  });

  describe('GET /api/instincts/stats', () => {
    it('returns domain breakdown and confidence distribution', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/instincts/stats' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.byDomain);
      assert.ok(body.confidenceDistribution);
    });
  });

  describe('GET /api/instincts/:id/observations', () => {
    it('returns observations for an instinct', async () => {
      const instId = app.db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read first').id;
      const res = await app.inject({ method: 'GET', url: `/api/instincts/${instId}/observations` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
    });
  });

  describe('GET /api/instincts/:id/suggestions', () => {
    it('returns suggestions for an instinct', async () => {
      const instId = app.db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read first').id;
      const res = await app.inject({ method: 'GET', url: `/api/instincts/${instId}/suggestions` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });
  });

  describe('PUT /api/instincts/:id', () => {
    it('updates confidence', async () => {
      const instId = app.db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('read first').id;
      const res = await app.inject({
        method: 'PUT', url: `/api/instincts/${instId}`,
        payload: { confidence: 0.55 },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, true);
    });
  });

  describe('DELETE /api/instincts/:id', () => {
    it('deletes an instinct', async () => {
      app.db.prepare(`INSERT INTO cl_instincts (project_id, category, pattern, confidence, instinct)
        VALUES ('proj1', 'test', 'to-delete', 0.1, 'temp')`).run();
      const instId = app.db.prepare('SELECT id FROM cl_instincts WHERE pattern = ?').get('to-delete').id;
      const res = await app.inject({ method: 'DELETE', url: `/api/instincts/${instId}` });
      assert.equal(res.statusCode, 200);
      const gone = app.db.prepare('SELECT id FROM cl_instincts WHERE id = ?').get(instId);
      assert.equal(gone, undefined);
    });
  });
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `node --test test/op-learning-api.test.js`
Expected: FAIL — new endpoints not registered

### Step 2: Implement endpoints

- [ ] **Step 2.1: Replace existing `GET /api/instincts` with enhanced version**

Replace the existing instincts endpoint (~line 894) with the filtered version. Import the new functions at the top of the routes section:

```javascript
app.get('/api/instincts', async (request) => {
  const { domain, source, project, confidence_min, confidence_max, search, page, per_page } = request.query;
  return queryInstinctsFiltered(db, {
    domain, source, project,
    confidence_min: confidence_min != null ? parseFloat(confidence_min) : undefined,
    confidence_max: confidence_max != null ? parseFloat(confidence_max) : undefined,
    search,
    page: Math.max(1, parseInt(page) || 1),
    perPage: Math.min(50, Math.max(1, parseInt(per_page) || 20)),
  });
});

app.get('/api/instincts/stats', async () => {
  return getInstinctStats(db);
});

app.get('/api/instincts/:id/observations', async (request) => {
  return getInstinctObservations(db, parseInt(request.params.id));
});

app.get('/api/instincts/:id/suggestions', async (request) => {
  return getInstinctSuggestions(db, parseInt(request.params.id));
});

app.put('/api/instincts/:id', async (request) => {
  const id = parseInt(request.params.id);
  const { confidence } = request.body || {};
  updateInstinct(db, id, { confidence });
  return { success: true, id };
});

app.delete('/api/instincts/:id', async (request) => {
  const id = parseInt(request.params.id);
  deleteInstinct(db, id);
  return { success: true, id };
});
```

Note: register `/api/instincts/stats` and `/api/instincts/projects` BEFORE `/api/instincts/:id/*` routes.

- [ ] **Step 2.2: Run tests**

Run: `node --test test/op-learning-api.test.js`
Expected: All PASS

- [ ] **Step 2.3: Run full test suite**

Run: `npm test`
Expected: All PASS (check existing instinct endpoint tests in `op-server.test.js` still work — the response shape changed from array to `{items, total, page, per_page}`)

If existing tests fail due to response shape change, update them to match the new paginated response format.

- [ ] **Step 2.4: Commit**

```bash
git add src/op-server.js test/op-learning-api.test.js
git commit -m "feat: enhanced instincts API with filters, stats, CRUD

Replace basic instincts list with filtered/paginated version.
Add stats, per-instinct observations/suggestions, update, delete."
```

---

## Task 4: Projects + Learning Widget API

**Files:**
- Modify: `src/op-server.js`
- Test: `test/op-learning-api.test.js` (extend)

### Step 1: Write tests

- [ ] **Step 1.1: Add project and learning widget API tests**

```javascript
  describe('GET /api/projects/:id/summary', () => {
    it('returns project with counts', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/proj1/summary' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.name, 'test-proj');
      assert.ok(typeof body.instinct_count === 'number');
      assert.ok(typeof body.observation_count === 'number');
    });

    it('returns 404 for unknown project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/nonexistent/summary' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /api/projects/:id/timeline', () => {
    it('returns weekly data', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/proj1/timeline?weeks=4' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });
  });

  describe('GET /api/learning/activity', () => {
    it('returns combined daily activity', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/learning/activity?days=7' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });
  });

  describe('GET /api/learning/recent', () => {
    it('returns mixed recent items', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/learning/recent?limit=5' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
      assert.ok(body[0].kind);
    });
  });

  describe('GET /api/suggestions (enhanced)', () => {
    it('filters by project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/suggestions?project=proj1' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });
  });
```

- [ ] **Step 1.2: Run tests to verify they fail**

### Step 2: Implement endpoints

- [ ] **Step 2.1: Add project endpoints**

```javascript
app.get('/api/projects/:id/summary', async (request) => {
  const summary = getProjectSummary(db, request.params.id);
  if (!summary) return request.server.httpErrors.notFound('Project not found');
  return summary;
});

app.get('/api/projects/:id/timeline', async (request) => {
  const weeks = Math.max(1, parseInt(request.query.weeks) || 8);
  return getProjectTimeline(db, request.params.id, weeks);
});
```

- [ ] **Step 2.2: Add learning widget endpoints**

```javascript
app.get('/api/learning/activity', async (request) => {
  const days = Math.max(1, parseInt(request.query.days) || 7);
  return queryLearningActivity(db, days);
});

app.get('/api/learning/recent', async (request) => {
  const limit = Math.min(20, Math.max(1, parseInt(request.query.limit) || 5));
  return queryLearningRecent(db, limit);
});
```

- [ ] **Step 2.3: Enhance `GET /api/suggestions` with project filter**

Modify the existing suggestions endpoint to accept a `project` query parameter. When provided, join through `cl_instincts` to filter by project:

```javascript
app.get('/api/suggestions', async (request) => {
  const { status, project } = request.query;
  if (project) {
    const sql = `SELECT s.* FROM suggestions s
      JOIN cl_instincts i ON s.instinct_id = i.id
      WHERE i.project_id = ?` + (status ? ' AND s.status = ?' : '') +
      ' ORDER BY s.created_at DESC';
    return status ? db.prepare(sql).all(project, status) : db.prepare(sql).all(project);
  }
  return querySuggestions(db, status || null);
});
```

- [ ] **Step 2.4: Enhance `GET /api/instincts/projects` with approve/dismiss rates**

Modify the existing projects endpoint to include suggestion counts per project:

```javascript
// After fetching base project data, add suggestion counts
for (const proj of projects) {
  const counts = db.prepare(`
    SELECT s.status, COUNT(*) AS cnt FROM suggestions s
    JOIN cl_instincts i ON s.instinct_id = i.id
    WHERE i.project_id = ?
    GROUP BY s.status
  `).all(proj.project_id);
  proj.approved = counts.find(c => c.status === 'approved')?.cnt || 0;
  proj.dismissed = counts.find(c => c.status === 'dismissed')?.cnt || 0;
  proj.pending = counts.find(c => c.status === 'pending')?.cnt || 0;
  const total = proj.approved + proj.dismissed;
  proj.approve_rate = total > 0 ? proj.approved / total : null;
}
```

- [ ] **Step 2.5: Run tests**

Run: `node --test test/op-learning-api.test.js`
Expected: All PASS

- [ ] **Step 2.6: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 2.7: Commit**

```bash
git add src/op-server.js test/op-learning-api.test.js
git commit -m "feat: projects, learning widget, and enhanced suggestions API

GET /api/projects/:id/summary, /api/projects/:id/timeline
GET /api/learning/activity, /api/learning/recent
Add project filter to GET /api/suggestions
Add approve/dismiss rates to GET /api/instincts/projects"
```

---

## Task 5: Frontend — Nav + Router + Learning Scaffold

**Files:**
- Modify: `public/index.html`, `public/modules/router.js`
- Create: `public/modules/learning.js`

- [ ] **Step 5.1: Add "Learning" link to nav in `index.html`**

After the Expert link, add:

```html
<a href="#learning">Learning</a>
```

- [ ] **Step 5.2: Add CSS for learning layout in `index.html`**

In the `<style>` section, add:

```css
.learning-layout { display: flex; gap: 0; min-height: 70vh; }
.learning-sidebar {
  width: 200px; flex-shrink: 0; border-right: 1px solid var(--border);
  padding: 1rem 0; display: flex; flex-direction: column;
}
.learning-sidebar a {
  display: block; padding: 0.6rem 1.2rem; color: var(--text-muted);
  text-decoration: none; border-left: 3px solid transparent;
}
.learning-sidebar a.active { color: var(--accent); border-left-color: var(--accent); background: rgba(108,92,231,0.08); }
.learning-sidebar a:hover { color: var(--text); background: rgba(255,255,255,0.03); }
.learning-sidebar .sidebar-stats { margin-top: auto; padding: 1rem 1.2rem; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--text-muted); }
.learning-sidebar .sidebar-stats div { margin-bottom: 0.3rem; }
.learning-sidebar .sidebar-stats span { color: var(--text); font-weight: 600; }
.learning-main { flex: 1; padding: 1.2rem; min-width: 0; }
.learning-footer { padding: 0.6rem 1.2rem; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--text-muted); display: flex; gap: 1.5rem; }
.learning-breadcrumb { font-size: 0.85rem; margin-bottom: 1rem; color: var(--text-muted); }
.learning-breadcrumb a { color: var(--accent); text-decoration: none; }
.confidence-bar { display: inline-block; width: 60px; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; vertical-align: middle; }
.confidence-bar .fill { height: 100%; border-radius: 4px; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; background: var(--border); color: var(--text); }
.badge.workflow { background: rgba(108,92,231,0.2); color: #a29bfe; }
.badge.testing { background: rgba(0,184,148,0.2); color: #55efc4; }
.badge.security { background: rgba(225,112,85,0.2); color: #fab1a0; }
.badge.approved { background: rgba(0,184,148,0.2); color: var(--success); }
.badge.dismissed { background: rgba(225,112,85,0.2); color: var(--danger); }
.badge.pending { background: rgba(253,203,110,0.2); color: var(--warning); }
.obs-activity-chart { height: 120px; margin-bottom: 1rem; }
.chart-toggle { cursor: pointer; color: var(--accent); font-size: 0.85rem; margin-bottom: 0.5rem; }
.filter-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 1rem; }
.filter-row select, .filter-row input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.4rem 0.6rem; border-radius: 4px; font-size: 0.85rem; }
```

- [ ] **Step 5.3: Add learning route to `router.js`**

In the `ROUTES` object, add:

```javascript
learning: () => import('./learning.js'),
```

Add `'learning'` to the `NO_PERIOD` set if it exists (Learning page manages its own filters).

- [ ] **Step 5.4: Create `learning.js` scaffold**

```javascript
// public/modules/learning.js
import { get } from './api.js';

const SECTIONS = [
  { key: 'instincts', label: 'Instincts' },
  { key: 'observations', label: 'Observations' },
  { key: 'projects', label: 'Projects' },
  { key: 'suggestions', label: 'Suggestions' },
];

let root = null;
let mainEl = null;
let currentSection = 'instincts';

// Lazy-loaded sub-modules
const loaders = {
  instincts: () => import('./learning-instincts.js'),
  observations: () => import('./learning-observations.js'),
  projects: () => import('./learning-projects.js'),
  suggestions: () => import('./learning-suggestions.js'),
};
let loadedModules = {};

function parseParams(params) {
  if (!params) return { section: 'instincts', detail: null };
  const parts = params.split('/');
  const section = SECTIONS.find(s => s.key === parts[0]) ? parts[0] : 'instincts';
  const detail = parts[1] || null;
  return { section, detail };
}

async function loadStats(statsEl) {
  try {
    const [instincts, activity, suggestions] = await Promise.all([
      get('/instincts?per_page=1'),
      get('/observations/activity?days=1'),
      get('/suggestions?status=pending'),
    ]);
    const todayObs = activity.reduce((s, d) => s + d.count, 0);
    statsEl.innerHTML =
      `<div>Instincts: <span>${instincts.total}</span></div>` +
      `<div>Observations today: <span>${todayObs}</span></div>` +
      `<div>Pending: <span>${suggestions.length}</span></div>`;
  } catch { statsEl.innerHTML = '<div>Stats unavailable</div>'; }
}

function renderSidebar(container, active) {
  const sidebar = document.createElement('div');
  sidebar.className = 'learning-sidebar';

  for (const { key, label } of SECTIONS) {
    const a = document.createElement('a');
    a.href = '#learning/' + key;
    a.textContent = label;
    if (key === active) a.className = 'active';
    sidebar.appendChild(a);
  }

  const stats = document.createElement('div');
  stats.className = 'sidebar-stats';
  stats.textContent = 'Loading...';
  sidebar.appendChild(stats);
  loadStats(stats);

  container.appendChild(sidebar);
  return sidebar;
}

async function renderSection(section, detail) {
  if (!mainEl) return;
  mainEl.innerHTML = '<div class="loading">Loading...</div>';

  if (!loadedModules[section]) {
    loadedModules[section] = await loaders[section]();
  }
  const mod = loadedModules[section];
  if (detail) {
    mod.renderDetail(mainEl, detail);
  } else {
    mod.renderList(mainEl);
  }
}

export function mount(el, { params }) {
  const { section, detail } = parseParams(params);
  currentSection = section;

  root = document.createElement('div');

  const layout = document.createElement('div');
  layout.className = 'learning-layout';

  renderSidebar(layout, currentSection);

  mainEl = document.createElement('div');
  mainEl.className = 'learning-main';
  layout.appendChild(mainEl);

  root.appendChild(layout);

  const footer = document.createElement('div');
  footer.className = 'learning-footer';
  footer.innerHTML = '<div>Last sync: checking...</div><div>Observer: checking...</div>';
  root.appendChild(footer);

  // Load sync status
  get('/instincts/projects').then(projects => {
    const running = projects.filter(p => p.observer_running).length;
    footer.innerHTML =
      `<div>Projects: ${projects.length}</div>` +
      `<div>Observer: ${running > 0 ? '● ' + running + ' running' : '○ stopped'}</div>`;
  }).catch(() => {});

  el.appendChild(root);
  renderSection(currentSection, detail);
}

export function unmount() {
  loadedModules = {};
  if (root) { root.remove(); root = null; }
  mainEl = null;
}
```

- [ ] **Step 5.5: Create placeholder sub-modules**

Create 4 placeholder files so the scaffold loads without errors:

`public/modules/learning-instincts.js`:
```javascript
export function renderList(el) { el.innerHTML = '<p>Instincts — coming soon</p>'; }
export function renderDetail(el, id) { el.innerHTML = '<p>Instinct detail — coming soon</p>'; }
```

`public/modules/learning-observations.js`:
```javascript
export function renderList(el) { el.innerHTML = '<p>Observations — coming soon</p>'; }
export function renderDetail(el, id) { el.innerHTML = '<p>Observation detail — coming soon</p>'; }
```

`public/modules/learning-projects.js`:
```javascript
export function renderList(el) { el.innerHTML = '<p>Projects — coming soon</p>'; }
export function renderDetail(el, id) { el.innerHTML = '<p>Project detail — coming soon</p>'; }
```

`public/modules/learning-suggestions.js`:
```javascript
export function renderList(el) { el.innerHTML = '<p>Suggestion history — coming soon</p>'; }
export function renderDetail(el, id) { el.innerHTML = '<p>Suggestion detail — coming soon</p>'; }
```

- [ ] **Step 5.6: Verify manually**

Start server: `npm start`
Open `http://localhost:3827/#learning`
Expected: Learning page with sidebar (4 items), main area shows "Instincts — coming soon", footer shows project/observer status.

Click sidebar links — URL changes, placeholder content updates.

- [ ] **Step 5.7: Commit**

```bash
git add public/index.html public/modules/router.js public/modules/learning.js \
  public/modules/learning-instincts.js public/modules/learning-observations.js \
  public/modules/learning-projects.js public/modules/learning-suggestions.js
git commit -m "feat: Learning page scaffold with sidebar and sub-routing

Nav link, router entry, master-detail layout with sidebar navigation.
Placeholder sub-modules for instincts, observations, projects, suggestions."
```

---

## Task 6: Frontend — Instincts Views

**Files:**
- Modify: `public/modules/learning-instincts.js`

- [ ] **Step 6.1: Implement instincts list view**

Replace placeholder with full implementation:

```javascript
// public/modules/learning-instincts.js
import { get, put, del } from './api.js';

let charts = [];

function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}

function confidenceColor(c) {
  if (c < 0.3) return 'var(--danger)';
  if (c < 0.6) return 'var(--warning)';
  return 'var(--success)';
}

function renderConfidenceBar(confidence) {
  return '<span class="confidence-bar"><span class="fill" style="width:' + (confidence * 100) + '%;background:' + confidenceColor(confidence) + '"></span></span> ' + confidence.toFixed(2);
}

function renderFilters(el, state, onFilter) {
  const row = document.createElement('div');
  row.className = 'filter-row';
  row.innerHTML =
    '<select data-key="domain"><option value="">All domains</option></select>' +
    '<select data-key="project"><option value="">All projects</option></select>' +
    '<input type="text" data-key="search" placeholder="Search..." value="' + (state.search || '') + '">';

  // Populate domain options from stats
  get('/instincts/stats').then(stats => {
    const domainSel = row.querySelector('[data-key="domain"]');
    stats.byDomain.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.domain;
      opt.textContent = d.domain + ' (' + d.count + ')';
      if (d.domain === state.domain) opt.selected = true;
      domainSel.appendChild(opt);
    });
  }).catch(() => {});

  // Populate project options
  get('/instincts/projects').then(projects => {
    const projSel = row.querySelector('[data-key="project"]');
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.project_id;
      opt.textContent = p.name;
      if (p.project_id === state.project) opt.selected = true;
      projSel.appendChild(opt);
    });
  }).catch(() => {});

  row.addEventListener('change', () => {
    state.domain = row.querySelector('[data-key="domain"]').value || undefined;
    state.project = row.querySelector('[data-key="project"]').value || undefined;
    state.page = 1;
    onFilter();
  });

  let searchTimeout;
  row.querySelector('[data-key="search"]').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value || undefined;
      state.page = 1;
      onFilter();
    }, 300);
  });

  el.appendChild(row);
}

function renderCharts(el, stats) {
  const toggle = document.createElement('div');
  toggle.className = 'chart-toggle';
  toggle.textContent = '\u25BC Charts';
  let visible = true;

  const row = document.createElement('div');
  row.className = 'charts-row';
  row.style.display = 'flex';
  row.style.gap = '1rem';
  row.style.marginBottom = '1rem';

  const confCanvas = document.createElement('canvas');
  confCanvas.style.maxHeight = '180px';
  confCanvas.style.flex = '1';
  row.appendChild(confCanvas);

  const domCanvas = document.createElement('canvas');
  domCanvas.style.maxHeight = '180px';
  domCanvas.style.flex = '1';
  row.appendChild(domCanvas);

  toggle.addEventListener('click', () => {
    visible = !visible;
    row.style.display = visible ? 'flex' : 'none';
    toggle.textContent = (visible ? '\u25BC' : '\u25B6') + ' Charts';
  });

  el.appendChild(toggle);
  el.appendChild(row);

  const confChart = new Chart(confCanvas, {
    type: 'bar',
    data: {
      labels: stats.confidenceDistribution.map(b => b.bucket),
      datasets: [{ label: 'Instincts', data: stats.confidenceDistribution.map(b => b.count),
        backgroundColor: ['#e17055', '#fdcb6e', '#00b894'] }],
    },
    options: { responsive: true, plugins: { legend: { display: false }, title: { display: true, text: 'Confidence Distribution' } } },
  });

  const domChart = new Chart(domCanvas, {
    type: 'bar',
    data: {
      labels: stats.byDomain.map(d => d.domain),
      datasets: [{ label: 'Count', data: stats.byDomain.map(d => d.count), backgroundColor: '#6c5ce7' }],
    },
    options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'By Domain' } } },
  });

  charts.push(confChart, domChart);
}

function renderPagination(el, page, totalPages, onChange) {
  const nav = document.createElement('div');
  nav.style.cssText = 'display:flex;gap:0.5rem;margin-top:1rem;justify-content:center';
  const prev = document.createElement('button');
  prev.textContent = '\u2190 Prev';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => onChange(page - 1));
  const info = document.createElement('span');
  info.textContent = 'Page ' + page + ' of ' + totalPages;
  info.style.padding = '0.4rem';
  const next = document.createElement('button');
  next.textContent = 'Next \u2192';
  next.disabled = page >= totalPages;
  next.addEventListener('click', () => onChange(page + 1));
  nav.append(prev, info, next);
  el.appendChild(nav);
}

export function renderList(el, initialState) {
  destroyCharts();
  const state = Object.assign({ page: 1, perPage: 20 }, initialState);

  function load() {
    const qs = new URLSearchParams();
    if (state.domain) qs.set('domain', state.domain);
    if (state.project) qs.set('project', state.project);
    if (state.search) qs.set('search', state.search);
    if (state.confidence_min) qs.set('confidence_min', state.confidence_min);
    qs.set('page', state.page);
    qs.set('per_page', state.perPage);

    Promise.all([
      get('/instincts?' + qs.toString()),
      get('/instincts/stats'),
    ]).then(function (results) {
      var data = results[0], stats = results[1];
      el.innerHTML = '';
      renderFilters(el, state, load);
      renderCharts(el, stats);

      if (data.items.length === 0) {
        el.insertAdjacentHTML('beforeend', '<p style="color:var(--text-muted)">No instincts found. Run the CL observer to start learning.</p>');
        return;
      }

      var list = document.createElement('div');
      for (var i = 0; i < data.items.length; i++) {
        var inst = data.items[i];
        var card = document.createElement('div');
        card.className = 'card';
        card.style.cursor = 'pointer';
        card.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<div>' +
              '<strong>' + inst.pattern + '</strong> ' +
              '<span class="badge ' + inst.category + '">' + inst.category + '</span> ' +
              (inst.project_id ? '<span class="badge">' + inst.project_id + '</span>' : '<span class="badge">global</span>') +
            '</div>' +
            '<div>' + renderConfidenceBar(inst.confidence) + ' \u00B7 ' + (inst.seen_count || 0) + 'x</div>' +
          '</div>' +
          '<div style="color:var(--text-muted);font-size:0.85rem;margin-top:0.3rem">' +
            (inst.instinct || '').slice(0, 100) + ((inst.instinct || '').length > 100 ? '...' : '') +
          '</div>';
        card.dataset.id = inst.id;
        card.addEventListener('click', function () {
          window.location.hash = 'learning/instincts/' + this.dataset.id;
        });
        list.appendChild(card);
      }
      el.appendChild(list);

      var totalPages = Math.ceil(data.total / state.perPage);
      if (totalPages > 1) {
        renderPagination(el, state.page, totalPages, function (p) { state.page = p; load(); });
      }
    }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
  }

  load();
}

export function renderDetail(el, id) {
  destroyCharts();
  el.innerHTML = '<div class="loading">Loading...</div>';

  Promise.all([
    get('/instincts?per_page=100'),
    get('/instincts/' + id + '/observations'),
    get('/instincts/' + id + '/suggestions'),
  ]).then(function (results) {
    var allInstincts = results[0], observations = results[1], suggestions = results[2];
    var inst = allInstincts.items.find(function (i) { return String(i.id) === String(id); });
    if (!inst) { el.innerHTML = '<p>Instinct not found</p>'; return; }

    el.innerHTML = '';

    // Breadcrumb
    var bc = document.createElement('div');
    bc.className = 'learning-breadcrumb';
    bc.innerHTML = '<a href="#learning/instincts">Instincts</a> / ' + inst.pattern;
    el.appendChild(bc);

    // Metadata
    var meta = document.createElement('div');
    meta.className = 'card';
    meta.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">' +
        '<div>Domain: <span class="badge ' + inst.category + '">' + inst.category + '</span></div>' +
        '<div>Project: ' + (inst.project_id || 'global') + '</div>' +
        '<div>Confidence: ' + renderConfidenceBar(inst.confidence) + '</div>' +
        '<div>Seen: ' + (inst.seen_count || 0) + 'x</div>' +
        '<div>First: ' + (inst.first_seen || '\u2014') + '</div>' +
        '<div>Last: ' + (inst.last_seen || '\u2014') + '</div>' +
      '</div>' +
      '<div style="margin-top:0.8rem;display:flex;gap:0.5rem">' +
        '<button id="btn-edit-conf">Edit confidence</button>' +
        '<button id="btn-archive" style="color:var(--warning)">Archive</button>' +
        '<button id="btn-delete" style="color:var(--danger)">Delete</button>' +
      '</div>';
    el.appendChild(meta);

    // Actions
    meta.querySelector('#btn-edit-conf').addEventListener('click', function () {
      var val = prompt('New confidence (0.0 - 0.95):', inst.confidence);
      if (val == null) return;
      put('/instincts/' + id, { confidence: parseFloat(val) })
        .then(function () { renderDetail(el, id); })
        .catch(function (err) { alert('Error: ' + err.message); });
    });
    meta.querySelector('#btn-archive').addEventListener('click', function () {
      if (!confirm('Archive this instinct? (sets confidence to 0)')) return;
      put('/instincts/' + id, { confidence: 0 })
        .then(function () { window.location.hash = 'learning/instincts'; })
        .catch(function (err) { alert('Error: ' + err.message); });
    });
    meta.querySelector('#btn-delete').addEventListener('click', function () {
      if (!confirm('Delete this instinct permanently?')) return;
      del('/instincts/' + id)
        .then(function () { window.location.hash = 'learning/instincts'; })
        .catch(function (err) { alert('Error: ' + err.message); });
    });

    // Content
    var content = document.createElement('div');
    content.className = 'card';
    content.innerHTML = '<h3>Content</h3><pre style="white-space:pre-wrap;color:var(--text-muted)">' + (inst.instinct || 'No content') + '</pre>';
    el.appendChild(content);

    // Related observations
    var obsSection = document.createElement('div');
    obsSection.className = 'card';
    obsSection.innerHTML = '<h3>Related Observations (' + observations.length + ')</h3>';
    if (observations.length === 0) {
      obsSection.insertAdjacentHTML('beforeend', '<p style="color:var(--text-muted)">No linked observations</p>');
    } else {
      for (var j = 0; j < Math.min(observations.length, 10); j++) {
        var obs = observations[j];
        obsSection.insertAdjacentHTML('beforeend',
          '<div style="padding:0.4rem 0;border-bottom:1px solid var(--border)">' +
            '<span style="color:var(--text-muted)">' + obs.observed_at + '</span> ' +
            '<span class="badge ' + (obs.category || '') + '">' + (obs.category || '') + '</span> ' +
            (obs.session_id ? '<a href="#sessions/' + obs.session_id + '" style="color:var(--accent)">' + obs.session_id.slice(0,8) + '</a> ' : '') +
            '<div>' + obs.observation + '</div>' +
          '</div>');
      }
    }
    el.appendChild(obsSection);

    // Related suggestions
    var sugSection = document.createElement('div');
    sugSection.className = 'card';
    sugSection.innerHTML = '<h3>Related Suggestions (' + suggestions.length + ')</h3>';
    for (var k = 0; k < suggestions.length; k++) {
      var sug = suggestions[k];
      sugSection.insertAdjacentHTML('beforeend',
        '<div style="padding:0.4rem 0;border-bottom:1px solid var(--border)">' +
          '<span class="badge ' + sug.status + '">' + sug.status + '</span> ' +
          '<span class="badge">' + sug.type + '</span> ' +
          sug.description + ' \u2014 ' + sug.confidence.toFixed(2) +
        '</div>');
    }
    el.appendChild(sugSection);
  }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
}
```

- [ ] **Step 6.2: Verify manually**

Open `http://localhost:3827/#learning/instincts`
Expected: filters, charts, instinct cards. Click card to see detail view with metadata, content, observations, suggestions, action buttons.

- [ ] **Step 6.3: Commit**

```bash
git add public/modules/learning-instincts.js
git commit -m "feat: instincts list and detail views

Filters (domain, project, search), confidence/domain charts,
paginated list. Detail: metadata, content, related observations
and suggestions, edit/archive/delete actions."
```

---

## Task 7: Frontend — Observations Views

**Files:**
- Modify: `public/modules/learning-observations.js`

- [ ] **Step 7.1: Implement observations list and detail**

```javascript
// public/modules/learning-observations.js
import { get } from './api.js';

let activityChart = null;

function destroyCharts() {
  if (activityChart) { activityChart.destroy(); activityChart = null; }
}

function renderPagination(el, page, totalPages, onChange) {
  var nav = document.createElement('div');
  nav.style.cssText = 'display:flex;gap:0.5rem;margin-top:1rem;justify-content:center';
  var prev = document.createElement('button');
  prev.textContent = '\u2190 Prev'; prev.disabled = page <= 1;
  prev.addEventListener('click', function () { onChange(page - 1); });
  var info = document.createElement('span');
  info.textContent = 'Page ' + page + ' of ' + totalPages; info.style.padding = '0.4rem';
  var next = document.createElement('button');
  next.textContent = 'Next \u2192'; next.disabled = page >= totalPages;
  next.addEventListener('click', function () { onChange(page + 1); });
  nav.append(prev, info, next);
  el.appendChild(nav);
}

export function renderList(el, initialState) {
  destroyCharts();
  var state = Object.assign({ page: 1, perPage: 20 }, initialState);

  function load() {
    var qs = new URLSearchParams();
    if (state.project) qs.set('project', state.project);
    if (state.category) qs.set('category', state.category);
    if (state.from) qs.set('from', state.from);
    if (state.to) qs.set('to', state.to);
    if (state.search) qs.set('search', state.search);
    qs.set('page', state.page);
    qs.set('per_page', state.perPage);

    Promise.all([
      get('/observations?' + qs.toString()),
      get('/observations/activity?days=30'),
    ]).then(function (results) {
      var data = results[0], activity = results[1];
      el.innerHTML = '';

      // Filters
      var row = document.createElement('div');
      row.className = 'filter-row';
      row.innerHTML =
        '<select data-key="project"><option value="">All projects</option></select>' +
        '<select data-key="category"><option value="">All categories</option></select>' +
        '<input type="date" data-key="from" value="' + (state.from || '') + '">' +
        '<input type="date" data-key="to" value="' + (state.to || '') + '">' +
        '<input type="text" data-key="search" placeholder="Search..." value="' + (state.search || '') + '">';

      get('/instincts/projects').then(function (projects) {
        var sel = row.querySelector('[data-key="project"]');
        projects.forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p.project_id; opt.textContent = p.name;
          if (p.project_id === state.project) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(function () {});

      row.addEventListener('change', function () {
        state.project = row.querySelector('[data-key="project"]').value || undefined;
        state.category = row.querySelector('[data-key="category"]').value || undefined;
        state.from = row.querySelector('[data-key="from"]').value || undefined;
        state.to = row.querySelector('[data-key="to"]').value || undefined;
        state.page = 1;
        load();
      });
      var searchTimeout;
      row.querySelector('[data-key="search"]').addEventListener('input', function (e) {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function () { state.search = e.target.value || undefined; state.page = 1; load(); }, 300);
      });
      el.appendChild(row);

      // Activity chart
      var toggle = document.createElement('div');
      toggle.className = 'chart-toggle';
      toggle.textContent = '\u25BC Activity';
      var visible = true;
      var chartWrap = document.createElement('div');
      chartWrap.className = 'obs-activity-chart';
      var canvas = document.createElement('canvas');
      chartWrap.appendChild(canvas);
      toggle.addEventListener('click', function () {
        visible = !visible;
        chartWrap.style.display = visible ? 'block' : 'none';
        toggle.textContent = (visible ? '\u25BC' : '\u25B6') + ' Activity';
      });
      el.appendChild(toggle);
      el.appendChild(chartWrap);

      activityChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: activity.map(function (d) { return d.date; }),
          datasets: [{ label: 'Observations', data: activity.map(function (d) { return d.count; }), backgroundColor: '#6c5ce7' }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
      });

      // List
      if (data.items.length === 0) {
        el.insertAdjacentHTML('beforeend', '<p style="color:var(--text-muted)">No observations found.</p>');
        return;
      }

      var list = document.createElement('div');
      for (var i = 0; i < data.items.length; i++) {
        var obs = data.items[i];
        var card = document.createElement('div');
        card.className = 'card';
        card.style.cursor = 'pointer';
        card.innerHTML =
          '<div>' +
            '<span style="color:var(--text-muted)">' + obs.observed_at + '</span> ' +
            '<span class="badge ' + (obs.category || '') + '">' + (obs.category || '\u2014') + '</span> ' +
            '<span class="badge">' + (obs.project_id || 'global') + '</span> ' +
            (obs.session_id ? '<span style="color:var(--accent);font-size:0.8rem">' + obs.session_id.slice(0,8) + '</span>' : '') +
          '</div>' +
          '<div style="margin-top:0.3rem">' + (obs.observation || '').slice(0, 150) + ((obs.observation || '').length > 150 ? '...' : '') + '</div>';
        card.dataset.id = obs.id;
        card.addEventListener('click', function () { window.location.hash = 'learning/observations/' + this.dataset.id; });
        list.appendChild(card);
      }
      el.appendChild(list);

      var totalPages = Math.ceil(data.total / state.perPage);
      if (totalPages > 1) renderPagination(el, state.page, totalPages, function (p) { state.page = p; load(); });
    }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
  }

  load();
}

export function renderDetail(el, id) {
  destroyCharts();
  el.innerHTML = '<div class="loading">Loading...</div>';

  get('/observations/' + id).then(function (obs) {
    el.innerHTML = '';

    var bc = document.createElement('div');
    bc.className = 'learning-breadcrumb';
    bc.innerHTML = '<a href="#learning/observations">Observations</a> / #' + obs.id;
    el.appendChild(bc);

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1rem">' +
        '<div>Observed: ' + obs.observed_at + '</div>' +
        '<div>Category: <span class="badge ' + (obs.category || '') + '">' + (obs.category || '\u2014') + '</span></div>' +
        '<div>Project: ' + (obs.project_id || 'global') + '</div>' +
        '<div>Session: ' + (obs.session_id ? '<a href="#sessions/' + obs.session_id + '" style="color:var(--accent)">' + obs.session_id + '</a>' : '\u2014') + '</div>' +
      '</div>' +
      '<h3>Observation</h3>' +
      '<p>' + (obs.observation || 'No content') + '</p>';

    // Raw context
    if (obs.raw_context) {
      var toggle = document.createElement('div');
      toggle.className = 'chart-toggle';
      toggle.textContent = '\u25B6 Raw context';
      var pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;display:none;background:var(--bg);padding:0.8rem;border-radius:4px;font-size:0.8rem';
      try { pre.textContent = JSON.stringify(JSON.parse(obs.raw_context), null, 2); }
      catch (e) { pre.textContent = obs.raw_context; }
      toggle.addEventListener('click', function () {
        var show = pre.style.display === 'none';
        pre.style.display = show ? 'block' : 'none';
        toggle.textContent = (show ? '\u25BC' : '\u25B6') + ' Raw context';
      });
      card.appendChild(toggle);
      card.appendChild(pre);
    }

    // Linked instinct
    if (obs.instinct_id) {
      card.insertAdjacentHTML('beforeend',
        '<div style="margin-top:1rem;padding-top:0.8rem;border-top:1px solid var(--border)">' +
          'Linked instinct: <a href="#learning/instincts/' + obs.instinct_id + '" style="color:var(--accent)">View instinct #' + obs.instinct_id + '</a>' +
        '</div>');
    }

    el.appendChild(card);
  }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
}
```

- [ ] **Step 7.2: Verify manually**

Open `http://localhost:3827/#learning/observations`
Expected: filters, activity chart, observation cards. Click card to see detail with raw JSON toggle and instinct link.

- [ ] **Step 7.3: Commit**

```bash
git add public/modules/learning-observations.js
git commit -m "feat: observations list and detail views

Filters (project, category, date range, search), activity bar chart,
paginated list. Detail: full content, collapsible raw JSON context,
linked instinct and session navigation."
```

---

## Task 8: Frontend — Projects Views

**Files:**
- Modify: `public/modules/learning-projects.js`

- [ ] **Step 8.1: Implement projects list and drill-down**

```javascript
// public/modules/learning-projects.js
import { get, post } from './api.js';

let charts = [];

function destroyCharts() {
  charts.forEach(function (c) { c.destroy(); });
  charts = [];
}

function renderComparisonCharts(el, projects) {
  var toggle = document.createElement('div');
  toggle.className = 'chart-toggle';
  toggle.textContent = '\u25BC Comparison';
  var visible = true;

  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem';

  var names = projects.map(function (p) { return p.name; });

  function makeChart(label, data, color) {
    var canvas = document.createElement('canvas');
    canvas.style.maxHeight = '160px';
    grid.appendChild(canvas);
    var c = new Chart(canvas, {
      type: 'bar',
      data: { labels: names, datasets: [{ label: label, data: data, backgroundColor: color }] },
      options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: label } } },
    });
    charts.push(c);
  }

  makeChart('Instincts', projects.map(function (p) { return p.instincts || 0; }), '#6c5ce7');
  makeChart('Avg Confidence', projects.map(function (p) { return p.avg_confidence || 0; }), '#00b894');
  makeChart('Observations', projects.map(function (p) { return p.observations || 0; }), '#74b9ff');
  makeChart('Approve Rate %', projects.map(function (p) { return p.approve_rate != null ? (p.approve_rate * 100) : 0; }), '#fdcb6e');

  toggle.addEventListener('click', function () {
    visible = !visible;
    grid.style.display = visible ? 'grid' : 'none';
    toggle.textContent = (visible ? '\u25BC' : '\u25B6') + ' Comparison';
  });

  el.appendChild(toggle);
  el.appendChild(grid);
}

export function renderList(el) {
  destroyCharts();
  el.innerHTML = '<div class="loading">Loading...</div>';

  get('/instincts/projects').then(function (projects) {
    el.innerHTML = '';

    if (projects.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted)">No CL projects found. Start a session in a project to begin learning.</p>';
      return;
    }

    if (projects.length > 1) renderComparisonCharts(el, projects);

    for (var i = 0; i < projects.length; i++) {
      var proj = projects[i];
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<strong>' + proj.name + '</strong>' +
            '<div style="font-size:0.8rem;color:var(--text-muted)">' + (proj.directory || '') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:0.5rem;align-items:center">' +
            '<span style="color:' + (proj.observer_running ? 'var(--success)' : 'var(--text-muted)') + '">' +
              (proj.observer_running ? '\u25CF' : '\u25CB') +
            '</span>' +
            '<button class="btn-sync">Sync</button>' +
            '<button class="btn-view" data-pid="' + proj.project_id + '">View \u2192</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:1.5rem;margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted)">' +
          '<span>Sessions: ' + (proj.session_count || 0) + '</span>' +
          '<span>Instincts: ' + (proj.instincts || 0) + '</span>' +
          '<span>Observations: ' + (proj.observations || 0) + '</span>' +
        '</div>';
      card.querySelector('.btn-sync').addEventListener('click', function (e) {
        e.stopPropagation();
        post('/instincts/sync').then(function () { renderList(el); }).catch(function (err) { alert('Sync failed: ' + err.message); });
      });
      card.querySelector('.btn-view').addEventListener('click', function (e) {
        e.stopPropagation();
        window.location.hash = 'learning/projects/' + this.dataset.pid;
      });
      el.appendChild(card);
    }
  }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
}

export function renderDetail(el, projectId) {
  destroyCharts();
  el.innerHTML = '<div class="loading">Loading...</div>';

  Promise.all([
    get('/projects/' + projectId + '/summary'),
    get('/projects/' + projectId + '/timeline?weeks=8'),
    get('/instincts?project=' + projectId + '&per_page=5'),
    get('/observations?project=' + projectId + '&per_page=5'),
    get('/suggestions?project=' + projectId),
  ]).then(function (results) {
    var summary = results[0], timeline = results[1], instincts = results[2];
    var observations = results[3], suggestions = results[4];
    el.innerHTML = '';

    // Breadcrumb
    var bc = document.createElement('div');
    bc.className = 'learning-breadcrumb';
    bc.innerHTML = '<a href="#learning/projects">Projects</a> / ' + summary.name;
    el.appendChild(bc);

    // Header
    var header = document.createElement('div');
    header.className = 'card';
    header.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div>' +
          '<h2 style="margin:0">' + summary.name + '</h2>' +
          '<div style="color:var(--text-muted);font-size:0.85rem">' + (summary.directory || '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:0.5rem">' +
          '<button id="btn-log">View log</button>' +
          '<button id="btn-sync">Sync</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:1.5rem;margin-top:0.8rem;font-size:0.85rem">' +
        '<span>Sessions: ' + (summary.session_count || 0) + '</span>' +
        '<span>Instincts: ' + (summary.instinct_count || 0) + '</span>' +
        '<span>Observations: ' + (summary.observation_count || 0) + '</span>' +
        '<span>First seen: ' + (summary.first_seen_at || '\u2014') + '</span>' +
      '</div>';
    header.querySelector('#btn-sync').addEventListener('click', function () {
      post('/instincts/sync').then(function () { renderDetail(el, projectId); }).catch(function (err) { alert(err.message); });
    });
    el.appendChild(header);

    // Timeline chart
    if (timeline.length > 0) {
      var canvas = document.createElement('canvas');
      canvas.style.cssText = 'max-height:200px;margin-bottom:1rem';
      el.appendChild(canvas);
      var c = new Chart(canvas, {
        type: 'line',
        data: {
          labels: timeline.map(function (t) { return t.week_start; }),
          datasets: [
            { label: 'Instincts', data: timeline.map(function (t) { return t.instinct_count; }), borderColor: '#6c5ce7', tension: 0.3 },
            { label: 'Avg Confidence', data: timeline.map(function (t) { return (t.avg_confidence || 0).toFixed(2); }), borderColor: '#00b894', tension: 0.3, yAxisID: 'y1' },
          ],
        },
        options: {
          responsive: true,
          plugins: { title: { display: true, text: 'Learning Timeline' } },
          scales: { y: { beginAtZero: true }, y1: { position: 'right', min: 0, max: 1 } },
        },
      });
      charts.push(c);
    }

    // Top instincts
    var instSection = document.createElement('div');
    instSection.className = 'card';
    instSection.innerHTML = '<div style="display:flex;justify-content:space-between"><h3>Instincts (' + instincts.total + ')</h3><a href="#learning/instincts" style="color:var(--accent)">View all \u2192</a></div>';
    for (var i = 0; i < instincts.items.length; i++) {
      var inst = instincts.items[i];
      instSection.insertAdjacentHTML('beforeend',
        '<div style="padding:0.3rem 0;border-bottom:1px solid var(--border)">' +
          '<a href="#learning/instincts/' + inst.id + '" style="color:var(--text);text-decoration:none">' + inst.pattern + '</a> ' +
          '<span class="badge ' + inst.category + '">' + inst.category + '</span>' +
          '<span style="float:right">' + inst.confidence.toFixed(2) + '</span>' +
        '</div>');
    }
    el.appendChild(instSection);

    // Recent observations
    var obsSection = document.createElement('div');
    obsSection.className = 'card';
    obsSection.innerHTML = '<div style="display:flex;justify-content:space-between"><h3>Recent Observations (' + observations.total + ')</h3><a href="#learning/observations" style="color:var(--accent)">View all \u2192</a></div>';
    for (var j = 0; j < observations.items.length; j++) {
      var obs = observations.items[j];
      obsSection.insertAdjacentHTML('beforeend',
        '<div style="padding:0.3rem 0;border-bottom:1px solid var(--border)">' +
          '<span style="color:var(--text-muted);font-size:0.8rem">' + obs.observed_at + '</span> ' +
          (obs.observation || '').slice(0, 80) +
        '</div>');
    }
    el.appendChild(obsSection);

    // Suggestions summary
    var pending = suggestions.filter(function (s) { return s.status === 'pending'; });
    var approved = suggestions.filter(function (s) { return s.status === 'approved'; }).length;
    var dismissed = suggestions.filter(function (s) { return s.status === 'dismissed'; }).length;
    var sugSection = document.createElement('div');
    sugSection.className = 'card';
    sugSection.innerHTML =
      '<h3>Suggestions</h3>' +
      '<div style="display:flex;gap:1rem;margin-bottom:0.5rem;font-size:0.85rem">' +
        '<span class="badge approved">Approved: ' + approved + '</span>' +
        '<span class="badge dismissed">Dismissed: ' + dismissed + '</span>' +
        '<span class="badge pending">Pending: ' + pending.length + '</span>' +
      '</div>';
    for (var k = 0; k < pending.length; k++) {
      var sug = pending[k];
      sugSection.insertAdjacentHTML('beforeend',
        '<div style="padding:0.3rem 0;border-bottom:1px solid var(--border)">' +
          '<span class="badge pending">pending</span> <span class="badge">' + sug.type + '</span> ' +
          sug.description + ' \u2014 ' + sug.confidence.toFixed(2) +
        '</div>');
    }
    el.appendChild(sugSection);

    // Observer log (collapsible)
    var logToggle = document.createElement('div');
    logToggle.className = 'chart-toggle';
    logToggle.textContent = '\u25B6 Observer log';
    var logPre = document.createElement('pre');
    logPre.style.cssText = 'display:none;background:var(--bg);padding:0.8rem;border-radius:4px;font-size:0.75rem;max-height:300px;overflow-y:auto';
    var logLoaded = false;
    logToggle.addEventListener('click', function () {
      var show = logPre.style.display === 'none';
      logPre.style.display = show ? 'block' : 'none';
      logToggle.textContent = (show ? '\u25BC' : '\u25B6') + ' Observer log';
      if (show && !logLoaded) {
        logLoaded = true;
        get('/instincts/observer?project=' + projectId + '&lines=20')
          .then(function (data) { logPre.textContent = data.log || 'No log available'; })
          .catch(function () { logPre.textContent = 'Failed to load log'; });
      }
    });
    header.querySelector('#btn-log').addEventListener('click', function () { logToggle.click(); });
    el.appendChild(logToggle);
    el.appendChild(logPre);
  }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
}
```

- [ ] **Step 8.2: Verify manually**

Open `http://localhost:3827/#learning/projects`
Expected: comparison charts (if >1 project), project cards with status/counts. Click View to see drill-down with timeline chart, top instincts, observations, suggestions, observer log.

- [ ] **Step 8.3: Commit**

```bash
git add public/modules/learning-projects.js
git commit -m "feat: projects list with comparison charts and drill-down

Comparison: instincts, avg confidence, observations, approve rate.
Drill-down: learning timeline, top instincts, recent observations,
suggestion summary, collapsible observer log."
```

---

## Task 9: Frontend — Suggestion History

**Files:**
- Modify: `public/modules/learning-suggestions.js`

- [ ] **Step 9.1: Implement suggestion history view**

```javascript
// public/modules/learning-suggestions.js
import { get, put } from './api.js';

function renderPagination(el, page, totalPages, onChange) {
  var nav = document.createElement('div');
  nav.style.cssText = 'display:flex;gap:0.5rem;margin-top:1rem;justify-content:center';
  var prev = document.createElement('button');
  prev.textContent = '\u2190 Prev'; prev.disabled = page <= 1;
  prev.addEventListener('click', function () { onChange(page - 1); });
  var info = document.createElement('span');
  info.textContent = 'Page ' + page + ' of ' + totalPages; info.style.padding = '0.4rem';
  var next = document.createElement('button');
  next.textContent = 'Next \u2192'; next.disabled = page >= totalPages;
  next.addEventListener('click', function () { onChange(page + 1); });
  nav.append(prev, info, next);
  el.appendChild(nav);
}

export function renderList(el) {
  var state = { status: '', type: '', page: 1, perPage: 20 };

  function load() {
    var qs = new URLSearchParams();
    if (state.status) qs.set('status', state.status);

    get('/suggestions?' + qs.toString()).then(function (suggestions) {
      var filtered = suggestions;
      if (state.type) filtered = filtered.filter(function (s) { return s.type === state.type; });

      el.innerHTML = '';

      // Filters
      var row = document.createElement('div');
      row.className = 'filter-row';
      row.innerHTML =
        '<select data-key="status">' +
          '<option value="">All statuses</option>' +
          '<option value="pending"' + (state.status === 'pending' ? ' selected' : '') + '>Pending</option>' +
          '<option value="approved"' + (state.status === 'approved' ? ' selected' : '') + '>Approved</option>' +
          '<option value="dismissed"' + (state.status === 'dismissed' ? ' selected' : '') + '>Dismissed</option>' +
        '</select>' +
        '<select data-key="type">' +
          '<option value="">All types</option>' +
          '<option value="skill"' + (state.type === 'skill' ? ' selected' : '') + '>Skill</option>' +
          '<option value="agent"' + (state.type === 'agent' ? ' selected' : '') + '>Agent</option>' +
          '<option value="hook"' + (state.type === 'hook' ? ' selected' : '') + '>Hook</option>' +
          '<option value="rule"' + (state.type === 'rule' ? ' selected' : '') + '>Rule</option>' +
        '</select>';
      row.addEventListener('change', function () {
        state.status = row.querySelector('[data-key="status"]').value;
        state.type = row.querySelector('[data-key="type"]').value;
        state.page = 1;
        load();
      });
      el.appendChild(row);

      // Summary cards
      var pendingCount = suggestions.filter(function (s) { return s.status === 'pending'; }).length;
      var approvedCount = suggestions.filter(function (s) { return s.status === 'approved'; }).length;
      var dismissedCount = suggestions.filter(function (s) { return s.status === 'dismissed'; }).length;
      var total = approvedCount + dismissedCount;
      var rate = total > 0 ? ((approvedCount / total) * 100).toFixed(0) : '\u2014';

      var cards = document.createElement('div');
      cards.style.cssText = 'display:flex;gap:1rem;margin-bottom:1rem';
      cards.innerHTML =
        '<div class="card" style="flex:1;text-align:center"><div class="stat-value" style="color:var(--warning)">' + pendingCount + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Pending</div></div>' +
        '<div class="card" style="flex:1;text-align:center"><div class="stat-value" style="color:var(--success)">' + approvedCount + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Approved</div></div>' +
        '<div class="card" style="flex:1;text-align:center"><div class="stat-value" style="color:var(--danger)">' + dismissedCount + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Dismissed</div></div>' +
        '<div class="card" style="flex:1;text-align:center"><div class="stat-value">' + rate + '%</div><div style="font-size:0.8rem;color:var(--text-muted)">Approve Rate</div></div>';
      el.appendChild(cards);

      // Paginate
      var totalPages = Math.ceil(filtered.length / state.perPage) || 1;
      var page = Math.min(state.page, totalPages);
      var pageItems = filtered.slice((page - 1) * state.perPage, page * state.perPage);

      if (pageItems.length === 0) {
        el.insertAdjacentHTML('beforeend', '<p style="color:var(--text-muted)">No suggestions found.</p>');
        return;
      }

      var list = document.createElement('div');
      for (var i = 0; i < pageItems.length; i++) {
        var sug = pageItems[i];
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:start">' +
            '<div>' +
              '<span class="badge ' + sug.status + '">' + sug.status + '</span> ' +
              '<span class="badge">' + sug.type + '</span> ' +
              sug.description +
              '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">' +
                'Confidence: ' + sug.confidence.toFixed(2) +
                (sug.instinct_id ? ' \u00B7 <a href="#learning/instincts/' + sug.instinct_id + '" style="color:var(--accent)">Source instinct</a>' : '') +
                ' \u00B7 Created: ' + sug.created_at +
                (sug.resolved_at ? ' \u00B7 Resolved: ' + sug.resolved_at : '') +
              '</div>' +
            '</div>' +
            (sug.status === 'pending' ?
              '<div style="display:flex;gap:0.3rem;flex-shrink:0">' +
                '<button class="btn-approve" data-id="' + sug.id + '" style="color:var(--success)">Approve</button>' +
                '<button class="btn-dismiss" data-id="' + sug.id + '" style="color:var(--danger)">Dismiss</button>' +
              '</div>' : '') +
          '</div>';
        list.appendChild(card);
      }

      list.addEventListener('click', function (e) {
        var approveBtn = e.target.closest('.btn-approve');
        var dismissBtn = e.target.closest('.btn-dismiss');
        if (approveBtn) {
          put('/suggestions/' + approveBtn.dataset.id + '/approve').then(function () { load(); }).catch(function (err) { alert(err.message); });
        }
        if (dismissBtn) {
          put('/suggestions/' + dismissBtn.dataset.id + '/dismiss').then(function () { load(); }).catch(function (err) { alert(err.message); });
        }
      });

      el.appendChild(list);
      if (totalPages > 1) renderPagination(el, page, totalPages, function (p) { state.page = p; load(); });
    }).catch(function (err) { el.innerHTML = '<p style="color:var(--danger)">Error: ' + err.message + '</p>'; });
  }

  load();
}

export function renderDetail(el) {
  renderList(el);
}
```

- [ ] **Step 9.2: Verify manually**

Open `http://localhost:3827/#learning/suggestions`
Expected: status/type filters, summary cards (pending/approved/dismissed/rate), list with approve/dismiss buttons on pending items.

- [ ] **Step 9.3: Commit**

```bash
git add public/modules/learning-suggestions.js
git commit -m "feat: suggestion history view with filters and actions

Status and type filters, summary cards (pending/approved/dismissed/rate),
paginated list with inline approve/dismiss for pending suggestions,
source instinct links."
```

---

## Task 10: Frontend — Dashboard CL Widget

**Files:**
- Modify: `public/modules/dashboard.js`

- [ ] **Step 10.1: Add CL widget to dashboard**

At the end of the `mount()` function in `dashboard.js`, after existing content is rendered, add a widget section. Find where the existing data loading happens (the `.then()` chain after the API calls) and add the widget rendering after it:

```javascript
function renderLearningWidget(container) {
  var section = document.createElement('div');
  section.className = 'card';
  section.style.marginTop = '1.5rem';
  section.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">' +
      '<h2 style="margin:0">Learning</h2>' +
      '<a href="#learning" style="color:var(--accent);text-decoration:none">View all \u2192</a>' +
    '</div>' +
    '<div id="cl-widget-cards" style="display:flex;gap:1rem;margin-bottom:1rem"></div>' +
    '<div id="cl-widget-chart" style="height:100px;margin-bottom:1rem"></div>' +
    '<div id="cl-widget-recent"></div>';
  container.appendChild(section);

  Promise.all([
    get('/instincts?per_page=1'),
    get('/observations/activity?days=1'),
    get('/instincts/projects'),
    get('/suggestions?status=pending'),
    get('/learning/activity?days=7'),
    get('/learning/recent?limit=5'),
  ]).then(function (results) {
    var instincts = results[0], todayActivity = results[1], projects = results[2];
    var pending = results[3], activity = results[4], recent = results[5];
    var todayObs = todayActivity.reduce(function (s, d) { return s + d.count; }, 0);

    // Cards
    var cardsEl = section.querySelector('#cl-widget-cards');
    cardsEl.innerHTML =
      '<div class="card" style="flex:1;text-align:center"><div class="stat-value">' + instincts.total + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Instincts</div></div>' +
      '<div class="card" style="flex:1;text-align:center"><div class="stat-value">' + todayObs + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Obs. today</div></div>' +
      '<div class="card" style="flex:1;text-align:center"><div class="stat-value">' + projects.length + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Projects</div></div>' +
      '<div class="card" style="flex:1;text-align:center"><div class="stat-value" style="color:var(--warning)">' + pending.length + '</div><div style="font-size:0.8rem;color:var(--text-muted)">Pending</div></div>';

    // Mini chart
    var chartEl = section.querySelector('#cl-widget-chart');
    var canvas = document.createElement('canvas');
    chartEl.appendChild(canvas);
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: activity.map(function (d) { return d.date; }),
        datasets: [{ label: 'Activity', data: activity.map(function (d) { return d.count; }), backgroundColor: '#6c5ce7' }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { ticks: { font: { size: 10 } } } } },
    });

    // Recent list
    var recentEl = section.querySelector('#cl-widget-recent');
    if (recent.length === 0) {
      recentEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No recent activity</p>';
    } else {
      for (var i = 0; i < recent.length; i++) {
        var item = recent[i];
        var href = item.kind === 'instinct' ? '#learning/instincts/' + item.id : '#learning/suggestions';
        recentEl.insertAdjacentHTML('beforeend',
          '<div style="padding:0.3rem 0;border-bottom:1px solid var(--border);font-size:0.85rem">' +
            '<span class="badge ' + (item.kind === 'instinct' ? 'workflow' : 'pending') + '">' + item.kind + '</span> ' +
            '<a href="' + href + '" style="color:var(--text);text-decoration:none">' + item.title + '</a>' +
            '<span style="float:right;color:var(--text-muted)">' + (item.confidence != null ? item.confidence.toFixed(2) : '') + '</span>' +
          '</div>');
      }
    }
  }).catch(function () {
    section.querySelector('#cl-widget-cards').innerHTML = '<p style="color:var(--text-muted)">CL data unavailable</p>';
  });
}
```

Call `renderLearningWidget(el)` at the end of `mount()`, after the existing charts/data render.

- [ ] **Step 10.2: Verify manually**

Open `http://localhost:3827/#dashboard`
Expected: existing dashboard content + new "Learning" widget at bottom with 4 cards, 7-day activity chart, and 5 recent items.

- [ ] **Step 10.3: Commit**

```bash
git add public/modules/dashboard.js
git commit -m "feat: CL summary widget on Dashboard overview

4 stat cards (instincts, observations today, projects, pending),
7-day learning activity bar chart, 5 most recent items list."
```

---

## Task 11: Integration Verification

- [ ] **Step 11.1: Run full backend test suite**

Run: `npm test`
Expected: All tests PASS including new learning API tests.

- [ ] **Step 11.2: Manual integration test — happy path**

Start server: `npm start`

1. Open `http://localhost:3827/#dashboard` — verify Learning widget renders
2. Click "View all" — verify navigation to `#learning`
3. Sidebar: click each section — verify content loads
4. Instincts: verify filters change results, charts render, click card then detail
5. Instinct detail: verify metadata, observations, suggestions sections
6. Observations: verify activity chart, filters, click card then detail
7. Observation detail: verify raw context toggle, instinct link
8. Projects: verify comparison charts (if >1 project), click View then drill-down
9. Project drill-down: verify timeline chart, top instincts, observer log toggle
10. Suggestions: verify summary cards, filters, approve/dismiss buttons

- [ ] **Step 11.3: Manual test — empty state**

Test with empty DB (no CL data):
1. Instincts list: shows "No instincts found" message
2. Observations list: shows "No observations found" message
3. Projects list: shows "No CL projects found" message
4. Dashboard widget: shows "CL data unavailable" gracefully

- [ ] **Step 11.4: Commit any fixes from integration testing**

If any fixes were needed, commit them:

```bash
git add -u
git commit -m "fix: integration test fixes for CL dashboard"
```

---

## Summary

| Task | Description | Files | Steps |
|---|---|---|---|
| 1 | DB migration + 12 query functions | op-db.js, test | 16 |
| 2 | Observations API (3 endpoints) | op-server.js, test | 5 |
| 3 | Enhanced instincts API (6 endpoints) | op-server.js, test | 4 |
| 4 | Projects + learning widget API (5 endpoints) | op-server.js, test | 7 |
| 5 | Nav + router + learning scaffold | index.html, router.js, learning.js, 4 placeholders | 7 |
| 6 | Instincts views (list + detail) | learning-instincts.js | 3 |
| 7 | Observations views (list + detail) | learning-observations.js | 3 |
| 8 | Projects views (list + drill-down) | learning-projects.js | 3 |
| 9 | Suggestion history | learning-suggestions.js | 3 |
| 10 | Dashboard CL widget | dashboard.js | 3 |
| 11 | Integration verification | all | 4 |

**Total**: 11 tasks, ~58 steps, 10 commits
