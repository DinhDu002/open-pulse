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
    const p = path.join(TEST_DIR, 'data', 'events.jsonl');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  it('parseEvent returns tool_call for Read tool', () => {
    const event = mod.parseEvent('post-tool', {
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

  it('parseEvent defaults to general-purpose when subagent_type missing', () => {
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Agent',
      tool_input: { description: 'do something', prompt: 'test' },
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.event_type, 'agent_spawn');
    assert.equal(event.name, 'general-purpose');
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

  it('stop event produces DB-compatible session fields', () => {
    const event = mod.parseEvent('stop', {
      usage: { input_tokens: 8000, output_tokens: 4000 },
      cost_usd: 0.25,
    }, 'sess-2', '/projects/app', 'sonnet');

    // Simulate what main() builds from the event
    const session = {
      session_id:          'sess-2',
      ended_at:            event.ts,
      working_directory:   '/projects/app',
      model:               'sonnet',
      total_input_tokens:  event.input_tokens,
      total_output_tokens: event.output_tokens,
      total_cost_usd:      event.estimated_cost_usd,
    };

    assert.ok(session.ended_at, 'ended_at must be set');
    assert.equal(session.working_directory, '/projects/app');
    assert.equal(session.total_input_tokens, 8000);
    assert.equal(session.total_output_tokens, 4000);
    assert.equal(session.total_cost_usd, 0.25);
  });

  it('user_prompt can be attached to events via spread', () => {
    // Simulates the pattern used in main() to attach user_prompt
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Skill',
      tool_input: { skill: 'commit', args: 'test' },
    }, 'sess-3', '/tmp', 'opus');

    // parseEvent does not include user_prompt
    assert.equal(event.user_prompt, undefined);

    // main() reads .last-prompt and attaches via spread
    const userPrompt = 'please commit my changes';
    const enriched = userPrompt ? { ...event, user_prompt: userPrompt } : event;
    assert.equal(enriched.user_prompt, 'please commit my changes');
    assert.equal(enriched.event_type, 'skill_invoke');
    assert.equal(enriched.name, 'commit');
  });

  it('appendToFile writes JSONL', () => {
    const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
    mod.appendToFile(filePath, { type: 'test', value: 1 });
    mod.appendToFile(filePath, { type: 'test', value: 2 });
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { type: 'test', value: 1 });
  });

  it('scrubSecrets redacts sensitive values', () => {
    assert.equal(
      mod.scrubSecrets('api_key: sk-abc123456789'),
      'api_key: [REDACTED]',
    );
    assert.equal(
      mod.scrubSecrets('token=ghp_xxxxxxxxxxxx'),
      'token= [REDACTED]',
    );
    assert.equal(
      mod.scrubSecrets('no secrets here'),
      'no secrets here',
    );
  });

  it('serializeToolData truncates and scrubs', () => {
    const data = { file_path: '/tmp/x', password: 'supersecret123' };
    const result = mod.serializeToolData(data);
    assert.ok(result.includes('/tmp/x'));
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('supersecret123'));
  });

  it('parseEvent includes tool_input, tool_response, seq_num, success', () => {
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'All tests passed',
      is_error: false,
    }, 'sess-1', '/tmp', 'opus', { seqNum: 3 });
    assert.equal(event.seq_num, 3);
    assert.equal(event.success, true);
    assert.ok(event.tool_input.includes('npm test'));
    assert.ok(event.tool_response.includes('All tests passed'));
  });

  it('parseEvent sets success null when is_error absent', () => {
    const event = mod.parseEvent('post-tool', {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    }, 'sess-1', '/tmp', 'opus');
    assert.equal(event.success, null);
  });

  it('nextSeqNum returns timestamp-based monotonic values', () => {
    const n1 = mod.nextSeqNum();
    const n2 = mod.nextSeqNum();
    assert.ok(typeof n1 === 'number');
    assert.ok(n1 > 1700000000000, 'should be a ms timestamp');
    assert.ok(n2 >= n1, 'should be monotonically increasing');
  });
});
