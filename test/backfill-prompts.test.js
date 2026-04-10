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

    // Insert sessions first (required by FK constraint on prompts)
    dbMod.upsertSession(db, { session_id: 'sess-bf-1', started_at: '2026-04-08T10:00:00Z', working_directory: null, model: null });
    dbMod.upsertSession(db, { session_id: 'sess-bf-2', started_at: '2026-04-08T11:00:00Z', working_directory: null, model: null });

    // Insert test events without prompt_id (simulating old data)
    const events = [
      { timestamp: '2026-04-08T10:00:01Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Read', user_prompt: 'add auth', seq_num: 1 },
      { timestamp: '2026-04-08T10:00:02Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Edit', user_prompt: 'add auth', seq_num: 2 },
      { timestamp: '2026-04-08T10:00:05Z', session_id: 'sess-bf-1',
        event_type: 'tool_call', name: 'Bash', user_prompt: 'run tests', seq_num: 3 },
      { timestamp: '2026-04-08T10:00:10Z', session_id: 'sess-bf-1',
        event_type: 'session_end', name: 'session_end', user_prompt: 'run tests', seq_num: 4 },
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
    assert.equal(result.prompts, 0);
    const prompts = db.prepare('SELECT * FROM prompts').all();
    assert.equal(prompts.length, 3);
  });

  it('links events to prompt_id', () => {
    const evts = db.prepare(
      "SELECT prompt_id, name FROM events WHERE session_id = 'sess-bf-1' ORDER BY seq_num"
    ).all();
    assert.ok(evts[0].prompt_id !== null);
    assert.equal(evts[0].prompt_id, evts[1].prompt_id);
    assert.notEqual(evts[1].prompt_id, evts[2].prompt_id);
    assert.equal(evts[3].prompt_id, null);
  });
});
