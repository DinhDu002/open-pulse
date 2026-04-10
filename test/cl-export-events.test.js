'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const { exportEvents, parseArgs } = require('../scripts/cl-export-events');

const TEST_DIR = path.join(os.tmpdir(), `cl-export-events-test-${Date.now()}`);
let dbPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedEvent(db, overrides = {}) {
  const defaults = {
    timestamp: new Date().toISOString(),
    session_id: 'sess-1',
    event_type: 'tool_call',
    name: 'Read',
    detail: null,
    tool_input: '{"file":"/tmp/a.js"}',
    tool_response: '{"ok":true}',
    user_prompt: null,
    seq_num: 1,
    success: 1,
    duration_ms: 100,
    working_directory: '/Users/test/project-a',
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO events (timestamp, session_id, event_type, name, detail,
      tool_input, tool_response, user_prompt, seq_num, success,
      duration_ms, working_directory)
    VALUES (@timestamp, @session_id, @event_type, @name, @detail,
      @tool_input, @tool_response, @user_prompt, @seq_num, @success,
      @duration_ms, @working_directory)
  `).run(row);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('cl-export-events', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbPath = path.join(TEST_DIR, 'test.db');
    const { createDb } = require('../src/op-db');
    const freshDb = createDb(dbPath);
    freshDb.close();
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── ASC ordering ────────────────────────────────────────────────────────

  it('exports events in ascending chronological order', () => {
    const db = new Database(dbPath);
    try {
      db.exec('DELETE FROM events');
      seedEvent(db, { timestamp: '2026-04-01T10:00:00Z', seq_num: 1 });
      seedEvent(db, { timestamp: '2026-04-01T10:01:00Z', seq_num: 2 });
      seedEvent(db, { timestamp: '2026-04-01T10:02:00Z', seq_num: 3 });
    } finally {
      db.close();
    }

    const events = exportEvents(dbPath, null, null, 100);
    assert.equal(events.length, 3);
    assert.equal(events[0].timestamp, '2026-04-01T10:00:00Z');
    assert.equal(events[2].timestamp, '2026-04-01T10:02:00Z');
  });

  // ── since filter ────────────────────────────────────────────────────────

  it('respects --since filter with strict inequality', () => {
    const db = new Database(dbPath);
    try {
      db.exec('DELETE FROM events');
      seedEvent(db, { timestamp: '2026-04-01T10:00:00Z', seq_num: 1 });
      seedEvent(db, { timestamp: '2026-04-01T10:01:00Z', seq_num: 2 });
      seedEvent(db, { timestamp: '2026-04-01T10:02:00Z', seq_num: 3 });
      seedEvent(db, { timestamp: '2026-04-01T10:03:00Z', seq_num: 4 });
    } finally {
      db.close();
    }

    const events = exportEvents(dbPath, null, '2026-04-01T10:01:00Z', 100);
    assert.equal(events.length, 2);
    assert.equal(events[0].timestamp, '2026-04-01T10:02:00Z');
    assert.equal(events[1].timestamp, '2026-04-01T10:03:00Z');
  });

  // ── ASC + LIMIT takes oldest ───────────────────────────────────────────

  it('ASC + LIMIT returns oldest events, not newest', () => {
    const db = new Database(dbPath);
    try {
      db.exec('DELETE FROM events');
      for (let i = 1; i <= 10; i++) {
        const mm = String(i).padStart(2, '0');
        seedEvent(db, { timestamp: `2026-04-01T10:${mm}:00Z`, seq_num: i });
      }
    } finally {
      db.close();
    }

    const events = exportEvents(dbPath, null, null, 5);
    assert.equal(events.length, 5);
    assert.equal(events[0].timestamp, '2026-04-01T10:01:00Z');
    assert.equal(events[4].timestamp, '2026-04-01T10:05:00Z');
  });

  // ── project root filter ────────────────────────────────────────────────

  it('filters by project root working_directory', () => {
    const db = new Database(dbPath);
    try {
      db.exec('DELETE FROM events');
      seedEvent(db, { working_directory: '/proj/a/src', seq_num: 1, timestamp: '2026-04-01T10:00:00Z' });
      seedEvent(db, { working_directory: '/proj/a/test', seq_num: 2, timestamp: '2026-04-01T10:01:00Z' });
      seedEvent(db, { working_directory: '/proj/b/src', seq_num: 3, timestamp: '2026-04-01T10:02:00Z' });
    } finally {
      db.close();
    }

    const events = exportEvents(dbPath, '/proj/a', null, 100);
    assert.equal(events.length, 2);

    const eventsB = exportEvents(dbPath, '/proj/b', null, 100);
    assert.equal(eventsB.length, 1);
  });

  // ── parseArgs ──────────────────────────────────────────────────────────

  it('parseArgs parses all flags correctly', () => {
    const args = parseArgs([
      'node', 'script',
      '--db', '/tmp/x.db',
      '--limit', '100',
      '--since', '2026-01-01T00:00:00Z',
      '--output', '/tmp/out.jsonl',
      '--project-root', '/proj/a',
    ]);
    assert.equal(args.db, '/tmp/x.db');
    assert.equal(args.limit, 100);
    assert.equal(args.since, '2026-01-01T00:00:00Z');
    assert.equal(args.output, '/tmp/out.jsonl');
    assert.equal(args.projectRoot, '/proj/a');
  });
});
