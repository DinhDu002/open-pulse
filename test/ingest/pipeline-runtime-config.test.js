'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-runtime-config-${Date.now()}-${process.pid}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

const ORIGINAL_OPEN_PULSE_DIR = process.env.OPEN_PULSE_DIR;
process.env.OPEN_PULSE_DIR = TEST_DIR;

describe('pipeline — runtime config toggle (fresh read per ingest batch)', () => {
  let db, pipeline, dbMod;
  let counts;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    dbMod = require('../../src/db/schema');
    pipeline = require('../../src/ingest/pipeline');
    db = dbMod.createDb(TEST_DB);

    counts = { knowledge: 0, pattern: 0, quality: 0 };

    pipeline.setKnowledgeHook(() => { counts.knowledge++; return Promise.resolve(); }, {});
    pipeline.setPatternHook(() => { counts.pattern++; return Promise.resolve(); }, {});
    pipeline.setQualityHook(() => { counts.quality++; return Promise.resolve(); }, {});
  });

  after(() => {
    pipeline.setKnowledgeHook(null, null);
    pipeline.setPatternHook(null, null);
    pipeline.setQualityHook(null, null);
    if (db) db.close();
    if (ORIGINAL_OPEN_PULSE_DIR === undefined) delete process.env.OPEN_PULSE_DIR;
    else process.env.OPEN_PULSE_DIR = ORIGINAL_OPEN_PULSE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeConfig(overrides) {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify(overrides, null, 2),
      'utf8'
    );
  }

  async function ingestOnePrompt(sessionId, promptText) {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    const event = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      event_type: 'tool_call',
      name: 'Read',
      detail: null,
      duration_ms: 10,
      success: 1,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
      working_directory: '/tmp',
      model: 'opus',
      user_prompt: promptText,
    };
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
    pipeline.ingestFile(db, filePath, 'events');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  }

  it('hooks fire when flags are true in config.json', async () => {
    writeConfig({
      knowledge_enabled: true,
      pattern_detect_enabled: true,
      quality_scoring_enabled: true,
    });

    const before = { ...counts };
    await ingestOnePrompt('toggle-on-1', 'first prompt');

    assert.ok(counts.knowledge > before.knowledge, 'knowledge hook should fire');
    assert.ok(counts.pattern > before.pattern, 'pattern hook should fire');
    assert.ok(counts.quality > before.quality, 'quality hook should fire');
  });

  it('hooks do NOT fire after runtime edit sets flags to false — without restart', async () => {
    writeConfig({
      knowledge_enabled: false,
      pattern_detect_enabled: false,
      quality_scoring_enabled: false,
    });

    const before = { ...counts };
    await ingestOnePrompt('toggle-off-1', 'second prompt');

    assert.equal(counts.knowledge, before.knowledge, 'knowledge hook must not fire when flag=false');
    assert.equal(counts.pattern, before.pattern, 'pattern hook must not fire when flag=false');
    assert.equal(counts.quality, before.quality, 'quality hook must not fire when flag=false');
  });

  it('hooks fire again after flags flip back to true', async () => {
    writeConfig({
      knowledge_enabled: true,
      pattern_detect_enabled: true,
      quality_scoring_enabled: true,
    });

    const before = { ...counts };
    await ingestOnePrompt('toggle-on-2', 'third prompt');

    assert.ok(counts.knowledge > before.knowledge, 'knowledge hook should fire after re-enable');
    assert.ok(counts.pattern > before.pattern, 'pattern hook should fire after re-enable');
    assert.ok(counts.quality > before.quality, 'quality hook should fire after re-enable');
  });

  it('individual flag toggles are independent — quality off, pattern+knowledge on', async () => {
    writeConfig({
      knowledge_enabled: true,
      pattern_detect_enabled: true,
      quality_scoring_enabled: false,
    });

    const before = { ...counts };
    await ingestOnePrompt('toggle-mixed-1', 'fourth prompt');

    assert.ok(counts.knowledge > before.knowledge, 'knowledge should fire');
    assert.ok(counts.pattern > before.pattern, 'pattern should fire');
    assert.equal(counts.quality, before.quality, 'quality must not fire');
  });
});
