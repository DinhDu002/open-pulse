# Split Feedback Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the unified insights feedback loop into 2 independent flows: auto-evolve (autonomous component promotion) and daily review (comprehensive 3AM analysis).

**Architecture:** Two completely independent modules — `src/op-auto-evolve.js` (server timer, 60s) and `scripts/op-daily-review.js` (launchd, 3AM daily). Each has its own DB table, API routes, and frontend UI. Zero shared code between flows. Old `insights` table and related code deleted after new flows are working.

**Tech Stack:** Node.js (CommonJS), better-sqlite3, Fastify 5, vanilla JS ES modules (frontend), node:test (testing)

**Spec:** `docs/superpowers/specs/2026-04-10-split-feedback-loop-design.md`

---

### Task 1: Add new DB tables

**Files:**
- Modify: `src/op-db.js:168-189` (SCHEMA constant)
- Test: `test/op-db.test.js`

- [ ] **Step 1: Add auto_evolves and daily_reviews tables to SCHEMA**

In `src/op-db.js`, add these two table definitions **after** the `insights` table block (keep `insights` for now — it will be removed in Task 10):

```sql
CREATE TABLE IF NOT EXISTS auto_evolves (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  target_type       TEXT NOT NULL,
  confidence        REAL DEFAULT 0.05,
  observation_count INTEGER DEFAULT 1,
  rejection_count   INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',
  promoted_to       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  promoted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_evolves_status ON auto_evolves(status);
CREATE INDEX IF NOT EXISTS idx_auto_evolves_target ON auto_evolves(target_type);

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
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `node --test test/op-db.test.js`
Expected: All 12 tests PASS. New tables are created silently via `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 3: Commit**

```bash
git add src/op-db.js
git commit -m "feat: add auto_evolves and daily_reviews tables to schema"
```

---

### Task 2: Auto-evolve core module (TDD)

**Files:**
- Create: `src/op-auto-evolve.js`
- Create: `test/op-auto-evolve.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/op-auto-evolve.test.js`:

```js
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-auto-evolve-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const TEST_LOG_DIR = path.join(TEST_DIR, 'logs');
const TEST_CL_DIR = path.join(TEST_DIR, 'cl', 'instincts');

describe('op-auto-evolve', () => {
  let db, autoEvolve;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    fs.mkdirSync(TEST_CL_DIR, { recursive: true });
    db = require('../src/op-db').createDb(TEST_DB);
    autoEvolve = require('../src/op-auto-evolve');
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- slugify --

  it('slugify converts title to kebab-case', () => {
    assert.equal(autoEvolve.slugify('Always Run Tests'), 'always-run-tests');
  });

  it('slugify caps at 60 chars', () => {
    const long = 'a'.repeat(100);
    assert.ok(autoEvolve.slugify(long).length <= 60);
  });

  // -- generateComponent --

  it('generateComponent returns markdown for rule type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'rule', title: 'Always lint', description: 'Run lint before commit',
    });
    assert.ok(content.includes('# Always lint'));
    assert.ok(content.includes('Run lint before commit'));
  });

  it('generateComponent returns YAML frontmatter for skill type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'skill', title: 'Deploy checklist', description: 'Steps to deploy',
    });
    assert.ok(content.includes('---'));
    assert.ok(content.includes('deploy-checklist'));
  });

  it('generateComponent returns markdown for knowledge type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'knowledge', title: 'Project uses Fastify', description: 'Not Express',
    });
    assert.ok(content.includes('# Project uses Fastify'));
  });

  // -- getComponentPath --

  it('getComponentPath returns correct path for each allowed type', () => {
    const rulePath = autoEvolve.getComponentPath('rule', 'always-lint');
    assert.ok(rulePath.endsWith(path.join('rules', 'always-lint.md')));

    const skillPath = autoEvolve.getComponentPath('skill', 'deploy');
    assert.ok(skillPath.includes(path.join('skills', 'deploy')));

    const knowledgePath = autoEvolve.getComponentPath('knowledge', 'facts');
    assert.ok(knowledgePath.endsWith(path.join('knowledge', 'facts.md')));
  });

  // -- syncInstincts --

  it('syncInstincts upserts new instinct into auto_evolves', () => {
    const yaml = [
      '---',
      'name: always-test',
      'description: Always run tests before commit',
      'type: rule',
      'confidence: 0.1',
      'seen_count: 3',
      '---',
      '',
      'Always run tests before committing changes.',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'always-test.md'), yaml);

    autoEvolve.syncInstincts(db, TEST_CL_DIR);

    const rows = db.prepare('SELECT * FROM auto_evolves').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'always-test');
    assert.equal(rows[0].target_type, 'rule');
    assert.equal(rows[0].observation_count, 3);
  });

  it('syncInstincts increments confidence when observation_count grows', () => {
    const yaml = [
      '---',
      'name: always-test',
      'description: Always run tests before commit',
      'type: rule',
      'confidence: 0.2',
      'seen_count: 5',
      '---',
      '',
      'Always run tests before committing changes.',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'always-test.md'), yaml);

    autoEvolve.syncInstincts(db, TEST_CL_DIR);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE title = ?').get('always-test');
    assert.equal(row.observation_count, 5);
    assert.ok(row.confidence > 0.1);
  });

  it('syncInstincts skips blacklisted target_types', () => {
    const yaml = [
      '---',
      'name: auto-format-hook',
      'description: Format on save',
      'type: hook',
      'confidence: 0.5',
      'seen_count: 10',
      '---',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'auto-format-hook.md'), yaml);

    const countBefore = db.prepare('SELECT COUNT(*) as c FROM auto_evolves').get().c;
    autoEvolve.syncInstincts(db, TEST_CL_DIR, ['agent', 'hook']);
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM auto_evolves').get().c;

    assert.equal(countAfter, countBefore);
  });

  // -- runAutoEvolve --

  it('runAutoEvolve promotes when confidence >= threshold', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-promote-1', 'Use strict mode', 'Always use strict', 'rule', 0.90, 20, 0, 'active', datetime('now'))
    `).run();

    const result = autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['agent', 'hook'],
      logDir: TEST_LOG_DIR,
    });

    assert.equal(result.promoted, 1);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-promote-1');
    assert.equal(row.status, 'promoted');
    assert.ok(row.promoted_to);
    assert.ok(fs.existsSync(row.promoted_to));
  });

  it('runAutoEvolve skips when confidence < threshold', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-skip-1', 'Maybe lint', 'Consider linting', 'rule', 0.5, 5, 0, 'active', datetime('now'))
    `).run();

    autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['agent', 'hook'],
      logDir: TEST_LOG_DIR,
    });

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-skip-1');
    assert.equal(row.status, 'active');
  });

  it('runAutoEvolve writes to log file', () => {
    const logPath = path.join(TEST_LOG_DIR, 'auto-evolve.log');
    assert.ok(fs.existsSync(logPath));
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('PROMOTED'));
    assert.ok(content.includes('Use strict mode'));
  });

  it('runAutoEvolve does not promote blacklisted types', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-agent-1', 'Code reviewer agent', 'Reviews code', 'agent', 0.95, 30, 0, 'active', datetime('now'))
    `).run();

    autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['agent', 'hook'],
      logDir: TEST_LOG_DIR,
    });

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-agent-1');
    assert.equal(row.status, 'active');
  });

  // -- revertAutoEvolve --

  it('revertAutoEvolve deletes file and updates status', () => {
    const promoted = db.prepare(
      "SELECT * FROM auto_evolves WHERE status = 'promoted' LIMIT 1"
    ).get();
    assert.ok(promoted, 'Need a promoted row from earlier test');

    autoEvolve.revertAutoEvolve(db, promoted.id);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(promoted.id);
    assert.equal(row.status, 'reverted');
    assert.ok(!fs.existsSync(promoted.promoted_to));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-auto-evolve.test.js`
Expected: FAIL — `Cannot find module '../src/op-auto-evolve'`

- [ ] **Step 3: Implement op-auto-evolve.js**

Create `src/op-auto-evolve.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function makeId(title, targetType) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${targetType}`)
    .digest('hex')
    .substring(0, 16);
  return `ae-${hash}`;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, self-contained)
// ---------------------------------------------------------------------------

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) ||
        (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Component path + content generation
// ---------------------------------------------------------------------------

function getComponentPath(targetType, name) {
  const slug = slugify(name);
  const claudeDir = getClaudeDir();

  switch (targetType) {
    case 'rule':      return path.join(claudeDir, 'rules', `${slug}.md`);
    case 'skill':     return path.join(claudeDir, 'skills', slug, 'SKILL.md');
    case 'knowledge': return path.join(claudeDir, 'knowledge', `${slug}.md`);
    default:          return path.join(claudeDir, 'rules', `${slug}.md`);
  }
}

function generateComponent(insight) {
  const { target_type, title, description } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

    case 'skill':
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${title}`,
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    default:
      return `# ${title}\n\n${description}\n`;
  }
}

// ---------------------------------------------------------------------------
// Instinct sync: YAML files -> auto_evolves table
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
  INSERT INTO auto_evolves
    (id, title, description, target_type, confidence, observation_count, status, created_at, updated_at)
  VALUES
    (@id, @title, @description, @target_type, @confidence, @observation_count, 'active', @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    observation_count = @observation_count,
    confidence = MIN(0.95, auto_evolves.confidence + 0.15),
    description = @description,
    updated_at = @updated_at
  WHERE @observation_count > auto_evolves.observation_count
`;

function syncInstincts(db, instinctDir, blacklist = ['agent', 'hook']) {
  if (!fs.existsSync(instinctDir)) return 0;

  const files = fs.readdirSync(instinctDir).filter(f => f.endsWith('.md'));
  const stmt = db.prepare(UPSERT_SQL);
  let synced = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(instinctDir, file), 'utf8');
    const meta = parseYamlFrontmatter(content);
    if (!meta || !meta.name) continue;

    const targetType = meta.type || null;
    if (!targetType || blacklist.includes(targetType)) continue;

    const now = new Date().toISOString();
    stmt.run({
      id: makeId(meta.name, targetType),
      title: meta.name,
      description: meta.description || '',
      target_type: targetType,
      confidence: parseFloat(meta.confidence) || 0.05,
      observation_count: parseInt(meta.seen_count, 10) || 1,
      created_at: now,
      updated_at: now,
    });
    synced++;
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Auto-promote cycle
// ---------------------------------------------------------------------------

function runAutoEvolve(db, opts = {}) {
  const {
    min_confidence = 0.85,
    blacklist = ['agent', 'hook'],
    logDir,
  } = opts;

  const allTypes = ['rule', 'knowledge', 'skill', 'agent', 'hook'];
  const allowed = allTypes.filter(t => !blacklist.includes(t));
  const placeholders = allowed.map(() => '?').join(',');

  const ready = db.prepare(`
    SELECT * FROM auto_evolves
    WHERE status = 'active'
      AND confidence >= ?
      AND rejection_count = 0
      AND target_type IN (${placeholders})
  `).all(min_confidence, ...allowed);

  let promoted = 0;

  for (const row of ready) {
    try {
      const filePath = getComponentPath(row.target_type, row.title);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, generateComponent(row), 'utf8');

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE auto_evolves
        SET status = 'promoted', promoted_to = ?, promoted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(filePath, now, now, row.id);

      if (logDir) {
        const logPath = path.join(logDir, 'auto-evolve.log');
        const logLine = `[${now}] PROMOTED ${row.target_type} "${row.title}" -> ${filePath}\n`;
        fs.appendFileSync(logPath, logLine);
      }

      promoted++;
    } catch { /* skip individual failures */ }
  }

  return { promoted };
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

function revertAutoEvolve(db, id) {
  const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
  if (!row) throw new Error(`Auto-evolve not found: ${id}`);

  if (row.promoted_to && fs.existsSync(row.promoted_to)) {
    fs.unlinkSync(row.promoted_to);
    try {
      const dir = path.dirname(row.promoted_to);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  db.prepare(`
    UPDATE auto_evolves
    SET status = 'reverted', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

// ---------------------------------------------------------------------------
// Query helpers (self-contained, no shared code)
// ---------------------------------------------------------------------------

function queryAutoEvolves(db, opts = {}) {
  const { status, target_type, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (target_type) { conditions.push('target_type = ?'); params.push(target_type); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM auto_evolves ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM auto_evolves ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getAutoEvolve(db, id) {
  return db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
}

function getAutoEvolveStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM auto_evolves GROUP BY status ORDER BY count DESC'
  ).all();
  const byTargetType = db.prepare(
    'SELECT target_type, COUNT(*) as count FROM auto_evolves GROUP BY target_type ORDER BY count DESC'
  ).all();
  return { byStatus, byTargetType };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  slugify,
  makeId,
  getComponentPath,
  generateComponent,
  parseYamlFrontmatter,
  syncInstincts,
  runAutoEvolve,
  revertAutoEvolve,
  queryAutoEvolves,
  getAutoEvolve,
  getAutoEvolveStats,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-auto-evolve.test.js`
Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/op-auto-evolve.js test/op-auto-evolve.test.js
git commit -m "feat: add auto-evolve core module with TDD tests"
```

---

### Task 3: Auto-evolve API routes

**Files:**
- Create: `src/routes/auto-evolves.js`

- [ ] **Step 1: Create routes**

Create `src/routes/auto-evolves.js`:

```js
'use strict';

const {
  queryAutoEvolves, getAutoEvolve, getAutoEvolveStats, revertAutoEvolve,
} = require('../op-auto-evolve');

module.exports = async function autoEvolveRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply, parsePagination } = helpers;

  // GET /api/auto-evolves/stats — MUST be before /:id
  app.get('/api/auto-evolves/stats', (req, reply) => {
    reply.send(getAutoEvolveStats(db));
  });

  // GET /api/auto-evolves
  app.get('/api/auto-evolves', (req, reply) => {
    const { status, target_type } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryAutoEvolves(db, { status, target_type, page, per_page: perPage }));
  });

  // GET /api/auto-evolves/:id
  app.get('/api/auto-evolves/:id', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    reply.send(row);
  });

  // PUT /api/auto-evolves/:id/revert
  app.put('/api/auto-evolves/:id/revert', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    if (row.status !== 'promoted') return errorReply(reply, 400, 'Only promoted items can be reverted');
    revertAutoEvolve(db, req.params.id);
    reply.send(getAutoEvolve(db, req.params.id));
  });
};
```

- [ ] **Step 2: Verify route file is syntactically valid**

Run: `node -e "require('./src/routes/auto-evolves')"`
Expected: No errors (function exported).

- [ ] **Step 3: Commit**

```bash
git add src/routes/auto-evolves.js
git commit -m "feat: add auto-evolve API routes"
```

---

### Task 4: Daily review prompt template

**Files:**
- Create: `scripts/op-daily-review-prompt.md`

- [ ] **Step 1: Create prompt template**

Create `scripts/op-daily-review-prompt.md`:

````markdown
# Daily Review — {{date}}

You are a Claude Code setup advisor. Analyze the user's current configuration and work history against best practices, then suggest improvements.

## Work History Today
{{work_history_json}}

## Current Setup (Full Content)

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

## Best Practices Reference
{{claude_code_knowledge}}

## Instructions

Analyze the current setup against the best practices reference. Consider:
1. Are there redundant or conflicting rules/skills/agents?
2. Are there patterns in today's work history that suggest new rules or skills?
3. Are there components that should be merged, updated, or removed?
4. Are there missing components suggested by best practices?
5. Are there cost optimization opportunities based on model usage?

For each suggestion, return a JSON array (no other text):
```json
[
  {
    "category": "adoption|cleanup|agent_creation|update|optimization|integration|cost|security|refinement",
    "title": "Short descriptive title",
    "description": "Detailed description of what to do and why",
    "target_type": "rule|skill|agent|hook|knowledge",
    "action": "create|update|remove|merge",
    "confidence": 0.5,
    "reasoning": "Evidence-based reasoning for this suggestion"
  }
]
```

Rules:
- Maximum {{max_suggestions}} suggestions
- Confidence range: 0.1 (speculative) to 0.9 (strong evidence)
- Every suggestion must reference specific evidence from work history or setup content
- Do not suggest changes already handled by existing components
````

- [ ] **Step 2: Commit**

```bash
git add scripts/op-daily-review-prompt.md
git commit -m "feat: add daily review prompt template"
```

---

### Task 5: Daily review core module (TDD)

**Files:**
- Create: `scripts/op-daily-review.js`
- Create: `test/op-daily-review.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/op-daily-review.test.js`:

```js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-daily-review-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const REPO_DIR = path.join(__dirname, '..');

describe('op-daily-review', () => {
  let db, review;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'skills', 'test-skill'), { recursive: true });

    // Write sample component files
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'rules', 'test-rule.md'), '# Test Rule\n\nAlways test.');
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'agents', 'test-agent.md'), '---\nname: test\n---\nTest agent.');
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test\n---\nTest skill.');

    db = require('../src/op-db').createDb(TEST_DB);
    review = require('../scripts/op-daily-review');

    // Seed some events for today
    const today = new Date().toISOString();
    const stmtE = db.prepare(`
      INSERT INTO events (session_id, timestamp, event_type, name, detail, cost, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmtE.run('sess-1', today, 'tool_call', 'Read', 'Read file', 0.001, 100, 50);
    stmtE.run('sess-1', today, 'tool_call', 'Edit', 'Edit file', 0.002, 200, 100);
    stmtE.run('sess-1', today, 'skill_invoke', 'tdd-workflow', 'TDD', 0.01, 500, 300);

    const stmtS = db.prepare(`
      INSERT INTO sessions (session_id, started_at, model, cost, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmtS.run('sess-1', today, 'sonnet', 0.013, 800, 450);
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- collectWorkHistory --

  it('collectWorkHistory returns events for given date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = review.collectWorkHistory(db, today);
    assert.ok(history.events.length >= 3);
    assert.ok(history.sessions.length >= 1);
    assert.ok(typeof history.totalCost === 'number');
  });

  it('collectWorkHistory returns empty for future date', () => {
    const history = review.collectWorkHistory(db, '2099-01-01');
    assert.equal(history.events.length, 0);
  });

  // -- scanAllComponents --

  it('scanAllComponents reads rule, skill, agent files', () => {
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    assert.ok(components.rules.length >= 1);
    assert.ok(components.skills.length >= 1);
    assert.ok(components.agents.length >= 1);
    assert.ok(components.rules[0].content.includes('Test Rule'));
  });

  // -- loadBestPractices --

  it('loadBestPractices reads reference docs', () => {
    const practices = review.loadBestPractices(REPO_DIR);
    assert.ok(practices.length > 0, 'Should find at least one reference doc');
  });

  // -- buildPrompt --

  it('buildPrompt assembles template with all sections', () => {
    const history = review.collectWorkHistory(db, new Date().toISOString().slice(0, 10));
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    const practices = review.loadBestPractices(REPO_DIR);
    const prompt = review.buildPrompt(history, components, practices, {
      date: '2026-04-10',
      max_suggestions: 25,
    });
    assert.ok(prompt.includes('Daily Review'));
    assert.ok(prompt.includes('Work History Today'));
    assert.ok(prompt.includes('Rules'));
    assert.ok(prompt.includes('Best Practices'));
  });

  // -- parseSuggestions --

  it('parseSuggestions parses valid JSON array', () => {
    const output = JSON.stringify([{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Adopt TDD workflow',
      target_type: 'skill',
      action: 'create',
      confidence: 0.7,
      reasoning: 'User rarely runs tests first',
    }]);
    const result = review.parseSuggestions(output);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Use TDD');
  });

  it('parseSuggestions extracts JSON from markdown fences', () => {
    const output = 'Text\n```json\n[{"category":"cleanup","title":"Remove unused","description":"d","target_type":"rule","action":"remove","confidence":0.5,"reasoning":"r"}]\n```\nMore';
    const result = review.parseSuggestions(output);
    assert.equal(result.length, 1);
  });

  it('parseSuggestions returns empty array for invalid output', () => {
    const result = review.parseSuggestions('not json at all');
    assert.deepEqual(result, []);
  });

  // -- saveSuggestions --

  it('saveSuggestions inserts into daily_reviews table', () => {
    const suggestions = [{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Adopt TDD workflow',
      target_type: 'skill',
      action: 'create',
      confidence: 0.7,
      reasoning: 'Evidence',
    }];
    review.saveSuggestions(db, suggestions, '2026-04-10');

    const rows = db.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').all('2026-04-10');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].title, 'Use TDD');
    assert.equal(rows[0].status, 'pending');
  });

  it('saveSuggestions deduplicates by SHA-256 id', () => {
    const suggestions = [{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Updated description',
      target_type: 'skill',
      action: 'create',
      confidence: 0.8,
      reasoning: 'More evidence',
    }];
    review.saveSuggestions(db, suggestions, '2026-04-10');

    const rows = db.prepare("SELECT * FROM daily_reviews WHERE title = 'Use TDD' AND review_date = '2026-04-10'").all();
    assert.equal(rows.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-daily-review.test.js`
Expected: FAIL — `Cannot find module '../scripts/op-daily-review'`

- [ ] **Step 3: Implement op-daily-review.js**

Create `scripts/op-daily-review.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

// ---------------------------------------------------------------------------
// Phase 1: Collect work history
// ---------------------------------------------------------------------------

function collectWorkHistory(db, date) {
  const events = db.prepare(`
    SELECT event_type, name, detail, cost, tokens_in, tokens_out, timestamp
    FROM events
    WHERE DATE(timestamp) = ?
    ORDER BY timestamp ASC
  `).all(date);

  const sessions = db.prepare(`
    SELECT session_id, started_at, ended_at, model, cost, tokens_in, tokens_out
    FROM sessions
    WHERE DATE(started_at) = ?
    ORDER BY started_at ASC
  `).all(date);

  const totalCost = events.reduce((sum, e) => sum + (e.cost || 0), 0);

  return { events, sessions, totalCost };
}

// ---------------------------------------------------------------------------
// Phase 2: Scan all component files
// ---------------------------------------------------------------------------

function readDirFiles(dirPath, pattern = '.md') {
  if (!fs.existsSync(dirPath)) return [];
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        results.push({
          name: entry.name,
          path: skillFile,
          content: fs.readFileSync(skillFile, 'utf8'),
        });
      }
    } else if (entry.name.endsWith(pattern)) {
      results.push({
        name: entry.name.replace(pattern, ''),
        path: fullPath,
        content: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return results;
}

function scanAllComponents(claudeDir) {
  const dir = claudeDir || getClaudeDir();

  const rules = readDirFiles(path.join(dir, 'rules'));
  const knowledge = readDirFiles(path.join(dir, 'knowledge'));
  const skills = readDirFiles(path.join(dir, 'skills'));
  const agents = readDirFiles(path.join(dir, 'agents'));

  let hooks = [];
  const settingsPath = path.join(dir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      hooks = settings.hooks || [];
    } catch { /* ignore parse errors */ }
  }

  const memory = [];
  const projectsDir = path.join(dir, 'projects');
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memDir = path.join(projectsDir, proj.name, 'memory');
      if (fs.existsSync(memDir)) {
        memory.push(...readDirFiles(memDir));
      }
    }
  }

  let plugins = [];
  const pluginsPath = path.join(dir, 'plugins', 'installed_plugins.json');
  if (fs.existsSync(pluginsPath)) {
    try {
      plugins = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
    } catch { /* ignore */ }
  }

  return { rules, knowledge, skills, agents, hooks, memory, plugins };
}

// ---------------------------------------------------------------------------
// Phase 3: Load best practices
// ---------------------------------------------------------------------------

function loadBestPractices(repoDir) {
  const refDir = path.join(
    repoDir || REPO_DIR,
    'claude', 'skills', 'claude-code-knowledge', 'references'
  );
  if (!fs.existsSync(refDir)) return [];

  const results = [];
  const entries = fs.readdirSync(refDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    results.push({
      name: entry.name,
      content: fs.readFileSync(path.join(refDir, entry.name), 'utf8'),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Phase 4: Build prompt
// ---------------------------------------------------------------------------

function buildPrompt(history, components, practices, opts = {}) {
  const { date = new Date().toISOString().slice(0, 10), max_suggestions = 25 } = opts;

  const templatePath = path.join(__dirname, 'op-daily-review-prompt.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  const formatComponents = (items) =>
    items.map(c => `#### ${c.name}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');

  const replacements = {
    '{{date}}': date,
    '{{work_history_json}}': JSON.stringify({
      events: history.events.slice(0, 200),
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
    '{{claude_code_knowledge}}': practices.map(p => `### ${p.name}\n${p.content}`).join('\n\n'),
    '{{max_suggestions}}': String(max_suggestions),
  };

  for (const [key, val] of Object.entries(replacements)) {
    template = template.replaceAll(key, val);
  }

  return template;
}

// ---------------------------------------------------------------------------
// Phase 5: Parse + Save
// ---------------------------------------------------------------------------

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

function makeReviewId(title, date) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${date}`)
    .digest('hex')
    .substring(0, 16);
  return `dr-${hash}`;
}

function saveSuggestions(db, suggestions, reviewDate) {
  const stmt = db.prepare(`
    INSERT INTO daily_reviews
      (id, review_date, category, title, description, target_type, action, confidence, reasoning, status, created_at)
    VALUES
      (@id, @review_date, @category, @title, @description, @target_type, @action, @confidence, @reasoning, 'pending', @created_at)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      confidence = excluded.confidence,
      reasoning = excluded.reasoning
  `);

  const tx = db.transaction((rows) => {
    for (const s of rows) {
      stmt.run({
        id: makeReviewId(s.title, reviewDate),
        review_date: reviewDate,
        category: s.category || 'general',
        title: s.title,
        description: s.description || '',
        target_type: s.target_type || null,
        action: s.action || null,
        confidence: Math.min(1.0, Math.max(0.0, s.confidence || 0.5)),
        reasoning: s.reasoning || '',
        created_at: new Date().toISOString(),
      });
    }
  });
  tx(suggestions);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function writeReport(suggestions, history, reportDir, date) {
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

  const reportPath = path.join(dir, `${date}-daily-review.md`);
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

// ---------------------------------------------------------------------------
// Query helpers (self-contained)
// ---------------------------------------------------------------------------

function queryDailyReviews(db, opts = {}) {
  const { review_date, status, category, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (review_date) { conditions.push('review_date = ?'); params.push(review_date); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM daily_reviews ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM daily_reviews ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getDailyReview(db, id) {
  return db.prepare('SELECT * FROM daily_reviews WHERE id = ?').get(id);
}

function updateDailyReviewStatus(db, id, status) {
  db.prepare('UPDATE daily_reviews SET status = ? WHERE id = ?').run(status, id);
}

function getDailyReviewStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM daily_reviews GROUP BY status ORDER BY count DESC'
  ).all();
  const byCategory = db.prepare(
    'SELECT category, COUNT(*) as count FROM daily_reviews GROUP BY category ORDER BY count DESC'
  ).all();
  const byDate = db.prepare(
    'SELECT review_date, COUNT(*) as count FROM daily_reviews GROUP BY review_date ORDER BY review_date DESC LIMIT 30'
  ).all();
  return { byStatus, byCategory, byDate };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

async function runDailyReview(db, opts = {}) {
  const {
    date = new Date().toISOString().slice(0, 10),
    model = 'opus',
    timeout = 300000,
    max_suggestions = 25,
    reportDir,
    repoDir,
    claudeDir,
  } = opts;

  const history = collectWorkHistory(db, date);
  const components = scanAllComponents(claudeDir);
  const practices = loadBestPractices(repoDir);
  const prompt = buildPrompt(history, components, practices, { date, max_suggestions });

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
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], reportPath: null, error: err.message };
  }

  const suggestions = parseSuggestions(output).slice(0, max_suggestions);
  saveSuggestions(db, suggestions, date);
  const reportPath = writeReport(suggestions, history, reportDir, date);

  return { suggestions, reportPath };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { createDb } = require('../src/op-db');
  const DB_PATH = process.env.OPEN_PULSE_DB || path.join(REPO_DIR, 'open-pulse.db');

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
  } catch { /* use defaults */ }

  const db = createDb(DB_PATH);
  runDailyReview(db, {
    model: config.daily_review_model || 'opus',
    timeout: config.daily_review_timeout_ms || 300000,
    max_suggestions: config.daily_review_max_suggestions || 25,
  })
    .then(result => {
      console.log(`Daily review complete: ${result.suggestions.length} suggestions`);
      if (result.reportPath) console.log(`Report: ${result.reportPath}`);
      db.close();
    })
    .catch(err => {
      console.error('Daily review failed:', err);
      db.close();
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  collectWorkHistory,
  scanAllComponents,
  loadBestPractices,
  buildPrompt,
  parseSuggestions,
  saveSuggestions,
  writeReport,
  makeReviewId,
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  runDailyReview,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-daily-review.test.js`
Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/op-daily-review.js test/op-daily-review.test.js
git commit -m "feat: add daily review core module with TDD tests"
```

---

### Task 6: Daily review API routes

**Files:**
- Create: `src/routes/daily-reviews.js`

- [ ] **Step 1: Create routes**

Create `src/routes/daily-reviews.js`:

```js
'use strict';

const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus,
  getDailyReviewStats, runDailyReview,
} = require('../../scripts/op-daily-review');

module.exports = async function dailyReviewRoutes(app, opts) {
  const { db, helpers, config } = opts;
  const { errorReply, parsePagination } = helpers;

  // GET /api/daily-reviews/stats — MUST be before /:id
  app.get('/api/daily-reviews/stats', (req, reply) => {
    reply.send(getDailyReviewStats(db));
  });

  // GET /api/daily-reviews
  app.get('/api/daily-reviews', (req, reply) => {
    const { review_date, status, category } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryDailyReviews(db, { review_date, status, category, page, per_page: perPage }));
  });

  // GET /api/daily-reviews/:id
  app.get('/api/daily-reviews/:id', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    reply.send(row);
  });

  // PUT /api/daily-reviews/:id/accept
  app.put('/api/daily-reviews/:id/accept', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    updateDailyReviewStatus(db, req.params.id, 'accepted');
    reply.send(getDailyReview(db, req.params.id));
  });

  // PUT /api/daily-reviews/:id/dismiss
  app.put('/api/daily-reviews/:id/dismiss', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    updateDailyReviewStatus(db, req.params.id, 'dismissed');
    reply.send(getDailyReview(db, req.params.id));
  });

  // POST /api/daily-reviews/run
  app.post('/api/daily-reviews/run', async (req, reply) => {
    try {
      const result = await runDailyReview(db, {
        model: config.daily_review_model || 'opus',
        timeout: config.daily_review_timeout_ms || 300000,
        max_suggestions: config.daily_review_max_suggestions || 25,
      });
      reply.send(result);
    } catch (err) {
      return errorReply(reply, 500, err.message);
    }
  });
};
```

- [ ] **Step 2: Verify route file is syntactically valid**

Run: `node -e "require('./src/routes/daily-reviews')"`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/daily-reviews.js
git commit -m "feat: add daily review API routes"
```

---

### Task 7: Server wiring

**Files:**
- Modify: `src/op-server.js:1-18` (imports), `:84-98` (timers), `:146-149` (routes)
- Modify: `config.json`

- [ ] **Step 1: Add auto-evolve import and timer to op-server.js**

Add import at top of `src/op-server.js` (after the `runPromotionCheck` require on line 14):

```js
const { syncInstincts, runAutoEvolve } = require('./op-auto-evolve');
```

Add timer block after the existing promotion timer (after line ~98):

```js
    // Auto-evolve timer: sync instincts + auto-promote
    if (config.auto_evolve_enabled !== false) {
      const instinctDir = path.join(REPO_DIR, 'cl', 'instincts');
      const logDir = path.join(REPO_DIR, 'logs');
      timers.push(setInterval(() => {
        try {
          syncInstincts(db, instinctDir, config.auto_evolve_blacklist || ['agent', 'hook']);
          runAutoEvolve(db, {
            min_confidence: config.auto_evolve_min_confidence || 0.85,
            blacklist: config.auto_evolve_blacklist || ['agent', 'hook'],
            logDir,
          });
        } catch { /* non-critical */ }
      }, config.cl_sync_interval_ms || 60000));
    }
```

- [ ] **Step 2: Register new route plugins**

Add after the existing route registrations (line ~148, after `app.register(require('./routes/insights'), routeOpts);`):

```js
  app.register(require('./routes/auto-evolves'), routeOpts);
  app.register(require('./routes/daily-reviews'), routeOpts);
```

- [ ] **Step 3: Update config.json with new keys**

Add these keys to `config.json` (merge with existing):

```json
{
  "auto_evolve_enabled": true,
  "auto_evolve_blacklist": ["agent", "hook"],
  "auto_evolve_min_confidence": 0.85,
  "daily_review_enabled": true,
  "daily_review_model": "opus",
  "daily_review_timeout_ms": 300000,
  "daily_review_max_suggestions": 25
}
```

- [ ] **Step 4: Run existing server tests to verify no regression**

Run: `node --test test/op-server.test.js`
Expected: All existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/op-server.js config.json
git commit -m "feat: wire auto-evolve timer and daily-review routes into server"
```

---

### Task 8: Frontend — Auto-evolves UI

**Files:**
- Create: `public/modules/auto-evolves.js`

- [ ] **Step 1: Create auto-evolves UI module**

Create `public/modules/auto-evolves.js`:

```js
import { get, put } from './api.js';

function fmtTime(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, HH:mm');
}

function confidenceBar(score) {
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
  const bar = document.createElement('span');
  bar.className = 'confidence-bar';
  const fill = document.createElement('span');
  fill.className = 'confidence-fill';
  fill.style.width = pct + '%';
  fill.style.background = color;
  bar.appendChild(fill);
  return bar;
}

function statusBadge(status) {
  const colors = { active: 'var(--accent)', promoted: 'var(--success)', reverted: 'var(--danger)' };
  const span = document.createElement('span');
  span.className = 'badge';
  span.style.cssText = `background:${colors[status] || 'var(--text-muted)'}26;color:${colors[status] || 'var(--text-muted)'}`;
  span.textContent = status;
  return span;
}

function typeBadge(type) {
  const span = document.createElement('span');
  span.className = 'badge';
  span.textContent = type || 'unknown';
  return span;
}

async function renderStats(container) {
  const stats = await get('/auto-evolves/stats');
  const cards = document.createElement('div');
  cards.className = 'stats-grid';
  for (const { status, count } of (stats.byStatus || [])) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="stat-value">${count}</div><div class="stat-label">${status}</div>`;
    cards.appendChild(card);
  }
  container.appendChild(cards);
}

async function renderList(container, filterStatus) {
  const qs = filterStatus ? `?status=${filterStatus}` : '';
  const data = await get(`/auto-evolves${qs}`);

  if (!data.rows || data.rows.length === 0) {
    container.innerHTML = '<div class="empty-state">No auto-evolves yet</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>Title</th><th>Type</th><th>Confidence</th><th>Obs.</th><th>Status</th><th>Promoted</th><th>Actions</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const tdTitle = document.createElement('td');
    tdTitle.textContent = row.title;
    tr.appendChild(tdTitle);

    const tdType = document.createElement('td');
    tdType.appendChild(typeBadge(row.target_type));
    tr.appendChild(tdType);

    const tdConf = document.createElement('td');
    tdConf.appendChild(confidenceBar(row.confidence));
    tr.appendChild(tdConf);

    const tdObs = document.createElement('td');
    tdObs.textContent = row.observation_count;
    tr.appendChild(tdObs);

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(row.status));
    tr.appendChild(tdStatus);

    const tdPromoted = document.createElement('td');
    tdPromoted.textContent = fmtTime(row.promoted_at);
    tr.appendChild(tdPromoted);

    const tdActions = document.createElement('td');
    if (row.status === 'promoted') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-danger';
      btn.textContent = 'Revert';
      btn.onclick = async () => {
        await put(`/auto-evolves/${row.id}/revert`);
        mount(container.closest('#app'), {});
      };
      tdActions.appendChild(btn);
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export function mount(app, opts = {}) {
  app.textContent = '';

  const header = document.createElement('h2');
  header.textContent = 'Auto-evolve';
  app.appendChild(header);

  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  const filters = document.createElement('div');
  filters.className = 'filter-bar';
  for (const s of ['all', 'active', 'promoted', 'reverted']) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = s;
    btn.onclick = () => {
      listEl.textContent = '';
      renderList(listEl, s === 'all' ? '' : s);
    };
    filters.appendChild(btn);
  }
  app.appendChild(filters);

  const listEl = document.createElement('div');
  app.appendChild(listEl);
  renderList(listEl);
}

export function unmount() {}
```

- [ ] **Step 2: Commit**

```bash
git add public/modules/auto-evolves.js
git commit -m "feat: add auto-evolves frontend UI module"
```

---

### Task 9: Frontend — Daily Reviews UI + Router + Nav

**Files:**
- Create: `public/modules/daily-reviews.js`
- Modify: `public/modules/router.js`
- Modify: `public/index.html:820-829` (nav tabs)

- [ ] **Step 1: Create daily-reviews UI module**

Create `public/modules/daily-reviews.js`:

```js
import { get, put, post } from './api.js';

function categoryBadge(cat) {
  const colors = {
    adoption: '#00b894', cleanup: '#e17055', agent_creation: '#6c5ce7',
    update: '#fdcb6e', optimization: '#74b9ff', integration: '#a29bfe',
    cost: '#fd79a8', security: '#d63031', refinement: '#00cec9',
  };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[cat] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = cat || 'general';
  return span;
}

function actionBadge(action) {
  const colors = { create: '#00b894', update: '#fdcb6e', remove: '#e17055', merge: '#74b9ff' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[action] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px`;
  span.textContent = action || '\u2014';
  return span;
}

function statusBadge(status) {
  const colors = { pending: 'var(--warning)', accepted: 'var(--success)', dismissed: 'var(--text-muted)' };
  const span = document.createElement('span');
  span.className = 'badge';
  span.style.cssText = `background:${colors[status] || 'var(--text-muted)'}26;color:${colors[status] || 'var(--text-muted)'}`;
  span.textContent = status;
  return span;
}

async function renderStats(container) {
  const stats = await get('/daily-reviews/stats');
  const cards = document.createElement('div');
  cards.className = 'stats-grid';
  for (const { status, count } of (stats.byStatus || [])) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="stat-value">${count}</div><div class="stat-label">${status}</div>`;
    cards.appendChild(card);
  }
  container.appendChild(cards);
}

async function renderList(container, filterDate, filterStatus) {
  const params = new URLSearchParams();
  if (filterDate) params.set('review_date', filterDate);
  if (filterStatus) params.set('status', filterStatus);
  const qs = params.toString() ? `?${params}` : '';
  const data = await get(`/daily-reviews${qs}`);

  if (!data.rows || data.rows.length === 0) {
    container.innerHTML = '<div class="empty-state">No daily reviews yet</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>Date</th><th>Category</th><th>Title</th><th>Action</th><th>Target</th><th>Confidence</th><th>Status</th><th>Actions</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.textContent = row.review_date;
    tr.appendChild(tdDate);

    const tdCat = document.createElement('td');
    tdCat.appendChild(categoryBadge(row.category));
    tr.appendChild(tdCat);

    const tdTitle = document.createElement('td');
    if (row.reasoning) {
      const details = document.createElement('details');
      details.className = 'inline-details';
      const summary = document.createElement('summary');
      summary.textContent = row.title;
      details.appendChild(summary);
      const p = document.createElement('p');
      p.className = 'reasoning-text';
      p.textContent = row.reasoning;
      details.appendChild(p);
      tdTitle.appendChild(details);
    } else {
      tdTitle.textContent = row.title;
    }
    tr.appendChild(tdTitle);

    const tdAction = document.createElement('td');
    tdAction.appendChild(actionBadge(row.action));
    tr.appendChild(tdAction);

    const tdTarget = document.createElement('td');
    tdTarget.textContent = row.target_type || '\u2014';
    tr.appendChild(tdTarget);

    const tdConf = document.createElement('td');
    tdConf.textContent = row.confidence ? row.confidence.toFixed(2) : '\u2014';
    tr.appendChild(tdConf);

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(row.status));
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    if (row.status === 'pending') {
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn btn-sm btn-success';
      acceptBtn.textContent = 'Accept';
      acceptBtn.onclick = async () => {
        await put(`/daily-reviews/${row.id}/accept`);
        container.textContent = '';
        renderList(container, filterDate, filterStatus);
      };
      tdActions.appendChild(acceptBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-sm';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.marginLeft = '4px';
      dismissBtn.onclick = async () => {
        await put(`/daily-reviews/${row.id}/dismiss`);
        container.textContent = '';
        renderList(container, filterDate, filterStatus);
      };
      tdActions.appendChild(dismissBtn);
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export function mount(app, opts = {}) {
  app.textContent = '';

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
    runBtn.textContent = 'Running...';
    try {
      await post('/daily-reviews/run');
      mount(app, opts);
    } catch (err) {
      runBtn.textContent = 'Failed';
    }
  };
  header.appendChild(runBtn);
  app.appendChild(header);

  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = new Date().toISOString().slice(0, 10);
  filterBar.appendChild(dateInput);

  for (const s of ['all', 'pending', 'accepted', 'dismissed']) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = s;
    btn.onclick = () => {
      listEl.textContent = '';
      renderList(listEl, dateInput.value, s === 'all' ? '' : s);
    };
    filterBar.appendChild(btn);
  }
  app.appendChild(filterBar);

  const listEl = document.createElement('div');
  app.appendChild(listEl);
  renderList(listEl);

  dateInput.onchange = () => {
    listEl.textContent = '';
    renderList(listEl, dateInput.value);
  };
}

export function unmount() {}
```

- [ ] **Step 2: Update router.js — replace expert route with 2 new routes**

In `public/modules/router.js`, replace the `expert` entry in ROUTES:

```js
// Remove:
  expert: () => import('./expert.js'),

// Add:
  'auto-evolves': () => import('./auto-evolves.js'),
  'daily-reviews': () => import('./daily-reviews.js'),
```

Add to NO_PERIOD set:

```js
const NO_PERIOD = new Set(['settings', 'learning', 'knowledge', 'projects', 'auto-evolves', 'daily-reviews']);
```

- [ ] **Step 3: Update index.html nav — replace Expert tab**

In `public/index.html`, replace the Expert nav link (line ~827):

```html
<!-- Remove: -->
        <a href="#expert">Expert</a>

<!-- Add: -->
        <a href="#auto-evolves">Auto-evolve</a>
        <a href="#daily-reviews">Daily Review</a>
```

- [ ] **Step 4: Commit**

```bash
git add public/modules/daily-reviews.js public/modules/router.js public/index.html
git commit -m "feat: add daily-reviews UI and update nav/router"
```

---

### Task 10: Delete insights code

**Files:**
- Delete: `src/db/insights.js`, `src/routes/insights.js`, `public/modules/expert.js`, `public/modules/learning-suggestions.js`, `scripts/op-suggestion-agent.js`, `scripts/op-suggestion-prompt.md`, `test/op-suggestion-agent.test.js`
- Modify: `src/op-db.js`, `src/op-server.js`, `public/modules/learning.js`

- [ ] **Step 1: Delete files**

```bash
rm src/db/insights.js src/routes/insights.js public/modules/expert.js public/modules/learning-suggestions.js scripts/op-suggestion-agent.js scripts/op-suggestion-prompt.md test/op-suggestion-agent.test.js
```

- [ ] **Step 2: Remove insights table from SCHEMA in op-db.js**

In `src/op-db.js`, remove the entire `CREATE TABLE IF NOT EXISTS insights` block (lines 168-189) and its indexes. Add migration to drop old table:

```js
  db.exec('DROP TABLE IF EXISTS insights');
```

- [ ] **Step 3: Remove insights re-export from op-db.js**

In `src/op-db.js`, remove:

```js
const insights = require('./db/insights');
```

And remove `...insights,` from `module.exports`.

- [ ] **Step 4: Remove insights route + promotion timer from op-server.js**

Remove import:
```js
const { runPromotionCheck } = require('./op-promote');
```

Remove promotion timer (lines 96-98):
```js
    timers.push(setInterval(() => {
      try { runPromotionCheck(db); } catch { /* non-critical */ }
    }, config.cl_sync_interval_ms || 60000));
```

Remove route registration:
```js
  app.register(require('./routes/insights'), routeOpts);
```

- [ ] **Step 5: Update learning.js — remove suggestions section**

In `public/modules/learning.js`:

Remove suggestions from SECTIONS array (keep only instincts):
```js
const SECTIONS = [
  { key: 'instincts', label: 'Instincts' },
];
```

Remove suggestions loader:
```js
const loaders = {
  instincts: () => import('./learning-instincts.js'),
};
```

Update loadStats to remove suggestions API call:
```js
async function loadStats(statsEl) {
  try {
    var results = await Promise.all([
      get('/instincts?per_page=1'),
    ]);
    statsEl.innerHTML =
      '<div>Instincts: <span>' + results[0].total + '</span></div>';
  } catch(e) { statsEl.innerHTML = '<div>Stats unavailable</div>'; }
}
```

- [ ] **Step 6: Grep for remaining insights references**

Run: `grep -r "insights\|expert\.js\|suggestion-agent\|learning-suggestions" src/ public/ scripts/ test/ --include="*.js" --include="*.html" -l`

Fix any remaining references found.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All remaining tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove insights table and all related code

Replaced by independent auto_evolves and daily_reviews tables."
```

---

### Task 11: Install + gitignore + CLAUDE.md

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add reports/ to .gitignore**

Append to `.gitignore`:

```
reports/
```

- [ ] **Step 2: Update CLAUDE.md**

Update these sections in `CLAUDE.md`:
- **Database Schema**: Remove `insights` row, add `auto_evolves` and `daily_reviews` rows
- **API Endpoints**: Remove `/api/insights/*`, add `/api/auto-evolves/*` and `/api/daily-reviews/*`
- **Directory Structure**: Update file listing
- **Key Design Decisions**: Replace "Unified insights" with "Split flows" description
- **Data Flow**: Update for auto-evolve and daily review flows

- [ ] **Step 3: Run final verification**

```bash
npm test
node -e "const {createDb} = require('./src/op-db'); const db = createDb(':memory:'); console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name))"
```

Expected: Tables include `auto_evolves` and `daily_reviews`, no `insights`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: update CLAUDE.md for split feedback loop, add reports/ to gitignore"
```

---

## Parallel execution map

```
Task 1 (DB schema)
  |
  +-- Task 2 (auto-evolve core) --+-- Task 3 (AE routes)
  |                                |
  +-- Task 4 (prompt template) ----+-- Task 5 (daily review core) -- Task 6 (DR routes)
  |
  +-- Task 7 (server wiring) -- depends on Tasks 3, 6
  |
  +-- Task 8 (AE frontend) \
  |                          +-- can run in parallel
  +-- Task 9 (DR frontend) /
  |
  +-- Task 10 (delete insights) -- depends on all above
  |
  +-- Task 11 (gitignore + docs)
```

Tasks 2-3 and Tasks 4-6 can run **in parallel** (zero shared code).
Tasks 8-9 can run **in parallel** after Task 7.
