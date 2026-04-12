'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-retention-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-retention', () => {
  let db, dbMod, retention;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbMod = require('../src/db/schema');
    retention = require('../src/retention');
    db = dbMod.createDb(TEST_DB);
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('compacts tool_input/tool_response for warm events', () => {
    // Insert an event 10 days old with tool data
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, tool_response)
      VALUES (datetime('now', '-10 days'), 'ret-1', 'tool_call', 'Read',
              '{"file_path":"/tmp/x"}', 'file contents here')
    `).run();

    const result = retention.runRetention(db, { warmDays: 7, coldDays: 90 });
    assert.ok(result.compacted >= 1, 'should compact at least 1 event');

    const row = db.prepare("SELECT * FROM events WHERE session_id = 'ret-1'").get();
    assert.equal(row.tool_input, null, 'tool_input should be NULL after compaction');
    assert.equal(row.tool_response, null, 'tool_response should be NULL after compaction');
    assert.equal(row.name, 'Read', 'metadata should be preserved');
  });

  it('does not compact recent events', () => {
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, tool_response)
      VALUES (datetime('now', '-1 days'), 'ret-2', 'tool_call', 'Edit',
              '{"file_path":"/tmp/y"}', 'edit response')
    `).run();

    retention.runRetention(db, { warmDays: 7, coldDays: 90 });

    const row = db.prepare("SELECT * FROM events WHERE session_id = 'ret-2'").get();
    assert.ok(row.tool_input, 'recent event tool_input should be preserved');
    assert.ok(row.tool_response, 'recent event tool_response should be preserved');
  });

  it('deletes cold events older than coldDays', () => {
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name)
      VALUES (datetime('now', '-100 days'), 'ret-3', 'tool_call', 'Bash')
    `).run();

    const before = db.prepare("SELECT COUNT(*) as c FROM events WHERE session_id = 'ret-3'").get().c;
    assert.equal(before, 1);

    const result = retention.runRetention(db, { warmDays: 7, coldDays: 90 });
    assert.ok(result.deleted >= 1);

    const after = db.prepare("SELECT COUNT(*) as c FROM events WHERE session_id = 'ret-3'").get().c;
    assert.equal(after, 0, 'cold event should be deleted');
  });

  it('returns zero changes when nothing to process', () => {
    // Clear all events
    db.prepare('DELETE FROM events').run();

    const result = retention.runRetention(db, { warmDays: 7, coldDays: 90 });
    assert.equal(result.compacted, 0);
    assert.equal(result.deleted, 0);
  });

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

    retention.runRetention(db, { warmDays: 7, coldDays: 90 });

    const after = db.prepare('SELECT COUNT(*) AS c FROM pipeline_runs').get().c;
    assert.equal(after, 1, 'should delete the 100-day-old run');
  });
});
