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
    dbMod = require('../src/op-db');
    ingest = require('../src/op-ingest');
    db = dbMod.createDb(TEST_DB);
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const f of ['events.jsonl', 'sessions.jsonl', 'suggestions.jsonl']) {
      const p = path.join(TEST_DIR, 'data', f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const proc = p + '.processing';
      if (fs.existsSync(proc)) fs.unlinkSync(proc);
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

  it('ingestFile processes sessions.jsonl into DB', () => {
    const filePath = path.join(TEST_DIR, 'data', 'sessions.jsonl');
    const session = {
      session_id: 'ingest-sess-1', started_at: '2026-04-06T10:00:00Z',
      ended_at: '2026-04-06T10:05:00Z', working_directory: '/tmp', model: 'opus',
      total_input_tokens: 5000, total_output_tokens: 3000, total_cost_usd: 0.15,
    };
    fs.writeFileSync(filePath, JSON.stringify(session) + '\n');
    const result = ingest.ingestFile(db, filePath, 'sessions');
    assert.equal(result.processed, 1);
    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('ingest-sess-1');
    assert.ok(row);
    assert.equal(row.total_cost_usd, 0.15);
  });

  it('ingestFile processes suggestions.jsonl into DB', () => {
    const filePath = path.join(TEST_DIR, 'data', 'suggestions.jsonl');
    const suggestion = {
      id: 'sugg-ingest-1', created_at: '2026-04-06T10:00:00Z',
      type: 'hook', confidence: 0.8, description: 'test suggestion',
      evidence: '["session:abc"]', status: 'pending',
    };
    fs.writeFileSync(filePath, JSON.stringify(suggestion) + '\n');
    const result = ingest.ingestFile(db, filePath, 'suggestions');
    assert.equal(result.processed, 1);
    const rows = db.prepare('SELECT * FROM suggestions').all();
    assert.ok(rows.some(r => r.id === 'sugg-ingest-1'));
  });

  it('ingestFile skips empty/missing file', () => {
    const filePath = path.join(TEST_DIR, 'data', 'nonexistent.jsonl');
    const result = ingest.ingestFile(db, filePath, 'events');
    assert.equal(result.processed, 0);
    assert.equal(result.errors, 0);
  });

  it('ingestFile handles malformed lines', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    fs.writeFileSync(filePath, 'not json\n{"timestamp":"2026-04-06T10:00:00Z","session_id":"ok","event_type":"tool_call","name":"X","detail":null,"duration_ms":null,"success":null,"input_tokens":null,"output_tokens":null,"estimated_cost_usd":null,"working_directory":"/tmp","model":"opus","user_prompt":null}\n');
    const result = ingest.ingestFile(db, filePath, 'events');
    assert.equal(result.processed, 1);
    assert.equal(result.errors, 1);
  });
});
