# Pipeline Runs Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track all internal Claude CLI invocations (knowledge extraction, scan, daily review) in a `pipeline_runs` table and display run history with token usage stats on the project detail page.

**Architecture:** New `pipeline_runs` table stores execution metadata (model, tokens, duration, status). `callClaude()` is modified to return extended info (stderr + duration). Each pipeline caller wraps its Claude invocation with timing + logging. Two new API endpoints serve the data to a new frontend section on the project detail page.

**Tech Stack:** SQLite (better-sqlite3), Fastify routes, vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-04-11-pipeline-runs-design.md`

---

### Task 1: DB Schema — `pipeline_runs` table

**Files:**
- Modify: `src/db/schema.js:209-210` (add table to SCHEMA string)
- Modify: `src/db/schema.js:369` (add migration)
- Test: `test/db/schema.test.js`

- [ ] **Step 1: Write the failing test**

In `test/db/schema.test.js`, add a test for the new table:

```javascript
it('creates pipeline_runs table', () => {
  const cols = db.prepare("PRAGMA table_info('pipeline_runs')").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id column');
  assert.ok(cols.includes('pipeline'), 'has pipeline column');
  assert.ok(cols.includes('project_id'), 'has project_id column');
  assert.ok(cols.includes('model'), 'has model column');
  assert.ok(cols.includes('status'), 'has status column');
  assert.ok(cols.includes('error'), 'has error column');
  assert.ok(cols.includes('input_tokens'), 'has input_tokens column');
  assert.ok(cols.includes('output_tokens'), 'has output_tokens column');
  assert.ok(cols.includes('duration_ms'), 'has duration_ms column');
  assert.ok(cols.includes('created_at'), 'has created_at column');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db/schema.test.js`
Expected: FAIL — table `pipeline_runs` does not exist

- [ ] **Step 3: Add table to SCHEMA string**

In `src/db/schema.js`, before the closing backtick of `SCHEMA` (line 210), add:

```sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline      TEXT NOT NULL,
  project_id    TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'success',
  error         TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_ms   INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_project ON pipeline_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_pipeline ON pipeline_runs(pipeline, created_at);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db/schema.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.js test/db/schema.test.js
git commit -m "feat: add pipeline_runs table to schema"
```

---

### Task 2: DB Query Module — `src/db/pipeline-runs.js`

**Files:**
- Create: `src/db/pipeline-runs.js`
- Create: `test/db/pipeline-runs.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/db/pipeline-runs.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-pipeline-runs-test-${Date.now()}`);

describe('pipeline-runs queries', () => {
  let db;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    const { createDb } = require('../../src/db/schema');
    db = createDb(process.env.OPEN_PULSE_DB);
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('insertPipelineRun inserts and returns id', () => {
    const { insertPipelineRun } = require('../../src/db/pipeline-runs');
    const id = insertPipelineRun(db, {
      pipeline: 'knowledge_extract',
      project_id: 'proj-1',
      model: 'sonnet',
      status: 'success',
      input_tokens: 1200,
      output_tokens: 380,
      duration_ms: 4200,
    });
    assert.ok(id > 0);
  });

  it('queryPipelineRuns returns paginated results', () => {
    const { insertPipelineRun, queryPipelineRuns } = require('../../src/db/pipeline-runs');
    insertPipelineRun(db, { pipeline: 'knowledge_scan', project_id: 'proj-1', model: 'sonnet', status: 'success', input_tokens: 500, output_tokens: 100, duration_ms: 2000 });
    insertPipelineRun(db, { pipeline: 'daily_review', project_id: null, model: 'opus', status: 'error', error: 'timeout', input_tokens: 8000, output_tokens: 0, duration_ms: 300000 });
    insertPipelineRun(db, { pipeline: 'knowledge_extract', project_id: 'proj-2', model: 'sonnet', status: 'success', input_tokens: 900, output_tokens: 200, duration_ms: 3000 });

    const result = queryPipelineRuns(db, { projectId: 'proj-1', page: 1, perPage: 10 });
    assert.equal(result.total, 2);
    assert.equal(result.items.length, 2);
    assert.equal(result.page, 1);
  });

  it('queryPipelineRuns filters by pipeline', () => {
    const { queryPipelineRuns } = require('../../src/db/pipeline-runs');
    const result = queryPipelineRuns(db, { pipeline: 'daily_review' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].status, 'error');
  });

  it('queryPipelineRuns filters by status', () => {
    const { queryPipelineRuns } = require('../../src/db/pipeline-runs');
    const result = queryPipelineRuns(db, { status: 'error' });
    assert.equal(result.total, 1);
  });

  it('getPipelineRunStats returns aggregated stats', () => {
    const { getPipelineRunStats } = require('../../src/db/pipeline-runs');
    const stats = getPipelineRunStats(db, { projectId: 'proj-1' });
    assert.equal(stats.total_runs, 2);
    assert.equal(stats.success_count, 2);
    assert.equal(stats.error_count, 0);
    assert.equal(stats.total_input_tokens, 1700);
    assert.equal(stats.total_output_tokens, 480);
    assert.ok(Array.isArray(stats.by_pipeline));
  });

  it('getPipelineRunStats without filter returns all', () => {
    const { getPipelineRunStats } = require('../../src/db/pipeline-runs');
    const stats = getPipelineRunStats(db, {});
    assert.equal(stats.total_runs, 4);
    assert.equal(stats.error_count, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db/pipeline-runs.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement query module**

Create `src/db/pipeline-runs.js`:

```javascript
'use strict';

/**
 * Insert a pipeline run record.
 * @param {import('better-sqlite3').Database} db
 * @param {object} run
 * @returns {number} inserted row id
 */
function insertPipelineRun(db, run) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO pipeline_runs (pipeline, project_id, model, status, error, input_tokens, output_tokens, duration_ms, created_at)
    VALUES (@pipeline, @project_id, @model, @status, @error, @input_tokens, @output_tokens, @duration_ms, @created_at)
  `).run({
    pipeline: run.pipeline,
    project_id: run.project_id ?? null,
    model: run.model ?? null,
    status: run.status ?? 'success',
    error: run.error ?? null,
    input_tokens: run.input_tokens ?? 0,
    output_tokens: run.output_tokens ?? 0,
    duration_ms: run.duration_ms ?? 0,
    created_at: now,
  });
  return result.lastInsertRowid;
}

/**
 * Query pipeline runs with filters and pagination.
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @returns {{ items: object[], total: number, page: number, perPage: number }}
 */
function queryPipelineRuns(db, opts = {}) {
  const { projectId, pipeline, status } = opts;
  let { page = 1, perPage = 20 } = opts;
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 100);

  const conditions = [];
  const params = {};

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }
  if (pipeline) {
    conditions.push('pipeline = @pipeline');
    params.pipeline = pipeline;
  }
  if (status) {
    conditions.push('status = @status');
    params.status = status;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM pipeline_runs ${where}`).get(params).c;
  const items = db.prepare(
    `SELECT * FROM pipeline_runs ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  return { items, total, page, perPage };
}

/**
 * Aggregated stats for pipeline runs.
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @returns {object}
 */
function getPipelineRunStats(db, opts = {}) {
  const { projectId, days = 90 } = opts;

  const conditions = ["created_at >= datetime('now', '-' || @days || ' days')"];
  const params = { days };

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(input_tokens) AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      AVG(duration_ms) AS avg_duration_ms
    FROM pipeline_runs ${where}
  `).get(params);

  const byPipeline = db.prepare(`
    SELECT pipeline, COUNT(*) AS count,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens
    FROM pipeline_runs ${where}
    GROUP BY pipeline
  `).all(params);

  return {
    total_runs: totals.total_runs,
    success_count: totals.success_count,
    error_count: totals.error_count,
    total_input_tokens: totals.total_input_tokens || 0,
    total_output_tokens: totals.total_output_tokens || 0,
    avg_duration_ms: Math.round(totals.avg_duration_ms || 0),
    by_pipeline: byPipeline,
  };
}

module.exports = { insertPipelineRun, queryPipelineRuns, getPipelineRunStats };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db/pipeline-runs.test.js`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/pipeline-runs.js test/db/pipeline-runs.test.js
git commit -m "feat: add pipeline-runs query module with tests"
```

---

### Task 3: Retention Cleanup

**Files:**
- Modify: `src/retention.js:37-42`
- Modify: `test/retention.test.js`

- [ ] **Step 1: Write the failing test**

In `test/retention.test.js`, add a test:

```javascript
it('deletes cold pipeline_runs', () => {
  db.prepare(`
    INSERT INTO pipeline_runs (pipeline, status, input_tokens, output_tokens, duration_ms, created_at)
    VALUES ('knowledge_extract', 'success', 100, 50, 1000, datetime('now', '-100 days'))
  `).run();
  db.prepare(`
    INSERT INTO pipeline_runs (pipeline, status, input_tokens, output_tokens, duration_ms, created_at)
    VALUES ('knowledge_extract', 'success', 200, 80, 2000, datetime('now', '-1 day'))
  `).run();

  const before = db.prepare('SELECT COUNT(*) AS c FROM pipeline_runs').get().c;
  assert.equal(before, 2);

  runRetention(db, { warmDays: 7, coldDays: 90 });

  const after = db.prepare('SELECT COUNT(*) AS c FROM pipeline_runs').get().c;
  assert.equal(after, 1, 'should delete the 100-day-old run');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/retention.test.js`
Expected: FAIL — count is still 2

- [ ] **Step 3: Add pipeline_runs deletion to retention**

In `src/retention.js`, after the Tier 3 delete block (line 37), before the return, add:

```javascript
  // Tier 3: Delete cold pipeline_runs
  const pipelineDeleteResult = db.prepare(`
    DELETE FROM pipeline_runs
    WHERE created_at < datetime('now', '-' || @coldDays || ' days')
  `).run({ coldDays });
```

Update the return to include pipeline deletes:

```javascript
  return {
    compacted: compactResult.changes,
    deleted: deleteResult.changes + pipelineDeleteResult.changes,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/retention.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/retention.js test/retention.test.js
git commit -m "feat: add pipeline_runs cleanup to retention"
```

---

### Task 4: Modify `callClaude()` to Return Extended Info

**Files:**
- Modify: `src/knowledge/extract.js:197-227` (callClaude function)
- Modify: `src/knowledge/extract.js:365` (caller in extractKnowledgeFromPrompt)
- Modify: `src/knowledge/scan.js:162` (caller in scanProject)

- [ ] **Step 1: Modify `callClaude()` return shape**

In `src/knowledge/extract.js`, replace the `callClaude` function (lines 197-227) with:

```javascript
/**
 * Calls Claude via CLI (`claude -p`). Uses the user's Max subscription.
 * Sets OPEN_PULSE_INTERNAL=1 to prevent collector hooks from firing.
 *
 * @param {string} prompt
 * @param {string} [model]
 * @param {object} [opts]
 * @returns {Promise<{output: string, stderr: string, duration_ms: number}>}
 */
function callClaude(prompt, model = 'opus', opts = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = ['-p', '--model', model, '--no-session-persistence'];
    if (opts.effort) args.push('--effort', opts.effort);
    const proc = spawn('claude', args, {
      env: { ...process.env, OPEN_PULSE_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    proc.on('close', code => {
      const duration_ms = Date.now() - startTime;
      if (code === 0) {
        resolve({ output: stdout, stderr, duration_ms });
      } else {
        const err = new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
        err.stderr = stderr;
        err.duration_ms = duration_ms;
        reject(err);
      }
    });

    proc.on('error', err => {
      err.duration_ms = Date.now() - startTime;
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
```

- [ ] **Step 2: Add `parseTokenUsage` helper**

In `src/knowledge/extract.js`, add after `callClaude` (before `parseJsonResponse` at line 229):

```javascript
/**
 * Parse token usage from Claude CLI stderr output.
 * @param {string} stderr
 * @returns {{ input_tokens: number, output_tokens: number }}
 */
function parseTokenUsage(stderr) {
  let input_tokens = 0;
  let output_tokens = 0;
  const inputMatch = stderr.match(/input.tokens?\s*[:=]\s*(\d[\d,]*)/i);
  const outputMatch = stderr.match(/output.tokens?\s*[:=]\s*(\d[\d,]*)/i);
  if (inputMatch) input_tokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
  if (outputMatch) output_tokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
  return { input_tokens, output_tokens };
}
```

- [ ] **Step 3: Update caller in extract.js**

In `src/knowledge/extract.js`, line 365, change:

```javascript
// Before:
const rawResponse = await callClaude(llmPrompt, model, { effort: 'max' });
const entries = parseJsonResponse(rawResponse);
```

to:

```javascript
// After:
const claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
const entries = parseJsonResponse(claudeResult.output);
```

- [ ] **Step 4: Update caller in scan.js**

In `src/knowledge/scan.js`, line 162, change:

```javascript
// Before:
const rawResponse = await callClaude(llmPrompt, model, { effort: 'max' });
const entries = parseJsonResponse(rawResponse);
```

to:

```javascript
// After:
const claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
const entries = parseJsonResponse(claudeResult.output);
```

- [ ] **Step 5: Add `parseTokenUsage` to exports**

In `src/knowledge/extract.js`, add `parseTokenUsage` to `module.exports`:

```javascript
module.exports = {
  loadSkillTemplate,
  buildExistingEntriesBlock,
  buildExtractPrompt,
  callClaude,
  parseTokenUsage,
  parseJsonResponse,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
};
```

- [ ] **Step 6: Run existing tests to verify no regressions**

Run: `node --test test/knowledge/knowledge.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/extract.js src/knowledge/scan.js
git commit -m "refactor: callClaude returns extended info (stderr, duration_ms)"
```

---

### Task 5: Instrument Knowledge Extract Pipeline

**Files:**
- Modify: `src/knowledge/extract.js:324-378` (extractKnowledgeFromPrompt)

- [ ] **Step 1: Add import at top of file**

In `src/knowledge/extract.js`, add after existing requires:

```javascript
const { insertPipelineRun } = require('../db/pipeline-runs');
```

- [ ] **Step 2: Wrap Claude call with pipeline logging**

In `extractKnowledgeFromPrompt()`, replace lines 363-377 (after `buildExtractPrompt` through the return). The current code:

```javascript
  const llmPrompt = buildExtractPrompt(project.name || project.project_id, events, existingEntriesBlock);
  const claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
  const entries = parseJsonResponse(claudeResult.output);

  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, project.project_id, entries);

  const { renderKnowledgeVault } = require('./vault');
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated };
```

becomes:

```javascript
  const llmPrompt = buildExtractPrompt(project.name || project.project_id, events, existingEntriesBlock);

  let claudeResult;
  try {
    claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
  } catch (err) {
    const tokens = parseTokenUsage(err.stderr || '');
    insertPipelineRun(db, {
      pipeline: 'knowledge_extract',
      project_id: project.project_id,
      model,
      status: 'error',
      error: err.message,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      duration_ms: err.duration_ms || 0,
    });
    throw err;
  }

  const tokens = parseTokenUsage(claudeResult.stderr);
  insertPipelineRun(db, {
    pipeline: 'knowledge_extract',
    project_id: project.project_id,
    model,
    status: 'success',
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    duration_ms: claudeResult.duration_ms,
  });

  const entries = parseJsonResponse(claudeResult.output);
  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, project.project_id, entries);

  const { renderKnowledgeVault } = require('./vault');
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated };
```

- [ ] **Step 3: Commit**

```bash
git add src/knowledge/extract.js
git commit -m "feat: log knowledge_extract runs to pipeline_runs"
```

---

### Task 6: Instrument Knowledge Scan Pipeline

**Files:**
- Modify: `src/knowledge/scan.js:150-172` (scanProject)

- [ ] **Step 1: Add imports**

In `src/knowledge/scan.js`, add after existing requires:

```javascript
const { insertPipelineRun } = require('../db/pipeline-runs');
const { parseTokenUsage } = require('./extract');
```

- [ ] **Step 2: Wrap Claude call with pipeline logging**

In `scanProject()`, replace lines 161-171. The current code:

```javascript
  const llmPrompt = buildScanPrompt(projectName, files, existingTitles, claudeMdContent);
  const claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
  const entries = parseJsonResponse(claudeResult.output);

  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, projectId, entries);

  renderKnowledgeVault(db, projectId);

  return { extracted: entries.length, inserted, updated };
```

becomes:

```javascript
  const llmPrompt = buildScanPrompt(projectName, files, existingTitles, claudeMdContent);

  let claudeResult;
  try {
    claudeResult = await callClaude(llmPrompt, model, { effort: 'max' });
  } catch (err) {
    const tokens = parseTokenUsage(err.stderr || '');
    insertPipelineRun(db, {
      pipeline: 'knowledge_scan',
      project_id: projectId,
      model,
      status: 'error',
      error: err.message,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      duration_ms: err.duration_ms || 0,
    });
    throw err;
  }

  const tokens = parseTokenUsage(claudeResult.stderr);
  insertPipelineRun(db, {
    pipeline: 'knowledge_scan',
    project_id: projectId,
    model,
    status: 'success',
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    duration_ms: claudeResult.duration_ms,
  });

  const entries = parseJsonResponse(claudeResult.output);
  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, projectId, entries);
  renderKnowledgeVault(db, projectId);

  return { extracted: entries.length, inserted, updated };
```

- [ ] **Step 3: Commit**

```bash
git add src/knowledge/scan.js
git commit -m "feat: log knowledge_scan runs to pipeline_runs"
```

---

### Task 7: Instrument Daily Review Pipeline

**Files:**
- Modify: `src/review/pipeline.js:205-257` (runDailyReview)

- [ ] **Step 1: Add imports**

In `src/review/pipeline.js`, add after existing requires:

```javascript
const { insertPipelineRun } = require('../db/pipeline-runs');
const { parseTokenUsage } = require('../knowledge/extract');
```

- [ ] **Step 2: Wrap execFileSync with pipeline logging**

In `runDailyReview()`, replace lines 229-246. The current code:

```javascript
  let output;
  try {
    output = execFileSync('claude', [
      '--model', model,
      '--max-turns', '1',
      '--print',
      '-p',
    ], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], insights: [], reportPath: null, error: err.message };
  }
```

becomes:

```javascript
  let output;
  const startTime = Date.now();
  try {
    output = execFileSync('claude', [
      '--model', model,
      '--max-turns', '1',
      '--print',
      '-p',
    ], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
      maxBuffer: 50 * 1024 * 1024,
    });
    insertPipelineRun(db, {
      pipeline: 'daily_review',
      project_id: null,
      model,
      status: 'success',
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const tokens = parseTokenUsage(err.stderr ? err.stderr.toString() : '');
    insertPipelineRun(db, {
      pipeline: 'daily_review',
      project_id: null,
      model,
      status: 'error',
      error: err.message,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      duration_ms: Date.now() - startTime,
    });
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], insights: [], reportPath: null, error: err.message };
  }
```

Note: `execFileSync` does not capture stderr on success — token counts will be 0 for successful daily review runs. This is acceptable; duration is the primary metric.

- [ ] **Step 3: Commit**

```bash
git add src/review/pipeline.js
git commit -m "feat: log daily_review runs to pipeline_runs"
```

---

### Task 8: API Routes

**Files:**
- Modify: `src/routes/projects.js`
- Modify: `test/routes/routes.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/routes/routes.test.js`, add a describe block:

```javascript
describe('pipeline-runs API', () => {
  before(() => {
    const { insertPipelineRun } = require('../../src/db/pipeline-runs');
    const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
    insertPipelineRun(testDb, { pipeline: 'knowledge_extract', project_id: 'proj-1', model: 'sonnet', status: 'success', input_tokens: 1200, output_tokens: 380, duration_ms: 4200 });
    insertPipelineRun(testDb, { pipeline: 'knowledge_scan', project_id: 'proj-1', model: 'sonnet', status: 'error', error: 'timeout', input_tokens: 500, output_tokens: 0, duration_ms: 30000 });
    insertPipelineRun(testDb, { pipeline: 'daily_review', project_id: null, model: 'opus', status: 'success', input_tokens: 8000, output_tokens: 2000, duration_ms: 120000 });
    testDb.close();
  });

  it('GET /api/projects/:id/pipeline-runs returns runs for project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/pipeline-runs' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.total, 2);
    assert.ok(Array.isArray(body.items));
  });

  it('GET /api/projects/:id/pipeline-runs filters by pipeline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/pipeline-runs?pipeline=knowledge_extract' });
    const body = JSON.parse(res.body);
    assert.equal(body.total, 1);
  });

  it('GET /api/pipeline-runs/stats returns aggregated stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pipeline-runs/stats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.total_runs, 3);
    assert.ok(body.total_input_tokens > 0);
    assert.ok(Array.isArray(body.by_pipeline));
  });

  it('GET /api/pipeline-runs/stats filters by project_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pipeline-runs/stats?project_id=proj-1' });
    const body = JSON.parse(res.body);
    assert.equal(body.total_runs, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/routes/routes.test.js`
Expected: FAIL — 404

- [ ] **Step 3: Add routes**

In `src/routes/projects.js`, add import at top:

```javascript
const { queryPipelineRuns, getPipelineRunStats } = require('../db/pipeline-runs');
```

Add routes before the closing `};`:

```javascript
  // ── Pipeline Runs ─────────────────────────────────────────────────────────

  app.get('/api/pipeline-runs/stats', async (request) => {
    const projectId = request.query.project_id || undefined;
    const days = Math.max(1, parseInt(request.query.days) || 90);
    return getPipelineRunStats(db, { projectId, days });
  });

  app.get('/api/projects/:id/pipeline-runs', async (request) => {
    const projectId = request.params.id;
    const pipeline = request.query.pipeline || undefined;
    const status = request.query.status || undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit) || 20), 100);
    const page = Math.max(1, parseInt(request.query.page) || 1);
    return queryPipelineRuns(db, { projectId, pipeline, status, page, perPage: limit });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/routes/routes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/projects.js test/routes/routes.test.js
git commit -m "feat: add pipeline-runs API endpoints"
```

---

### Task 9: Frontend — Stats Cards + History Table

**Files:**
- Modify: `public/modules/projects.js:27` (add helpers)
- Modify: `public/modules/projects.js:299` (add section to renderDetailContent)

- [ ] **Step 1: Add helper functions**

In `public/modules/projects.js`, after the `statCell` helper (line 27), add:

```javascript
function fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function timeAgo(isoString) {
  if (!isoString) return '\u2014';
  var diff = Date.now() - new Date(isoString).getTime();
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.floor(hrs / 24);
  return days + 'd ago';
}
```

- [ ] **Step 2: Add pipeline runs section to renderDetailContent**

At the end of `renderDetailContent()` (after line 298, before the closing brace), add the pipeline runs card. Build the table using DOM methods (createElement + textContent) instead of innerHTML string concatenation. See the full code block in the spec — the structure is:

1. Create `runsCard` div.card with title "Pipeline Runs"
2. Create `runsStatsRow` grid (4 columns): Total Runs, Total Tokens, Success Rate, Avg Duration — initially show "—"
3. Create `runsTableWrap` div with loading spinner
4. Fetch `GET /pipeline-runs/stats?project_id={projectId}` → update stats cells
5. Fetch `GET /projects/{projectId}/pipeline-runs?limit=20` → build table with columns: Time, Pipeline, Model, Tokens (in/out), Duration, Status
6. Pipeline badges: color-coded spans (extract=blue `#74b9ff`, scan=purple `#a29bfe`, daily_review=amber `#fdcb6e`)
7. Status: green checkmark for success, red X for error (with error text in title attribute)

For the table body, build each row using DOM methods:
- Create `tr` element for each run
- Create `td` elements with `textContent` for safe values
- For pipeline badge and status indicator, create `span` elements with appropriate styles
- For tokens column, use `fmtTokens()` helper

- [ ] **Step 3: Verify in browser**

1. Restart server: kill existing process, run `npm start`
2. Open `http://127.0.0.1:3827/#projects`
3. Click on a project with existing pipeline runs
4. Verify: stats cards render, table shows runs with badges and status indicators
5. Verify: empty state shows "No pipeline runs yet" for projects without runs

- [ ] **Step 4: Commit**

```bash
git add public/modules/projects.js
git commit -m "feat: add pipeline runs stats + history table to project detail"
```

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add pipeline_runs to DB schema table**

In the Database Schema section, update the table count from "13 tables" to "14 tables" and add row:

```markdown
| `pipeline_runs` | Internal Claude CLI invocation log | pipeline, project_id, model, status, error, input_tokens, output_tokens, duration_ms |
```

- [ ] **Step 2: Add API endpoints**

In the API Endpoints section, add:

```markdown
### Pipeline Runs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/pipeline-runs/stats?project_id=&days=` | Aggregated run stats |
| GET | `/api/projects/:id/pipeline-runs?pipeline=&status=&limit=&page=` | Project pipeline run history |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add pipeline_runs to CLAUDE.md schema and API docs"
```
