# Daily Review Quality Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve daily review quality by scanning all registered project configs, supporting multi-day history, and adding cross-project insights.

**Architecture:** Extend the existing `src/review/` pipeline with new data collection functions (`discoverProjectPaths`, `scanOneProject`, `scanProjectConfigs`), a new `daily_review_insights` table, redesigned prompt template with 2 JSON output blocks, new API routes, and a tabbed frontend UI.

**Tech Stack:** Node.js, better-sqlite3, Fastify 5, vanilla JS ES modules, node:test

---

### Task 1: Database — Create `daily_review_insights` table + config

**Files:**
- Modify: `src/db/schema.js:168-182` (add table in SCHEMA string)
- Modify: `config.json` (add `daily_review_history_days`)
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/review/review.test.js` after the existing `after()` block, inside the main `describe`:

```javascript
  // -- daily_review_insights table --

  it('daily_review_insights table exists with correct columns', () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('daily_review_insights')").all().map(c => c.name);
    const expected = ['id', 'review_date', 'insight_type', 'title', 'description', 'projects', 'target_type', 'severity', 'reasoning', 'summary_vi', 'status', 'created_at'];
    for (const col of expected) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — table `daily_review_insights` does not exist

- [ ] **Step 3: Add CREATE TABLE to schema**

In `src/db/schema.js`, inside the SCHEMA template string, after the `daily_reviews` indexes (line 182, before the closing backtick+semicolon), add:

```sql
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

- [ ] **Step 4: Add config key**

In `config.json`, add after `daily_review_max_suggestions`:

```json
  "daily_review_history_days": 1
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test 2>&1 | tail -5`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js config.json test/review/review.test.js
git commit -m "feat: add daily_review_insights table and history_days config"
```

---

### Task 2: Query helpers — `src/review/queries.js`

**Files:**
- Modify: `src/review/queries.js`
- Modify: `src/review/pipeline.js` (re-export new functions)
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write failing tests**

Add to `test/review/review.test.js` inside the main `describe`, after the insights table test:

```javascript
  // -- insight query helpers --

  it('saveInsights inserts into daily_review_insights', () => {
    const insights = [{
      insight_type: 'duplicate',
      title: 'Duplicate TDD rule',
      description: 'Same rule in 2 projects',
      projects: ['open-pulse', 'carthings'],
      target_type: 'rule',
      severity: 'warning',
      reasoning: 'Identical content',
      summary_vi: 'Quy tắc TDD trùng lặp',
    }];
    review.saveInsights(db, insights, '2026-04-10');
    const rows = db.prepare('SELECT * FROM daily_review_insights WHERE review_date = ?').all('2026-04-10');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].title, 'Duplicate TDD rule');
    assert.equal(rows[0].severity, 'warning');
    assert.equal(rows[0].status, 'pending');
    const projects = JSON.parse(rows[0].projects);
    assert.deepEqual(projects, ['open-pulse', 'carthings']);
  });

  it('queryInsights filters by insight_type', () => {
    const result = review.queryInsights(db, { insight_type: 'duplicate' });
    assert.ok(result.rows.length >= 1);
    assert.ok(result.total >= 1);
  });

  it('queryInsights returns empty for non-matching filter', () => {
    const result = review.queryInsights(db, { insight_type: 'conflict' });
    assert.equal(result.rows.length, 0);
  });

  it('getInsight returns single row', () => {
    const all = db.prepare('SELECT id FROM daily_review_insights LIMIT 1').get();
    const row = review.getInsight(db, all.id);
    assert.ok(row);
    assert.equal(row.title, 'Duplicate TDD rule');
  });

  it('updateInsightStatus changes status', () => {
    const all = db.prepare('SELECT id FROM daily_review_insights LIMIT 1').get();
    review.updateInsightStatus(db, all.id, 'resolved');
    const row = review.getInsight(db, all.id);
    assert.equal(row.status, 'resolved');
  });

  it('getInsightStats returns counts by type and severity', () => {
    const stats = review.getInsightStats(db);
    assert.ok(Array.isArray(stats.byType));
    assert.ok(Array.isArray(stats.bySeverity));
  });
```

- [ ] **Step 2: Run test to verify they fail**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — `review.saveInsights is not a function`

- [ ] **Step 3: Add query functions to `src/review/queries.js`**

Append before `module.exports` in `src/review/queries.js`:

```javascript
// ---------------------------------------------------------------------------
// daily_review_insights table query helpers
// ---------------------------------------------------------------------------

function queryInsights(db, opts = {}) {
  const { review_date, insight_type, status, severity, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (review_date) { conditions.push('review_date = ?'); params.push(review_date); }
  if (insight_type) { conditions.push('insight_type = ?'); params.push(insight_type); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (severity) { conditions.push('severity = ?'); params.push(severity); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM daily_review_insights ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM daily_review_insights ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getInsight(db, id) {
  return db.prepare('SELECT * FROM daily_review_insights WHERE id = ?').get(id);
}

function updateInsightStatus(db, id, status) {
  db.prepare('UPDATE daily_review_insights SET status = ? WHERE id = ?').run(status, id);
}

function getInsightStats(db) {
  const byType = db.prepare(
    'SELECT insight_type, COUNT(*) as count FROM daily_review_insights GROUP BY insight_type ORDER BY count DESC'
  ).all();
  const bySeverity = db.prepare(
    'SELECT severity, COUNT(*) as count FROM daily_review_insights GROUP BY severity ORDER BY count DESC'
  ).all();
  const byDate = db.prepare(
    'SELECT review_date, COUNT(*) as count FROM daily_review_insights GROUP BY review_date ORDER BY review_date DESC LIMIT 30'
  ).all();
  return { byType, bySeverity, byDate };
}
```

Update `module.exports` in `src/review/queries.js`:

```javascript
module.exports = {
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  queryInsights,
  getInsight,
  updateInsightStatus,
  getInsightStats,
};
```

- [ ] **Step 4: Add `saveInsights` + `makeInsightId` to `src/review/pipeline.js`**

After `saveSuggestions()` (line 72), add:

```javascript
function makeInsightId(title, date) {
  const hash = crypto
    .createHash('sha256')
    .update(`insight::${title}::${date}`)
    .digest('hex')
    .substring(0, 16);
  return `dri-${hash}`;
}

function saveInsights(db, insights, reviewDate) {
  const stmt = db.prepare(`
    INSERT INTO daily_review_insights
      (id, review_date, insight_type, title, description, projects, target_type, severity, reasoning, summary_vi, status, created_at)
    VALUES
      (@id, @review_date, @insight_type, @title, @description, @projects, @target_type, @severity, @reasoning, @summary_vi, 'pending', @created_at)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      severity = excluded.severity,
      reasoning = excluded.reasoning,
      summary_vi = excluded.summary_vi
  `);

  const tx = db.transaction((rows) => {
    for (const ins of rows) {
      stmt.run({
        id: makeInsightId(ins.title, reviewDate),
        review_date: reviewDate,
        insight_type: ins.insight_type || 'gap',
        title: ins.title,
        description: ins.description || '',
        projects: JSON.stringify(ins.projects || []),
        target_type: ins.target_type || null,
        severity: ins.severity || 'info',
        reasoning: ins.reasoning || '',
        summary_vi: ins.summary_vi || '',
        created_at: new Date().toISOString(),
      });
    }
  });
  tx(insights);
}
```

Update `module.exports` in `src/review/pipeline.js` — add `saveInsights`, `queryInsights`, `getInsight`, `updateInsightStatus`, `getInsightStats`:

```javascript
const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus, getDailyReviewStats,
  queryInsights, getInsight, updateInsightStatus, getInsightStats,
} = require('./queries');

// ... at module.exports:
module.exports = {
  collectWorkHistory,
  scanAllComponents,
  loadBestPractices,
  buildPrompt,
  parseSuggestions,
  saveSuggestions,
  saveInsights,
  writeReport,
  makeReviewId,
  makeInsightId,
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  queryInsights,
  getInsight,
  updateInsightStatus,
  getInsightStats,
  runDailyReview,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/review/queries.js src/review/pipeline.js test/review/review.test.js
git commit -m "feat: add insight query helpers and saveInsights"
```

---

### Task 3: Data collection — `discoverProjectPaths` + `scanProjectConfigs`

**Files:**
- Modify: `src/review/context.js`
- Modify: `src/review/pipeline.js` (re-export)
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write failing tests**

Add to `test/review/review.test.js`. First, in `before()`, seed a cl_projects row and create a fake project `.claude/` dir:

```javascript
    // Seed cl_projects for project scanning tests
    const TEST_PROJECT_DIR = path.join(TEST_DIR, 'fake-project');
    fs.mkdirSync(path.join(TEST_PROJECT_DIR, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROJECT_DIR, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'CLAUDE.md'), '# Fake Project\nProject instructions.');
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, '.claude', 'rules', 'style.md'), '# Style\nUse tabs.');
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nHelper agent.');

    db.prepare(
      'INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('proj-1', 'fake-project', TEST_PROJECT_DIR, new Date().toISOString(), new Date().toISOString(), 5);
```

Store `TEST_PROJECT_DIR` at the top of the file (next to `TEST_DIR`):

```javascript
const TEST_PROJECT_DIR = path.join(TEST_DIR, 'fake-project');
```

Then add the test cases inside the `describe`:

```javascript
  // -- discoverProjectPaths --

  it('discoverProjectPaths finds projects from cl_projects', () => {
    const paths = review.discoverProjectPaths(db);
    assert.ok(paths.length >= 1);
    const found = paths.find(p => p.name === 'fake-project');
    assert.ok(found, 'Should find fake-project');
    assert.equal(found.directory, TEST_PROJECT_DIR);
  });

  it('discoverProjectPaths filters out non-existent directories', () => {
    db.prepare(
      'INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('proj-ghost', 'ghost', '/nonexistent/path', new Date().toISOString(), new Date().toISOString(), 0);
    const paths = review.discoverProjectPaths(db);
    const found = paths.find(p => p.name === 'ghost');
    assert.ok(!found, 'Should not include nonexistent directory');
  });

  // -- scanOneProject --

  it('scanOneProject reads project CLAUDE.md and .claude/ components', () => {
    const result = review.scanOneProject(TEST_PROJECT_DIR);
    assert.ok(result.claudeMd.includes('Fake Project'));
    assert.ok(result.rules.length >= 1);
    assert.ok(result.rules[0].content.includes('Use tabs'));
    assert.ok(result.agents.length >= 1);
  });

  it('scanOneProject returns empty for project without .claude/', () => {
    const emptyDir = path.join(TEST_DIR, 'empty-project');
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = review.scanOneProject(emptyDir);
    assert.equal(result.claudeMd, '');
    assert.deepEqual(result.rules, []);
  });

  // -- scanProjectConfigs --

  it('scanProjectConfigs returns configs keyed by project name', () => {
    const configs = review.scanProjectConfigs(db);
    assert.ok(configs['fake-project']);
    assert.ok(configs['fake-project'].claudeMd.includes('Fake Project'));
    assert.ok(configs['fake-project'].rules.length >= 1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — `review.discoverProjectPaths is not a function`

- [ ] **Step 3: Implement in `src/review/context.js`**

Add after `loadBestPractices()` (line 134), before `module.exports`:

```javascript
// ---------------------------------------------------------------------------
// Phase 5: Discover + scan project configs
// ---------------------------------------------------------------------------

function discoverProjectPaths(db, registryPath) {
  const projects = db.prepare('SELECT name, directory FROM cl_projects WHERE directory IS NOT NULL').all();

  // Merge with projects.json if available
  const regPath = registryPath || path.join(REPO_DIR, 'projects.json');
  if (fs.existsSync(regPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const knownDirs = new Set(projects.map(p => p.directory));
      for (const [, proj] of Object.entries(registry)) {
        if (proj.root && !knownDirs.has(proj.root)) {
          projects.push({ name: proj.name || path.basename(proj.root), directory: proj.root });
          knownDirs.add(proj.root);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Filter: only projects whose directory exists on disk
  return projects.filter(p => fs.existsSync(p.directory));
}

function scanOneProject(projectDir) {
  let claudeMd = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
  }

  const dotClaude = path.join(projectDir, '.claude');
  const rules = readDirFiles(path.join(dotClaude, 'rules'));
  const skills = readDirFiles(path.join(dotClaude, 'skills'));
  const agents = readDirFiles(path.join(dotClaude, 'agents'));
  const knowledge = readDirFiles(path.join(dotClaude, 'knowledge'));

  let hooks = [];
  const settingsPath = path.join(dotClaude, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      hooks = settings.hooks || [];
    } catch { /* ignore */ }
  }

  return { claudeMd, rules, skills, agents, knowledge, hooks };
}

function scanProjectConfigs(db, registryPath) {
  const paths = discoverProjectPaths(db, registryPath);
  const configs = {};
  for (const { name, directory } of paths) {
    configs[name] = { directory, ...scanOneProject(directory) };
  }
  return configs;
}
```

Update `module.exports` in `src/review/context.js`:

```javascript
module.exports = {
  collectWorkHistory,
  scanAllComponents,
  loadBestPractices,
  buildPrompt,
  readDirFiles,
  discoverProjectPaths,
  scanOneProject,
  scanProjectConfigs,
};
```

Update imports in `src/review/pipeline.js` (line 8):

```javascript
const {
  collectWorkHistory, scanAllComponents, loadBestPractices, buildPrompt,
  discoverProjectPaths, scanOneProject, scanProjectConfigs,
} = require('./context');
```

Add to `module.exports` in `src/review/pipeline.js`:

```javascript
  discoverProjectPaths,
  scanOneProject,
  scanProjectConfigs,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/context.js src/review/pipeline.js test/review/review.test.js
git commit -m "feat: add discoverProjectPaths, scanOneProject, scanProjectConfigs"
```

---

### Task 4: Extend `collectWorkHistory` for multi-day range

**Files:**
- Modify: `src/review/context.js:21-39`
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write failing test**

Add to `test/review/review.test.js` before the existing `collectWorkHistory` tests. First, in `before()`, seed events for a second day:

```javascript
    // Seed events for yesterday (for multi-day history test)
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    stmtE.run('sess-2', yesterday, 'tool_call', 'Bash', 'Run tests', 0.003, 150, 80);
    stmtS.run('sess-2', yesterday, 'opus', 0.003, 150, 80);
```

Then add the test:

```javascript
  it('collectWorkHistory with historyDays=2 includes yesterday', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = review.collectWorkHistory(db, today, 2);
    assert.ok(history.events.length >= 4, 'Should include today + yesterday events');
    assert.ok(history.sessions.length >= 2, 'Should include both sessions');
  });

  it('collectWorkHistory with historyDays=1 only includes target date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history1 = review.collectWorkHistory(db, today, 1);
    const historyDefault = review.collectWorkHistory(db, today);
    assert.equal(history1.events.length, historyDefault.events.length);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — historyDays=2 doesn't include yesterday events (current code ignores the param)

- [ ] **Step 3: Modify `collectWorkHistory` in `src/review/context.js`**

Replace the function (lines 21-39):

```javascript
function collectWorkHistory(db, date, historyDays = 1) {
  const days = Math.max(1, historyDays);
  // Calculate start date: date minus (days - 1)
  const endDate = date;
  const startMs = new Date(date + 'T00:00:00Z').getTime() - (days - 1) * 86400000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);

  const events = db.prepare(`
    SELECT event_type, name, detail, estimated_cost_usd AS cost, input_tokens, output_tokens, timestamp
    FROM events
    WHERE DATE(timestamp) BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(startDate, endDate);

  const sessions = db.prepare(`
    SELECT session_id, started_at, ended_at, model, total_cost_usd AS cost, total_input_tokens, total_output_tokens
    FROM sessions
    WHERE DATE(started_at) BETWEEN ? AND ?
    ORDER BY started_at ASC
  `).all(startDate, endDate);

  const totalCost = events.reduce((sum, e) => sum + (e.cost || 0), 0);

  return { events, sessions, totalCost, startDate, endDate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/context.js test/review/review.test.js
git commit -m "feat: support multi-day history in collectWorkHistory"
```

---

### Task 5: Redesign prompt template + `buildPrompt` + `parseReviewOutput`

**Files:**
- Modify: `src/review/prompt.md` (full rewrite)
- Modify: `src/review/context.js:140-175` (`buildPrompt`)
- Modify: `src/review/pipeline.js:17-30` (`parseSuggestions` → `parseReviewOutput`)
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write failing tests for `parseReviewOutput`**

Add to `test/review/review.test.js`:

```javascript
  // -- parseReviewOutput --

  it('parseReviewOutput parses labeled suggestions + insights blocks', () => {
    const output = [
      'Analysis:',
      '```json suggestions',
      '[{"category":"cleanup","title":"Remove unused","description":"d","target_type":"rule","action":"remove","confidence":0.8,"reasoning":"r","summary_vi":"v"}]',
      '```',
      '',
      '```json insights',
      '[{"insight_type":"duplicate","title":"Dup rule","description":"d","projects":["a","b"],"target_type":"rule","severity":"warning","reasoning":"r","summary_vi":"v"}]',
      '```',
    ].join('\n');
    const result = review.parseReviewOutput(output);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].title, 'Remove unused');
    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].title, 'Dup rule');
  });

  it('parseReviewOutput falls back to single block as suggestions', () => {
    const output = '```json\n[{"category":"cleanup","title":"Test","description":"d","target_type":"rule","action":"remove","confidence":0.5,"reasoning":"r"}]\n```';
    const result = review.parseReviewOutput(output);
    assert.equal(result.suggestions.length, 1);
    assert.deepEqual(result.insights, []);
  });

  it('parseReviewOutput returns empty for invalid output', () => {
    const result = review.parseReviewOutput('not json');
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.insights, []);
  });
```

- [ ] **Step 2: Write failing test for updated `buildPrompt`**

```javascript
  it('buildPrompt includes project configs section', () => {
    const history = review.collectWorkHistory(db, new Date().toISOString().slice(0, 10));
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    const practices = review.loadBestPractices(REPO_DIR);
    const projectConfigs = { 'fake-project': { directory: '/tmp', claudeMd: '# Fake', rules: [], skills: [], agents: [], knowledge: [], hooks: [] } };
    const prompt = review.buildPrompt(history, components, practices, {
      date: '2026-04-10',
      max_suggestions: 25,
      projectConfigs,
      historyDays: 1,
    });
    assert.ok(prompt.includes('Project Configurations'));
    assert.ok(prompt.includes('fake-project'));
    assert.ok(prompt.includes('# Fake'));
    assert.ok(prompt.includes('json suggestions'));
    assert.ok(prompt.includes('json insights'));
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — `parseReviewOutput is not a function`, prompt doesn't include project configs

- [ ] **Step 4: Rewrite `src/review/prompt.md`**

Replace entire content:

```markdown
# Daily Review — {{date}}

You are a Claude Code setup advisor. Analyze the user's complete configuration across all scopes and work history, then provide suggestions and cross-project insights.

## Work History ({{history_days}} days: {{date_range}})
{{work_history_json}}

## Global Configuration (~/.claude/)

### Rules ({{rule_count}})
{{rules_content}}

### Skills ({{skill_count}})
{{skills_content}}

### Agents ({{agent_count}})
{{agents_content}}

### Hooks
{{hooks_config}}

### Memory
{{memory_content}}

### Plugins ({{plugin_count}})
{{plugins_content}}

## Project Configurations ({{project_count}} projects)
{{project_configs_content}}

## Best Practices Reference
{{claude_code_knowledge}}

## Instructions

### Part 1: Suggestions
Analyze configurations against best practices. Consider:
1. Are there redundant or conflicting rules/skills/agents?
2. Are there patterns in work history that suggest new rules or skills?
3. Are there components that should be merged, updated, or removed?
4. Are there missing components suggested by best practices?
5. Are there cost optimization opportunities based on model usage?

### Part 2: Cross-Project Insights
Analyze configurations across all {{project_count}} projects. Identify:
1. Duplicate rules/skills/agents across projects or global scope
2. Conflicting configurations between scopes (global vs project)
3. Gaps — project missing components that other similar projects have
4. Unused components — defined but never invoked in work history
5. Cross-dependencies — project using components defined elsewhere

Return TWO labeled JSON code blocks:

```json suggestions
[
  {
    "category": "adoption|cleanup|agent_creation|update|optimization|integration|cost|security|refinement",
    "title": "Short descriptive title",
    "description": "Detailed description of what to do and why",
    "target_type": "rule|skill|agent|hook|knowledge",
    "action": "create|update|remove|merge",
    "confidence": 0.5,
    "reasoning": "Evidence-based reasoning for this suggestion",
    "summary_vi": "Tóm tắt bằng tiếng Việt (có dấu đầy đủ): giải thích vấn đề gì đang xảy ra và đề xuất hành động cụ thể để cải thiện"
  }
]
```

```json insights
[
  {
    "insight_type": "duplicate|conflict|gap|unused|cross_dependency",
    "title": "Short descriptive title",
    "description": "Detailed description of what was found",
    "projects": ["project-a", "project-b"],
    "target_type": "rule|skill|agent|hook|knowledge",
    "severity": "info|warning|critical",
    "reasoning": "Evidence-based reasoning referencing specific files/components",
    "summary_vi": "Tóm tắt bằng tiếng Việt (có dấu đầy đủ): giải thích vấn đề gì đang xảy ra và đề xuất hành động cụ thể để cải thiện"
  }
]
```

Rules:
- Maximum {{max_suggestions}} suggestions
- Confidence range: 0.1 (speculative) to 0.9 (strong evidence)
- Every suggestion and insight must reference specific evidence from work history or setup content
- Do not suggest changes already handled by existing components
```

- [ ] **Step 5: Update `buildPrompt` in `src/review/context.js`**

Replace the function (lines 140-175):

```javascript
function buildPrompt(history, components, practices, opts = {}) {
  const { date = new Date().toISOString().slice(0, 10), max_suggestions = 25, projectConfigs = {}, historyDays = 1 } = opts;

  const templatePath = path.join(__dirname, 'prompt.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  const formatComponents = (items) =>
    items.map(c => `#### ${c.name}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');

  // Format project configs section
  const projectNames = Object.keys(projectConfigs);
  let projectContent = 'None';
  if (projectNames.length > 0) {
    const sections = [];
    for (const [name, cfg] of Object.entries(projectConfigs)) {
      const parts = [`### Project: ${name} (${cfg.directory})`];
      if (cfg.claudeMd) parts.push(`#### CLAUDE.md\n\`\`\`\n${cfg.claudeMd}\n\`\`\``);
      if (cfg.rules.length) parts.push(`#### Rules (${cfg.rules.length})\n${formatComponents(cfg.rules)}`);
      if (cfg.skills.length) parts.push(`#### Skills (${cfg.skills.length})\n${formatComponents(cfg.skills)}`);
      if (cfg.agents.length) parts.push(`#### Agents (${cfg.agents.length})\n${formatComponents(cfg.agents)}`);
      if (cfg.knowledge.length) parts.push(`#### Knowledge (${cfg.knowledge.length})\n${formatComponents(cfg.knowledge)}`);
      if (cfg.hooks.length) parts.push(`#### Hooks\n${JSON.stringify(cfg.hooks, null, 2)}`);
      sections.push(parts.join('\n\n'));
    }
    projectContent = sections.join('\n\n---\n\n');
  }

  const startDate = history.startDate || date;
  const dateRange = startDate === date ? date : `${startDate} → ${date}`;

  const replacements = {
    '{{date}}': date,
    '{{history_days}}': String(historyDays),
    '{{date_range}}': dateRange,
    '{{work_history_json}}': JSON.stringify({
      events: history.events,
      sessions: history.sessions,
      totalCost: history.totalCost,
    }, null, 2),
    '{{rule_count}}': String(components.rules.length),
    '{{rules_content}}': formatComponents(components.rules) || 'None',
    '{{skill_count}}': String(components.skills.length),
    '{{skills_content}}': formatComponents(components.skills) || 'None',
    '{{agent_count}}': String(components.agents.length),
    '{{agents_content}}': formatComponents(components.agents) || 'None',
    '{{hooks_config}}': JSON.stringify(components.hooks, null, 2),
    '{{memory_content}}': formatComponents(components.memory) || 'None',
    '{{plugin_count}}': String(components.plugins.length),
    '{{plugins_content}}': JSON.stringify(components.plugins, null, 2),
    '{{project_count}}': String(projectNames.length),
    '{{project_configs_content}}': projectContent,
    '{{claude_code_knowledge}}': practices.map(p => `### ${p.name}\n${p.content}`).join('\n\n'),
    '{{max_suggestions}}': String(max_suggestions),
  };

  for (const [key, val] of Object.entries(replacements)) {
    template = template.replaceAll(key, val);
  }

  return template;
}
```

Note: removed `history.events.slice(0, 200)` — now sends all events (raw content, max effort per user decision).

- [ ] **Step 6: Add `parseReviewOutput` to `src/review/pipeline.js`**

Replace `parseSuggestions` (lines 17-30) with both functions:

```javascript
function parseSuggestions(output) {
  if (!output || typeof output !== 'string') return [];

  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : output.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(s => s && s.title && s.category);
  } catch {
    return [];
  }
}

function parseReviewOutput(output) {
  if (!output || typeof output !== 'string') return { suggestions: [], insights: [] };

  // Try labeled blocks first: ```json suggestions and ```json insights
  const sugMatch = output.match(/```json\s+suggestions\s*\n([\s\S]*?)\n```/);
  const insMatch = output.match(/```json\s+insights\s*\n([\s\S]*?)\n```/);

  if (sugMatch || insMatch) {
    let suggestions = [];
    let insights = [];
    if (sugMatch) {
      try {
        const parsed = JSON.parse(sugMatch[1].trim());
        if (Array.isArray(parsed)) suggestions = parsed.filter(s => s && s.title && s.category);
      } catch { /* ignore */ }
    }
    if (insMatch) {
      try {
        const parsed = JSON.parse(insMatch[1].trim());
        if (Array.isArray(parsed)) insights = parsed.filter(i => i && i.title && i.insight_type);
      } catch { /* ignore */ }
    }
    return { suggestions, insights };
  }

  // Fallback: single unlabeled block treated as suggestions
  return { suggestions: parseSuggestions(output), insights: [] };
}
```

Add `parseReviewOutput` to `module.exports`:

```javascript
  parseReviewOutput,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add src/review/prompt.md src/review/context.js src/review/pipeline.js test/review/review.test.js
git commit -m "feat: redesign prompt template with project configs and dual output blocks"
```

---

### Task 6: Wire up `runDailyReview` pipeline

**Files:**
- Modify: `src/review/pipeline.js:113-152` (`runDailyReview`)
- Modify: `src/review/pipeline.js:78-107` (`writeReport`)
- Test: `test/review/review.test.js`

- [ ] **Step 1: Write failing test**

```javascript
  // -- writeReport with insights --

  it('writeReport includes insights section', () => {
    const history = { events: [], sessions: [], totalCost: 0 };
    const suggestions = [{ category: 'cleanup', title: 'Test', action: 'remove', target_type: 'rule', confidence: 0.5, reasoning: 'r', description: 'd' }];
    const insights = [{ insight_type: 'duplicate', title: 'Dup', projects: ['a', 'b'], target_type: 'rule', severity: 'warning', reasoning: 'r', description: 'd' }];
    const reportDir = path.join(TEST_DIR, 'reports');
    const reportPath = review.writeReport(suggestions, history, reportDir, '2026-04-10', insights);
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(content.includes('Suggestions (1 total)'));
    assert.ok(content.includes('Cross-Project Insights (1 total)'));
    assert.ok(content.includes('[duplicate] Dup'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: FAIL — report doesn't include insights section

- [ ] **Step 3: Update `writeReport` in `src/review/pipeline.js`**

Replace the function (lines 78-107):

```javascript
function writeReport(suggestions, history, reportDir, date, insights = []) {
  const dir = reportDir || path.join(REPO_DIR, 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `# Daily Review -- ${date}`,
    '',
    '## Summary',
    `- Sessions: ${history.sessions.length}`,
    `- Total cost: $${history.totalCost.toFixed(4)}`,
    `- Events: ${history.events.length}`,
    '',
    `## Suggestions (${suggestions.length} total)`,
    '',
  ];

  suggestions.forEach((s, i) => {
    lines.push(`### ${i + 1}. [${s.category}] ${s.title}`);
    lines.push(`- **Action:** ${s.action || 'N/A'}`);
    lines.push(`- **Target:** ${s.target_type || 'N/A'}`);
    lines.push(`- **Confidence:** ${s.confidence}`);
    lines.push(`- **Reasoning:** ${s.reasoning || 'N/A'}`);
    lines.push(`- **Description:** ${s.description || 'N/A'}`);
    lines.push('');
  });

  if (insights.length > 0) {
    lines.push(`## Cross-Project Insights (${insights.length} total)`);
    lines.push('');
    insights.forEach((ins, i) => {
      lines.push(`### ${i + 1}. [${ins.insight_type}] ${ins.title}`);
      lines.push(`- **Severity:** ${ins.severity || 'info'}`);
      lines.push(`- **Projects:** ${(ins.projects || []).join(', ') || 'N/A'}`);
      lines.push(`- **Target:** ${ins.target_type || 'N/A'}`);
      lines.push(`- **Reasoning:** ${ins.reasoning || 'N/A'}`);
      lines.push(`- **Description:** ${ins.description || 'N/A'}`);
      lines.push('');
    });
  }

  const reportPath = path.join(dir, `${date}-daily-review.md`);
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}
```

- [ ] **Step 4: Update `runDailyReview` in `src/review/pipeline.js`**

Replace the function (lines 113-152):

```javascript
async function runDailyReview(db, opts = {}) {
  const {
    date = new Date().toISOString().slice(0, 10),
    model = 'opus',
    timeout = 300000,
    max_suggestions = 25,
    historyDays = 1,
    reportDir,
    repoDir,
    claudeDir,
  } = opts;

  const history = collectWorkHistory(db, date, historyDays);
  const components = scanAllComponents(claudeDir);
  const projectConfigs = scanProjectConfigs(db);
  const practices = loadBestPractices(repoDir);
  const prompt = buildPrompt(history, components, practices, {
    date,
    max_suggestions,
    projectConfigs,
    historyDays,
  });

  let output;
  try {
    output = execFileSync('claude', [
      '--model', model,
      '--max-turns', '1',
      '--print',
      '-p', prompt,
    ], {
      timeout,
      encoding: 'utf8',
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], insights: [], reportPath: null, error: err.message };
  }

  const { suggestions: rawSuggestions, insights: rawInsights } = parseReviewOutput(output);
  const suggestions = rawSuggestions.slice(0, max_suggestions);
  const insights = rawInsights;

  saveSuggestions(db, suggestions, date);
  saveInsights(db, insights, date);
  const reportPath = writeReport(suggestions, history, reportDir, date, insights);

  return { suggestions, insights, reportPath };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/review/review.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test 2>&1 | tail -5`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/review/pipeline.js test/review/review.test.js
git commit -m "feat: wire up runDailyReview with project scanning, insights, and multi-day history"
```

---

### Task 7: API routes for insights

**Files:**
- Modify: `src/routes/daily-reviews.js`
- Test: `test/routes/routes.test.js`

- [ ] **Step 1: Write failing tests**

Add a new `describe` block in `test/routes/routes.test.js`. Follow the existing bootstrap pattern (uses `buildApp` from `src/server` + env vars). Add after the last route test block:

```javascript
describe('daily-review insight routes', () => {
  let app;

  before(async () => {
    // Use same TEST_DIR and env vars already set by the parent before()
    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed an insight
    const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
    testDb.prepare(`
      INSERT INTO daily_review_insights (id, review_date, insight_type, title, description, projects, target_type, severity, reasoning, summary_vi, status, created_at)
      VALUES ('dri-test1', '2026-04-10', 'duplicate', 'Test insight', 'desc', '["a","b"]', 'rule', 'warning', 'reason', 'vi', 'pending', '2026-04-10T00:00:00Z')
    `).run();
    testDb.close();
  });

  after(async () => { await app.close(); });

  it('GET /api/daily-reviews/insights returns list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/daily-reviews/insights' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.rows.length >= 1);
    assert.ok(body.total >= 1);
  });

  it('GET /api/daily-reviews/insights filters by insight_type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/daily-reviews/insights?insight_type=duplicate' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.rows.length >= 1);
  });

  it('GET /api/daily-reviews/insights/stats returns counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/daily-reviews/insights/stats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.byType));
  });

  it('GET /api/daily-reviews/insights/:id returns detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/daily-reviews/insights/dri-test1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.title, 'Test insight');
  });

  it('PUT /api/daily-reviews/insights/:id/resolve updates status', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/daily-reviews/insights/dri-test1/resolve' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'resolved');
  });

  it('PUT /api/daily-reviews/insights/:id/dismiss updates status', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/daily-reviews/insights/dri-test1/dismiss' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'dismissed');
  });

  it('GET /api/daily-reviews/insights/:id returns 404 for missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/daily-reviews/insights/nonexistent' });
    assert.equal(res.statusCode, 404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/routes/routes.test.js 2>&1 | tail -20`
Expected: FAIL — 404 or route not found

- [ ] **Step 3: Add routes to `src/routes/daily-reviews.js`**

Update the import at top (line 3-6) to include insight functions:

```javascript
const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus,
  getDailyReviewStats, runDailyReview,
  queryInsights, getInsight, updateInsightStatus, getInsightStats,
} = require('../review/pipeline');
```

Add new routes inside the function, after `POST /api/daily-reviews/run` and before the closing `};`. Register static insight routes BEFORE the dynamic `:id` route (Fastify route ordering):

```javascript
  // --- Insight routes (static before dynamic) ---

  // GET /api/daily-reviews/insights/stats
  app.get('/api/daily-reviews/insights/stats', (req, reply) => {
    reply.send(getInsightStats(db));
  });

  // GET /api/daily-reviews/insights
  app.get('/api/daily-reviews/insights', (req, reply) => {
    const { review_date, insight_type, status, severity } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryInsights(db, { review_date, insight_type, status, severity, page, per_page: perPage }));
  });

  // GET /api/daily-reviews/insights/:id
  app.get('/api/daily-reviews/insights/:id', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    reply.send(row);
  });

  // PUT /api/daily-reviews/insights/:id/resolve
  app.put('/api/daily-reviews/insights/:id/resolve', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    updateInsightStatus(db, req.params.id, 'resolved');
    reply.send(getInsight(db, req.params.id));
  });

  // PUT /api/daily-reviews/insights/:id/dismiss
  app.put('/api/daily-reviews/insights/:id/dismiss', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    updateInsightStatus(db, req.params.id, 'dismissed');
    reply.send(getInsight(db, req.params.id));
  });
```

Also update the `POST /api/daily-reviews/run` handler to pass `historyDays`:

```javascript
      const result = await runDailyReview(db, {
        date: req.body && req.body.date ? req.body.date : undefined,
        model: config.daily_review_model || 'opus',
        timeout: config.daily_review_timeout_ms || 300000,
        max_suggestions: config.daily_review_max_suggestions || 25,
        historyDays: config.daily_review_history_days || 1,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/routes/routes.test.js 2>&1 | tail -20`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -5`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/routes/daily-reviews.js test/routes/routes.test.js
git commit -m "feat: add insight API routes (list, detail, resolve, dismiss, stats)"
```

---

### Task 8: Frontend — Tab layout + insights UI

**Files:**
- Modify: `public/modules/daily-reviews.js`

- [ ] **Step 1: Add insight badge helpers**

After `statusBadge()` (line 35), add:

```javascript
function insightTypeBadge(type) {
  const colors = {
    duplicate: '#6c5ce7', conflict: '#d63031', gap: '#e17055',
    unused: '#8b8fa3', cross_dependency: '#74b9ff',
  };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[type] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = type || 'unknown';
  return span;
}

function severityBadge(severity) {
  const colors = { info: '#74b9ff', warning: '#fdcb6e', critical: '#d63031' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[severity] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = severity || 'info';
  return span;
}

function projectBadges(projectsJson) {
  const container = document.createElement('span');
  container.style.cssText = 'display:inline-flex;gap:4px;flex-wrap:wrap';
  let projects = [];
  try { projects = JSON.parse(projectsJson || '[]'); } catch { /* ignore */ }
  for (const p of projects) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.style.cssText = 'background:#a29bfe26;color:#a29bfe;font-size:10px';
    span.textContent = p;
    container.appendChild(span);
  }
  return container;
}
```

- [ ] **Step 2: Add `renderStats` for insights**

Replace `renderStats` to include both counts:

```javascript
async function renderStats(container) {
  const [stats, insightStats] = await Promise.all([
    get('/daily-reviews/stats'),
    get('/daily-reviews/insights/stats'),
  ]);
  const sugTotal = (stats.byStatus || []).reduce((sum, s) => sum + s.count, 0);
  const insTotal = (insightStats.byType || []).reduce((sum, s) => sum + s.count, 0);

  const grid = document.createElement('div');
  grid.className = 'stat-grid';

  const sugCard = document.createElement('div');
  sugCard.className = 'stat-card';
  const sugVal = document.createElement('div');
  sugVal.className = 'stat-value';
  sugVal.textContent = sugTotal;
  const sugLabel = document.createElement('div');
  sugLabel.className = 'stat-label';
  sugLabel.textContent = 'suggestions';
  sugCard.appendChild(sugVal);
  sugCard.appendChild(sugLabel);
  grid.appendChild(sugCard);

  const insCard = document.createElement('div');
  insCard.className = 'stat-card';
  const insVal = document.createElement('div');
  insVal.className = 'stat-value';
  insVal.textContent = insTotal;
  const insLabel = document.createElement('div');
  insLabel.className = 'stat-label';
  insLabel.textContent = 'insights';
  insCard.appendChild(insVal);
  insCard.appendChild(insLabel);
  grid.appendChild(insCard);

  container.appendChild(grid);
}
```

- [ ] **Step 3: Add `renderInsightList` function**

After `renderList`, add:

```javascript
async function renderInsightList(container, filterDate) {
  const params = new URLSearchParams();
  if (filterDate) params.set('review_date', filterDate);
  params.set('per_page', '50');
  const data = await get(`/daily-reviews/insights?${params}`);

  if (!data.rows || data.rows.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'No cross-project insights yet';
    container.appendChild(emptyDiv);
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Date', 'Type', 'Severity', 'Title', 'Projects', 'Target']) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.textContent = row.review_date;
    tr.appendChild(tdDate);

    const tdType = document.createElement('td');
    tdType.appendChild(insightTypeBadge(row.insight_type));
    tr.appendChild(tdType);

    const tdSev = document.createElement('td');
    tdSev.appendChild(severityBadge(row.severity));
    tr.appendChild(tdSev);

    const tdTitle = document.createElement('td');
    const titleLink = document.createElement('a');
    titleLink.href = '#daily-reviews/insight/' + row.id;
    titleLink.textContent = row.title;
    titleLink.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer';
    tdTitle.appendChild(titleLink);
    tr.appendChild(tdTitle);

    const tdProjects = document.createElement('td');
    tdProjects.appendChild(projectBadges(row.projects));
    tr.appendChild(tdProjects);

    const tdTarget = document.createElement('td');
    tdTarget.textContent = row.target_type || '\u2014';
    tr.appendChild(tdTarget);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
```

- [ ] **Step 4: Add `renderInsightDetail` function**

After `renderInsightList`, add:

```javascript
async function renderInsightDetail(el, insightId) {
  el.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Loading\u2026';
  el.appendChild(loading);

  try {
    const insight = await get('/daily-reviews/insights/' + insightId);
    el.removeChild(loading);

    const backLink = document.createElement('a');
    backLink.href = '#daily-reviews';
    backLink.className = 'back-link';
    backLink.textContent = '\u2190 Back to Daily Reviews';
    el.appendChild(backLink);

    // Header card
    const header = document.createElement('div');
    header.className = 'card';
    header.style.marginBottom = '20px';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 12px 0;font-size:18px';
    title.textContent = insight.title;
    header.appendChild(title);

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px';
    badges.appendChild(insightTypeBadge(insight.insight_type));
    badges.appendChild(severityBadge(insight.severity));
    badges.appendChild(statusBadge(insight.status));
    header.appendChild(badges);

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted)';
    const dateSpan = document.createElement('span');
    dateSpan.textContent = 'Date: ' + insight.review_date;
    meta.appendChild(dateSpan);
    if (insight.target_type) {
      const targetSpan = document.createElement('span');
      targetSpan.textContent = 'Target: ' + insight.target_type;
      meta.appendChild(targetSpan);
    }
    header.appendChild(meta);

    // Projects
    if (insight.projects) {
      const projDiv = document.createElement('div');
      projDiv.style.cssText = 'margin-top:12px;font-size:13px';
      const projLabel = document.createElement('span');
      projLabel.style.cssText = 'color:var(--muted);margin-right:8px';
      projLabel.textContent = 'Projects:';
      projDiv.appendChild(projLabel);
      projDiv.appendChild(projectBadges(insight.projects));
      header.appendChild(projDiv);
    }

    el.appendChild(header);

    // Description
    if (insight.description) {
      const descCard = document.createElement('div');
      descCard.className = 'card';
      descCard.style.marginBottom = '20px';
      const descTitle = document.createElement('div');
      descTitle.className = 'card-title';
      descTitle.textContent = 'Description';
      descCard.appendChild(descTitle);
      const descBody = document.createElement('div');
      descBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      descBody.textContent = insight.description;
      descCard.appendChild(descBody);
      el.appendChild(descCard);
    }

    // Reasoning
    if (insight.reasoning) {
      const reasonCard = document.createElement('div');
      reasonCard.className = 'card';
      reasonCard.style.marginBottom = '20px';
      const reasonTitle = document.createElement('div');
      reasonTitle.className = 'card-title';
      reasonTitle.textContent = 'Reasoning';
      reasonCard.appendChild(reasonTitle);
      const reasonBody = document.createElement('div');
      reasonBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      reasonBody.textContent = insight.reasoning;
      reasonCard.appendChild(reasonBody);
      el.appendChild(reasonCard);
    }

    // Vietnamese summary
    if (insight.summary_vi) {
      const viCard = document.createElement('div');
      viCard.className = 'card';
      viCard.style.marginBottom = '20px';
      const viTitle = document.createElement('div');
      viTitle.className = 'card-title';
      viTitle.textContent = 'T\u00f3m t\u1eaft';
      viCard.appendChild(viTitle);
      const viBody = document.createElement('div');
      viBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      viBody.textContent = insight.summary_vi;
      viCard.appendChild(viBody);
      el.appendChild(viCard);
    }

    // Action buttons
    if (insight.status === 'pending') {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:16px';

      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'btn btn-sm';
      resolveBtn.style.cssText = 'background:#00b894;color:white';
      resolveBtn.textContent = 'Resolve';
      resolveBtn.onclick = async () => {
        await put('/daily-reviews/insights/' + insightId + '/resolve');
        renderInsightDetail(el, insightId);
      };
      actions.appendChild(resolveBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-sm';
      dismissBtn.style.cssText = 'background:#e17055;color:white';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.onclick = async () => {
        await put('/daily-reviews/insights/' + insightId + '/dismiss');
        renderInsightDetail(el, insightId);
      };
      actions.appendChild(dismissBtn);

      el.appendChild(actions);
    }

  } catch (err) {
    if (loading.parentNode === el) el.removeChild(loading);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load insight: ' + err.message;
    el.appendChild(errDiv);
  }
}
```

- [ ] **Step 5: Update imports and `mount` function**

Update import at top to include `put`:

```javascript
import { get, post, put } from './api.js';
```

Replace `mount` function with tabbed version:

```javascript
export async function mount(app, { period, params } = {}) {
  // Detail routes
  if (params) {
    if (params.startsWith('insight/')) {
      await renderInsightDetail(app, params.slice(8));
    } else {
      await renderDetail(app, params);
    }
    return;
  }

  app.textContent = '';

  // Header + Run Now
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px';
  const h2 = document.createElement('h2');
  h2.textContent = 'Daily Review';
  header.appendChild(h2);

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-sm';
  runBtn.textContent = 'Run Now';
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running\u2026';
    try {
      await post('/daily-reviews/run');
      mount(app, { period, params });
    } catch (err) {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Now';
      const errEl = document.createElement('div');
      errEl.style.cssText = 'color:#e17055;font-size:13px;margin-top:8px';
      errEl.textContent = err.message || 'Daily review failed';
      header.appendChild(errEl);
      setTimeout(() => errEl.remove(), 8000);
    }
  };
  header.appendChild(runBtn);
  app.appendChild(header);

  // Stats
  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';
  const tabs = ['Suggestions', 'Cross-Project Insights'];
  const tabBtns = tabs.map((label, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    tabBar.appendChild(btn);
    return btn;
  });
  app.appendChild(tabBar);

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  filterBar.appendChild(dateInput);
  app.appendChild(filterBar);

  // Content area
  const contentEl = document.createElement('div');
  app.appendChild(contentEl);

  function showTab(index) {
    tabBtns.forEach((b, i) => b.className = 'tab-btn' + (i === index ? ' active' : ''));
    contentEl.textContent = '';
    if (index === 0) {
      renderList(contentEl, dateInput.value || undefined);
    } else {
      renderInsightList(contentEl, dateInput.value || undefined);
    }
  }

  tabBtns[0].onclick = () => showTab(0);
  tabBtns[1].onclick = () => showTab(1);
  dateInput.onchange = () => {
    const activeIdx = tabBtns.findIndex(b => b.classList.contains('active'));
    showTab(activeIdx);
  };

  // Initial render
  showTab(0);
}
```

- [ ] **Step 6: Verify visually with Playwright screenshot**

Run server and take screenshot:

```bash
pkill -f "node src/op-server" || true
node src/op-server.js &
sleep 1
npx playwright screenshot --viewport-size=1280,900 http://127.0.0.1:3827/#daily-reviews /tmp/daily-reviews-tabs.png
```

Verify: tabs visible, stats show both counts, table renders.

- [ ] **Step 7: Commit**

```bash
git add public/modules/daily-reviews.js
git commit -m "feat: add tabbed UI with suggestions + cross-project insights"
```

---

### Task 9: Update `CLAUDE.md` documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update Database Schema table**

Add `daily_review_insights` row to the table:

```
| `daily_review_insights` | Cross-project insights | id, review_date, insight_type, title, projects (JSON), target_type, severity, status |
```

- [ ] **Step 2: Update API Endpoints — Daily Review section**

Add insight endpoints:

```
| GET | `/api/daily-reviews/insights/stats` | Insight counts by type, severity |
| GET | `/api/daily-reviews/insights?review_date=&insight_type=&status=&severity=` | List insights |
| GET | `/api/daily-reviews/insights/:id` | Insight detail |
| PUT | `/api/daily-reviews/insights/:id/resolve` | Mark insight resolved |
| PUT | `/api/daily-reviews/insights/:id/dismiss` | Dismiss insight |
```

- [ ] **Step 3: Update Configuration table**

Add:

```
| `daily_review_history_days` | 1 | Number of days of work history to include |
```

- [ ] **Step 4: Update Key Design Decisions**

Add bullet:

```
- **Cross-project daily review**: Pipeline scans all registered project configs (CLAUDE.md, .claude/rules|skills|agents|knowledge) from `cl_projects` + `projects.json`. Cross-project insights stored in separate `daily_review_insights` table. Uses Opus 1M context with raw content for maximum analysis quality.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with insights table, routes, and config"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: Restart server and verify API**

```bash
pkill -f "node src/op-server" || true
node src/op-server.js &
sleep 1
curl -s http://127.0.0.1:3827/api/daily-reviews/insights/stats | head -c 200
curl -s http://127.0.0.1:3827/api/daily-reviews/insights | head -c 200
```

- [ ] **Step 3: Take final screenshot**

```bash
npx playwright screenshot --viewport-size=1280,900 http://127.0.0.1:3827/#daily-reviews /tmp/daily-reviews-final.png
```

Verify: tabs work, both Suggestions and Cross-Project Insights tabs render correctly, stats show both counts.
