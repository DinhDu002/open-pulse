# Remove Daily Reviews Feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the daily-reviews feature (pipeline, plan generation, cross-project insights, API, UI, DB tables, config, tests, docs).

**Architecture:** Delete 9 files (5 backend + 1 route + 1 frontend + 2 test), edit 11 files (server, routes, schema, frontend, config, tests, CLAUDE.md). Add `DROP TABLE IF EXISTS` migration for existing DBs.

**Tech Stack:** Node.js, Fastify, better-sqlite3, vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-04-14-remove-daily-reviews-design.md`

---

### Task 1: Database schema — remove daily_reviews tables

**Files:**
- Modify: `src/db/schema.js:177-224` (SCHEMA string), `src/db/schema.js:381-403` (migrations)

- [ ] **Step 1: Remove table definitions from SCHEMA string**

In `src/db/schema.js`, remove lines 177-209 (the `daily_reviews` table, `daily_review_insights` table, and their 5 indexes). Keep `pipeline_runs` table definition (lines 211-225) intact.

Remove this block:
```sql
CREATE TABLE IF NOT EXISTS daily_reviews (
  id                TEXT PRIMARY KEY,
  review_date       TEXT NOT NULL,
  category          TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  target_type       TEXT,
  action            TEXT,
  confidence        REAL,
  reasoning         TEXT,
  status            TEXT DEFAULT 'pending',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_status ON daily_reviews(status);

CREATE TABLE IF NOT EXISTS daily_review_insights (
  id                TEXT PRIMARY KEY,
  review_date       TEXT NOT NULL,
  insight_type      TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  projects          TEXT,
  target_type       TEXT,
  severity          TEXT DEFAULT 'info',
  reasoning         TEXT,
  summary_vi        TEXT,
  status            TEXT DEFAULT 'pending',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dri_date ON daily_review_insights(review_date);
CREATE INDEX IF NOT EXISTS idx_dri_type ON daily_review_insights(insight_type);
CREATE INDEX IF NOT EXISTS idx_dri_status ON daily_review_insights(status);
```

- [ ] **Step 2: Remove daily_reviews migrations**

Remove lines 381-403 — all the `ALTER TABLE daily_reviews` migrations and the orphan plan cleanup:

```js
  // Migrate: add summary_vi column to daily_reviews
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN summary_vi TEXT').run(); } catch { /* already exists */ }

  // Migrate: add projects column (JSON array of project names) to auto_evolves and daily_reviews
  try { db.prepare('ALTER TABLE auto_evolves ADD COLUMN projects TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN projects TEXT').run(); } catch { /* already exists */ }

  // Migrate: add plan generation columns to daily_reviews
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN plan_md TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN handoff_prompt TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN plan_status TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN plan_generated_at TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN plan_error TEXT').run(); } catch { /* already exists */ }
  try { db.prepare('ALTER TABLE daily_reviews ADD COLUMN plan_run_id INTEGER').run(); } catch { /* already exists */ }

  // Cleanup orphan running plans from previous server instance
  try {
    db.prepare(`UPDATE daily_reviews
                SET plan_status = 'error',
                    plan_error = 'Server restarted during plan generation'
                WHERE plan_status = 'running'`).run();
  } catch { /* table may not exist on first boot */ }
```

Keep the auto_evolves projects migration but as a standalone line:
```js
  try { db.prepare('ALTER TABLE auto_evolves ADD COLUMN projects TEXT').run(); } catch { /* already exists */ }
```

- [ ] **Step 3: Add DROP TABLE migration for existing databases**

Add after the existing `DROP TABLE IF EXISTS` lines (near line 237-239):
```js
  db.exec('DROP TABLE IF EXISTS daily_reviews');
  db.exec('DROP TABLE IF EXISTS daily_review_insights');
```

- [ ] **Step 4: Verify schema loads**

Run: `node -e "const {createDb} = require('./src/db/schema'); const db = createDb(':memory:'); const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name); console.log(tables); db.close()"`

Expected: tables list should NOT include `daily_reviews` or `daily_review_insights`. Should include `pipeline_runs`, `auto_evolves`, etc.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.js
git commit -m "refactor: remove daily_reviews and daily_review_insights tables from schema"
```

---

### Task 2: Delete backend files + remove route registration

**Files:**
- Delete: `src/review/pipeline.js`, `src/review/context.js`, `src/review/queries.js`, `src/review/plan.js`, `src/review/prompt.md`
- Delete: `src/routes/daily-reviews.js`
- Modify: `src/server.js:128-129,153`
- Modify: `src/routes/projects.js:11,118-143`

- [ ] **Step 1: Delete src/review/ directory**

```bash
rm -rf src/review/
```

- [ ] **Step 2: Delete route file**

```bash
rm src/routes/daily-reviews.js
```

- [ ] **Step 3: Remove daily-reviews from server.js**

In `src/server.js`, remove lines 128-129 (comment) and line 153 (route registration):

Remove:
```js
    // Daily review: handled by external script (launchd 3 AM daily)
    // Manual trigger available via POST /api/daily-reviews/run
```

Remove:
```js
  app.register(require('./routes/daily-reviews'), routeOpts);
```

- [ ] **Step 4: Remove daily-reviews from projects route**

In `src/routes/projects.js`, remove the import at line 11:
```js
const { queryDailyReviewsByProject, queryInsightsByProject } = require('../review/queries');
```

Remove the 2 endpoints at lines 118-143:
```js
  app.get('/api/projects/:id/daily-reviews', async (request, reply) => {
    ...
  });

  app.get('/api/projects/:id/daily-review-insights', async (request, reply) => {
    ...
  });
```

- [ ] **Step 5: Verify server starts**

Run: `node -e "const {buildApp} = require('./src/server'); const app = buildApp({disableTimers:true}); console.log('OK'); app.close()"`

Expected: prints `OK` without errors.

- [ ] **Step 6: Commit**

```bash
git add -A src/review/ src/routes/daily-reviews.js src/server.js src/routes/projects.js
git commit -m "feat: remove daily-reviews backend (pipeline, routes, queries)"
```

---

### Task 3: Remove frontend module + nav + router entry

**Files:**
- Delete: `public/modules/daily-reviews.js`
- Modify: `public/modules/router.js:10,15`
- Modify: `public/index.html:830`
- Modify: `public/modules/projects.js:281-284,385-388,601-707`

- [ ] **Step 1: Delete frontend module**

```bash
rm public/modules/daily-reviews.js
```

- [ ] **Step 2: Remove router entry**

In `public/modules/router.js`, remove line 10:
```js
  'daily-reviews': () => import('./daily-reviews.js'),
```

In the same file, remove `'daily-reviews'` from `NO_PERIOD` set at line 15. Change:
```js
const NO_PERIOD = new Set(['settings', 'knowledge', 'projects', 'auto-evolves', 'daily-reviews']);
```
to:
```js
const NO_PERIOD = new Set(['settings', 'knowledge', 'projects', 'auto-evolves']);
```

- [ ] **Step 3: Remove nav link**

In `public/index.html`, remove line 830:
```html
        <a href="#daily-reviews">Daily Review</a>
```

- [ ] **Step 4: Remove daily-reviews from projects.js**

In `public/modules/projects.js`:

1. Remove `daily_review` color from `PIPELINE_COLORS` (line 284):
```js
    daily_review: '#fdcb6e',
```

2. Update comment at line 385 and remove `buildDailyReviewsCard` call at line 388. Change:
```js
  // ── Project-scoped cards: Auto-evolves, Daily Reviews (with tabs) ─────────

  buildAutoEvolvesCard(el, projectId);
  buildDailyReviewsCard(el, projectId);
```
to:
```js
  // ── Project-scoped cards: Auto-evolves ─────────────────────────────────────

  buildAutoEvolvesCard(el, projectId);
```

3. Delete the entire `buildDailyReviewsCard` function and its supporting constants (lines 601-706). This includes:
   - `DR_CATEGORY_COLORS` (line 603-607)
   - `DR_STATUS_COLORS` (line 608)
   - `INSIGHT_TYPE_COLORS` (line 610-613)
   - `SEVERITY_COLORS` (line 614)
   - `buildDailyReviewsCard` function (lines 616-706)

- [ ] **Step 5: Verify syntax**

Run: `node --check public/modules/router.js && node --check public/modules/projects.js && echo OK`

Expected: no syntax errors, prints `OK`.

- [ ] **Step 6: Commit**

```bash
git add public/modules/daily-reviews.js public/modules/router.js public/index.html public/modules/projects.js
git commit -m "feat: remove daily-reviews frontend (module, nav, router, project cards)"
```

---

### Task 4: Remove config keys

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Remove 10 config keys**

In `config.json`, remove these keys:
```json
  "daily_review_enabled": true,
  "daily_review_model": "claude-opus-4-6[1m]",
  "daily_review_timeout_ms": 1800000,
  "daily_review_max_suggestions": 50,
  "daily_review_history_days": 1,
  "plan_generation_enabled": true,
  "plan_generation_model": "opus",
  "plan_generation_timeout_ms": 1800000,
  "plan_generation_max_context_kb": 100,
  "plan_generation_max_concurrent": 3
```

Ensure the last remaining key (`observer_confidence_cap_on_first_detect`) has no trailing comma — valid JSON.

- [ ] **Step 2: Verify JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('valid JSON')"`

Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "chore: remove daily-review and plan-generation config keys"
```

---

### Task 5: Fix tests

**Files:**
- Delete: `test/review/review.test.js`, `test/routes/plan-routes.test.js`
- Modify: `test/routes/routes.test.js:806-952`
- Modify: `test/db/schema.test.js:481-487`
- Modify: `test/db/pipeline-runs.test.js:43,54-57,79-81`

- [ ] **Step 1: Delete dedicated test files**

```bash
rm test/review/review.test.js
rm test/routes/plan-routes.test.js
rmdir test/review 2>/dev/null || true
```

- [ ] **Step 2: Fix routes.test.js — remove daily-review run tests**

Remove the daily-review route regression tests at lines 806-836 (the `TC-R1` and `TC-R2` tests):
```js
  // -- Daily review run route regression (TC-R1, TC-R2) --

  it('TC-R1: POST /api/daily-reviews/run without body.date does not use yesterday', async () => {
    ...
  });

  it('TC-R2: POST /api/daily-reviews/run with explicit date passes it through', async () => {
    ...
  });
```

- [ ] **Step 3: Fix routes.test.js — remove daily_review seed from pipeline-runs before()**

In the `pipeline-runs API` `before()` block (lines 838-846), remove line 844:
```js
      insertPipelineRun(testDb, { pipeline: 'daily_review', project_id: null, model: 'opus', status: 'success', input_tokens: 8000, output_tokens: 2000, duration_ms: 120000 });
```

Then update the stats assertions in `GET /api/pipeline-runs/stats returns aggregated stats` test (lines 862-870). Change:
```js
      // >= 3 because other tests in the suite may insert daily_review pipeline runs
      assert.ok(body.total_runs >= 3);
```
to:
```js
      assert.ok(body.total_runs >= 2);
```

- [ ] **Step 4: Fix routes.test.js — remove daily-reviews seeds and tests from project-scoped block**

In the `describe('project-scoped auto-evolves / daily-reviews API')` block (lines 879-953):

1. Rename the describe to: `'project-scoped auto-evolves API'`

2. In the `before()` at lines 883-914, remove the daily_reviews seed (lines 901-905):
```js
      const drStmt = testDb.prepare(
        "INSERT INTO daily_reviews ..."
      );
      drStmt.run('dr-tagged-1', ...);
      drStmt.run('dr-global-1', ...);
```

3. Remove the daily_review_insights seed (lines 907-912):
```js
      const iStmt = testDb.prepare(
        "INSERT INTO daily_review_insights ..."
      );
      iStmt.run('dri-tagged-1', ...);
      iStmt.run('dri-other-1', ...);
```

4. Remove the 3 daily-reviews test cases (lines 926-952):
   - `'GET /api/projects/:id/daily-reviews returns only project-tagged rows'`
   - `'GET /api/projects/:id/daily-review-insights returns insights mentioning project'`
   - `'GET /api/projects/:id/daily-reviews honors pagination'`

Keep the auto-evolves tests (lines 917-924, 942-945) intact.

- [ ] **Step 5: Fix schema.test.js — remove daily_reviews migration test**

In `test/db/schema.test.js`, replace lines 481-487:
```js
  it('migration adds projects column to auto_evolves and daily_reviews', () => {
    const aeCols = db.prepare("PRAGMA table_info('auto_evolves')").all().map(c => c.name);
    assert.ok(aeCols.includes('projects'), 'auto_evolves should have projects column');

    const drCols = db.prepare("PRAGMA table_info('daily_reviews')").all().map(c => c.name);
    assert.ok(drCols.includes('projects'), 'daily_reviews should have projects column');
  });
```

With:
```js
  it('migration adds projects column to auto_evolves', () => {
    const aeCols = db.prepare("PRAGMA table_info('auto_evolves')").all().map(c => c.name);
    assert.ok(aeCols.includes('projects'), 'auto_evolves should have projects column');
  });
```

- [ ] **Step 6: Fix pipeline-runs.test.js — remove daily_review test data + adjust counts**

In `test/db/pipeline-runs.test.js`:

1. Remove the `daily_review` insert at line 43:
```js
    insertPipelineRun(db, { pipeline: 'daily_review', project_id: null, model: 'opus', status: 'error', error: 'timeout', input_tokens: 8000, output_tokens: 0, duration_ms: 300000 });
```

2. Remove the `daily_review` filter test (lines 52-57):
```js
  it('queryPipelineRuns filters by pipeline', () => {
    const { queryPipelineRuns } = require('../../src/db/pipeline-runs');
    const result = queryPipelineRuns(db, { pipeline: 'daily_review' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].status, 'error');
  });
```

3. Update the "without filter returns all" test (lines 76-81). Change:
```js
    assert.equal(stats.total_runs, 4);
    assert.equal(stats.error_count, 1);
```
to:
```js
    assert.equal(stats.total_runs, 3);
    assert.equal(stats.error_count, 0);
```

- [ ] **Step 7: Run tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A test/
git commit -m "test: remove daily-reviews tests and fix affected counts"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove daily-reviews from architecture diagram**

Remove these lines from the ASCII diagram:
```
                              │  Daily review│──→ daily_reviews table + reports/*.md
                              │  (3AM launchd│    Opus 4.6 analysis
                              │  + API POST) │
```

- [ ] **Step 2: Remove from Data Flow section**

Remove item 8:
```
8. **Daily Review**: 3 AM daily → ...
```

Renumber items 9 and 10 to 8 and 9.

- [ ] **Step 3: Remove from Directory Structure**

Remove these entries:
```
│   ├── review/                 # Daily review pipeline
│   │   ├── pipeline.js         # Orchestrate: context → Opus → save
│   │   ├── context.js          # Read components + work history
│   │   ├── prompt.md           # Opus prompt template
│   │   └── queries.js          # daily_reviews CRUD
```
Also remove `daily-reviews.js` from routes listing and `daily-reviews.js` from frontend modules listing.
Remove `reports/` directory entry.

- [ ] **Step 4: Remove from Database Schema table**

Remove these rows:
```
| `daily_reviews` | ... |
| `daily_review_insights` | ... |
```

Update table count from "14 tables" to "12 tables".

- [ ] **Step 5: Remove from API Endpoints**

Remove the entire "### Daily Review" section (all 13 endpoints).

- [ ] **Step 6: Remove from Configuration table**

Remove all `daily_review_*` and `plan_generation_*` config key rows.

- [ ] **Step 7: Remove from Key Design Decisions**

Remove Flow 2 (daily review) from the "Split feedback loops" bullet. Simplify to describe only auto-evolve flow.
Remove the "Daily review pipeline" bullet.
Remove the "Cross-project daily review" bullet.

- [ ] **Step 8: Remove from Tech Stack**

Change:
```
- **Service**: macOS launchd (com.open-pulse server + com.open-pulse.daily-review daily 3 AM)
```
to:
```
- **Service**: macOS launchd (com.open-pulse server + com.open-pulse.observer hourly)
```

- [ ] **Step 9: Remove from Commands section**

Remove any daily-review specific commands.

- [ ] **Step 10: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: remove daily-reviews references from CLAUDE.md"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run grep to verify no remaining references in src/ and public/**

Run: `grep -rn 'daily.review\|daily_review\|dailyReview\|plan_generation\|plan_md\|plan_status\|handoff_prompt\|plan_error\|plan_run_id\|plan_generated_at' src/ public/ --include='*.js' --include='*.html'`

Expected: no matches.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Start server and verify health**

Start the server, then verify:
- `GET /api/health` returns `status: ok`
- `GET /api/daily-reviews` returns 404

- [ ] **Step 4: Take Playwright screenshot of frontend**

Open `http://127.0.0.1:3827` and verify:
- No "Daily Review" link in nav
- All other nav items work (Dashboard, Prompts, Inventory, Projects, Knowledge, Auto-evolve, Settings)

- [ ] **Step 5: Commit any remaining fixes**

If any issues found, fix and commit.
