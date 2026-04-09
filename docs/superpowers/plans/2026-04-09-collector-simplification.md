# Collector Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate dual JSONL streams into one, eliminate mutable .seq-* state files, and clean-break the DB.

**Architecture:** Collector writes only `events.jsonl` (single stream). Ingest creates sessions from `session_end` events instead of reading a separate `sessions.jsonl`. Sequence numbers use `Date.now()` (monotonic, no file I/O) instead of per-session `.seq-*` files.

**Tech Stack:** Node.js, better-sqlite3, node:test

---

### Task 1: Replace nextSeqNum with timestamp-based seq_num

**Files:**
- Modify: `collector/op-collector.js:66-79` (nextSeqNum function)
- Test: `test/op-collector.test.js:170-177` (nextSeqNum test)

- [ ] **Step 1: Write the failing test**

Replace the existing `nextSeqNum` test in `test/op-collector.test.js`:

```javascript
it('nextSeqNum returns timestamp-based monotonic values', () => {
  const n1 = mod.nextSeqNum();
  const n2 = mod.nextSeqNum();
  assert.ok(typeof n1 === 'number');
  assert.ok(n1 > 1700000000000, 'should be a ms timestamp');
  assert.ok(n2 >= n1, 'should be monotonically increasing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-collector.test.js`
Expected: FAIL — current nextSeqNum requires (repoDir, sessionId) args and returns small integers.

- [ ] **Step 3: Write minimal implementation**

Replace `nextSeqNum` in `collector/op-collector.js`:

```javascript
/**
 * Generate a monotonic sequence number using millisecond timestamp.
 * No file I/O — eliminates .seq-* state files.
 * @returns {number}
 */
function nextSeqNum() {
  return Date.now();
}
```

Update the call site in `main()` (line 343):

```javascript
const seqNum = nextSeqNum();
```

Update the module.exports — remove `nextSeqNum` from exports (it's now an internal detail), or keep it for test access. Keep it exported for test access.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-collector.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add collector/op-collector.js test/op-collector.test.js
git commit -m "refactor: replace .seq-* file counter with timestamp-based seq_num"
```

---

### Task 2: Remove sessions.jsonl writing from collector

**Files:**
- Modify: `collector/op-collector.js:349-362` (stop hook sessions.jsonl block)
- Test: `test/op-collector.test.js`

- [ ] **Step 1: Write the failing test**

Add test in `test/op-collector.test.js`:

```javascript
it('stop hook does not write sessions.jsonl', () => {
  const event = mod.parseEvent('stop', {
    usage: { input_tokens: 5000, output_tokens: 3000 },
    cost_usd: 0.5,
  }, 'sess-no-session-file', '/tmp', 'opus');

  // Simulate what main() does: write event to events.jsonl
  mod.appendToFile(path.join(TEST_DIR, 'data', 'events.jsonl'), event);

  // sessions.jsonl should NOT exist
  const sessionsPath = path.join(TEST_DIR, 'data', 'sessions.jsonl');
  assert.ok(!fs.existsSync(sessionsPath), 'sessions.jsonl must not be created');
});
```

This test already passes (test doesn't call main(), just simulates). Instead, verify by checking the source: the sessions.jsonl block should be gone. Since we can't test main() easily (it reads stdin), we verify by checking that sessions.jsonl is not referenced in the module.

Actually, write a test that verifies the export surface:

```javascript
it('module does not export session-file helpers', () => {
  // After refactor, sessions.jsonl logic is removed
  // Verify the stop event still has all fields needed by ingest
  const event = mod.parseEvent('stop', {
    usage: { input_tokens: 5000, output_tokens: 3000 },
    cost_usd: 0.5,
  }, 'sess-1', '/tmp', 'opus');

  // These fields let ingest create the session from the event
  assert.equal(event.event_type, 'session_end');
  assert.equal(event.session_id, 'sess-1');
  assert.equal(event.input_tokens, 5000);
  assert.equal(event.output_tokens, 3000);
  assert.equal(event.estimated_cost_usd, 0.5);
  assert.ok(event.timestamp);
});
```

- [ ] **Step 2: Run test to verify it passes (pre-existing behavior)**

Run: `node --test test/op-collector.test.js`
Expected: PASS (the event fields are already correct)

- [ ] **Step 3: Remove sessions.jsonl writing**

In `collector/op-collector.js`, delete the entire block inside `if (hookType === 'stop')` (lines 349-362) that writes to sessions.jsonl:

```javascript
    // DELETE THIS ENTIRE BLOCK:
    // ── stop: also write session summary ──────────────────────────────────
    if (hookType === 'stop') {
      const session = {
        session_id:          sessionId,
        ended_at:            event.ts,
        working_directory:   workDir,
        model,
        total_input_tokens:  event.input_tokens,
        total_output_tokens: event.output_tokens,
        total_cost_usd:      event.estimated_cost_usd,
        last_prompt:         readLastPrompt(repoDir, sessionId),
      };
      appendToFile(path.join(repoDir, 'data', 'sessions.jsonl'), session);
      cleanLastPrompt(repoDir, sessionId);
    }
```

Keep `cleanLastPrompt` but move it outside the deleted block — it should still run on stop to clean up `.last-prompt-*` files. The code after deletion should look like:

```javascript
    appendToFile(path.join(repoDir, 'data', 'events.jsonl'), eventWithPrompt);

    // Clean up per-session prompt file when session ends
    if (hookType === 'stop') {
      cleanLastPrompt(repoDir, sessionId);
    }
  } catch (err) {
```

- [ ] **Step 4: Update beforeEach cleanup in test**

In `test/op-collector.test.js`, update `beforeEach` (line 23-28) — remove `sessions.jsonl` from cleanup:

```javascript
beforeEach(() => {
  const p = path.join(TEST_DIR, 'data', 'events.jsonl');
  if (fs.existsSync(p)) fs.unlinkSync(p);
});
```

- [ ] **Step 5: Run all collector tests**

Run: `node --test test/op-collector.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add collector/op-collector.js test/op-collector.test.js
git commit -m "refactor: remove sessions.jsonl writing from collector"
```

---

### Task 3: Update ingest to create sessions from session_end events

**Files:**
- Modify: `src/op-ingest.js:35-46` (normaliseSession), `src/op-ingest.js:70-93` (upsertSessionFull), `src/op-ingest.js:179-197` (processContent), `src/op-ingest.js:273-280` (ingestAll)
- Test: `test/op-ingest.test.js`

- [ ] **Step 1: Write the failing test**

Add test in `test/op-ingest.test.js`:

```javascript
it('ingestFile creates session from session_end event in events.jsonl', () => {
  // Seed a session first (ingest expects session for prompt linking)
  // Actually — the new code should create the session FROM the event.
  const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
  const events = [
    {
      timestamp: '2026-04-09T10:00:01Z',
      session_id: 'sess-from-event',
      event_type: 'tool_call',
      name: 'Read',
      working_directory: '/projects/app',
      model: 'opus',
      seq_num: 1712000000001,
    },
    {
      timestamp: '2026-04-09T10:00:05Z',
      session_id: 'sess-from-event',
      event_type: 'session_end',
      name: null,
      input_tokens: 8000,
      output_tokens: 4000,
      estimated_cost_usd: 0.25,
      working_directory: '/projects/app',
      model: 'opus',
      seq_num: 1712000000005,
    },
  ];
  fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const result = ingest.ingestFile(db, filePath, 'events');
  assert.equal(result.processed, 2);

  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-from-event');
  assert.ok(session, 'session should be created from session_end event');
  assert.equal(session.working_directory, '/projects/app');
  assert.equal(session.model, 'opus');
  assert.equal(session.total_input_tokens, 8000);
  assert.equal(session.total_output_tokens, 4000);
  assert.equal(session.total_cost_usd, 0.25);
  assert.equal(session.ended_at, '2026-04-09T10:00:05Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-ingest.test.js`
Expected: FAIL — currently ingest only creates sessions from sessions.jsonl, not from events.

- [ ] **Step 3: Implement session upsert from events**

In `src/op-ingest.js`, modify `processContent` for `type === 'events'`:

```javascript
function processContent(db, processingPath, type) {
  const content = fs.readFileSync(processingPath, 'utf8');
  const { rows, errors } = parseJsonl(content);

  if (rows.length > 0) {
    if (type === 'events') {
      const events = rows.map(normaliseEvent);

      // Upsert sessions from events (so prompt linking can find them)
      const sessionMap = new Map();
      for (const evt of events) {
        if (!evt.session_id) continue;
        if (!sessionMap.has(evt.session_id)) {
          sessionMap.set(evt.session_id, {
            session_id: evt.session_id,
            started_at: evt.timestamp,
            working_directory: evt.working_directory,
            model: evt.model,
          });
        }
      }
      if (sessionMap.size > 0) {
        upsertSessionBatch(db, [...sessionMap.values()]);
      }

      // Update session end fields from session_end events
      for (const evt of events) {
        if (evt.event_type === 'session_end' && evt.session_id) {
          updateSessionEnd(db, {
            session_id: evt.session_id,
            ended_at: evt.timestamp,
            total_tool_calls: 0,
            total_skill_invokes: 0,
            total_agent_spawns: 0,
            total_input_tokens: evt.input_tokens || 0,
            total_output_tokens: evt.output_tokens || 0,
            total_cost_usd: evt.estimated_cost_usd || 0,
          });
        }
      }

      linkEventsToPrompts(db, events);
      insertEventBatch(db, events);
      updatePromptStatsAfterInsert(db, events);
    } else if (type === 'suggestions') {
      insertSuggestionBatch(db, rows.map(normaliseSuggestion));
    }
  }

  return { processed: rows.length, errors };
}
```

Add `updateSessionEnd` to the imports at the top of the file:

```javascript
const {
  insertEventBatch, upsertSessionBatch, updateSessionEnd, insertSuggestionBatch,
  insertPrompt, getLatestPromptForSession, updatePromptStats,
} = require('./op-db');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-ingest.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/op-ingest.js test/op-ingest.test.js
git commit -m "feat: create sessions from session_end events in ingest pipeline"
```

---

### Task 4: Remove sessions.jsonl processing from ingest

**Files:**
- Modify: `src/op-ingest.js:35-93` (normaliseSession, upsertSessionFull), `src/op-ingest.js:273-280` (ingestAll)
- Test: `test/op-ingest.test.js`

- [ ] **Step 1: Write the failing test**

Add test in `test/op-ingest.test.js`:

```javascript
it('ingestAll does not process sessions.jsonl', () => {
  // Write a sessions.jsonl — it should be ignored
  const sessPath = path.join(TEST_DIR, 'data', 'sessions.jsonl');
  fs.writeFileSync(sessPath, JSON.stringify({
    session_id: 'ignored-sess', started_at: '2026-04-09T10:00:00Z',
    working_directory: '/tmp', model: 'opus',
    total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.05,
  }) + '\n');

  const results = ingest.ingestAll(db, path.join(TEST_DIR, 'data'));

  // sessions key should not exist in results
  assert.equal(results.sessions, undefined);
  // sessions.jsonl should still exist (not consumed)
  assert.ok(fs.existsSync(sessPath), 'sessions.jsonl should not be consumed');

  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('ignored-sess');
  assert.equal(row, undefined, 'should not insert from sessions.jsonl');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-ingest.test.js`
Expected: FAIL — current ingestAll processes 'sessions' type.

- [ ] **Step 3: Remove sessions processing from ingestAll**

In `src/op-ingest.js`, modify `ingestAll`:

```javascript
function ingestAll(db, dataDir) {
  const results = {};
  for (const type of ['events', 'suggestions']) {
    const filePath = path.join(dataDir, `${type}.jsonl`);
    results[type] = ingestFile(db, filePath, type);
  }
  return results;
}
```

Remove `normaliseSession` function (lines 35-46).
Remove `upsertSessionFull` function (lines 70-93).
Remove the `type === 'sessions'` branch from `processContent` (line 189-190).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-ingest.test.js`
Expected: PASS

- [ ] **Step 5: Remove obsolete sessions.jsonl tests**

Delete these tests from `test/op-ingest.test.js`:
- `'ingestFile processes sessions.jsonl into DB'` (line 54-67)
- `'ingestFile handles old-format session fields'` (line 83-98)

Update `beforeEach` (line 28) — remove `sessions.jsonl` from cleanup:

```javascript
beforeEach(() => {
  for (const f of ['events.jsonl', 'suggestions.jsonl']) {
    const p = path.join(TEST_DIR, 'data', f);
    for (const suffix of ['', '.processing', '.retries', '.failed']) {
      const fp = p + suffix;
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }
});
```

- [ ] **Step 6: Run all tests**

Run: `node --test test/op-ingest.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/op-ingest.js test/op-ingest.test.js
git commit -m "refactor: remove sessions.jsonl processing from ingest pipeline"
```

---

### Task 5: Create reset-db script

**Files:**
- Create: `scripts/reset-db.js`
- Test: manual verification

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');
const DB_PATH  = process.env.OPEN_PULSE_DB  || path.join(REPO_DIR, 'open-pulse.db');
const DATA_DIR = path.join(REPO_DIR, 'data');

console.log('Open Pulse — Clean Break DB Reset');
console.log('==================================');

// 1. Delete existing DB
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log(`Deleted: ${DB_PATH}`);
  // Also remove WAL/SHM files
  for (const suffix of ['-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`Deleted: ${f}`); }
  }
} else {
  console.log('No existing DB found.');
}

// 2. Recreate DB with fresh schema
const { createDb } = require('../src/op-db');
const db = createDb(DB_PATH);
db.close();
console.log(`Created: ${DB_PATH}`);

// 3. Clean up legacy .seq-* files
if (fs.existsSync(DATA_DIR)) {
  const seqFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('.seq-'));
  for (const f of seqFiles) {
    fs.unlinkSync(path.join(DATA_DIR, f));
  }
  if (seqFiles.length > 0) {
    console.log(`Cleaned up ${seqFiles.length} legacy .seq-* files`);
  }

  // 4. Clean up leftover JSONL files
  const jsonlFiles = fs.readdirSync(DATA_DIR).filter(f =>
    f.endsWith('.jsonl') || f.endsWith('.processing') || f.endsWith('.retries') || f.endsWith('.failed')
  );
  for (const f of jsonlFiles) {
    fs.unlinkSync(path.join(DATA_DIR, f));
  }
  if (jsonlFiles.length > 0) {
    console.log(`Cleaned up ${jsonlFiles.length} JSONL/state files`);
  }
}

console.log('Done. Fresh DB ready.');
```

- [ ] **Step 2: Add npm script**

In `package.json`, add to `"scripts"`:

```json
"reset-db": "node scripts/reset-db.js"
```

- [ ] **Step 3: Verify it works**

Run: `npm run reset-db`
Expected: Output shows deleted + created messages. DB file exists and is valid.

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-db.js package.json
git commit -m "feat: add reset-db script for clean break DB reset"
```

---

### Task 6: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass. No references to sessions.jsonl in test output.

- [ ] **Step 2: Integration test — start server and verify**

```bash
npm run reset-db
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/health | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log('status:',j.status);process.exit(j.status==='ok'?0:1)"
kill %1
```

Expected: Health check returns `status: ok`.

- [ ] **Step 3: Verify no leftover references**

```bash
grep -r 'sessions\.jsonl' src/ collector/ test/ --include='*.js' | grep -v node_modules
grep -r '\.seq-' src/ collector/ test/ --include='*.js' | grep -v node_modules
```

Expected: No matches in source/test files (only in docs/specs is acceptable).

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: final cleanup for collector simplification"
```

---

### Summary of Changes

| File | Action |
|---|---|
| `collector/op-collector.js` | Replace nextSeqNum (Date.now), remove sessions.jsonl block |
| `src/op-ingest.js` | Add session upsert from events, remove sessions type, remove normaliseSession/upsertSessionFull |
| `test/op-collector.test.js` | Update nextSeqNum test, remove sessions.jsonl cleanup |
| `test/op-ingest.test.js` | Add session-from-event test, remove sessions.jsonl tests |
| `scripts/reset-db.js` | New: clean break DB + cleanup .seq-*/JSONL files |
| `package.json` | Add reset-db script |
