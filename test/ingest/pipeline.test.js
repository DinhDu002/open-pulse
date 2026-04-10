'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-ingest-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-ingest', () => {
  let db, ingest, dbMod;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    dbMod = require('../../src/op-db');
    ingest = require('../../src/ingest/pipeline');
    db = dbMod.createDb(TEST_DB);
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const f of ['events.jsonl']) {
      const p = path.join(TEST_DIR, 'data', f);
      for (const suffix of ['', '.processing', '.retries', '.failed']) {
        const fp = p + suffix;
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    }
  });

  it('ingestFile processes events.jsonl into DB', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const event = {
      timestamp: '2026-04-06T10:00:00Z', session_id: 'ingest-test-1',
      event_type: 'tool_call', name: 'Read', detail: null,
      duration_ms: 50, success: 1, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, working_directory: '/tmp', model: 'opus', user_prompt: null,
    };
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
    const result = ingest.ingestFile(db, filePath, 'events');
    assert.equal(result.processed, 1);
    assert.equal(result.errors, 0);
    assert.ok(!fs.existsSync(filePath + '.processing'));
    const rows = db.prepare('SELECT * FROM events WHERE session_id = ?').all('ingest-test-1');
    assert.equal(rows.length, 1);
  });

  it('ingestFile skips empty/missing file', () => {
    const filePath = path.join(TEST_DIR, 'data', 'nonexistent.jsonl');
    const result = ingest.ingestFile(db, filePath, 'events');
    assert.equal(result.processed, 0);
    assert.equal(result.errors, 0);
  });

  it('ingestFile stores tool_input, tool_response, seq_num from events', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const event = {
      timestamp: '2026-04-06T12:00:00Z', session_id: 'new-fields-1',
      event_type: 'tool_call', name: 'Bash', detail: 'npm test',
      duration_ms: 100, success: 1, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, working_directory: '/tmp', model: 'opus', user_prompt: 'run tests',
      tool_input: '{"command":"npm test"}', tool_response: 'All 37 tests passed', seq_num: 5,
    };
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
    ingest.ingestFile(db, filePath, 'events');
    const row = db.prepare('SELECT * FROM events WHERE session_id = ?').get('new-fields-1');
    assert.equal(row.tool_input, '{"command":"npm test"}');
    assert.equal(row.tool_response, 'All 37 tests passed');
    assert.equal(row.seq_num, 5);
  });

  it('ingestFile handles malformed lines', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    fs.writeFileSync(filePath, 'not json\n{"timestamp":"2026-04-06T10:00:00Z","session_id":"ok","event_type":"tool_call","name":"X","detail":null,"duration_ms":null,"success":null,"input_tokens":null,"output_tokens":null,"estimated_cost_usd":null,"working_directory":"/tmp","model":"opus","user_prompt":null}\n');
    const result = ingest.ingestFile(db, filePath, 'events');
    assert.equal(result.processed, 1);
    assert.equal(result.errors, 1);
  });

  it('ingestFile links events to prompts', () => {
    // Seed session so the prompts FK constraint is satisfied
    db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES ('sess-ingest-prompt', '2026-04-08T10:00:00Z')"
    ).run();

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

  it('ingestFile skips prompt linking for session_end with user_prompt', () => {
    db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at) VALUES ('sess-end-prompt', '2026-04-08T12:00:00Z')"
    ).run();

    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const events = [
      {
        timestamp: '2026-04-08T12:00:01Z',
        session_id: 'sess-end-prompt',
        event_type: 'tool_call',
        name: 'Read',
        user_prompt: 'fix the bug',
        seq_num: 1,
      },
      {
        timestamp: '2026-04-08T12:00:10Z',
        session_id: 'sess-end-prompt',
        event_type: 'session_end',
        name: 'session_end',
        user_prompt: 'fix the bug',
        seq_num: 2,
      },
    ];
    fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    ingest.ingestFile(db, filePath, 'events');

    const prompts = db.prepare(
      "SELECT * FROM prompts WHERE session_id = 'sess-end-prompt'"
    ).all();
    assert.equal(prompts.length, 1, 'session_end should not create a separate prompt');
    assert.equal(prompts[0].event_count, 1, 'only the tool_call event counts');

    const evts = db.prepare(
      "SELECT event_type, prompt_id FROM events WHERE session_id = 'sess-end-prompt' ORDER BY seq_num"
    ).all();
    assert.ok(evts[0].prompt_id !== null, 'tool_call should have prompt_id');
    assert.equal(evts[1].prompt_id, null, 'session_end should have prompt_id = NULL');
  });

  it('ingestFile creates session from session_end event in events.jsonl', () => {
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

  it('ingestFile distributes tokens to prompts after session_end', () => {
    const sid = 'sess-token-dist';
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');

    // Two prompts with different event counts
    const events = [
      { timestamp: '2026-04-09T11:00:00Z', session_id: sid, event_type: 'tool_call', name: 'Read', user_prompt: 'prompt A', working_directory: '/tmp', model: 'sonnet', seq_num: 1 },
      { timestamp: '2026-04-09T11:00:01Z', session_id: sid, event_type: 'tool_call', name: 'Grep', user_prompt: 'prompt A', working_directory: '/tmp', model: 'sonnet', seq_num: 2 },
      { timestamp: '2026-04-09T11:00:02Z', session_id: sid, event_type: 'tool_call', name: 'Edit', user_prompt: 'prompt A', working_directory: '/tmp', model: 'sonnet', seq_num: 3 },
      { timestamp: '2026-04-09T11:00:03Z', session_id: sid, event_type: 'tool_call', name: 'Bash', user_prompt: 'prompt B', working_directory: '/tmp', model: 'sonnet', seq_num: 4 },
      { timestamp: '2026-04-09T11:00:10Z', session_id: sid, event_type: 'session_end', input_tokens: 60000, output_tokens: 40000, estimated_cost_usd: 0.5, working_directory: '/tmp', model: 'sonnet', seq_num: 5 },
    ];
    fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    ingest.ingestFile(db, filePath, 'events');

    const prompts = db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY id').all(sid);
    assert.equal(prompts.length, 2);

    // Prompt A: 3 events out of 4 → 75% of 100K tokens = 75000
    // Prompt B: 1 event  out of 4 → 25% of 100K tokens = 25000
    assert.equal(prompts[0].total_tokens, 75000);
    assert.equal(prompts[1].total_tokens, 25000);
  });

  it('ingestFile populates project_name from cl_projects', () => {
    // Seed a cl_project
    db.prepare(`
      INSERT OR IGNORE INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
      VALUES ('ing-proj', 'test-project', '/tmp/test-project', '2026-01-01', '2026-01-01', 1)
    `).run();

    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const event = {
      timestamp: '2026-04-10T10:00:00Z', session_id: 'proj-test-1',
      event_type: 'skill_invoke', name: 'brainstorming', detail: null,
      duration_ms: 50, success: 1,
      working_directory: '/tmp/test-project', model: 'opus',
    };
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
    ingest.ingestFile(db, filePath, 'events');

    const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'proj-test-1'").get();
    assert.equal(row.project_name, 'test-project');
  });

  it('ingestFile uses basename fallback when no cl_project match', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const event = {
      timestamp: '2026-04-10T10:01:00Z', session_id: 'proj-test-2',
      event_type: 'agent_spawn', name: 'Explore', detail: null,
      duration_ms: 50, success: 1,
      working_directory: '/tmp/no-match-dir', model: 'opus',
    };
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
    ingest.ingestFile(db, filePath, 'events');

    const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'proj-test-2'").get();
    assert.equal(row.project_name, 'no-match-dir');
  });

  it('ingestAll does not process sessions.jsonl', () => {
    const sessPath = path.join(TEST_DIR, 'data', 'sessions.jsonl');
    fs.writeFileSync(sessPath, JSON.stringify({
      session_id: 'ignored-sess', started_at: '2026-04-09T10:00:00Z',
      working_directory: '/tmp', model: 'opus',
      total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.05,
    }) + '\n');

    const results = ingest.ingestAll(db, path.join(TEST_DIR, 'data'));

    assert.equal(results.sessions, undefined, 'sessions key should not exist');
    assert.ok(fs.existsSync(sessPath), 'sessions.jsonl should not be consumed');

    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('ignored-sess');
    assert.equal(row, undefined, 'should not insert from sessions.jsonl');
  });

  // -------------------------------------------------------------------------
  // Retry logic — fix race condition where .processing rename-back overwrites
  // new .jsonl created by collector during processing
  // -------------------------------------------------------------------------

  describe('retry logic', () => {
    it('processes leftover .processing before new .jsonl', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';

      const old = { timestamp: '2026-04-06T10:00:00Z', session_id: 'retry-old',
        event_type: 'tool_call', name: 'Read' };
      fs.writeFileSync(procPath, JSON.stringify(old) + '\n');

      const fresh = { timestamp: '2026-04-06T10:01:00Z', session_id: 'retry-new',
        event_type: 'tool_call', name: 'Write' };
      fs.writeFileSync(jsonlPath, JSON.stringify(fresh) + '\n');

      const result = ingest.ingestFile(db, jsonlPath, 'events');
      assert.equal(result.processed, 2);

      const rows = db.prepare(
        "SELECT session_id FROM events WHERE session_id IN ('retry-old','retry-new')"
      ).all();
      assert.equal(rows.length, 2);
      assert.ok(!fs.existsSync(procPath));
      assert.ok(!fs.existsSync(jsonlPath));
    });

    it('cleans up .retries file on successful retry', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';
      const retriesPath = jsonlPath + '.retries';

      fs.writeFileSync(retriesPath, JSON.stringify({ count: 2 }));
      const event = { timestamp: '2026-04-06T10:00:00Z', session_id: 'retry-cleanup',
        event_type: 'tool_call', name: 'Read' };
      fs.writeFileSync(procPath, JSON.stringify(event) + '\n');

      ingest.ingestFile(db, jsonlPath, 'events');

      assert.ok(!fs.existsSync(retriesPath));
      assert.ok(!fs.existsSync(procPath));
    });

    it('moves .processing to .failed after MAX_RETRIES', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';
      const retriesPath = jsonlPath + '.retries';
      const failedPath = jsonlPath + '.failed';

      fs.writeFileSync(retriesPath, JSON.stringify({ count: 3 }));
      fs.writeFileSync(procPath, 'corrupt data\n');

      const result = ingest.ingestFile(db, jsonlPath, 'events');

      assert.ok(!fs.existsSync(procPath), '.processing should be gone');
      assert.ok(!fs.existsSync(retriesPath), '.retries should be cleaned up');
      assert.ok(fs.existsSync(failedPath), '.failed should exist');
      assert.equal(result.processed, 0);
    });

    it('processes new .jsonl after .processing moved to .failed', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';
      const retriesPath = jsonlPath + '.retries';

      fs.writeFileSync(retriesPath, JSON.stringify({ count: 3 }));
      fs.writeFileSync(procPath, 'corrupt data\n');

      const event = { timestamp: '2026-04-06T10:00:00Z', session_id: 'after-failed',
        event_type: 'tool_call', name: 'Read' };
      fs.writeFileSync(jsonlPath, JSON.stringify(event) + '\n');

      const result = ingest.ingestFile(db, jsonlPath, 'events');
      assert.equal(result.processed, 1);

      const row = db.prepare('SELECT * FROM events WHERE session_id = ?').get('after-failed');
      assert.ok(row);
    });

    it('increments retry count on processing failure', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';
      const retriesPath = jsonlPath + '.retries';

      const event = { timestamp: '2026-04-06T10:00:00Z', session_id: 'fail-retry',
        event_type: 'tool_call', name: 'X' };
      fs.writeFileSync(procPath, JSON.stringify(event) + '\n');

      // Closed DB forces failure
      const badDbPath = path.join(TEST_DIR, 'bad.db');
      const badDb = dbMod.createDb(badDbPath);
      badDb.close();

      assert.throws(() => ingest.ingestFile(badDb, jsonlPath, 'events'));

      assert.ok(fs.existsSync(procPath), '.processing should remain');
      const retries = JSON.parse(fs.readFileSync(retriesPath, 'utf8'));
      assert.equal(retries.count, 1);
    });

    it('creates .retries on first failure of new .jsonl', () => {
      const jsonlPath = path.join(TEST_DIR, 'data', 'events.jsonl');
      const procPath = jsonlPath + '.processing';
      const retriesPath = jsonlPath + '.retries';

      const event = { timestamp: '2026-04-06T10:00:00Z', session_id: 'first-fail',
        event_type: 'tool_call', name: 'X' };
      fs.writeFileSync(jsonlPath, JSON.stringify(event) + '\n');

      const badDbPath = path.join(TEST_DIR, 'bad2.db');
      const badDb = dbMod.createDb(badDbPath);
      badDb.close();

      assert.throws(() => ingest.ingestFile(badDb, jsonlPath, 'events'));

      assert.ok(!fs.existsSync(jsonlPath), '.jsonl should have been renamed');
      assert.ok(fs.existsSync(procPath), '.processing should remain');
      const retries = JSON.parse(fs.readFileSync(retriesPath, 'utf8'));
      assert.equal(retries.count, 1);
    });
  });
});
