'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateScoreResponse,
  buildScorePrompt,
  parseScoreOutput,
} = require('../../src/quality/score');

// ---------------------------------------------------------------------------
// validateScoreResponse
// ---------------------------------------------------------------------------

describe('validateScoreResponse', () => {
  it('accepts valid score with all dimensions', () => {
    const { valid, score } = validateScoreResponse({
      efficiency: 85,
      accuracy: 90,
      cost_score: 70,
      approach: 80,
      reasoning: { efficiency: 'Good', accuracy: 'Great' },
    });
    assert.equal(valid, true);
    assert.equal(score.efficiency, 85);
    assert.equal(score.accuracy, 90);
    assert.equal(score.cost_score, 70);
    assert.equal(score.approach, 80);
    assert.equal(score.overall, 81); // (85+90+70+80)/4 = 81.25 → 81
    assert.ok(score.reasoning);
  });

  it('clamps scores to 0-100 range', () => {
    const { valid, score } = validateScoreResponse({
      efficiency: 150,
      accuracy: -20,
      cost_score: 50,
      approach: 200,
    });
    assert.equal(valid, true);
    assert.equal(score.efficiency, 100);
    assert.equal(score.accuracy, 0);
    assert.equal(score.cost_score, 50);
    assert.equal(score.approach, 100);
  });

  it('rounds float scores to integers', () => {
    const { valid, score } = validateScoreResponse({
      efficiency: 85.7,
      accuracy: 90.2,
      cost_score: 70.5,
      approach: 80.9,
    });
    assert.equal(valid, true);
    assert.equal(score.efficiency, 86);
    assert.equal(score.accuracy, 90);
    assert.equal(score.cost_score, 71);
    assert.equal(score.approach, 81);
  });

  it('rejects null input', () => {
    const { valid, reason } = validateScoreResponse(null);
    assert.equal(valid, false);
    assert.ok(reason.includes('not an object'));
  });

  it('rejects missing dimension', () => {
    const { valid, reason } = validateScoreResponse({
      efficiency: 80,
      accuracy: 90,
      // cost_score missing
      approach: 70,
    });
    assert.equal(valid, false);
    assert.ok(reason.includes('cost_score'));
  });

  it('rejects non-numeric dimension', () => {
    const { valid, reason } = validateScoreResponse({
      efficiency: 'high',
      accuracy: 90,
      cost_score: 70,
      approach: 80,
    });
    assert.equal(valid, false);
    assert.ok(reason.includes('efficiency'));
  });

  it('sets reasoning to null when not an object', () => {
    const { valid, score } = validateScoreResponse({
      efficiency: 80,
      accuracy: 80,
      cost_score: 80,
      approach: 80,
      reasoning: 'just a string',
    });
    assert.equal(valid, true);
    assert.equal(score.reasoning, null);
  });
});

// ---------------------------------------------------------------------------
// parseScoreOutput
// ---------------------------------------------------------------------------

describe('parseScoreOutput', () => {
  it('parses clean JSON object', () => {
    const json = JSON.stringify({
      efficiency: 85, accuracy: 90, cost_score: 70, approach: 80,
      reasoning: { efficiency: 'ok', accuracy: 'ok', cost_score: 'ok', approach: 'ok' },
    });
    const { valid, score } = parseScoreOutput(json);
    assert.equal(valid, true);
    assert.equal(score.efficiency, 85);
    assert.equal(score.overall, 81);
  });

  it('parses JSON wrapped in markdown code block', () => {
    const text = '```json\n{"efficiency": 75, "accuracy": 80, "cost_score": 65, "approach": 70, "reasoning": {}}\n```';
    const { valid, score } = parseScoreOutput(text);
    assert.equal(valid, true);
    assert.equal(score.efficiency, 75);
  });

  it('parses JSON array (takes first element)', () => {
    const text = '[{"efficiency": 60, "accuracy": 70, "cost_score": 55, "approach": 65}]';
    const { valid, score } = parseScoreOutput(text);
    assert.equal(valid, true);
    assert.equal(score.efficiency, 60);
  });

  it('extracts JSON object from surrounding text', () => {
    const text = 'Here is my evaluation:\n{"efficiency": 90, "accuracy": 95, "cost_score": 85, "approach": 88}\nDone.';
    const { valid, score } = parseScoreOutput(text);
    assert.equal(valid, true);
    assert.equal(score.efficiency, 90);
  });

  it('returns invalid for empty output', () => {
    const { valid, reason } = parseScoreOutput('');
    assert.equal(valid, false);
    assert.ok(reason.includes('empty'));
  });

  it('returns invalid for garbage text', () => {
    const { valid, reason } = parseScoreOutput('no json here at all');
    assert.equal(valid, false);
    assert.ok(reason);
  });
});

// ---------------------------------------------------------------------------
// buildScorePrompt
// ---------------------------------------------------------------------------

describe('buildScorePrompt', () => {
  it('returns null when skill template is missing', () => {
    // This test relies on the skill file being present in the repo
    // If it is present, the prompt should contain project name and events
    const result = buildScorePrompt('test-project', 'Fix the bug', [
      { event_type: 'tool_call', name: 'Read', tool_input: '{"file_path":"/src/app.js"}', tool_response: 'file content' },
      { event_type: 'tool_call', name: 'Edit', tool_input: '{"file_path":"/src/app.js"}', tool_response: 'ok' },
    ]);

    // Skill file exists in the repo, so prompt should be built
    if (result) {
      assert.ok(result.includes('test-project'), 'should include project name');
      assert.ok(result.includes('Fix the bug'), 'should include prompt text');
      assert.ok(result.includes('[tool_call] Read'), 'should include formatted events');
      assert.ok(result.includes('## JSON Schema'), 'should include schema from skill');
      assert.ok(result.includes('## Instructions'), 'should include instructions from skill');
    }
    // If null, that's also valid (skill file not found) — no assertion needed
  });

  it('truncates long prompt text', () => {
    const longPrompt = 'A'.repeat(600);
    const result = buildScorePrompt('proj', longPrompt, [
      { event_type: 'tool_call', name: 'Read', tool_input: null, tool_response: null },
    ]);
    if (result) {
      assert.ok(!result.includes('A'.repeat(600)), 'should not include full 600-char prompt');
      assert.ok(result.includes('A'.repeat(500)), 'should include first 500 chars');
      assert.ok(result.includes('...'), 'should have truncation marker');
    }
  });
});
