'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-collector-test-${Date.now()}`);

describe('op-collector', () => {
  let mod;

  before(() => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    mod = require('../collector/op-collector');
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const f of ['events.jsonl', 'sessions.jsonl']) {
      const p = path.join(TEST_DIR, 'data', f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('parseEvent returns tool_call for Read tool', () => {
    const event = mod.parseEvent('pre-tool', {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x.js' },
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.event_type, 'tool_call');
    assert.equal(event.name, 'Read');
    assert.equal(event.session_id, 'sess-1');
  });

  it('parseEvent returns skill_invoke for Skill tool', () => {
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Skill',
      tool_input: { skill: 'claude-code-knowledge', args: 'test' },
      duration_ms: 100,
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.event_type, 'skill_invoke');
    assert.equal(event.name, 'claude-code-knowledge');
    assert.equal(event.duration_ms, 100);
  });

  it('parseEvent returns agent_spawn for Agent tool', () => {
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'code-reviewer', description: 'review code' },
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.event_type, 'agent_spawn');
    assert.equal(event.name, 'code-reviewer');
  });

  it('parseEvent returns session_end for stop hook', () => {
    const event = mod.parseEvent('stop', {
      usage: { input_tokens: 5000, output_tokens: 3000 },
      cost_usd: 0.5,
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.event_type, 'session_end');
    assert.equal(event.input_tokens, 5000);
    assert.equal(event.estimated_cost_usd, 0.5);
  });

  it('estimateCost calculates opus rate', () => {
    const cost = mod.estimateCost('opus', 1000000, 500000);
    assert.equal(cost, 52.5);
  });

  it('appendToFile writes JSONL', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    mod.appendToFile(filePath, { type: 'test', value: 1 });
    mod.appendToFile(filePath, { type: 'test', value: 2 });
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { type: 'test', value: 1 });
  });
});
