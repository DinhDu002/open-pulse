# Auto-Evolve Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the auto-evolve subsystem in three stages — verify existing rule promotion, fix `generateComponent()` for skill/agent, then build the missing observer as a standalone hourly launchd service using Haiku for pattern detection.

**Architecture:** Stage A is manual verification (no code). Stage B adds one new case to `generateComponent()` and manually validates skill+agent promotion. Stage C builds `src/evolve/observer.js` as a CLI script triggered by launchd, reusing `execFileSync` stdin-based Claude invocation pattern from `src/review/pipeline.js`, the generic `kg_sync_state` KV store for per-project cursor tracking, and the existing `pipeline_runs` table for cost/error telemetry. Agents are blacklisted from auto-promotion and surfaced via a new manual-promote endpoint + UI button.

**Tech Stack:** Node.js (CommonJS), better-sqlite3, Fastify 5, vanilla JS ES modules, Claude CLI (`claude` binary) with Haiku 4.5, macOS launchd.

**Spec:** `docs/superpowers/specs/2026-04-12-auto-evolve-activation-design.md`

**Total tasks:** 18

---

## Stage A — Verify rule promotion (manual, no code changes)

### Task 1: Verify rule promotion lifecycle end-to-end

**Files:**
- Create: `cl/instincts/personal/test-verify-rule-promotion.md` (will be deleted at end of task)

- [ ] **Step 1: Create test instinct YAML file**

Create file `cl/instincts/personal/test-verify-rule-promotion.md` with this exact content:

```yaml
---
id: test-verify-rule-promotion
name: Test Verify Rule Promotion
description: Placeholder rule to verify auto-evolve rule promotion flow
type: rule
confidence: 0.9
seen_count: 20
source: manual-test
scope: global
---

Placeholder rule body. Safe to delete after verification.
```

- [ ] **Step 2: Wait for server sync cycle (60 seconds) or restart server**

Option A — wait for timer: `sleep 70` (60s sync + 10s margin).
Option B — restart server: `launchctl bootout gui/$(id -u)/com.open-pulse && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.open-pulse.plist`

- [ ] **Step 3: Verify DB row promoted**

Run:
```bash
sqlite3 open-pulse.db "SELECT id, title, status, confidence, promoted_at, promoted_to FROM auto_evolves WHERE title = 'Test Verify Rule Promotion'"
```

Expected: one row with `status=promoted`, `promoted_at` not null, `promoted_to` = path ending in `rules/test-verify-rule-promotion.md`.

- [ ] **Step 4: Verify file exists in ~/.claude/rules/**

Run:
```bash
cat ~/.claude/rules/test-verify-rule-promotion.md
```

Expected output:
```
# Test Verify Rule Promotion

Placeholder rule body. Safe to delete after verification.
```

- [ ] **Step 5: Verify auto-evolve log entry**

Run:
```bash
grep "Test Verify Rule Promotion" logs/auto-evolve.log
```

Expected: one line containing `PROMOTED rule "Test Verify Rule Promotion" -> /Users/du/.claude/rules/test-verify-rule-promotion.md`.

- [ ] **Step 6: Verify UI detail view**

Open `http://127.0.0.1:3827/#auto-evolves` in browser. Click the "Test Verify Rule Promotion" row. Verify the detail view shows: title, promoted badge, confidence 90%, observation count 20, promoted_at timestamp, promoted_to path, and a "Revert" button.

- [ ] **Step 7: Click Revert button and verify file deleted**

Click "Revert" in UI. After page reloads:
```bash
ls ~/.claude/rules/test-verify-rule-promotion.md 2>&1
```

Expected: `No such file or directory`.

```bash
sqlite3 open-pulse.db "SELECT status FROM auto_evolves WHERE title = 'Test Verify Rule Promotion'"
```

Expected: `reverted`.

- [ ] **Step 8: Cleanup test instinct YAML and stale DB row**

```bash
rm cl/instincts/personal/test-verify-rule-promotion.md
sqlite3 open-pulse.db "DELETE FROM auto_evolves WHERE title = 'Test Verify Rule Promotion'"
```

- [ ] **Step 9: Verify cleanup complete**

```bash
ls cl/instincts/personal/test-verify-rule-promotion.md 2>&1 | head -1
sqlite3 open-pulse.db "SELECT COUNT(*) FROM auto_evolves WHERE title = 'Test Verify Rule Promotion'"
```

Expected: file `No such file`, count `0`.

- [ ] **Step 10: No commit needed (no code changes)**

Stage A is pure verification. Proceed to Stage B.

---

## Stage B — Fix generateComponent + verify skill/agent

### Task 2: Write failing test for `agent` case in generateComponent

**Files:**
- Modify: `test/evolve/promote.test.js`

- [ ] **Step 1: Add test case for agent type after the existing skill test**

Find the test block starting with `it('generateComponent returns YAML frontmatter for skill type', ...)` in `test/evolve/promote.test.js`. Add these two new tests immediately after it:

```js
  it('generateComponent returns YAML frontmatter for agent type', () => {
    const content = promote.generateComponent({
      target_type: 'agent',
      title: 'Test Runner',
      description: 'Runs the project test suite and reports failures',
    });
    assert.ok(content.startsWith('---\n'), 'must start with YAML frontmatter');
    assert.ok(content.includes('name: test-runner'), 'must have slugified name');
    assert.ok(content.includes('description: Runs the project test suite and reports failures'));
    assert.ok(content.includes('model: sonnet'), 'must have default model');
    assert.ok(content.includes('Runs the project test suite and reports failures'), 'must include body');
  });

  it('generateComponent agent description caps at 200 chars and uses first line', () => {
    const longDesc = 'First line of description.\nSecond line that should not appear in frontmatter.\n' + 'x'.repeat(300);
    const content = promote.generateComponent({
      target_type: 'agent',
      title: 'Long Desc',
      description: longDesc,
    });
    // Frontmatter description should be the first line only
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'frontmatter must exist');
    const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
    assert.ok(descLine.length <= 'description: '.length + 200, 'description line capped at 200 chars');
    assert.ok(descLine.includes('First line of description'));
    assert.ok(!descLine.includes('Second line'), 'second line must not leak into frontmatter');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/evolve/promote.test.js 2>&1 | grep -A 2 "agent"
```

Expected: tests fail because `generateComponent` default case produces `# Test Runner\n\n...` with no YAML frontmatter. Error like `must start with YAML frontmatter`.

- [ ] **Step 3: Do not commit yet**

Tests failing is expected. Proceed to Task 3 to implement.

---

### Task 3: Implement `agent` case in `generateComponent`

**Files:**
- Modify: `src/evolve/promote.js:12-36`

- [ ] **Step 1: Add case 'agent' before default branch**

Open `src/evolve/promote.js`. Find the `generateComponent` function. Insert a new `case 'agent':` block between the `case 'knowledge':` and the `default:` branches. Replace lines 30-35 (the `case 'knowledge'` and `default` branches) with:

```js
    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    case 'agent': {
      const firstLine = (description || title).split('\n')[0].slice(0, 200);
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${firstLine}`,
        'model: sonnet',
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');
    }

    default:
      return `# ${title}\n\n${description}\n`;
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
node --test test/evolve/promote.test.js
```

Expected: all tests pass, including the two new agent tests.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
npm test
```

Expected: all tests pass (exit code 0).

- [ ] **Step 4: Commit**

```bash
git add src/evolve/promote.js test/evolve/promote.test.js
git commit -m "feat: add agent case to generateComponent with valid frontmatter"
```

---

### Task 4: Manually verify skill instinct promotion lifecycle

**Files:**
- Create: `cl/instincts/personal/test-auto-evolve-skill.md` (will be deleted)

- [ ] **Step 1: Create skill test instinct**

```yaml
# cl/instincts/personal/test-auto-evolve-skill.md
---
id: test-auto-evolve-skill
name: test-auto-evolve-skill
description: Test skill created to verify auto-evolve skill promotion path
type: skill
confidence: 0.9
seen_count: 10
source: manual-test
scope: global
---

Placeholder skill body for auto-evolve pipeline testing. Safe to delete.
```

Note: `name` uses kebab-case `test-auto-evolve-skill` (not "Test Auto Evolve Skill") so the slugified path is predictable.

- [ ] **Step 2: Wait 70s for sync timer or restart server**

```bash
sleep 70
```

- [ ] **Step 3: Verify file created at correct path**

```bash
cat ~/.claude/skills/test-auto-evolve-skill/SKILL.md
```

Expected: file exists with YAML frontmatter (`name: test-auto-evolve-skill`, `description: test-auto-evolve-skill`) and body.

- [ ] **Step 4: Verify frontmatter is valid**

```bash
head -5 ~/.claude/skills/test-auto-evolve-skill/SKILL.md
```

Expected output:
```
---
name: test-auto-evolve-skill
description: test-auto-evolve-skill
---

```

- [ ] **Step 5: Verify DB row**

```bash
sqlite3 open-pulse.db "SELECT title, status, target_type, promoted_to FROM auto_evolves WHERE target_type = 'skill' AND title = 'test-auto-evolve-skill'"
```

Expected: status=`promoted`, promoted_to = path ending in `skills/test-auto-evolve-skill/SKILL.md`.

- [ ] **Step 6: Revert via UI**

Navigate to `#auto-evolves`, click the test-auto-evolve-skill row, click "Revert".

- [ ] **Step 7: Verify skill directory removed**

```bash
ls ~/.claude/skills/test-auto-evolve-skill 2>&1
```

Expected: `No such file or directory`.

Note: `revertAutoEvolve` should delete the `SKILL.md` file. If the parent directory remains empty, verify whether the current revert logic cleans it up. If the parent directory persists, this is not a regression — just document the observation for Stage C cleanup work.

- [ ] **Step 8: Cleanup YAML**

```bash
rm cl/instincts/personal/test-auto-evolve-skill.md
sqlite3 open-pulse.db "DELETE FROM auto_evolves WHERE title = 'test-auto-evolve-skill'"
# Cleanup empty parent dir if revert left it behind
rmdir ~/.claude/skills/test-auto-evolve-skill 2>/dev/null || true
```

- [ ] **Step 9: No commit (manual verification only)**

---

### Task 5: Manually verify agent instinct promotion lifecycle

**IMPORTANT:** This task must run **before** Task 14 (config.json update that blacklists agents). Otherwise auto-promote will not fire for agents.

**Files:**
- Create: `cl/instincts/personal/test-auto-evolve-agent.md` (will be deleted)

- [ ] **Step 1: Create agent test instinct**

```yaml
# cl/instincts/personal/test-auto-evolve-agent.md
---
id: test-auto-evolve-agent
name: test-auto-evolve-agent
description: Test agent created to verify auto-evolve agent promotion path
type: agent
confidence: 0.9
seen_count: 10
source: manual-test
scope: global
---

Placeholder agent body for auto-evolve pipeline testing. Safe to delete.
```

- [ ] **Step 2: Wait 70s for sync timer**

```bash
sleep 70
```

- [ ] **Step 3: Verify file created with valid frontmatter**

```bash
cat ~/.claude/agents/test-auto-evolve-agent.md
```

Expected output:
```
---
name: test-auto-evolve-agent
description: Placeholder agent body for auto-evolve pipeline testing. Safe to delete.
model: sonnet
---

Placeholder agent body for auto-evolve pipeline testing. Safe to delete.
```

- [ ] **Step 4: Verify DB row**

```bash
sqlite3 open-pulse.db "SELECT title, status, target_type, promoted_to FROM auto_evolves WHERE target_type = 'agent'"
```

Expected: status=`promoted`, promoted_to = path ending in `agents/test-auto-evolve-agent.md`.

- [ ] **Step 5: Revert via UI**

Navigate to `#auto-evolves`, click the test-auto-evolve-agent row, click "Revert".

- [ ] **Step 6: Verify agent file removed**

```bash
ls ~/.claude/agents/test-auto-evolve-agent.md 2>&1
```

Expected: `No such file or directory`.

- [ ] **Step 7: Cleanup**

```bash
rm cl/instincts/personal/test-auto-evolve-agent.md
sqlite3 open-pulse.db "DELETE FROM auto_evolves WHERE title = 'test-auto-evolve-agent'"
```

- [ ] **Step 8: No commit (manual verification only)**

Stage B complete. All auto-promote target types verified working. Proceed to Stage C.

---

## Stage C — Build observer

### Task 6: Refactor `promoteOne` out of `runAutoEvolve`

**Files:**
- Modify: `src/evolve/promote.js`
- Modify: `test/evolve/promote.test.js`

- [ ] **Step 1: Write test for new `promoteOne` export**

Add this test to `test/evolve/promote.test.js` before the `describe` closing brace:

```js
  it('promoteOne promotes a single row regardless of confidence/blacklist', () => {
    const { promoteOne } = require('../../src/evolve/promote');
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-promote-one-1', 'Force Promoted Rule', 'Force body', 'rule', 0.1, 1, 0, 'active', datetime('now'))
    `).run();
    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-promote-one-1');

    const result = promoteOne(db, row, { logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'promote-one-log-')) });

    assert.ok(result.filePath, 'result must include filePath');
    const after = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-promote-one-1');
    assert.equal(after.status, 'promoted');
    assert.ok(after.promoted_to);
    assert.ok(fs.existsSync(after.promoted_to));
    fs.unlinkSync(after.promoted_to);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/evolve/promote.test.js
```

Expected: fails with `promoteOne is not a function` (not yet exported).

- [ ] **Step 3: Refactor `runAutoEvolve` to extract `promoteOne`**

Replace the body of `runAutoEvolve` in `src/evolve/promote.js` (the `for (const row of ready)` loop and the wrapping function) with:

```js
// Promote a single active row. Bypasses blacklist/threshold checks — caller is responsible.
// Returns { filePath } on success, throws on failure.
function promoteOne(db, row, opts = {}) {
  const { logDir } = opts;

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

  return { filePath };
}

function runAutoEvolve(db, opts = {}) {
  const {
    min_confidence = 0.85,
    blacklist = ['hook'],
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
      promoteOne(db, row, { logDir });
      promoted++;
    } catch { /* skip individual failures */ }
  }

  return { promoted };
}

module.exports = { generateComponent, runAutoEvolve, promoteOne };
```

- [ ] **Step 4: Run all promote tests to verify pass**

```bash
node --test test/evolve/promote.test.js test/evolve/sync.test.js
```

Expected: all tests pass (including the existing `runAutoEvolve` tests that exercise the same code path through `promoteOne`).

- [ ] **Step 5: Commit**

```bash
git add src/evolve/promote.js test/evolve/promote.test.js
git commit -m "refactor: extract promoteOne helper from runAutoEvolve"
```

---

### Task 7: Add `exportEventsSince` helper to export-events.js

**Files:**
- Modify: `src/evolve/export-events.js`
- Modify: `test/evolve/sync.test.js` (add new test)

- [ ] **Step 1: Write failing test**

Add a new test block at the end of `test/evolve/sync.test.js` before the closing `});`:

```js
  // -- exportEventsSince --

  it('exportEventsSince returns rows after cursor timestamp ordered ASC', () => {
    const { exportEventsSince } = require('../../src/evolve/export-events');

    // Seed 3 events with controlled timestamps and working_directory
    const projectRoot = '/tmp/test-project';
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, working_directory, tool_input, seq_num)
      VALUES
        ('2026-04-12T10:00:00Z', 's1', 'tool_call', 'Read', ?, '{"file_path":"/x"}', 1),
        ('2026-04-12T10:05:00Z', 's1', 'tool_call', 'Edit', ?, '{"file_path":"/x"}', 2),
        ('2026-04-12T10:10:00Z', 's1', 'tool_call', 'Bash', ?, '{"command":"ls"}', 3)
    `).run(projectRoot, projectRoot, projectRoot);

    const rows = exportEventsSince(db, projectRoot, '2026-04-12T10:02:00Z', 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Edit');
    assert.equal(rows[1].name, 'Bash');
  });

  it('exportEventsSince respects maxRows limit', () => {
    const { exportEventsSince } = require('../../src/evolve/export-events');
    const rows = exportEventsSince(db, '/tmp/test-project', '2026-04-12T00:00:00Z', 1);
    assert.equal(rows.length, 1);
  });
```

- [ ] **Step 2: Run test to verify fail**

```bash
node --test test/evolve/sync.test.js
```

Expected: fails with `exportEventsSince is not a function`.

- [ ] **Step 3: Implement `exportEventsSince` in `src/evolve/export-events.js`**

Add this function before the `module.exports` line at the bottom of `src/evolve/export-events.js`:

```js
/**
 * Export events for a project since a cursor timestamp.
 * Takes an open better-sqlite3 db handle (not a path) so callers can
 * batch this with other queries in the same connection.
 */
function exportEventsSince(db, projectRoot, sinceIso, maxRows) {
  return db.prepare(`
    SELECT timestamp, session_id, event_type, name, detail,
           tool_input, tool_response, user_prompt, seq_num, success,
           duration_ms, working_directory
    FROM events
    WHERE event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
      AND working_directory LIKE ?
      AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(projectRoot + '%', sinceIso, maxRows);
}
```

Update the `module.exports` line to include the new helper:

```js
module.exports = { exportEvents, parseArgs, exportEventsSince };
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test test/evolve/sync.test.js
```

Expected: new tests pass, existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/evolve/export-events.js test/evolve/sync.test.js
git commit -m "feat: add exportEventsSince helper for observer cursor reads"
```

---

### Task 8: Create observer.js skeleton with `queryActiveProjects` and `serializeFrontmatter`

**Files:**
- Create: `src/evolve/observer.js`
- Create: `test/evolve/observer.test.js`

- [ ] **Step 1: Create test file skeleton**

Create `test/evolve/observer.test.js`:

```js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-observer-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-observer', () => {
  let db, observer;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = require('../../src/db/schema').createDb(TEST_DB);
    observer = require('../../src/evolve/observer');
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- queryActiveProjects --

  it('queryActiveProjects returns projects with recent events, ordered by event count', () => {
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p1', 'proj-one', '/tmp/proj-one');
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p2', 'proj-two', '/tmp/proj-two');
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p3', 'proj-idle', '/tmp/proj-idle');

    const recent = "datetime('now', '-1 hours')";
    // p1: 5 events, p2: 3 events, p3: 0 events, all recent
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (${recent}, 'tool_call', 'Read', '/tmp/proj-one')`).run();
    }
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (${recent}, 'tool_call', 'Edit', '/tmp/proj-two')`).run();
    }

    const result = observer.queryActiveProjects(db, 24, 10);
    assert.equal(result.length, 2, 'idle project must be filtered out');
    assert.equal(result[0].project_id, 'p1', 'busiest project first');
    assert.equal(result[1].project_id, 'p2');
  });

  it('queryActiveProjects respects maxProjects limit', () => {
    const result = observer.queryActiveProjects(db, 24, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].project_id, 'p1');
  });

  it('queryActiveProjects filters projects below min event threshold', () => {
    // Single event for p3 — still below 3 threshold
    db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (datetime('now'), 'tool_call', 'Read', '/tmp/proj-idle')`).run();
    const result = observer.queryActiveProjects(db, 24, 10);
    assert.ok(!result.some(r => r.project_id === 'p3'), 'projects with <3 events must not appear');
  });

  // -- serializeFrontmatter --

  it('serializeFrontmatter produces a valid frontmatter block', () => {
    const out = observer.serializeFrontmatter({
      id: 'ae-123',
      name: 'test-pattern',
      type: 'rule',
      confidence: '0.75',
    });
    assert.ok(out.startsWith('---\n'));
    assert.ok(out.endsWith('\n---\n'));
    assert.ok(out.includes('id: ae-123'));
    assert.ok(out.includes('confidence: 0.75'));
  });

  it('serializeFrontmatter is round-trippable with parseFrontmatter', () => {
    const { parseFrontmatter } = require('../../src/lib/frontmatter');
    const original = { id: 'ae-abc', name: 'x', type: 'skill', confidence: '0.5' };
    const parsed = parseFrontmatter(observer.serializeFrontmatter(original) + '\n\nbody');
    assert.deepEqual(parsed, original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/evolve/observer.test.js
```

Expected: fails with `Cannot find module '../../src/evolve/observer'`.

- [ ] **Step 3: Create `src/evolve/observer.js` with the two functions**

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { parseFrontmatter, extractBody } = require('../lib/frontmatter');
const { exportEventsSince } = require('./export-events');
const { getKgSyncState, setKgSyncState } = require('../db/knowledge-sync');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Active project query
// ---------------------------------------------------------------------------

function queryActiveProjects(db, windowHours, maxProjects) {
  return db.prepare(`
    SELECT p.project_id, p.name, p.directory, COUNT(e.id) AS recent_events
    FROM cl_projects p
    JOIN events e ON e.working_directory LIKE p.directory || '%'
    WHERE e.timestamp >= datetime('now', ?)
    GROUP BY p.project_id, p.name, p.directory
    HAVING recent_events >= 3
    ORDER BY recent_events DESC
    LIMIT ?
  `).all(`-${windowHours} hours`, maxProjects);
}

// ---------------------------------------------------------------------------
// Frontmatter serialization (inverse of parseFrontmatter in src/lib/frontmatter.js)
// ---------------------------------------------------------------------------

function serializeFrontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test test/evolve/observer.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/evolve/observer.js test/evolve/observer.test.js
git commit -m "feat: add observer.js skeleton with queryActiveProjects"
```

---

### Task 9: Add `normalizeInstinctFile` helper with warm-up clamp

**Files:**
- Modify: `src/evolve/observer.js`
- Modify: `test/evolve/observer.test.js`

- [ ] **Step 1: Write failing tests**

Add these tests to the `describe('op-observer', ...)` block in `test/evolve/observer.test.js`:

```js
  // -- normalizeInstinctFile --

  it('normalizeInstinctFile computes canonical id matching sync.js:makeId', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-1.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: random-id-from-haiku',
      'name: always-test',
      'type: rule',
      'confidence: 0.8',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const content = fs.readFileSync(tmpFile, 'utf8');
    const meta = require('../../src/lib/frontmatter').parseFrontmatter(content);
    // Canonical id = 'ae-' + sha256('always-test::rule').substring(0,16)
    const expected = 'ae-' + crypto.createHash('sha256').update('always-test::rule').digest('hex').substring(0, 16);
    assert.equal(meta.id, expected);
  });

  it('normalizeInstinctFile clamps confidence when wasNew=true', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-2.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: clamp-me',
      'type: rule',
      'confidence: 0.85',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, true, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.75');
  });

  it('normalizeInstinctFile does not clamp when wasNew=false', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-3.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: existing',
      'type: rule',
      'confidence: 0.85',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.85');
  });

  it('normalizeInstinctFile rounds confidence to 2 decimals', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-4.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: round-me',
      'type: rule',
      'confidence: 0.123456',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.12');
  });
```

Add `const crypto = require('crypto');` at the top of the test file if not already present.

- [ ] **Step 2: Run to verify fail**

```bash
node --test test/evolve/observer.test.js
```

Expected: fails with `observer.normalizeInstinctFile is not a function`.

- [ ] **Step 3: Implement `normalizeInstinctFile` in `src/evolve/observer.js`**

Add this function to `src/evolve/observer.js` (before `module.exports`):

```js
// ---------------------------------------------------------------------------
// Instinct file normalization: canonical id + warm-up confidence clamp
// ---------------------------------------------------------------------------

function normalizeInstinctFile(filePath, wasNew, confidenceCap) {
  const content = fs.readFileSync(filePath, 'utf8');
  const meta = parseFrontmatter(content);
  if (!meta || !meta.name || !meta.type) return;

  const body = extractBody(content);

  const hash = crypto
    .createHash('sha256')
    .update(`${meta.name}::${meta.type}`)
    .digest('hex')
    .substring(0, 16);
  meta.id = `ae-${hash}`;

  const currentConf = parseFloat(meta.confidence);
  if (Number.isFinite(currentConf)) {
    const clamped = wasNew ? Math.min(currentConf, confidenceCap) : currentConf;
    meta.confidence = clamped.toFixed(2);
  }

  const newContent = serializeFrontmatter(meta) + '\n' + body + '\n';
  fs.writeFileSync(filePath, newContent, 'utf8');
}
```

Update `module.exports` to include `normalizeInstinctFile`:

```js
module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
  normalizeInstinctFile,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test test/evolve/observer.test.js
```

Expected: all four normalizeInstinctFile tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/evolve/observer.js test/evolve/observer.test.js
git commit -m "feat: add normalizeInstinctFile with canonical id and warm-up clamp"
```

---

### Task 10: Add `processProject` with injected Claude CLI runner

**Files:**
- Modify: `src/evolve/observer.js`
- Modify: `test/evolve/observer.test.js`

- [ ] **Step 1: Write test using a fake CLI runner**

Add these tests to `test/evolve/observer.test.js`:

```js
  // -- processProject (with fake CLI runner) --

  it('processProject skips when fewer than 3 events since cursor', async () => {
    const repoDir = path.join(TEST_DIR, 'repo-skip');
    fs.mkdirSync(path.join(repoDir, 'cl/instincts/personal'), { recursive: true });

    let cliCalled = false;
    const fakeRunner = () => { cliCalled = true; return { stdout: '', usage: {} }; };

    const result = observer.processProject(db, {
      project: { project_id: 'p-skip', name: 'skip', directory: '/tmp/nothing-here' },
      repoDir,
      config: {
        observer_model: 'fake',
        observer_max_events_per_project: 100,
        observer_confidence_cap_on_first_detect: 0.75,
      },
      runClaude: fakeRunner,
    });

    assert.equal(cliCalled, false, 'CLI must not run when events below threshold');
    assert.equal(result.status, 'skipped');
  });

  it('processProject invokes CLI and normalizes new files', async () => {
    const repoDir = path.join(TEST_DIR, 'repo-run');
    const instinctsDir = path.join(repoDir, 'cl/instincts/personal');
    fs.mkdirSync(instinctsDir, { recursive: true });

    const projRoot = '/tmp/proj-run';
    // Seed 5 events for this project
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory, tool_input)
        VALUES (datetime('now'), 'tool_call', 'Edit', ?, '{}')`).run(projRoot);
    }

    // Fake runner: simulates Haiku writing a file to instincts dir
    const fakeRunner = (/* args, opts */) => {
      fs.writeFileSync(path.join(instinctsDir, 'new-pattern.md'), [
        '---',
        'name: new-pattern',
        'type: rule',
        'confidence: 0.85',
        '---',
        '',
        'Body text',
      ].join('\n'));
      return {
        stdout: JSON.stringify({ result: 'done', usage: { input_tokens: 100, output_tokens: 50 } }),
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    };

    const result = observer.processProject(db, {
      project: { project_id: 'p-run', name: 'proj-run', directory: projRoot },
      repoDir,
      config: {
        observer_model: 'fake',
        observer_max_events_per_project: 100,
        observer_confidence_cap_on_first_detect: 0.75,
      },
      runClaude: fakeRunner,
    });

    assert.equal(result.status, 'success');
    assert.equal(result.input_tokens, 100);
    assert.equal(result.output_tokens, 50);

    // File must exist and have clamped confidence
    const written = fs.readFileSync(path.join(instinctsDir, 'new-pattern.md'), 'utf8');
    assert.ok(written.includes('confidence: 0.75'), 'new file confidence clamped to 0.75');
    assert.ok(written.match(/id: ae-[a-f0-9]{16}/), 'canonical id set');
  });
```

- [ ] **Step 2: Run to verify fail**

```bash
node --test test/evolve/observer.test.js
```

Expected: fails with `observer.processProject is not a function`.

- [ ] **Step 3: Implement `processProject` in `src/evolve/observer.js`**

Add these functions to `src/evolve/observer.js` before `module.exports`:

```js
// ---------------------------------------------------------------------------
// Snapshot helper: list all instinct file basenames in cl/instincts/**
// ---------------------------------------------------------------------------

function snapshotInstinctFiles(instinctsRoot) {
  const out = new Set();
  for (const sub of ['inherited', 'personal']) {
    const dir = path.join(instinctsRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) out.add(path.join(dir, f));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt template rendering
// ---------------------------------------------------------------------------

function renderObserverPrompt(templatePath, vars) {
  let tpl = fs.readFileSync(templatePath, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    tpl = tpl.split(`{{${key}}}`).join(val);
  }
  return tpl;
}

// ---------------------------------------------------------------------------
// Process a single project: query events, invoke CLI, post-process files
// ---------------------------------------------------------------------------

function processProject(db, opts) {
  const { project, repoDir, config, runClaude } = opts;
  const minEvents = 3;

  const cursorKey = `observer_last_run_at_${project.project_id}`;
  const cursor = getKgSyncState(db, cursorKey)
    || new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const events = exportEventsSince(
    db,
    project.directory,
    cursor,
    config.observer_max_events_per_project
  );

  if (events.length < minEvents) {
    return { status: 'skipped', reason: 'below_min_events', events: events.length };
  }

  // Write events to tmpfile for Haiku to read
  const tmpFile = path.join(
    require('os').tmpdir(),
    `op-observer-${project.project_id}-${Date.now()}.jsonl`
  );
  fs.writeFileSync(tmpFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const instinctsRoot = path.join(repoDir, 'cl', 'instincts');
  fs.mkdirSync(path.join(instinctsRoot, 'personal'), { recursive: true });
  fs.mkdirSync(path.join(instinctsRoot, 'inherited'), { recursive: true });

  const before = snapshotInstinctFiles(instinctsRoot);

  const prompt = renderObserverPrompt(
    path.join(__dirname, 'observer-prompt.md'),
    {
      analysis_path: tmpFile,
      instincts_dir: path.join(instinctsRoot, 'personal'),
      project_id: project.project_id,
      project_name: project.name,
    }
  );

  let cliResult;
  try {
    cliResult = runClaude({
      model: config.observer_model,
      prompt,
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
  }

  // Post-process all files modified during this run
  const after = snapshotInstinctFiles(instinctsRoot);
  for (const filePath of after) {
    const wasNew = !before.has(filePath);
    try {
      normalizeInstinctFile(filePath, wasNew, config.observer_confidence_cap_on_first_detect);
    } catch { /* skip malformed files */ }
  }

  // Update cursor to timestamp of latest event processed
  if (events.length > 0) {
    setKgSyncState(db, cursorKey, events[events.length - 1].timestamp);
  }

  return {
    status: 'success',
    events: events.length,
    input_tokens: cliResult?.usage?.input_tokens || 0,
    output_tokens: cliResult?.usage?.output_tokens || 0,
  };
}
```

Update `module.exports`:

```js
module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
  normalizeInstinctFile,
  snapshotInstinctFiles,
  renderObserverPrompt,
  processProject,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test test/evolve/observer.test.js
```

Expected: all processProject tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/evolve/observer.js test/evolve/observer.test.js
git commit -m "feat: add processProject with injected CLI runner"
```

---

### Task 11: Wire observer.js CLI entry point + real `execFileSync` runner

**Files:**
- Modify: `src/evolve/observer.js`

- [ ] **Step 1: Add CLI entry point and real Claude runner**

Append this code to `src/evolve/observer.js` after the existing `module.exports` (not inside it):

```js
// ---------------------------------------------------------------------------
// Real Claude CLI runner (production use — tests use injected fake)
// ---------------------------------------------------------------------------

function runClaudeReal({ model, prompt }) {
  const startTime = Date.now();
  const rawOutput = execFileSync('claude', [
    '--model', model,
    '--max-turns', '10',
    '-p',
    '--output-format', 'json',
  ], {
    input: prompt,
    timeout: 180000,
    encoding: 'utf8',
    env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
    maxBuffer: 50 * 1024 * 1024,
  });

  try {
    const parsed = JSON.parse(rawOutput);
    const usage = parsed.usage || {};
    return {
      stdout: parsed.result || rawOutput,
      usage: {
        input_tokens: (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0),
        output_tokens: usage.output_tokens || 0,
      },
      duration_ms: Date.now() - startTime,
    };
  } catch {
    return {
      stdout: rawOutput,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: Date.now() - startTime,
    };
  }
}

// ---------------------------------------------------------------------------
// Main CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { repoDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo-dir') args.repoDir = argv[++i];
  }
  return args;
}

function loadConfig(repoDir) {
  const cfgPath = path.join(repoDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv);
  const repoDir = args.repoDir || path.resolve(__dirname, '..', '..');
  const config = loadConfig(repoDir);

  if (config.observer_enabled === false) {
    console.log('observer: disabled in config');
    process.exit(0);
  }

  const dbPath = path.join(repoDir, 'open-pulse.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');

  try {
    const projects = queryActiveProjects(
      db,
      config.observer_active_project_window_hours || 24,
      config.observer_max_projects_per_run || 5
    );

    const summary = { projects: 0, success: 0, skipped: 0, errors: 0 };

    for (const project of projects) {
      summary.projects++;
      const startTime = Date.now();
      try {
        const result = processProject(db, {
          project,
          repoDir,
          config,
          runClaude: runClaudeReal,
        });

        if (result.status === 'success') {
          summary.success++;
          insertPipelineRun(db, {
            pipeline: 'auto_evolve_observer',
            project_id: project.project_id,
            model: config.observer_model || 'claude-haiku-4-5-20251001',
            status: 'success',
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            duration_ms: Date.now() - startTime,
          });
        } else {
          summary.skipped++;
        }
        console.log(`observer: ${project.name} -> ${result.status} (events=${result.events})`);
      } catch (err) {
        summary.errors++;
        insertPipelineRun(db, {
          pipeline: 'auto_evolve_observer',
          project_id: project.project_id,
          model: config.observer_model || 'claude-haiku-4-5-20251001',
          status: 'error',
          error: err.message,
          duration_ms: Date.now() - startTime,
        });
        console.error(`observer: ${project.name} -> error: ${err.message}`);
      }
    }

    console.log(`observer: done ${JSON.stringify(summary)}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}
```

- [ ] **Step 2: Verify observer.js parses (syntax check)**

```bash
node -c src/evolve/observer.js
```

Expected: no output (syntax OK).

- [ ] **Step 3: Run existing observer tests to verify nothing regressed**

```bash
node --test test/evolve/observer.test.js
```

Expected: all tests still pass.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/evolve/observer.js
git commit -m "feat: wire observer.js CLI entry with real Claude runner"
```

---

### Task 12: Add `POST /api/auto-evolves/:id/promote` route

**Files:**
- Modify: `src/routes/auto-evolves.js`
- Modify: `test/routes/routes.test.js` (or create if absent — check first)

- [ ] **Step 1: Locate the routes test file**

```bash
ls test/routes/ 2>&1
```

Add the test to the existing `test/routes/routes.test.js` if it exists; otherwise fall back to an existing auto-evolves-adjacent test file or create `test/routes/auto-evolves.test.js` following the same pattern.

- [ ] **Step 2: Write failing test for the POST /promote endpoint**

Add this test to the chosen test file (adapt import paths to match existing conventions in that file):

```js
  it('POST /api/auto-evolves/:id/promote promotes an active entry', async () => {
    // Seed an active rule entry
    const id = 'test-force-promote-route';
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        (?, 'Route Force Promote', 'body', 'rule', 0.1, 1, 0, 'active', datetime('now'))
    `).run(id);

    const res = await app.inject({ method: 'POST', url: `/api/auto-evolves/${id}/promote` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.promoted_to);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
    assert.equal(row.status, 'promoted');
    assert.ok(fs.existsSync(row.promoted_to));
    fs.unlinkSync(row.promoted_to);
  });

  it('POST /api/auto-evolves/:id/promote rejects non-active entries', async () => {
    const id = 'test-force-promote-reverted';
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        (?, 'Already Reverted', 'body', 'rule', 0.5, 1, 0, 'reverted', datetime('now'))
    `).run(id);

    const res = await app.inject({ method: 'POST', url: `/api/auto-evolves/${id}/promote` });
    assert.equal(res.statusCode, 400);
  });

  it('POST /api/auto-evolves/:id/promote returns 404 for missing id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auto-evolves/nonexistent/promote' });
    assert.equal(res.statusCode, 404);
  });
```

- [ ] **Step 3: Run tests to verify fail**

```bash
node --test test/routes/routes.test.js
```

Expected: 3 new tests fail with 404 (route not registered).

- [ ] **Step 4: Implement the route in `src/routes/auto-evolves.js`**

Replace the existing file content with:

```js
'use strict';

const path = require('path');
const { queryAutoEvolves, getAutoEvolve, getAutoEvolveStats } = require('../evolve/queries');
const { revertAutoEvolve } = require('../evolve/revert');
const { promoteOne } = require('../evolve/promote');

module.exports = async function autoEvolveRoutes(app, opts) {
  const { db, helpers, repoDir } = opts;
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

  // POST /api/auto-evolves/:id/promote — manual force-promote
  app.post('/api/auto-evolves/:id/promote', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    if (row.status !== 'active') {
      return errorReply(reply, 400, `Cannot promote: status is ${row.status}`);
    }
    try {
      const result = promoteOne(db, row, { logDir: path.join(repoDir, 'logs') });
      reply.send({ ok: true, promoted_to: result.filePath });
    } catch (err) {
      return errorReply(reply, 500, err.message);
    }
  });
};
```

- [ ] **Step 5: Run tests to verify pass**

```bash
node --test test/routes/routes.test.js
```

Expected: all three new tests pass.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/routes/auto-evolves.js test/routes/routes.test.js
git commit -m "feat: add POST /api/auto-evolves/:id/promote for manual promotion"
```

---

### Task 13: Add "Promote now" button to auto-evolves detail view

**Files:**
- Modify: `public/modules/auto-evolves.js`

- [ ] **Step 1: Verify `post` is imported in api.js**

```bash
grep -n "^export const post" public/modules/api.js
```

Expected: `export const post = (path, body) => request('POST', path, body);` at line 45.

- [ ] **Step 2: Import `post` in auto-evolves.js**

Open `public/modules/auto-evolves.js`. Line 1 currently reads:

```js
import { get, put } from './api.js';
```

Change it to:

```js
import { get, put, post } from './api.js';
```

- [ ] **Step 3: Add "Promote now" button in `renderDetail()` for active entries**

Find the existing action button block in `renderDetail()` (around the `if (row.status === 'promoted')` check near the end). Replace it with:

```js
    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:16px';

    if (row.status === 'active') {
      const promoteBtn = document.createElement('button');
      promoteBtn.className = 'btn btn-sm btn-success';
      promoteBtn.textContent = 'Promote now';
      promoteBtn.onclick = async () => {
        try {
          await post('/auto-evolves/' + id + '/promote');
          renderDetail(el, id);
        } catch (err) {
          alert('Promote failed: ' + err.message);
        }
      };
      actions.appendChild(promoteBtn);
    }

    if (row.status === 'promoted') {
      const revertBtn = document.createElement('button');
      revertBtn.className = 'btn btn-sm btn-danger';
      revertBtn.textContent = 'Revert';
      revertBtn.onclick = async () => {
        await put('/auto-evolves/' + id + '/revert');
        renderDetail(el, id);
      };
      actions.appendChild(revertBtn);
    }

    if (actions.children.length > 0) {
      el.appendChild(actions);
    }
```

- [ ] **Step 4: Manually verify in browser**

Open `http://127.0.0.1:3827/#auto-evolves`. Seed a test active rule:

```bash
sqlite3 open-pulse.db "INSERT OR REPLACE INTO auto_evolves (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at) VALUES ('ui-test-promote', 'UI Test Promote', 'body', 'rule', 0.3, 1, 0, 'active', datetime('now'))"
```

Navigate to `#auto-evolves/ui-test-promote`. Verify "Promote now" button appears. Click it. Verify status changes to promoted and "Revert" button appears.

Cleanup:
```bash
rm -f ~/.claude/rules/ui-test-promote.md
sqlite3 open-pulse.db "DELETE FROM auto_evolves WHERE id = 'ui-test-promote'"
```

- [ ] **Step 5: Commit**

```bash
git add public/modules/auto-evolves.js
git commit -m "feat: add Promote now button to auto-evolve detail view"
```

---

### Task 14: Update config.json with observer keys + agent blacklist

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Read current config**

```bash
cat config.json
```

- [ ] **Step 2: Replace `auto_evolve_blacklist` and add observer keys**

Edit `config.json`. Change `"auto_evolve_blacklist": ["hook"]` to `"auto_evolve_blacklist": ["agent", "hook"]`. Add these keys immediately after the existing `auto_evolve_min_confidence` line:

```json
  "observer_enabled": true,
  "observer_interval_seconds": 3600,
  "observer_model": "claude-haiku-4-5-20251001",
  "observer_max_events_per_project": 500,
  "observer_active_project_window_hours": 24,
  "observer_max_projects_per_run": 5,
  "observer_confidence_cap_on_first_detect": 0.75,
```

- [ ] **Step 3: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('config.json', 'utf8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add config.json
git commit -m "feat: add observer config keys and blacklist agent from auto-promote"
```

---

### Task 15: Update install.sh — add step 9 for observer launchd service

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Update the step counter in existing echo lines**

Open `scripts/install.sh`. Find the 8 existing step counters `[1/8]` through `[8/8]`. Use the Edit tool with `replace_all: false` on each one:

- `[1/8]` → `[1/9]`
- `[2/8]` → `[2/9]`
- `[3/8]` → `[3/9]`
- `[4/8]` → `[4/9]`
- `[5/8]` → `[5/9]`
- `[6/8]` → `[6/9]`
- `[7/8]` → `[7/9]`
- `[8/8]` → `[8/9]`

- [ ] **Step 2: Add observer plist variables near the top**

Find the section with `PLIST_NAME="com.open-pulse"` near the top (around line 7). After the `AGENT_PLIST_PATH=...` line, add:

```bash
OBSERVER_PLIST_NAME="com.open-pulse.observer"
OBSERVER_PLIST_PATH="$HOME/Library/LaunchAgents/${OBSERVER_PLIST_NAME}.plist"
```

- [ ] **Step 3: Add step 9 at the end of the file, before the final echo block**

Find the line `echo ""` followed by `echo "=== Open Pulse installed ==="`. Insert a new section **before** the final `echo ""`:

```bash
# ── 9. Observer launchd service (runs every hour) ──
echo "[9/9] Setting up observer launchd service..."
if launchctl list 2>/dev/null | grep -q "$OBSERVER_PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$OBSERVER_PLIST_NAME" 2>/dev/null || true
fi

cat > "$OBSERVER_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OBSERVER_PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${REPO_DIR}/src/evolve/observer.js</string>
    <string>--repo-dir</string>
    <string>${REPO_DIR}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${REPO_DIR}/logs/observer-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_DIR}/logs/observer-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")${CLAUDE_BIN_DIR:+:${CLAUDE_BIN_DIR}}</string>
    <key>OPEN_PULSE_DIR</key>
    <string>${REPO_DIR}</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$OBSERVER_PLIST_PATH"

```

- [ ] **Step 4: Update the final management hints block**

In the existing final `echo` block that prints management hints, add these two lines after the daily review hints:

```bash
echo ""
echo "Observer (auto-evolve): runs every hour"
echo "  Manual:  node $REPO_DIR/src/evolve/observer.js --repo-dir $REPO_DIR"
echo "  Logs:    $REPO_DIR/logs/observer-stdout.log"
```

- [ ] **Step 5: Shellcheck the script (if shellcheck is installed)**

```bash
bash -n scripts/install.sh
```

Expected: exit code 0 (syntax OK).

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh
git commit -m "feat: install observer launchd service as step 9"
```

---

### Task 16: Update uninstall.sh — remove observer service

**Files:**
- Modify: `scripts/uninstall.sh`

- [ ] **Step 1: Read current uninstall.sh**

```bash
cat scripts/uninstall.sh
```

- [ ] **Step 2: Add observer bootout + plist removal**

Find the section that bootouts existing launchd services (look for `launchctl bootout` calls). Add observer cleanup alongside the existing service cleanup. The exact placement depends on the current structure — add the block parallel to the existing `com.open-pulse.suggestion-agent` cleanup block:

```bash
# Observer service
if launchctl list 2>/dev/null | grep -q "com.open-pulse.observer"; then
  launchctl bootout "gui/$(id -u)/com.open-pulse.observer" 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/com.open-pulse.observer.plist"
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/uninstall.sh
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/uninstall.sh
git commit -m "feat: uninstall observer launchd service"
```

---

### Task 17: Update CLAUDE.md with observer config + commands

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add observer config keys to the config table**

Find the `## Configuration (config.json)` section table. Add these rows after the existing `auto_evolve_min_confidence` row:

```markdown
| `observer_enabled` | true | Enable observer (auto-evolve pattern detection) |
| `observer_interval_seconds` | 3600 | Observer run interval (launchd) |
| `observer_model` | "claude-haiku-4-5-20251001" | Model for observer pattern detection |
| `observer_max_events_per_project` | 500 | Cap events passed to observer per project per run |
| `observer_active_project_window_hours` | 24 | Only run observer for projects with events in this window |
| `observer_max_projects_per_run` | 5 | Hard cap on projects processed per observer cycle |
| `observer_confidence_cap_on_first_detect` | 0.75 | Warm-up clamp for newly detected instincts |
```

Also update the `auto_evolve_blacklist` row: change default from `["agent","hook"]` description (if already matches, no change needed).

- [ ] **Step 2: Add observer to the commands section**

Find the `## Commands` section with the `### Service management (macOS launchd)` subsection. Add this block after the existing service management commands:

````markdown
### Observer (auto-evolve pattern detection)

```bash
# Manual run
node src/evolve/observer.js --repo-dir $PWD

# Service status
launchctl print gui/$(id -u)/com.open-pulse.observer

# Logs
tail -f logs/observer-stdout.log
```
````

- [ ] **Step 3: Update the Key Design Decisions section**

Find the bullet about "Split feedback loops". Append a sentence noting that observer is now implemented:

> Flow 1 (auto-evolve): Observer (`src/evolve/observer.js`) runs hourly via launchd, uses Haiku 4.5 to detect patterns from recent events, and writes instinct YAML files. `syncInstincts` + `runAutoEvolve` then auto-promote rule/knowledge/skill to component files. Agents are blacklisted from auto-promote and require manual promotion via the new `POST /api/auto-evolves/:id/promote` endpoint.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document observer config, commands, and design decisions"
```

---

### Task 18: Final integration verification — run observer locally

**Files:** None modified — manual verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: exit code 0, all tests pass.

- [ ] **Step 2: Run install script to register observer service**

```bash
scripts/install.sh
```

Expected: output shows 9 steps, ends with "Open Pulse installed" and the new observer management hints.

- [ ] **Step 3: Verify observer plist registered**

```bash
launchctl print gui/$(id -u)/com.open-pulse.observer 2>&1 | head -10
```

Expected: service registered, `state = waiting` (next run scheduled).

- [ ] **Step 4: Trigger an initial observer run manually**

```bash
node src/evolve/observer.js --repo-dir $PWD
```

Expected output (approximate):
```
observer: <project-name> -> success (events=N)
observer: done {"projects":1,"success":1,"skipped":0,"errors":0}
```

If no active project, expect:
```
observer: done {"projects":0,"success":0,"skipped":0,"errors":0}
```

- [ ] **Step 5: Inspect pipeline_runs for the observer run**

```bash
sqlite3 open-pulse.db "SELECT id, pipeline, project_id, status, input_tokens, output_tokens, duration_ms, created_at FROM pipeline_runs WHERE pipeline = 'auto_evolve_observer' ORDER BY id DESC LIMIT 5"
```

Expected: at least one row per active project with `status=success` (or `status=error` with an error message to investigate).

- [ ] **Step 6: Inspect cl/instincts/ for any new files**

```bash
ls -la cl/instincts/personal/
```

Expected: any new files created by observer have canonical ids (format `ae-<16 hex chars>.md`) OR retain their original name if Haiku didn't rename them.

If new files exist, verify their confidence is clamped:
```bash
grep -l "confidence:" cl/instincts/personal/*.md | xargs -I {} sh -c 'echo "=== {} ==="; grep confidence {}'
```

Expected: newly created files have `confidence: 0.75` or lower.

- [ ] **Step 7: Wait 65–70 minutes and verify next automatic run**

```bash
sleep 3900
launchctl print gui/$(id -u)/com.open-pulse.observer | grep -E "state|last exit"
tail -20 logs/observer-stdout.log
```

Expected: `state = waiting` again (service ran and is waiting for next cycle), log shows a second run entry.

- [ ] **Step 8: 24-hour monitoring checklist**

After leaving observer running for 24 hours, spot-check:

```bash
# Observer runs per day
sqlite3 open-pulse.db "SELECT COUNT(*), status FROM pipeline_runs WHERE pipeline = 'auto_evolve_observer' AND created_at > datetime('now', '-1 day') GROUP BY status"

# Instincts created/updated
sqlite3 open-pulse.db "SELECT target_type, status, COUNT(*) FROM auto_evolves WHERE created_at > datetime('now', '-1 day') GROUP BY target_type, status"

# Promotions triggered via observer
ls -lt ~/.claude/rules/ | head
ls -lt ~/.claude/skills/ | head
```

Expected: ~24 observer runs (1/hour), some new `auto_evolves` rows with `target_type in ('rule','knowledge','skill')`, possibly some newly promoted component files.

If observer misbehaves (wrong promotions, excessive token usage, errors): see Rollback in the spec.

- [ ] **Step 9: No commit (manual verification)**

Stage C complete.

---

## Completion Checklist

When all 18 tasks are done:

- [ ] Stage A verified: rule promotion + revert round-trip works
- [ ] Stage B verified: skill + agent promotion + revert round-trip works, `generateComponent` has explicit agent case
- [ ] Stage C code: `observer.js`, `promoteOne`, `exportEventsSince`, `POST /promote`, frontend button all implemented and tested
- [ ] Stage C config: `config.json` has observer keys + `["agent","hook"]` blacklist
- [ ] Stage C installer: `install.sh` step 9 creates observer plist; `uninstall.sh` removes it
- [ ] Stage C docs: CLAUDE.md updated with observer config/commands/design note
- [ ] Stage C verification: observer ran at least twice (manual + scheduled), `pipeline_runs` records the runs, no unexplained errors in logs

Rollback procedure documented in the spec (`docs/superpowers/specs/2026-04-12-auto-evolve-activation-design.md` → "Rollback" section).
