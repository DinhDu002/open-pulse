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

  it('truncates long tool_response to 300 chars by default', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: '{}',
      tool_response: 'x'.repeat(500),
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.length < 500);
    assert.ok(result.includes('…'));
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

  it('returns empty string for empty events array and no userPrompt', () => {
    assert.equal(formatEventsForLLM([]), '');
  });

  // --- opts.userPrompt -------------------------------------------------

  it('prepends userPrompt at the top of the block', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: JSON.stringify({ file_path: 'a.js' }),
      tool_response: 'ok',
    }];
    const result = formatEventsForLLM(events, { userPrompt: 'fix the server bug' });
    assert.ok(result.startsWith('User prompt:'));
    assert.ok(result.includes('fix the server bug'));
    // userPrompt should appear exactly once
    const matches = result.match(/User prompt:/g) || [];
    assert.equal(matches.length, 1);
  });

  it('skips userPrompt line when string is empty or whitespace', () => {
    const events = [{
      event_type: 'tool_call', name: 'Read',
      tool_input: '{}', tool_response: 'ok',
    }];
    const result = formatEventsForLLM(events, { userPrompt: '   ' });
    assert.ok(!result.includes('User prompt:'));
  });

  it('handles userPrompt with no events', () => {
    const result = formatEventsForLLM([], { userPrompt: 'hello' });
    assert.ok(result.includes('User prompt:'));
    assert.ok(result.includes('hello'));
  });

  // --- Edit/Write diff segments ----------------------------------------

  it('renders old/new diff segments for Edit events', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Edit',
      tool_input: JSON.stringify({
        file_path: 'src/foo.js',
        old_string: 'const a = 1;',
        new_string: 'const a = 42;',
      }),
      tool_response: 'edited',
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('- const a = 1;'));
    assert.ok(result.includes('+ const a = 42;'));
  });

  it('truncates long diff segments to editDiffChars', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Edit',
      tool_input: JSON.stringify({
        file_path: 'f.js',
        old_string: 'o'.repeat(400),
        new_string: 'n'.repeat(400),
      }),
      tool_response: 'edited',
    }];
    const result = formatEventsForLLM(events, { editDiffChars: 50 });
    assert.ok(!result.includes('o'.repeat(100)));
    assert.ok(!result.includes('n'.repeat(100)));
    assert.ok(result.includes('…'));
  });

  it('renders content as new segment for Write events', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Write',
      tool_input: JSON.stringify({
        file_path: 'src/new.js',
        content: 'module.exports = {};',
      }),
      tool_response: 'written',
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('+ module.exports = {};'));
  });

  // --- Bash stderr -----------------------------------------------------

  it('appends stderr line for Bash events when non-empty', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Bash',
      tool_input: JSON.stringify({ command: 'npm test' }),
      tool_response: JSON.stringify({ stdout: 'ok', stderr: 'Warning: deprecated API' }),
    }];
    const result = formatEventsForLLM(events);
    assert.ok(result.includes('stderr: Warning: deprecated API'));
  });

  it('omits stderr line when empty', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls' }),
      tool_response: JSON.stringify({ stdout: 'file.js', stderr: '' }),
    }];
    const result = formatEventsForLLM(events);
    assert.ok(!result.includes('stderr:'));
  });

  // --- total budget cap ------------------------------------------------

  it('caps total block length around totalBudget on large inputs', () => {
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push({
        event_type: 'tool_call',
        name: 'Read',
        tool_input: JSON.stringify({ file_path: `f${i}.js` }),
        tool_response: 'x'.repeat(1000),
      });
    }
    const result = formatEventsForLLM(events, { totalBudget: 2000 });
    // Should be shorter than unbudgeted output; allow overhead for line prefixes.
    assert.ok(result.length < 5000, `expected reduced output, got ${result.length}`);
  });
});
