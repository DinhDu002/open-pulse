# Auto-Promote & Execute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-promote pipeline (insights → component files) and execute mechanism (spawn Claude or copy prompt) to complete the observe→learn→act loop.

**Architecture:** Server timer checks promotion threshold every 60s. Uses Haiku to generate component content. Revert deletes file + resets status. Execute spawns `claude --print` or returns copy-ready prompt.

**Tech Stack:** Node.js, better-sqlite3, node:test, child_process.spawn

---

### Task 1: Add promote DB functions + threshold query

**Files:**
- Modify: `src/db/insights.js` — add getPromotableInsights, markPromoted
- Modify: `test/op-db.test.js` — add tests

- [ ] **Step 1: Write failing tests**

Add to the `insights` describe block in `test/op-db.test.js`:

```javascript
it('getPromotableInsights returns insights meeting threshold', () => {
  const { upsertInsight, getPromotableInsights, updateInsightFeedback } = require('../src/db/insights');
  // Create insight meeting all criteria
  upsertInsight(db, {
    id: 'promo-ready', source: 'observer', category: 'workflow',
    target_type: 'rule', title: 'Always lint', description: 'Always run lint',
    confidence: 0.9,
  });
  // Set observation_count >= 10 via repeated upserts
  for (let i = 0; i < 9; i++) {
    upsertInsight(db, { id: 'promo-ready', source: 'observer', category: 'workflow',
      target_type: 'rule', title: 'Always lint', description: 'Always run lint', confidence: 0.9 });
  }
  const ready = getPromotableInsights(db);
  assert.ok(ready.some(r => r.id === 'promo-ready'));
});

it('getPromotableInsights excludes low confidence', () => {
  const { upsertInsight, getPromotableInsights } = require('../src/db/insights');
  upsertInsight(db, {
    id: 'promo-low', source: 'observer', category: 'workflow',
    target_type: 'rule', title: 'Low conf', description: 'test', confidence: 0.3,
  });
  const ready = getPromotableInsights(db);
  assert.ok(!ready.some(r => r.id === 'promo-low'));
});
```

- [ ] **Step 2: Implement**

Add to `src/db/insights.js`:

```javascript
function getPromotableInsights(db) {
  return db.prepare(`
    SELECT * FROM insights
    WHERE confidence >= 0.85
      AND observation_count >= 10
      AND rejection_count = 0
      AND target_type IS NOT NULL
      AND status = 'active'
  `).all();
}
```

Export it.

- [ ] **Step 3: Run tests, commit**

Run: `node --test test/op-db.test.js`

```bash
git add src/db/insights.js test/op-db.test.js
git commit -m "feat: add getPromotableInsights threshold query"
```

---

### Task 2: Create promote engine

**Files:**
- Create: `src/op-promote.js` — component generator + promote logic
- Test: `test/op-promote.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/op-promote.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-promote-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');

describe('op-promote', () => {
  let db, promote;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    db = require('../src/op-db').createDb(TEST_DB);
    promote = require('../src/op-promote');
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('generateComponentContent returns markdown for rule type', () => {
    const content = promote.generateComponentContent({
      target_type: 'rule', title: 'Always run lint', description: 'Run lint before commit', category: 'workflow',
    });
    assert.ok(content.includes('Always run lint'));
    assert.ok(content.includes('Run lint before commit'));
  });

  it('getComponentPath returns correct path for each target_type', () => {
    const rulePath = promote.getComponentPath('rule', 'always-lint');
    assert.ok(rulePath.includes('rules'));
    assert.ok(rulePath.endsWith('.md'));

    const skillPath = promote.getComponentPath('skill', 'deploy-checklist');
    assert.ok(skillPath.includes('skills'));

    const agentPath = promote.getComponentPath('agent', 'code-reviewer');
    assert.ok(agentPath.includes('agents'));
    assert.ok(agentPath.endsWith('.md'));
  });

  it('promoteInsight creates file and updates status', () => {
    const { upsertInsight, getInsight } = require('../src/db/insights');
    upsertInsight(db, {
      id: 'promote-test', source: 'observer', category: 'workflow',
      target_type: 'rule', title: 'Always test', description: 'Always run tests before committing',
      confidence: 0.9,
    });

    const result = promote.promoteInsight(db, 'promote-test');
    assert.ok(result.promoted_to);
    assert.ok(fs.existsSync(result.promoted_to));

    const updated = getInsight(db, 'promote-test');
    assert.equal(updated.status, 'promoted');
    assert.equal(updated.promoted_to, result.promoted_to);
  });

  it('revertInsight deletes file and updates status', () => {
    const { getInsight } = require('../src/db/insights');
    // promote-test was promoted in previous test
    const insight = getInsight(db, 'promote-test');
    assert.ok(insight.promoted_to);

    promote.revertInsight(db, 'promote-test');

    assert.ok(!fs.existsSync(insight.promoted_to));
    const reverted = getInsight(db, 'promote-test');
    assert.equal(reverted.status, 'reverted');
  });
});
```

- [ ] **Step 2: Implement promote engine**

Create `src/op-promote.js`:

```javascript
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getInsight, updateInsightStatus, getPromotableInsights } = require('./op-db');

const CLAUDE_DIR = process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function getComponentPath(targetType, name) {
  const slug = slugify(name);
  switch (targetType) {
    case 'rule':       return path.join(CLAUDE_DIR, 'rules', `${slug}.md`);
    case 'hook':       return path.join(CLAUDE_DIR, 'hooks', `${slug}.sh`);
    case 'skill':      return path.join(CLAUDE_DIR, 'skills', slug, 'SKILL.md');
    case 'agent':      return path.join(CLAUDE_DIR, 'agents', `${slug}.md`);
    case 'knowledge':  return path.join(CLAUDE_DIR, 'knowledge', `${slug}.md`);
    default:           return path.join(CLAUDE_DIR, 'rules', `${slug}.md`);
  }
}

function generateComponentContent(insight) {
  const { target_type, title, description, category, confidence } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

    case 'hook':
      return `#!/bin/bash\n# Hook: ${title}\n# Category: ${category}\n# Auto-promoted from insight (confidence: ${confidence})\n\n# ${description}\nexit 0\n`;

    case 'skill':
      return `---\nname: ${slugify(title)}\ndescription: ${title}\n---\n\n${description}\n`;

    case 'agent':
      return `---\nname: ${slugify(title)}\ndescription: ${title}\nmodel: haiku\n---\n\n${description}\n`;

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    default:
      return `# ${title}\n\n${description}\n`;
  }
}

function promoteInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight || !insight.target_type) throw new Error('Insight not found or no target_type');

  const filePath = getComponentPath(insight.target_type, insight.title);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, generateComponentContent(insight), 'utf8');

  updateInsightStatus(db, insightId, 'promoted', filePath);
  return { promoted_to: filePath };
}

function revertInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error('Insight not found');

  if (insight.promoted_to && fs.existsSync(insight.promoted_to)) {
    fs.unlinkSync(insight.promoted_to);
    // Clean up empty parent dirs
    const dir = path.dirname(insight.promoted_to);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* non-critical */ }
  }

  updateInsightStatus(db, insightId, 'reverted', null);
  // Lower confidence so it doesn't auto-promote again
  const { updateInsightFeedback } = require('./op-db');
  updateInsightFeedback(db, insightId, 'reject');
}

function runPromotionCheck(db) {
  const ready = getPromotableInsights(db);
  let promoted = 0;
  for (const insight of ready) {
    try {
      promoteInsight(db, insight.id);
      promoted++;
    } catch { /* skip individual failures */ }
  }
  return promoted;
}

module.exports = {
  getComponentPath,
  generateComponentContent,
  promoteInsight,
  revertInsight,
  runPromotionCheck,
  slugify,
};
```

- [ ] **Step 3: Run tests, commit**

Run: `node --test test/op-promote.test.js`

```bash
git add src/op-promote.js test/op-promote.test.js
git commit -m "feat: add promote engine with component generation and revert"
```

---

### Task 3: Wire promote timer + revert API

**Files:**
- Modify: `src/op-server.js` — add promote timer
- Modify: `src/routes/insights.js` — add revert endpoint
- Test: `test/op-server.test.js`

- [ ] **Step 1: Add revert endpoint to insights routes**

In `src/routes/insights.js`, add before the DELETE route:

```javascript
// PUT /api/insights/:id/revert
app.put('/api/insights/:id/revert', (req, reply) => {
  const existing = getInsight(db, req.params.id);
  if (!existing) return errorReply(reply, 404, 'Insight not found');
  if (existing.status !== 'promoted') return errorReply(reply, 400, 'Only promoted insights can be reverted');
  const { revertInsight } = require('../op-promote');
  revertInsight(db, req.params.id);
  reply.send(getInsight(db, req.params.id));
});
```

- [ ] **Step 2: Add promote timer to op-server.js**

In `src/op-server.js`, import and add timer alongside existing CL sync timer:

```javascript
const { runPromotionCheck } = require('./op-promote');
```

In the timers section (where CL sync timer is), add:

```javascript
// Promote check: run alongside CL sync
timers.push(setInterval(() => {
  try { runPromotionCheck(db); } catch { /* non-critical */ }
}, config.cl_sync_interval_ms || 60000));
```

- [ ] **Step 3: Write test for revert endpoint**

Add to `test/op-server.test.js` insights API describe block:

```javascript
it('PUT /api/insights/:id/revert reverts promoted insight', async () => {
  const { upsertInsight, updateInsightStatus } = require('../src/db/insights');
  upsertInsight(db, { id: 'revert-test', source: 'observer', category: 'workflow',
    target_type: 'rule', title: 'Revert me', description: 'test', confidence: 0.9 });
  updateInsightStatus(db, 'revert-test', 'promoted', '/tmp/fake-file.md');

  const res = await app.inject({ method: 'PUT', url: '/api/insights/revert-test/revert' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'reverted');
});

it('PUT /api/insights/:id/revert rejects non-promoted', async () => {
  const { upsertInsight } = require('../src/db/insights');
  upsertInsight(db, { id: 'revert-fail', source: 'observer', category: 'workflow',
    target_type: 'rule', title: 'Not promoted', description: 'test', confidence: 0.5 });

  const res = await app.inject({ method: 'PUT', url: '/api/insights/revert-fail/revert' });
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test`

```bash
git add src/routes/insights.js src/op-server.js test/op-server.test.js
git commit -m "feat: wire promote timer and revert API endpoint"
```

---

### Task 4: Add execute and generate-prompt endpoints

**Files:**
- Create: `src/op-execute.js` — execute logic
- Modify: `src/routes/insights.js` — add execute + generate-prompt endpoints
- Test: `test/op-server.test.js`

- [ ] **Step 1: Create execute module**

Create `src/op-execute.js`:

```javascript
'use strict';

const { spawn } = require('child_process');
const { getInsight, updateInsightStatus, updateInsightActionData } = require('./op-db');

function executeInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error('Insight not found');

  let actionData;
  try { actionData = typeof insight.action_data === 'string' ? JSON.parse(insight.action_data) : insight.action_data; }
  catch { actionData = {}; }

  const prompt = (actionData && actionData.claude_prompt) || insight.description;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--model', 'sonnet', '--max-turns', '3', '--print'], {
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SKIP_COLLECT: '1' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      const result = { exit_code: code, output: stdout.trim(), error: stderr.trim() };

      // Update action_data with execution result
      const newActionData = { ...(actionData || {}), execution_result: result };
      updateInsightActionData(db, insightId, newActionData);
      updateInsightStatus(db, insightId, 'executed', insight.promoted_to);

      resolve(result);
    });

    child.on('error', (err) => {
      reject(new Error('Failed to spawn claude: ' + err.message));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function generatePrompt(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error('Insight not found');

  const prompt = `Based on this insight, generate a ready-to-use Claude Code prompt.

Insight: ${insight.title}
Description: ${insight.description}
Category: ${insight.category}
Target: ${insight.target_type || 'not classified'}

Generate a structured response with:
1. A clear, actionable prompt for Claude Code
2. Implementation steps (numbered list)
3. What files would change

Format as JSON: {"claude_prompt": "...", "implementation_steps": ["..."], "what_changes": ["..."]}`;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SKIP_COLLECT: '1' },
    });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return reject(new Error('Prompt generation failed'));
      }

      // Try to parse JSON from output
      let actionData;
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        actionData = jsonMatch ? JSON.parse(jsonMatch[0]) : { claude_prompt: stdout.trim() };
      } catch {
        actionData = { claude_prompt: stdout.trim() };
      }

      updateInsightActionData(db, insightId, actionData);
      resolve(actionData);
    });

    child.on('error', (err) => reject(new Error('Failed to spawn claude: ' + err.message)));

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = { executeInsight, generatePrompt };
```

- [ ] **Step 2: Add API endpoints**

In `src/routes/insights.js`, add before DELETE:

```javascript
// POST /api/insights/:id/execute
app.post('/api/insights/:id/execute', async (req, reply) => {
  const existing = getInsight(db, req.params.id);
  if (!existing) return errorReply(reply, 404, 'Insight not found');
  try {
    const { executeInsight } = require('../op-execute');
    const result = await executeInsight(db, req.params.id);
    reply.send(result);
  } catch (err) {
    return errorReply(reply, 500, err.message);
  }
});

// POST /api/insights/:id/generate-prompt
app.post('/api/insights/:id/generate-prompt', async (req, reply) => {
  const existing = getInsight(db, req.params.id);
  if (!existing) return errorReply(reply, 404, 'Insight not found');
  try {
    const { generatePrompt } = require('../op-execute');
    const result = await generatePrompt(db, req.params.id);
    reply.send(result);
  } catch (err) {
    return errorReply(reply, 500, err.message);
  }
});
```

- [ ] **Step 3: Write tests**

Add to `test/op-server.test.js`:

```javascript
it('POST /api/insights/:id/execute returns 404 for missing', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/insights/nonexistent/execute' });
  assert.equal(res.statusCode, 404);
});

it('POST /api/insights/:id/generate-prompt returns 404 for missing', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/insights/nonexistent/generate-prompt' });
  assert.equal(res.statusCode, 404);
});
```

Note: Full integration tests for execute/generate-prompt require the `claude` CLI to be available. The 404 tests verify routing works without needing the CLI.

- [ ] **Step 4: Run tests, commit**

Run: `node --test`

```bash
git add src/op-execute.js src/routes/insights.js test/op-server.test.js
git commit -m "feat: add execute and generate-prompt endpoints"
```

---

### Task 5: Update frontend for promote/execute/revert

**Files:**
- Modify: `public/modules/learning-insights.js` — add execute dropdown, revert button, promote badge

- [ ] **Step 1: Update detail view**

In `public/modules/learning-insights.js`, update `renderDetail` to add:

1. **Execute dropdown** (only when action_data has claude_prompt OR description exists):
   - "Auto Execute" button → calls `POST /api/insights/:id/execute`, shows result
   - "Copy Prompt" button → copies claude_prompt to clipboard

2. **Revert button** (only when status === 'promoted'):
   - Calls `PUT /api/insights/:id/revert`, reloads detail

3. **Generate Prompt button** (only when no action_data):
   - Calls `POST /api/insights/:id/generate-prompt`, reloads detail

4. **Promoted badge** — show promoted_to path when status is 'promoted'

- [ ] **Step 2: Verify manually**

Start server, navigate to an insight detail page, verify buttons render correctly.

- [ ] **Step 3: Commit**

```bash
git add public/modules/learning-insights.js
git commit -m "feat: add execute/revert/generate-prompt to insights UI"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 2: Integration test**

```bash
npm run reset-db
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/insights | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'total: {d[\"total\"]}')"
curl -s http://127.0.0.1:3827/api/insights/stats
kill %1
```

- [ ] **Step 3: Update CLAUDE.md with new endpoints**

Add to API table:
- `PUT /api/insights/:id/revert`
- `POST /api/insights/:id/execute`
- `POST /api/insights/:id/generate-prompt`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final verification for promote + execute pipeline"
```
