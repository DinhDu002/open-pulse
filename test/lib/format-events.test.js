'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatEventsForLLM } = require('../../src/lib/format-events');

describe('formatEventsForLLM', () => {
  it('formats basic tool call event', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: JSON.stringify({ file_path: 'src/server.js' }),
      tool_response: 'const fastify = require("fastify");',
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('1. [tool_call] Read [src/server.js]'));
    assert.ok(result.includes('const fastify'));
  });

  it('truncates long tool_response to 300 chars', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: '{}',
      tool_response: 'x'.repeat(500),
    }];
    const result = formatEventsForLLM(events);
    // Should contain truncated response + ellipsis indicator
    assert.ok(result.length < 500);
  });

  it('formats skill_invoke event', () => {
    const events = [{
      event_type: 'skill_invoke',
      name: 'tdd-workflow',
      tool_input: '{}',
      tool_response: 'Running tests...',
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('[skill_invoke] tdd-workflow'));
  });

  it('handles events with no tool_input or tool_response', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Bash',
      tool_input: null,
      tool_response: null,
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('1. [tool_call] Bash'));
  });

  it('extracts key fields from tool_input JSON', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Grep',
      tool_input: JSON.stringify({ pattern: 'loadSkillTemplate', path: 'src/' }),
      tool_response: 'match found',
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('[loadSkillTemplate]') || result.includes('[src/]'));
  });

  it('returns empty string for empty events array', () => {
    assert.equal(formatEventsForLLM([]), '');
  });
});
