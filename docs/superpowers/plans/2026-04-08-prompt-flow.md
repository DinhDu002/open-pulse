# Prompt Flow Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a prompt management page and flow visualization so users can browse all user messages and see Claude's workflow per prompt.

**Architecture:** New `prompts` table as first-class entity with pre-aggregated stats. Events get `prompt_id` FK. Ingestion creates/links prompts automatically. Two new API endpoints. New frontend module with list + detail views. Session detail page groups events by prompt.

**Tech Stack:** SQLite (better-sqlite3), Fastify 5, Vanilla JS ES modules, Node.js test runner

**Spec:** `docs/superpowers/specs/2026-04-08-prompt-flow-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/op-db.js` | Add prompts table schema, prompt_id column, insert/query functions |
| Modify | `src/op-ingest.js` | Link events to prompts during ingestion |
| Modify | `src/op-server.js` | Add GET /api/prompts and GET /api/prompts/:id routes |
| Modify | `public/modules/router.js` | Add #prompts route |
| Modify | `public/modules/sessions.js` | Group events by prompt in session detail |
| Modify | `public/index.html` | Add Prompts nav link + CSS styles |
| Create | `public/modules/prompts.js` | Prompt list + detail views |
| Create | `scripts/op-backfill-prompts.js` | Migrate existing events to prompts |
| Modify | `scripts/op-install.sh` | Add backfill step |
| Modify | `test/op-db.test.js` | Tests for prompts schema + functions |
| Modify | `test/op-ingest.test.js` | Tests for prompt linking during ingestion |
| Modify | `test/op-server.test.js` | Tests for prompts API endpoints |
| Create | `test/op-backfill-prompts.test.js` | Tests for backfill script |

---

### Task 1: DB Schema — prompts table + prompt_id column

**Files:**
- Modify: `src/op-db.js:13-36` (SCHEMA string), `src/op-db.js:196-206` (migrations)
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing test for prompts table existence**

In `test/op-db.test.js`, add after the existing `'creates all tables'` test:

```javascript
it('creates prompts table', () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('prompts'));
});

it('events table has prompt_id column', () => {
  const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  assert.ok(cols.includes('prompt_id'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-db.test.js`
Expected: FAIL — `prompts` table not found, `prompt_id` column not found

- [ ] **Step 3: Add prompts table to SCHEMA**

In `src/op-db.js`, add after the `sessions` table definition (after line ~51) inside the SCHEMA template literal:

```sql
CREATE TABLE IF NOT EXISTS prompts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  prompt_text     TEXT    NOT NULL,
  seq_start       INTEGER NOT NULL,
  seq_end         INTEGER,
  timestamp       TEXT    NOT NULL,
  event_count     INTEGER DEFAULT 0,
  total_cost_usd  REAL    DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_timestamp ON prompts(timestamp);
```

- [ ] **Step 4: Add prompt_id migration for existing DBs**

In `src/op-db.js`, in the migrations section (around line 196-206), add a new migration:

```javascript
// Migration: add prompt_id to events
try {
  db.prepare('SELECT prompt_id FROM events LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE events ADD COLUMN prompt_id INTEGER REFERENCES prompts(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_prompt ON events(prompt_id)');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/op-db.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add prompts table schema and prompt_id column on events"
```

---

### Task 2: DB Functions — prompt CRUD

**Files:**
- Modify: `src/op-db.js` (add functions after existing query functions)
- Modify: `src/op-db.js:258-269` (add prompt_id to insertEvent)
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing tests for prompt functions**

In `test/op-db.test.js`, add a new describe block:

```javascript
describe('prompts', () => {
  it('insertPrompt creates a prompt record', () => {
    const id = mod.insertPrompt(db, {
      session_id: 'sess-prompt-1',
      prompt_text: 'add auth feature',
      seq_start: 1,
      timestamp: '2026-04-08T10:00:00Z',
    });
    assert.ok(id > 0);
    const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    assert.equal(row.session_id, 'sess-prompt-1');
    assert.equal(row.prompt_text, 'add auth feature');
    assert.equal(row.seq_start, 1);
    assert.equal(row.event_count, 0);
  });

  it('getLatestPromptForSession returns most recent prompt', () => {
    mod.insertPrompt(db, {
      session_id: 'sess-prompt-2',
      prompt_text: 'first prompt',
      seq_start: 1,
      timestamp: '2026-04-08T10:00:00Z',
    });
    const id2 = mod.insertPrompt(db, {
      session_id: 'sess-prompt-2',
      prompt_text: 'second prompt',
      seq_start: 5,
      timestamp: '2026-04-08T10:01:00Z',
    });
    const latest = mod.getLatestPromptForSession(db, 'sess-prompt-2');
    assert.equal(latest.id, id2);
    assert.equal(latest.prompt_text, 'second prompt');
  });

  it('getLatestPromptForSession returns undefined when no prompts', () => {
    const result = mod.getLatestPromptForSession(db, 'nonexistent-session');
    assert.equal(result, undefined);
  });

  it('updatePromptStats increments event_count and cost', () => {
    const id = mod.insertPrompt(db, {
      session_id: 'sess-prompt-3',
      prompt_text: 'test prompt',
      seq_start: 1,
      timestamp: '2026-04-08T10:00:00Z',
    });
    mod.updatePromptStats(db, id, {
      seq_end: 3,
      cost: 0.05,
      timestamp: '2026-04-08T10:00:30Z',
    });
    mod.updatePromptStats(db, id, {
      seq_end: 4,
      cost: 0.10,
      timestamp: '2026-04-08T10:01:00Z',
    });
    const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    assert.equal(row.event_count, 2);
    assert.ok(Math.abs(row.total_cost_usd - 0.15) < 0.001);
    assert.equal(row.seq_end, 4);
  });

  it('insertEvent includes prompt_id', () => {
    const promptId = mod.insertPrompt(db, {
      session_id: 'sess-prompt-4',
      prompt_text: 'with prompt_id',
      seq_start: 1,
      timestamp: '2026-04-08T10:00:00Z',
    });
    mod.insertEvent(db, {
      timestamp: '2026-04-08T10:00:05Z',
      session_id: 'sess-prompt-4',
      event_type: 'tool_call',
      name: 'Read',
      prompt_id: promptId,
    });
    const evt = db.prepare(
      'SELECT prompt_id FROM events WHERE session_id = ? AND name = ?'
    ).get('sess-prompt-4', 'Read');
    assert.equal(evt.prompt_id, promptId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-db.test.js`
Expected: FAIL — `mod.insertPrompt is not a function`

- [ ] **Step 3: Implement prompt functions**

In `src/op-db.js`, add after the existing session functions:

```javascript
function insertPrompt(db, p) {
  const result = db.prepare(`
    INSERT INTO prompts (session_id, prompt_text, seq_start, timestamp)
    VALUES (@session_id, @prompt_text, @seq_start, @timestamp)
  `).run({
    session_id: p.session_id,
    prompt_text: p.prompt_text,
    seq_start: p.seq_start,
    timestamp: p.timestamp,
  });
  return Number(result.lastInsertRowid);
}

function getLatestPromptForSession(db, sessionId) {
  return db.prepare(
    'SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId);
}

function updatePromptStats(db, promptId, { seq_end, cost, timestamp }) {
  db.prepare(`
    UPDATE prompts
    SET event_count = event_count + 1,
        total_cost_usd = total_cost_usd + @cost,
        seq_end = @seq_end,
        duration_ms = CAST(
          (julianday(@timestamp) - julianday(timestamp)) * 86400000 AS INTEGER
        )
    WHERE id = @id
  `).run({ id: promptId, seq_end, cost: cost || 0, timestamp });
}
```

- [ ] **Step 4: Add prompt_id to insertEvent**

In the `insertEvent` function, add `prompt_id` to the INSERT statement and parameter list. In `withEventDefaults`, add `prompt_id: e.prompt_id ?? null`.

The INSERT columns should now include `prompt_id` and the VALUES should include `@prompt_id`.

- [ ] **Step 5: Export the new functions**

Add to the `module.exports` object:

```javascript
insertPrompt,
getLatestPromptForSession,
updatePromptStats,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/op-db.test.js`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add prompt CRUD functions to op-db"
```

---

### Task 3: Ingestion — link events to prompts

**Files:**
- Modify: `src/op-ingest.js:139-145` (processContent function area)
- Test: `test/op-ingest.test.js`

- [ ] **Step 1: Write failing test for prompt linking**

In `test/op-ingest.test.js`, add:

```javascript
it('ingestFile links events to prompts', () => {
  const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
  const events = [
    {
      timestamp: '2026-04-08T10:00:01Z',
      session_id: 'sess-ingest-prompt',
      event_type: 'tool_call',
      tool_name: 'Read',
      detail: 'src/index.js',
      user_prompt: 'add auth feature',
      seq_num: 1,
    },
    {
      timestamp: '2026-04-08T10:00:02Z',
      session_id: 'sess-ingest-prompt',
      event_type: 'tool_call',
      tool_name: 'Edit',
      detail: 'src/index.js',
      user_prompt: 'add auth feature',
      seq_num: 2,
    },
    {
      timestamp: '2026-04-08T10:00:05Z',
      session_id: 'sess-ingest-prompt',
      event_type: 'tool_call',
      tool_name: 'Bash',
      detail: 'npm test',
      user_prompt: 'now run the tests',
      seq_num: 3,
    },
  ];
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const result = ingest.ingestFile(db, filePath, 'events');
  assert.equal(result.processed, 3);

  const prompts = db.prepare(
    "SELECT * FROM prompts WHERE session_id = 'sess-ingest-prompt' ORDER BY id"
  ).all();
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].prompt_text, 'add auth feature');
  assert.equal(prompts[0].event_count, 2);
  assert.equal(prompts[0].seq_start, 1);
  assert.equal(prompts[0].seq_end, 2);
  assert.equal(prompts[1].prompt_text, 'now run the tests');
  assert.equal(prompts[1].event_count, 1);
  assert.equal(prompts[1].seq_start, 3);

  const evts = db.prepare(
    "SELECT prompt_id FROM events WHERE session_id = 'sess-ingest-prompt' ORDER BY seq_num"
  ).all();
  assert.equal(evts[0].prompt_id, prompts[0].id);
  assert.equal(evts[1].prompt_id, prompts[0].id);
  assert.equal(evts[2].prompt_id, prompts[1].id);
});

it('ingestFile skips prompt linking for null user_prompt', () => {
  const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
  const event = {
    timestamp: '2026-04-08T11:00:00Z',
    session_id: 'sess-ingest-null',
    event_type: 'session_end',
    tool_name: 'session_end',
    seq_num: 1,
  };
  fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
  ingest.ingestFile(db, filePath, 'events');

  const evts = db.prepare(
    "SELECT prompt_id FROM events WHERE session_id = 'sess-ingest-null'"
  ).all();
  assert.equal(evts[0].prompt_id, null);

  const prompts = db.prepare(
    "SELECT * FROM prompts WHERE session_id = 'sess-ingest-null'"
  ).all();
  assert.equal(prompts.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-ingest.test.js`
Expected: FAIL — prompts table empty, prompt_id is null

- [ ] **Step 3: Implement prompt linking in ingestion**

In `src/op-ingest.js`, import the new DB functions at the top:

```javascript
const {
  insertEventBatch, upsertSessionBatch, insertSuggestionBatch,
  insertPrompt, getLatestPromptForSession, updatePromptStats,
} = require('./op-db');
```

Add two helper functions:

```javascript
function linkEventsToPrompts(db, events) {
  for (const evt of events) {
    if (!evt.user_prompt || !evt.session_id) {
      evt.prompt_id = null;
      continue;
    }
    const latest = getLatestPromptForSession(db, evt.session_id);
    if (latest && latest.prompt_text === evt.user_prompt) {
      evt.prompt_id = latest.id;
    } else {
      evt.prompt_id = insertPrompt(db, {
        session_id: evt.session_id,
        prompt_text: evt.user_prompt,
        seq_start: evt.seq_num ?? 0,
        timestamp: evt.timestamp,
      });
    }
  }
}

function updatePromptStatsAfterInsert(db, events) {
  for (const evt of events) {
    if (evt.prompt_id) {
      updatePromptStats(db, evt.prompt_id, {
        seq_end: evt.seq_num ?? 0,
        cost: evt.estimated_cost_usd ?? 0,
        timestamp: evt.timestamp,
      });
    }
  }
}
```

In the event processing branch of `processContent`, wrap prompt linking around the batch insert:

```javascript
if (type === 'events') {
  const txn = db.transaction((evts) => {
    linkEventsToPrompts(db, evts);
    insertEventBatch(db, evts);
    updatePromptStatsAfterInsert(db, evts);
  });
  txn(records);
}
```

Note: If `insertEventBatch` already wraps in a transaction internally, refactor to use the outer transaction. better-sqlite3 transactions nest safely (inner becomes savepoint).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-ingest.test.js`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `node --test test/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
git add src/op-ingest.js test/op-ingest.test.js
git commit -m "feat: link events to prompts during ingestion"
```

---

### Task 4: Backfill script

**Files:**
- Create: `scripts/op-backfill-prompts.js`
- Modify: `scripts/op-install.sh`
- Test: `test/op-backfill-prompts.test.js`

- [ ] **Step 1: Write failing test**

Create `test/op-backfill-prompts.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-backfill-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-backfill-prompts', () => {
  let db, dbMod, backfill;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbMod = require('../src/op-db');
    db = dbMod.createDb(TEST_DB);

    // Insert test events without prompt_id (simulating old data)
    const events = [
      { timestamp: '2026-04-08T10:00:01Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Read', user_prompt: 'add auth', seq_num: 1 },
      { timestamp: '2026-04-08T10:00:02Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Edit', user_prompt: 'add auth', seq_num: 2 },
      { timestamp: '2026-04-08T10:00:05Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Bash', user_prompt: 'run tests', seq_num: 3 },
      { timestamp: '2026-04-08T10:00:10Z', session_id: 'sess-bf-1',
        event_type: 'session_end', name: 'session_end', seq_num: 4 },
      { timestamp: '2026-04-08T11:00:01Z', session_id: 'sess-bf-2',
        event_type: 'tool_call', name: 'Read', user_prompt: 'fix bug', seq_num: 1 },
    ];
    for (const evt of events) {
      dbMod.insertEvent(db, evt);
    }

    backfill = require('../scripts/op-backfill-prompts');
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('backfills prompts from existing events', () => {
    const result = backfill.run(db);
    assert.equal(result.sessions, 2);
    assert.equal(result.prompts, 3); // 'add auth', 'run tests', 'fix bug'

    const prompts = db.prepare('SELECT * FROM prompts ORDER BY id').all();
    assert.equal(prompts.length, 3);
    assert.equal(prompts[0].prompt_text, 'add auth');
    assert.equal(prompts[0].event_count, 2);
    assert.equal(prompts[0].seq_start, 1);
    assert.equal(prompts[0].seq_end, 2);
    assert.equal(prompts[1].prompt_text, 'run tests');
    assert.equal(prompts[1].event_count, 1);
    assert.equal(prompts[2].session_id, 'sess-bf-2');
  });

  it('is idempotent — skips events already linked', () => {
    const result = backfill.run(db);
    assert.equal(result.prompts, 0); // no new prompts created
    const prompts = db.prepare('SELECT * FROM prompts').all();
    assert.equal(prompts.length, 3); // unchanged
  });

  it('links events to prompt_id', () => {
    const evts = db.prepare(
      "SELECT prompt_id, name FROM events WHERE session_id = 'sess-bf-1' ORDER BY seq_num"
    ).all();
    assert.ok(evts[0].prompt_id !== null); // Read -> 'add auth'
    assert.equal(evts[0].prompt_id, evts[1].prompt_id); // Edit -> same prompt
    assert.notEqual(evts[1].prompt_id, evts[2].prompt_id); // Bash -> 'run tests'
    assert.equal(evts[3].prompt_id, null); // session_end -> null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-backfill-prompts.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement backfill script**

Create `scripts/op-backfill-prompts.js`:

```javascript
'use strict';

const path = require('path');

function run(db) {
  const sessions = db.prepare(
    `SELECT DISTINCT session_id FROM events
     WHERE prompt_id IS NULL AND user_prompt IS NOT NULL
     ORDER BY session_id`
  ).all();

  let totalPrompts = 0;

  const processSession = db.transaction((sessionId) => {
    const events = db.prepare(
      `SELECT id, timestamp, user_prompt, seq_num, estimated_cost_usd
       FROM events
       WHERE session_id = ? AND prompt_id IS NULL
       ORDER BY seq_num`
    ).all(sessionId);

    let currentPromptId = null;
    let currentPromptText = null;

    for (const evt of events) {
      if (!evt.user_prompt) continue;

      if (evt.user_prompt !== currentPromptText) {
        const result = db.prepare(
          `INSERT INTO prompts (session_id, prompt_text, seq_start, timestamp)
           VALUES (?, ?, ?, ?)`
        ).run(sessionId, evt.user_prompt, evt.seq_num ?? 0, evt.timestamp);
        currentPromptId = Number(result.lastInsertRowid);
        currentPromptText = evt.user_prompt;
        totalPrompts++;
      }

      db.prepare('UPDATE events SET prompt_id = ? WHERE id = ?')
        .run(currentPromptId, evt.id);
      db.prepare(
        `UPDATE prompts
         SET event_count = event_count + 1,
             total_cost_usd = total_cost_usd + ?,
             seq_end = ?,
             duration_ms = CAST(
               (julianday(?) - julianday(timestamp)) * 86400000 AS INTEGER
             )
         WHERE id = ?`
      ).run(evt.estimated_cost_usd ?? 0, evt.seq_num ?? 0, evt.timestamp, currentPromptId);
    }
  });

  for (const { session_id } of sessions) {
    processSession(session_id);
  }

  return { sessions: sessions.length, prompts: totalPrompts };
}

// CLI entry point
if (require.main === module) {
  const repoDir = process.argv.includes('--repo-dir')
    ? process.argv[process.argv.indexOf('--repo-dir') + 1]
    : path.resolve(__dirname, '..');
  const dbPath = process.env.OPEN_PULSE_DB
    || path.join(repoDir, 'open-pulse.db');
  const { createDb } = require(path.join(repoDir, 'src', 'op-db'));
  const db = createDb(dbPath);
  const result = run(db);
  console.log(
    'Backfill complete: ' + result.sessions + ' sessions, '
    + result.prompts + ' prompts created'
  );
  db.close();
}

module.exports = { run };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-backfill-prompts.test.js`
Expected: ALL PASS

- [ ] **Step 5: Add backfill step to op-install.sh**

In `scripts/op-install.sh`, after the DB initialization step (step 3) and before instinct seeding (step 4), add:

```bash
# -- Backfill prompts (for upgrades with existing data) --
echo "[4/9] Backfilling prompts..."
node "$REPO_DIR/scripts/op-backfill-prompts.js" --repo-dir "$REPO_DIR"
```

Increment the step numbers in all subsequent echo statements by 1 (steps 4->5, 5->6, etc., total becomes 9).

- [ ] **Step 6: Commit**

```
git add scripts/op-backfill-prompts.js test/op-backfill-prompts.test.js scripts/op-install.sh
git commit -m "feat: add backfill script for prompts migration"
```

---

### Task 5: API — GET /api/prompts

**Files:**
- Modify: `src/op-server.js` (add route after sessions endpoints, around line 836)
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing tests**

In `test/op-server.test.js`, seed test data in the existing `before()` block (after `app.ready()`):

```javascript
// Seed prompts test data
const dbMod = require('../src/op-db');
const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

dbMod.upsertSession(testDb, {
  session_id: 'sess-prompt-api',
  started_at: '2026-04-08T10:00:00Z',
  working_directory: '/Users/test/my-project',
  model: 'claude-sonnet-4-6',
});
const p1Id = dbMod.insertPrompt(testDb, {
  session_id: 'sess-prompt-api',
  prompt_text: 'add authentication',
  seq_start: 1,
  timestamp: '2026-04-08T10:00:01Z',
});
const p2Id = dbMod.insertPrompt(testDb, {
  session_id: 'sess-prompt-api',
  prompt_text: 'run all tests',
  seq_start: 3,
  timestamp: '2026-04-08T10:01:00Z',
});
dbMod.insertEvent(testDb, {
  timestamp: '2026-04-08T10:00:02Z', session_id: 'sess-prompt-api',
  event_type: 'tool_call', name: 'Read', prompt_id: p1Id, seq_num: 1,
  estimated_cost_usd: 0.01,
});
dbMod.insertEvent(testDb, {
  timestamp: '2026-04-08T10:00:03Z', session_id: 'sess-prompt-api',
  event_type: 'agent_spawn', name: 'Explore', prompt_id: p1Id, seq_num: 2,
  estimated_cost_usd: 0.05,
});
dbMod.insertEvent(testDb, {
  timestamp: '2026-04-08T10:01:01Z', session_id: 'sess-prompt-api',
  event_type: 'tool_call', name: 'Bash', prompt_id: p2Id, seq_num: 3,
  estimated_cost_usd: 0.02,
});
dbMod.updatePromptStats(testDb, p1Id, {
  seq_end: 2, cost: 0.01, timestamp: '2026-04-08T10:00:02Z',
});
dbMod.updatePromptStats(testDb, p1Id, {
  seq_end: 2, cost: 0.05, timestamp: '2026-04-08T10:00:03Z',
});
dbMod.updatePromptStats(testDb, p2Id, {
  seq_end: 3, cost: 0.02, timestamp: '2026-04-08T10:01:01Z',
});
testDb.close();
```

Then add tests in a new describe block:

```javascript
describe('prompts API', () => {
  it('GET /api/prompts returns paginated list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/prompts?period=all' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.prompts.length > 0);
    assert.ok(body.total > 0);
    assert.equal(body.page, 1);
    assert.equal(body.per_page, 20);
    const p = body.prompts.find(p => p.prompt_text === 'add authentication');
    assert.ok(p);
    assert.equal(p.session_id, 'sess-prompt-api');
    assert.ok(p.event_breakdown);
  });

  it('GET /api/prompts?q= filters by text', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/prompts?period=all&q=authentication',
    });
    const body = JSON.parse(res.body);
    assert.ok(body.prompts.every(p => p.prompt_text.includes('authentication')));
  });

  it('GET /api/prompts?session_id= filters by session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/prompts?period=all&session_id=sess-prompt-api',
    });
    const body = JSON.parse(res.body);
    assert.ok(body.prompts.length >= 2);
    assert.ok(body.prompts.every(p => p.session_id === 'sess-prompt-api'));
  });

  it('GET /api/prompts paginates correctly', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/prompts?period=all&per_page=1&page=1',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.prompts.length, 1);
    assert.equal(body.per_page, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-server.test.js`
Expected: FAIL — 404 for /api/prompts

- [ ] **Step 3: Implement GET /api/prompts endpoint**

In `src/op-server.js`, add after the sessions endpoints:

```javascript
app.get('/api/prompts', async (request) => {
  const {
    period = '7d', q, session_id, project,
    page: pageStr, per_page: perPageStr,
  } = request.query;

  const page = Math.max(1, parseInt(pageStr) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(perPageStr) || 20));
  const offset = (page - 1) * perPage;
  const since = periodToDate(period);

  const conditions = [];
  const params = {};

  if (since) {
    conditions.push('p.timestamp >= @since');
    params.since = since;
  }
  if (q) {
    conditions.push('p.prompt_text LIKE @q');
    params.q = '%' + q + '%';
  }
  if (session_id) {
    conditions.push('p.session_id = @session_id');
    params.session_id = session_id;
  }
  if (project) {
    conditions.push('s.working_directory LIKE @project');
    params.project = '%/' + project;
  }

  const where = conditions.length
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM prompts p'
    + ' LEFT JOIN sessions s ON s.session_id = p.session_id '
    + where
  ).get(params).count;

  const rows = db.prepare(
    'SELECT p.*, s.working_directory FROM prompts p'
    + ' LEFT JOIN sessions s ON s.session_id = p.session_id '
    + where
    + ' ORDER BY p.timestamp DESC LIMIT @limit OFFSET @offset'
  ).all({ ...params, limit: perPage, offset });

  const breakdowns = {};
  const promptIds = rows.map(r => r.id);
  if (promptIds.length > 0) {
    const placeholders = promptIds.map(() => '?').join(',');
    const bdRows = db.prepare(
      'SELECT prompt_id, event_type, COUNT(*) as count'
      + ' FROM events WHERE prompt_id IN (' + placeholders + ')'
      + ' GROUP BY prompt_id, event_type'
    ).all(...promptIds);
    for (const r of bdRows) {
      if (!breakdowns[r.prompt_id]) breakdowns[r.prompt_id] = {};
      breakdowns[r.prompt_id][r.event_type] = r.count;
    }
  }

  const prompts = rows.map(r => ({
    id: r.id,
    session_id: r.session_id,
    prompt_text: r.prompt_text,
    timestamp: r.timestamp,
    event_count: r.event_count,
    total_cost_usd: r.total_cost_usd,
    duration_ms: r.duration_ms,
    project: r.working_directory
      ? path.basename(r.working_directory) : null,
    event_breakdown: breakdowns[r.id] || {},
  }));

  return { prompts, total, page, per_page: perPage };
});
```

Ensure `path` is imported at the top of `op-server.js` (it likely already is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-server.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```
git add src/op-server.js test/op-server.test.js
git commit -m "feat: add GET /api/prompts endpoint with filters and pagination"
```

---

### Task 6: API — GET /api/prompts/:id

**Files:**
- Modify: `src/op-server.js` (add after GET /api/prompts)
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing tests**

In `test/op-server.test.js`, add inside the `prompts API` describe block:

```javascript
it('GET /api/prompts/:id returns prompt with events', async () => {
  const listRes = await app.inject({
    method: 'GET', url: '/api/prompts?period=all&q=authentication',
  });
  const listBody = JSON.parse(listRes.body);
  const promptId = listBody.prompts[0].id;

  const res = await app.inject({
    method: 'GET', url: '/api/prompts/' + promptId,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.prompt.id, promptId);
  assert.equal(body.prompt.prompt_text, 'add authentication');
  assert.ok(body.prompt.project);
  assert.ok(Array.isArray(body.events));
  assert.ok(body.events.length >= 2);
  assert.equal(body.events[0].name, 'Read');
  assert.equal(body.events[1].name, 'Explore');
});

it('GET /api/prompts/:id returns 404 for nonexistent', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/prompts/99999',
  });
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-server.test.js`
Expected: FAIL — 404 for valid prompt ID

- [ ] **Step 3: Implement GET /api/prompts/:id endpoint**

In `src/op-server.js`, add after the GET /api/prompts route:

```javascript
app.get('/api/prompts/:id', async (request, reply) => {
  const { id } = request.params;
  const row = db.prepare(
    'SELECT p.*, s.working_directory FROM prompts p'
    + ' LEFT JOIN sessions s ON s.session_id = p.session_id'
    + ' WHERE p.id = ?'
  ).get(id);

  if (!row) {
    reply.code(404);
    return { error: 'Prompt not found' };
  }

  const events = db.prepare(
    'SELECT id, timestamp, event_type, name, detail, duration_ms, success,'
    + ' estimated_cost_usd, tool_input, tool_response, seq_num, model'
    + ' FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
  ).all(id);

  return {
    prompt: {
      id: row.id,
      session_id: row.session_id,
      prompt_text: row.prompt_text,
      timestamp: row.timestamp,
      event_count: row.event_count,
      total_cost_usd: row.total_cost_usd,
      duration_ms: row.duration_ms,
      project: row.working_directory
        ? path.basename(row.working_directory) : null,
    },
    events,
  };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-server.test.js`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `node --test test/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
git add src/op-server.js test/op-server.test.js
git commit -m "feat: add GET /api/prompts/:id endpoint"
```

---

### Task 7: Frontend — Router + Nav

**Files:**
- Modify: `public/modules/router.js:4-13` (ROUTES object)
- Modify: `public/index.html:723-732` (nav links)

- [ ] **Step 1: Add prompts route to router.js**

In `public/modules/router.js`, add to the ROUTES object after `sessions`:

```javascript
prompts: () => import('./prompts.js'),
```

- [ ] **Step 2: Add Prompts nav link to index.html**

In `public/index.html`, add after the Sessions link (around line 725):

```html
<a href="#prompts">Prompts</a>
```

- [ ] **Step 3: Verify in browser**

Start server: `npm start`
Open: `http://localhost:3827`
Verify: "Prompts" link appears in nav between Sessions and Inventory.

- [ ] **Step 4: Commit**

```
git add public/modules/router.js public/index.html
git commit -m "feat: add prompts route and nav link"
```

---

### Task 8: Frontend — Prompts list view

**Files:**
- Create: `public/modules/prompts.js`

- [ ] **Step 1: Create prompts.js with list view**

Create `public/modules/prompts.js` with the full list view implementation:

```javascript
import { get } from './api.js';

const EVENT_COLORS = {
  tool_call: { bg: '#1a3a1a', color: '#56d364', icon: '🔧' },
  skill_invoke: { bg: '#3a1a2a', color: '#f778ba', icon: '⭐' },
  agent_spawn: { bg: '#3a1a3a', color: '#d2a8ff', icon: '🤖' },
};

function renderBreakdownBadges(breakdown) {
  return Object.entries(breakdown).map(([type, count]) => {
    const s = EVENT_COLORS[type] || EVENT_COLORS.tool_call;
    return '<span style="background:' + s.bg + ';color:' + s.color
      + ';padding:3px 10px;border-radius:12px;font-size:11px">'
      + s.icon + ' ' + count + ' ' + type.replace('_', ' ') + '</span>';
  }).join(' ');
}

function formatDuration(ms) {
  if (!ms) return '\u2014';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

function formatCost(usd) {
  if (!usd) return '$0.00';
  return '$' + usd.toFixed(2);
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function renderFilters(el, { onFilter }) {
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML =
    '<input type="text" id="prompt-search" placeholder="Search prompts..."'
    + ' class="filter-input">'
    + '<select id="prompt-project" class="filter-select">'
    + '<option value="">All projects</option></select>';
  el.appendChild(bar);

  const search = bar.querySelector('#prompt-search');
  const project = bar.querySelector('#prompt-project');

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(
      () => onFilter({ q: search.value, project: project.value }),
      300,
    );
  });
  project.addEventListener('change',
    () => onFilter({ q: search.value, project: project.value }),
  );

  // Populate projects from sessions
  get('/sessions?limit=100').then(data => {
    const sessions = Array.isArray(data) ? data : (data.sessions || []);
    const projects = [...new Set(
      sessions
        .map(s => s.working_directory || s.cwd)
        .filter(Boolean)
        .map(d => d.split('/').pop()),
    )];
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      project.appendChild(opt);
    }
  });
}

function renderSummary(el, { total, totalEvents, totalCost }) {
  const row = document.createElement('div');
  row.className = 'stat-grid';
  row.innerHTML =
    '<div class="stat-card"><div class="stat-label">Prompts</div>'
    + '<div class="stat-value">' + total + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Total Events</div>'
    + '<div class="stat-value">' + totalEvents + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Total Cost</div>'
    + '<div class="stat-value">' + formatCost(totalCost) + '</div></div>';
  el.appendChild(row);
}

function renderPromptCard(prompt) {
  const card = document.createElement('div');
  card.className = 'card clickable';
  card.innerHTML =
    '<div class="card-title">"' + escapeHtml(prompt.prompt_text) + '"</div>'
    + '<div class="card-meta">'
    + '<span>\ud83d\udcc1 ' + (prompt.project || '\u2014') + '</span>'
    + '<span>\ud83d\udd50 ' + formatTime(prompt.timestamp) + '</span>'
    + '<span>\u23f1 ' + formatDuration(prompt.duration_ms) + '</span>'
    + '<span>\ud83d\udcb0 ' + formatCost(prompt.total_cost_usd) + '</span>'
    + '</div>'
    + '<div class="badge-row">'
    + renderBreakdownBadges(prompt.event_breakdown || {})
    + '</div>';
  card.addEventListener('click', () => {
    location.hash = '#prompts/' + prompt.id;
  });
  return card;
}

function renderPagination(el, { page, perPage, total, onPage }) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return;

  const nav = document.createElement('div');
  nav.className = 'pagination';

  if (page > 1) {
    const prev = document.createElement('button');
    prev.className = 'btn btn-sm';
    prev.textContent = '\u2190 Prev';
    prev.addEventListener('click', () => onPage(page - 1));
    nav.appendChild(prev);
  }

  for (let i = 1; i <= totalPages && i <= 5; i++) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm' + (i === page ? ' active' : '');
    btn.textContent = i;
    btn.addEventListener('click', () => onPage(i));
    nav.appendChild(btn);
  }

  if (page < totalPages) {
    const next = document.createElement('button');
    next.className = 'btn btn-sm';
    next.textContent = 'Next \u2192';
    next.addEventListener('click', () => onPage(page + 1));
    nav.appendChild(next);
  }

  el.appendChild(nav);
}

async function renderList(el, period, filters) {
  el.innerHTML = '<h2>Prompts</h2>';
  let currentPage = 1;
  const perPage = 20;
  let currentFilters = { ...(filters || {}) };

  renderFilters(el, {
    onFilter(f) {
      currentFilters = f;
      currentPage = 1;
      loadPage();
    },
  });

  const container = document.createElement('div');
  el.appendChild(container);

  async function loadPage() {
    const params = new URLSearchParams({
      period: period || '7d',
      page: currentPage,
      per_page: perPage,
    });
    if (currentFilters.q) params.set('q', currentFilters.q);
    if (currentFilters.project) params.set('project', currentFilters.project);

    const data = await get('/prompts?' + params);
    container.innerHTML = '';

    const totalEvents = data.prompts.reduce((s, p) => s + p.event_count, 0);
    const totalCost = data.prompts.reduce((s, p) => s + p.total_cost_usd, 0);
    renderSummary(container, { total: data.total, totalEvents, totalCost });

    const cards = document.createElement('div');
    cards.className = 'card-list';
    for (const prompt of data.prompts) {
      cards.appendChild(renderPromptCard(prompt));
    }
    container.appendChild(cards);

    renderPagination(container, {
      page: data.page,
      perPage: data.per_page,
      total: data.total,
      onPage(p) { currentPage = p; loadPage(); },
    });
  }

  await loadPage();
}

// Detail view placeholder — implemented in Task 9
export async function renderDetail(el, id) {
  el.innerHTML = '<p>Loading prompt ' + id + '...</p>';
}

export async function mount(el, { period, params } = {}) {
  if (params) {
    await renderDetail(el, params);
  } else {
    await renderList(el, period);
  }
}

export function unmount() {}

// Re-export helpers for detail view (Task 9)
export { formatDuration, formatCost, formatTime, escapeHtml, get };
```

- [ ] **Step 2: Verify in browser**

Open: `http://localhost:3827/#prompts`
Verify: Filter bar, summary cards, and prompt cards render correctly.

- [ ] **Step 3: Commit**

```
git add public/modules/prompts.js
git commit -m "feat: add prompts list view with filters and pagination"
```

---

### Task 9: Frontend — Prompts detail view

**Files:**
- Modify: `public/modules/prompts.js` (replace renderDetail placeholder)

- [ ] **Step 1: Replace renderDetail with full implementation**

Replace the placeholder `renderDetail` function in `public/modules/prompts.js`:

```javascript
const TOOL_COLORS = {
  Read: '#56d364', Glob: '#56d364',
  Grep: '#58a6ff',
  Edit: '#6e9eff', Write: '#6e9eff',
  Bash: '#d29922',
  Agent: '#d2a8ff',
  Skill: '#f778ba',
};

function getToolColor(name) {
  return TOOL_COLORS[name] || '#8b949e';
}

function formatJson(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2); }
  catch { return str; }
}

function renderEventRow(evt, index) {
  const color = getToolColor(evt.name);
  const row = document.createElement('div');
  row.className = 'flow-event';
  row.innerHTML =
    '<div class="flow-seq">' + (index + 1) + '</div>'
    + '<div class="flow-dot" style="background:' + color + '"></div>'
    + '<div class="flow-main">'
    + '<span class="flow-name">' + escapeHtml(evt.name) + '</span>'
    + '<span class="flow-detail">' + escapeHtml(evt.detail || '') + '</span>'
    + '</div>'
    + '<span class="flow-duration">' + formatDuration(evt.duration_ms) + '</span>'
    + '<span class="flow-status">'
    + (evt.success === 1 ? '\u2713' : evt.success === 0 ? '\u2717' : '')
    + '</span>';

  const hasDetail = evt.tool_input || evt.tool_response;
  if (hasDetail) {
    row.style.cursor = 'pointer';
    const panel = document.createElement('div');
    panel.className = 'flow-detail-panel';
    panel.style.display = 'none';

    let html = '';
    if (evt.tool_input) {
      html += '<div class="flow-detail-label">Input:</div>'
        + '<pre class="flow-detail-pre">'
        + escapeHtml(formatJson(evt.tool_input)) + '</pre>';
    }
    if (evt.tool_response) {
      html += '<div class="flow-detail-label">Response:</div>'
        + '<pre class="flow-detail-pre">'
        + escapeHtml(formatJson(evt.tool_response)) + '</pre>';
    }
    panel.innerHTML = html;

    row.addEventListener('click', () => {
      const visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      row.classList.toggle('expanded', !visible);
    });

    return [row, panel];
  }
  return [row];
}

export async function renderDetail(el, id) {
  el.innerHTML = '<p>Loading...</p>';

  const data = await get('/prompts/' + id);
  if (!data || !data.prompt) {
    el.innerHTML = '<p>Prompt not found</p>';
    return;
  }

  const { prompt, events } = data;
  el.innerHTML = '';

  // Back link
  const back = document.createElement('a');
  back.href = '#prompts';
  back.className = 'back-link';
  back.textContent = '\u2190 Back to Prompts';
  el.appendChild(back);

  // Header
  const header = document.createElement('div');
  header.className = 'prompt-header';
  header.innerHTML =
    '<h2 class="prompt-text">"' + escapeHtml(prompt.prompt_text) + '"</h2>'
    + '<div class="card-meta">'
    + '<span>\ud83d\udcc1 ' + (prompt.project || '\u2014') + '</span>'
    + '<span>Session: <a href="#sessions/' + prompt.session_id + '">'
    + prompt.session_id.slice(0, 8) + '...</a></span>'
    + '<span>\ud83d\udd50 ' + formatTime(prompt.timestamp) + '</span>'
    + '<span>\u23f1 ' + formatDuration(prompt.duration_ms) + '</span>'
    + '<span>\ud83d\udcb0 ' + formatCost(prompt.total_cost_usd) + '</span>'
    + '<span>\ud83d\udd27 ' + prompt.event_count + ' events</span>'
    + '</div>';
  el.appendChild(header);

  // Flow timeline
  const timeline = document.createElement('div');
  timeline.className = 'flow-timeline';
  for (let i = 0; i < events.length; i++) {
    const elements = renderEventRow(events[i], i);
    for (const elem of elements) {
      timeline.appendChild(elem);
    }
  }
  el.appendChild(timeline);
}
```

- [ ] **Step 2: Verify in browser**

Click a prompt card from the list. Verify: back link, prompt header, flow timeline with colored dots, expandable events showing tool_input/response.

- [ ] **Step 3: Commit**

```
git add public/modules/prompts.js
git commit -m "feat: add prompts detail view with expandable flow timeline"
```

---

### Task 10: Frontend — Session detail grouping

**Files:**
- Modify: `public/modules/sessions.js:98-223` (renderDetail function)

- [ ] **Step 1: Add groupEventsByPrompt helper**

In `public/modules/sessions.js`, add a helper function before `renderDetail`:

```javascript
function groupEventsByPrompt(events) {
  const groups = [];
  let current = null;

  for (const evt of events) {
    const pid = evt.prompt_id;
    if (pid && current && current.promptId === pid) {
      current.events.push(evt);
    } else if (pid) {
      current = { promptId: pid, promptText: evt.user_prompt, events: [evt] };
      groups.push(current);
    } else {
      if (!current || current.promptId !== null) {
        current = { promptId: null, promptText: null, events: [] };
        groups.push(current);
      }
      current.events.push(evt);
    }
  }
  return groups;
}
```

- [ ] **Step 2: Replace flat timeline with grouped rendering**

In the `renderDetail` function, replace the flat event loop (the section that iterates over events) with:

```javascript
const groups = groupEventsByPrompt(events);
for (const group of groups) {
  const header = document.createElement('div');
  header.className = 'prompt-group-header'
    + (group.promptText ? ' clickable' : '');

  if (group.promptText) {
    const cost = group.events.reduce(
      (s, e) => s + (e.estimated_cost_usd || e.cost || 0), 0,
    );
    header.innerHTML =
      '<span class="prompt-group-text">\ud83d\udcac "'
      + group.promptText + '"</span>'
      + '<span class="prompt-group-stats">'
      + group.events.length + ' events \u2022 $' + cost.toFixed(2)
      + '</span>';
    header.addEventListener('click', () => {
      location.hash = '#prompts/' + group.promptId;
    });
  } else {
    header.innerHTML =
      '<span class="prompt-group-text">Other events</span>';
  }
  timeline.appendChild(header);

  for (const evt of group.events) {
    // Keep existing event row rendering logic from the original code
    // (the div.timeline-event creation with type dot, name, timestamp, detail)
    const row = document.createElement('div');
    row.className = 'timeline-event';
    // ... existing event row rendering ...
    timeline.appendChild(row);
  }
}
```

Keep the existing event row rendering code inside the inner loop. Only the outer structure changes from flat iteration to grouped iteration.

- [ ] **Step 3: Verify in browser**

Navigate to a session detail: `http://localhost:3827/#sessions/{id}`
Verify: Events grouped under prompt headers. Click prompt header navigates to `#prompts/{id}`. "Other events" group for events without prompts.

- [ ] **Step 4: Commit**

```
git add public/modules/sessions.js
git commit -m "feat: group events by prompt in session detail view"
```

---

### Task 11: CSS styles for prompts

**Files:**
- Modify: `public/index.html` (add CSS in style section)

- [ ] **Step 1: Add CSS for prompt-specific elements**

Add to the style section in `public/index.html`:

```css
/* Prompt cards */
.card.clickable { cursor: pointer; transition: border-color 0.2s; }
.card.clickable:hover { border-color: var(--accent, #58a6ff); }
.card-title { font-size: 14px; line-height: 1.4; margin-bottom: 8px; }
.card-meta {
  display: flex; gap: 16px; font-size: 12px;
  color: var(--text-muted, #8b949e); margin-bottom: 10px; flex-wrap: wrap;
}
.badge-row { display: flex; gap: 6px; flex-wrap: wrap; }
.card-list { display: flex; flex-direction: column; gap: 10px; }

/* Filter bar */
.filter-bar {
  display: flex; gap: 12px; margin-bottom: 20px;
  align-items: center; flex-wrap: wrap;
}
.filter-input { flex: 1; min-width: 200px; }
.filter-select { min-width: 140px; }

/* Pagination */
.pagination {
  display: flex; justify-content: center; gap: 8px; margin-top: 20px;
}
.btn.active {
  background: var(--accent, #58a6ff); color: var(--bg, #0d1117);
}

/* Flow timeline */
.flow-timeline {
  border: 1px solid var(--border, #30363d); border-radius: 8px;
  overflow: hidden;
}
.flow-event {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-light, #21262d);
}
.flow-event:last-child { border-bottom: none; }
.flow-event.expanded { background: var(--bg-secondary, #161b22); }
.flow-seq {
  color: var(--text-muted, #8b949e); font-size: 11px;
  width: 20px; text-align: right;
}
.flow-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.flow-main { flex: 1; }
.flow-name { font-weight: 500; }
.flow-detail {
  color: var(--text-muted, #8b949e); margin-left: 8px;
}
.flow-duration { color: var(--text-dim, #484f58); font-size: 11px; }
.flow-status { font-size: 11px; width: 16px; }
.flow-detail-panel {
  padding: 12px 16px 12px 56px;
  border-bottom: 1px solid var(--border-light, #21262d);
  background: var(--bg, #0d1117);
  border-left: 3px solid var(--accent, #58a6ff);
}
.flow-detail-label {
  font-size: 12px; color: var(--text-muted, #8b949e);
  margin-bottom: 4px; font-weight: 600;
}
.flow-detail-pre {
  background: var(--bg-secondary, #161b22); padding: 8px 12px;
  border-radius: 4px; font-size: 11px; overflow-x: auto;
  margin: 0 0 8px 0; white-space: pre-wrap;
}

/* Prompt group headers in session detail */
.prompt-group-header {
  padding: 10px 16px;
  background: var(--bg-tertiary, #1a1f2b);
  border-bottom: 1px solid var(--border, #30363d);
  display: flex; justify-content: space-between; align-items: center;
}
.prompt-group-header.clickable { cursor: pointer; }
.prompt-group-header.clickable:hover {
  background: var(--bg-secondary, #161b22);
}
.prompt-group-text { font-weight: 500; font-size: 13px; }
.prompt-group-stats {
  font-size: 11px; color: var(--text-muted, #8b949e);
}

/* Prompt detail header */
.prompt-header { margin-bottom: 20px; }
.prompt-text { font-size: 16px; margin-bottom: 6px; line-height: 1.4; }
.back-link {
  color: var(--accent, #58a6ff); text-decoration: none; font-size: 13px;
  display: inline-block; margin-bottom: 12px;
}
```

- [ ] **Step 2: Verify all views look correct in browser**

Check:
1. `#prompts` — filter bar, summary, cards with badges
2. `#prompts/{id}` — header, flow timeline, expandable events
3. `#sessions/{id}` — grouped prompt headers

- [ ] **Step 3: Commit**

```
git add public/index.html
git commit -m "feat: add CSS styles for prompts views and flow timeline"
```

---

### Task 12: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `node --test test/`
Expected: ALL PASS

- [ ] **Step 2: Start server and verify end-to-end**

Run: `npm start`
Open: `http://localhost:3827`

Verify all flows:
1. Nav shows "Prompts" link
2. `#prompts` — loads with filters, summary cards, prompt cards
3. Click card — navigates to `#prompts/{id}` with flow timeline
4. Click event row — expands with tool_input/response
5. Session link in header — navigates to `#sessions/{id}`
6. `#sessions/{id}` — events grouped by prompt
7. Click prompt header in session — navigates to `#prompts/{id}`
8. Back link — returns to `#prompts`

- [ ] **Step 3: Run backfill on real data**

Run: `node scripts/op-backfill-prompts.js`
Verify: prompts appear in the list with real data from existing events.

- [ ] **Step 4: Take screenshots for verification**

Use browser to capture key views for visual verification.

- [ ] **Step 5: Final commit if any fixes needed**

```
git add -A
git commit -m "fix: integration fixes for prompt flow manager"
```

---

## Post-Implementation

Update `CLAUDE.md` to document:
- New `prompts` table in DB schema section
- New API endpoints (`GET /api/prompts`, `GET /api/prompts/:id`) in endpoints table
- New `prompts.js` module in directory structure
- Updated test count
