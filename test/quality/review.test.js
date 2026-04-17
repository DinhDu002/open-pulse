'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  buildReviewPrompt,
  collectNotableEvents,
  parseReviewOutput,
} = require('../../src/quality/review');

const TEST_DIR = path.join(os.tmpdir(), `op-review-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

// ---------------------------------------------------------------------------
// parseReviewOutput (pure function, no DB needed)
// ---------------------------------------------------------------------------

describe('parseReviewOutput', () => {
  it('parses clean JSON with summary', () => {
    const json = JSON.stringify({
      summary: 'Good session.',
      strengths: ['TDD approach'],
      improvements: ['Reduce retries'],
      suggestions: ['Use agents more'],
    });
    const { valid, review } = parseReviewOutput(json);
    assert.equal(valid, true);
    assert.equal(review.summary, 'Good session.');
    assert.equal(review.strengths.length, 1);
  });

  it('parses JSON in fenced code block', () => {
    const text = '```json\n{"summary": "Decent session", "strengths": [], "improvements": [], "suggestions": []}\n```';
    const { valid, review } = parseReviewOutput(text);
    assert.equal(valid, true);
    assert.equal(review.summary, 'Decent session');
  });

  it('extracts JSON from surrounding text', () => {
    const text = 'Here is my review:\n{"summary": "Mixed results", "strengths": ["A"], "improvements": ["B"], "suggestions": ["C"]}\nEnd.';
    const { valid, review } = parseReviewOutput(text);
    assert.equal(valid, true);
    assert.equal(review.summary, 'Mixed results');
  });

  it('rejects empty output', () => {
    const { valid } = parseReviewOutput('');
    assert.equal(valid, false);
  });

  it('rejects JSON without summary field', () => {
    const text = '{"efficiency": 80}';
    const { valid } = parseReviewOutput(text);
    assert.equal(valid, false);
  });
});

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe('buildReviewPrompt', () => {
  it('builds prompt with scores and notable events', () => {
    const result = buildReviewPrompt({
      projectName: 'test-project',
      durationMins: 15.5,
      promptCount: 3,
      eventCount: 25,
      totalCost: 0.45,
      scores: [
        { prompt_text: 'Fix login', efficiency: 85, accuracy: 90, cost_score: 70, approach: 80, overall: 81 },
        { prompt_text: 'Add tests', efficiency: 60, accuracy: 75, cost_score: 65, approach: 90, overall: 73 },
      ],
      notableEvents: ['3 tool failures from Bash', 'Agent spawned: code-reviewer (1x)'],
    });

    // Skill file exists in repo, so prompt should be built
    if (result) {
      assert.ok(result.includes('test-project'));
      assert.ok(result.includes('15.5 minutes'));
      assert.ok(result.includes('Fix login'));
      assert.ok(result.includes('3 tool failures'));
      assert.ok(result.includes('code-reviewer'));
    }
  });

  it('handles empty scores gracefully', () => {
    const result = buildReviewPrompt({
      projectName: 'proj',
      durationMins: 5,
      promptCount: 2,
      eventCount: 8,
      totalCost: 0.1,
      scores: [],
      notableEvents: [],
    });

    if (result) {
      assert.ok(result.includes('proj'));
      assert.ok(!result.includes('## Prompt Scores'));
    }
  });
});

// ---------------------------------------------------------------------------
// collectNotableEvents (requires DB)
// ---------------------------------------------------------------------------

describe('collectNotableEvents', () => {
  let db;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { createDb } = require('../../src/db/schema');
    db = createDb(TEST_DB);

    // Seed session
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, model)
      VALUES ('sess-review', '2026-04-15T10:00:00Z', 'sonnet')
    `).run();

    // Seed events: some failures, an agent spawn, a skill invoke
    const insertEvt = db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num)
      VALUES (@ts, 'sess-review', @type, @name, @success, @seq)
    `);
    insertEvt.run({ ts: '2026-04-15T10:01:00Z', type: 'tool_call', name: 'Bash', success: 0, seq: 1 });
    insertEvt.run({ ts: '2026-04-15T10:01:01Z', type: 'tool_call', name: 'Bash', success: 0, seq: 2 });
    insertEvt.run({ ts: '2026-04-15T10:01:02Z', type: 'tool_call', name: 'Edit', success: 0, seq: 3 });
    insertEvt.run({ ts: '2026-04-15T10:02:00Z', type: 'agent_spawn', name: 'code-reviewer', success: 1, seq: 4 });
    insertEvt.run({ ts: '2026-04-15T10:03:00Z', type: 'skill_invoke', name: 'commit', success: 1, seq: 5 });
    insertEvt.run({ ts: '2026-04-15T10:04:00Z', type: 'tool_call', name: 'Read', success: 1, seq: 6 });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('collects failures, agent spawns, and skill invocations', () => {
    const notables = collectNotableEvents(db, 'sess-review');

    assert.ok(notables.length >= 3, `expected at least 3 notables, got ${notables.length}`);

    const failureItems = notables.filter(n => n.includes('failure'));
    assert.ok(failureItems.length >= 1, 'should have failure entries');
    assert.ok(failureItems.some(n => n.includes('Bash')), 'should mention Bash failures');

    const agentItems = notables.filter(n => n.includes('Agent'));
    assert.ok(agentItems.length >= 1, 'should have agent entries');
    assert.ok(agentItems[0].includes('code-reviewer'));

    const skillItems = notables.filter(n => n.includes('Skill'));
    assert.ok(skillItems.length >= 1, 'should have skill entries');
    assert.ok(skillItems[0].includes('commit'));
  });

  it('returns empty array for session with no notable events', () => {
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, model)
      VALUES ('sess-clean', '2026-04-15T11:00:00Z', 'sonnet')
    `).run();
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num)
      VALUES ('2026-04-15T11:01:00Z', 'sess-clean', 'tool_call', 'Read', 1, 1)
    `).run();

    const notables = collectNotableEvents(db, 'sess-clean');
    assert.equal(notables.length, 0);
  });
});
