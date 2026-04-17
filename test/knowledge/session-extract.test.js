'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  buildSessionContextBlock,
  buildSessionExtractPrompt,
  buildSessionCompactExtractPrompt,
  getSessionContext,
  extractKnowledgeFromSession,
} = require('../../src/knowledge/extract');

// ---------------------------------------------------------------------------
// buildSessionContextBlock — pure function, no DB
// ---------------------------------------------------------------------------

describe('buildSessionContextBlock', () => {
  it('returns empty string when ctx is null/empty', () => {
    assert.equal(buildSessionContextBlock(null), '');
    assert.equal(buildSessionContextBlock({}), '');
    assert.equal(buildSessionContextBlock({ review: null, topScores: [] }), '');
  });

  it('renders review summary and improvements', () => {
    const block = buildSessionContextBlock({
      review: {
        summary: 'Productive session fixing auth bugs',
        improvements: 'Could use fewer retries on failing tests',
      },
      topScores: [],
    });
    assert.ok(block.includes('Session context:'));
    assert.ok(block.includes('Productive session fixing auth bugs'));
    assert.ok(block.includes('Could use fewer retries'));
  });

  it('renders top scores with approach reasoning', () => {
    const block = buildSessionContextBlock({
      review: null,
      topScores: [
        {
          prompt_text: 'Fix the login bug',
          overall: 92,
          reasoning: JSON.stringify({ approach: 'Read test first, then fix root cause' }),
        },
      ],
    });
    assert.ok(block.includes('Notable prompts'));
    assert.ok(block.includes('Fix the login bug'));
    assert.ok(block.includes('score 92'));
    assert.ok(block.includes('Read test first'));
  });

  it('handles malformed reasoning JSON gracefully', () => {
    const block = buildSessionContextBlock({
      review: null,
      topScores: [{ prompt_text: 'P', overall: 50, reasoning: 'not json {{{' }],
    });
    assert.ok(block.includes('"P"'));
    assert.ok(block.includes('score 50'));
  });

  it('truncates overly long summary/improvements', () => {
    const longText = 'x'.repeat(1000);
    const block = buildSessionContextBlock({
      review: { summary: longText, improvements: longText },
      topScores: [],
    });
    // Each capped at 400 chars
    assert.ok(!block.includes('x'.repeat(500)));
  });
});

// ---------------------------------------------------------------------------
// buildSessionExtractPrompt / buildSessionCompactExtractPrompt
// ---------------------------------------------------------------------------

describe('buildSessionExtractPrompt', () => {
  const sampleEvents = [{
    event_type: 'tool_call',
    name: 'Read',
    tool_input: JSON.stringify({ file_path: 'src/server.js' }),
    tool_response: 'ok',
  }];

  it('includes project name, events, and session context', () => {
    const ctx = { review: { summary: 'Session summary here' }, topScores: [] };
    const prompt = buildSessionExtractPrompt('MyProj', sampleEvents, '', ctx);
    assert.ok(prompt.includes('Project: MyProj'));
    assert.ok(prompt.includes('Session summary here'));
    assert.ok(prompt.includes('Read'));
    assert.ok(prompt.includes('Events:'));
  });

  it('puts format rules before project/events (stable-first order)', () => {
    const prompt = buildSessionExtractPrompt('P', sampleEvents, '', null);
    const rulesIdx = prompt.indexOf('ENTRY FORMAT AND RULES');
    const eventsIdx = prompt.indexOf('Events:');
    if (rulesIdx !== -1) {
      assert.ok(rulesIdx < eventsIdx, 'rules must precede events for prompt caching');
    }
  });

  it('omits session context block when no review/scores', () => {
    const prompt = buildSessionExtractPrompt('P', sampleEvents, '', { review: null, topScores: [] });
    assert.ok(!prompt.includes('Session context:'));
  });

  it('includes existingEntriesBlock verbatim', () => {
    const existing = '\nRelated entries:\n- "Foo" [source: bar.js]\n';
    const prompt = buildSessionExtractPrompt('P', sampleEvents, existing, null);
    assert.ok(prompt.includes('Related entries'));
    assert.ok(prompt.includes('Foo'));
  });
});

describe('buildSessionCompactExtractPrompt', () => {
  const events = [{
    event_type: 'tool_call',
    name: 'Bash',
    tool_input: JSON.stringify({ command: 'npm test' }),
    tool_response: 'pass',
  }];

  it('includes compact rules first when skill compact exists', () => {
    const prompt = buildSessionCompactExtractPrompt('P', events, [], null);
    if (prompt !== null) {
      const ruleIdx = prompt.indexOf('Compact Instructions') !== -1
        ? prompt.indexOf('Compact Instructions') : 0;
      const eventsIdx = prompt.indexOf('Events:');
      assert.ok(eventsIdx > ruleIdx, 'events must be after stable rules');
    }
  });

  it('includes session context block when provided', () => {
    const ctx = { review: { summary: 'Session went well' }, topScores: [] };
    const prompt = buildSessionCompactExtractPrompt('P', events, [], ctx);
    if (prompt !== null) {
      assert.ok(prompt.includes('Session went well'));
    }
  });

  it('includes existing titles', () => {
    const prompt = buildSessionCompactExtractPrompt('P', events, ['Existing Entry A'], null);
    if (prompt !== null) {
      assert.ok(prompt.includes('Existing Entry A'));
    }
  });
});

// ---------------------------------------------------------------------------
// getSessionContext + extractKnowledgeFromSession — integration
// ---------------------------------------------------------------------------

describe('getSessionContext + extractKnowledgeFromSession', () => {
  let db;
  let TEST_DIR;
  let TEST_DB;
  const SESSION_ID = 'sess-session-extract-test';
  const PROJECT_ID = 'proj-session-test';
  const WORK_DIR = '/tmp/op-session-extract-workdir';

  before(() => {
    TEST_DIR = path.join(os.tmpdir(), `op-session-extract-${Date.now()}`);
    TEST_DB = path.join(TEST_DIR, 'test.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    db = createDb(TEST_DB);

    upsertClProject(db, {
      project_id: PROJECT_ID,
      name: 'Session Test',
      directory: WORK_DIR,
      first_seen_at: '2026-04-15T10:00:00Z',
      last_seen_at: '2026-04-15T10:00:00Z',
      session_count: 1,
    });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset per-test state — delete children before parents (FK constraints)
    try { db.prepare('DELETE FROM prompt_scores WHERE session_id = ?').run(SESSION_ID); } catch {}
    db.prepare('DELETE FROM events WHERE session_id = ?').run(SESSION_ID);
    db.prepare('DELETE FROM prompts WHERE session_id = ?').run(SESSION_ID);
    try { db.prepare('DELETE FROM session_reviews WHERE session_id = ?').run(SESSION_ID); } catch {}
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(SESSION_ID);
    db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(PROJECT_ID);
    try { db.prepare('DELETE FROM pipeline_runs WHERE project_id = ?').run(PROJECT_ID); } catch {}

    db.prepare(`
      INSERT INTO sessions (session_id, started_at, model, working_directory)
      VALUES (?, ?, ?, ?)
    `).run(SESSION_ID, '2026-04-15T10:00:00Z', 'sonnet', WORK_DIR);
  });

  // ── getSessionContext ────────────────────────────────────────────────

  it('getSessionContext returns null review + empty scores when nothing seeded', () => {
    const ctx = getSessionContext(db, SESSION_ID);
    assert.equal(ctx.review, null);
    assert.deepEqual(ctx.topScores, []);
  });

  it('getSessionContext reads session_reviews when present', () => {
    db.prepare(`
      INSERT INTO session_reviews (session_id, project_id, summary, improvements, prompt_count, duration_mins, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(SESSION_ID, PROJECT_ID, 'Great session', 'Test more', 5, 30, '2026-04-15T11:00:00Z');

    const ctx = getSessionContext(db, SESSION_ID);
    assert.ok(ctx.review);
    assert.equal(ctx.review.summary, 'Great session');
    assert.equal(ctx.review.improvements, 'Test more');
  });

  it('getSessionContext returns top 3 scored prompts ordered by overall DESC', () => {
    // Seed 4 prompts + scores
    for (let i = 1; i <= 4; i++) {
      db.prepare(`
        INSERT INTO prompts (id, session_id, prompt_text, seq_start, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(2000 + i, SESSION_ID, `Prompt ${i}`, i * 10, '2026-04-15T10:00:00Z');
      db.prepare(`
        INSERT INTO prompt_scores (prompt_id, session_id, project_id, efficiency, accuracy, cost_score, approach, overall, reasoning, event_count, created_at)
        VALUES (?, ?, ?, 80, 80, 80, 80, ?, ?, 5, '2026-04-15T11:00:00Z')
      `).run(2000 + i, SESSION_ID, PROJECT_ID, 50 + i * 10, JSON.stringify({ approach: `Approach ${i}` }));
    }

    const ctx = getSessionContext(db, SESSION_ID);
    assert.equal(ctx.topScores.length, 3);
    // Overall values: 60, 70, 80, 90 → top 3: 90, 80, 70
    assert.equal(ctx.topScores[0].overall, 90);
    assert.equal(ctx.topScores[1].overall, 80);
    assert.equal(ctx.topScores[2].overall, 70);
  });

  // ── extractKnowledgeFromSession ──────────────────────────────────────

  it('returns {message} when session does not exist', async () => {
    const r = await extractKnowledgeFromSession(db, 'sess-nonexistent', { model: 'local' });
    assert.ok(r.message && r.message.includes('not found'));
  });

  it('returns {message} when project not found for working_directory', async () => {
    db.prepare('UPDATE sessions SET working_directory = ? WHERE session_id = ?')
      .run('/tmp/unknown-dir', SESSION_ID);
    const r = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'local' });
    assert.ok(r.message && r.message.includes('No project'));
  });

  it('returns {message} when session has no events', async () => {
    const r = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'local' });
    assert.ok(r.message && r.message.includes('No events'));
  });

  it('extracts + inserts entries using dispatch override (happy path with review)', async () => {
    // Seed events
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, seq_num, project_name)
      VALUES ('2026-04-15T10:01:00Z', ?, 'tool_call', 'Read', '{"file_path":"src/server.js"}', 1, 'Session Test')
    `).run(SESSION_ID);

    // Seed review
    db.prepare(`
      INSERT INTO session_reviews (session_id, project_id, summary, improvements, prompt_count, duration_mins, created_at)
      VALUES (?, ?, 'Productive', 'Add more tests', 1, 10, '2026-04-15T11:00:00Z')
    `).run(SESSION_ID, PROJECT_ID);

    // Capture prompt passed to dispatch + return canned entries
    let capturedPrompt = '';
    const dispatch = async (_model, llmPrompt) => {
      capturedPrompt = llmPrompt;
      return {
        output: JSON.stringify([{
          category: 'footgun',
          title: 'Session-scoped discovery test entry',
          body: '[Trigger]: When testing session extract. [Detail]: The dispatch seam lets tests inject canned JSON. Consequence: tests pass without calling real LLM.',
          source_file: 'src/server.js',
          tags: ['backend', 'testing'],
        }]),
        input_tokens: 100,
        output_tokens: 20,
        cost_usd: 0,
        duration_ms: 42,
        effectiveModel: 'sonnet',
      };
    };

    const result = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'sonnet', dispatch });
    assert.equal(result.extracted, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.updated, 0);

    // Verify DB
    const entries = db.prepare('SELECT * FROM knowledge_entries WHERE project_id = ?').all(PROJECT_ID);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Session-scoped discovery test entry');
    assert.equal(entries[0].category, 'footgun');

    // Verify session context was injected into prompt
    assert.ok(capturedPrompt.includes('Productive'), 'review summary should be in prompt');
    assert.ok(capturedPrompt.includes('Add more tests'), 'improvements should be in prompt');

    // Verify pipeline_run logged
    const runs = db.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'knowledge_session_extract' AND project_id = ?").all(PROJECT_ID);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'success');
    assert.equal(runs[0].model, 'sonnet');
  });

  it('still extracts when session has no review', async () => {
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, seq_num, project_name)
      VALUES ('2026-04-15T10:01:00Z', ?, 'tool_call', 'Read', '{"file_path":"src/a.js"}', 1, 'Session Test')
    `).run(SESSION_ID);

    const dispatch = async () => ({
      output: JSON.stringify([{
        category: 'convention',
        title: 'No-review session still extracts',
        body: '[Trigger]: When testing no-review path. [Detail]: extract should work even without session_reviews row. Consequence: feature would be broken for brand-new sessions without review.',
        source_file: null,
        tags: ['testing'],
      }]),
      input_tokens: 50, output_tokens: 10, cost_usd: 0, duration_ms: 10, effectiveModel: 'sonnet',
    });

    const result = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'sonnet', dispatch });
    assert.equal(result.inserted, 1);
  });

  it('updates existing entry when title collides (not a duplicate insert)', async () => {
    // Pre-seed an existing entry
    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');
    insertKnowledgeEntry(db, {
      project_id: PROJECT_ID,
      category: 'footgun',
      title: 'Known session footgun',
      body: 'Old body text (will be replaced).',
    });

    // Seed events
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, seq_num, project_name)
      VALUES ('2026-04-15T10:01:00Z', ?, 'tool_call', 'Read', '{"file_path":"src/a.js"}', 1, 'Session Test')
    `).run(SESSION_ID);

    const dispatch = async () => ({
      output: JSON.stringify([{
        category: 'footgun',
        title: 'Known session footgun',  // title collision
        body: '[Trigger]: When the session extract sees this file. [Detail]: Title-based upsert replaces body with the newer richer version from the full-session view. Consequence: merge semantics work across per-prompt and session extract.',
        source_file: 'src/a.js',
        tags: ['backend'],
      }]),
      input_tokens: 50, output_tokens: 10, cost_usd: 0, duration_ms: 10, effectiveModel: 'sonnet',
    });

    const result = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'sonnet', dispatch });
    assert.equal(result.inserted, 0, 'should not insert a duplicate');
    assert.equal(result.updated, 1, 'should update existing entry');

    const entries = db.prepare('SELECT * FROM knowledge_entries WHERE project_id = ? AND title = ?').all(PROJECT_ID, 'Known session footgun');
    assert.equal(entries.length, 1, 'should not duplicate');
    assert.ok(entries[0].body.includes('Title-based upsert'), 'body should be updated');
  });

  it('logs pipeline_run with status=error when dispatch throws non-recoverable error', async () => {
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, seq_num, project_name)
      VALUES ('2026-04-15T10:01:00Z', ?, 'tool_call', 'Read', '{"file_path":"src/b.js"}', 1, 'Session Test')
    `).run(SESSION_ID);

    const dispatch = async () => { throw new Error('boom'); };

    await assert.rejects(
      () => extractKnowledgeFromSession(db, SESSION_ID, { model: 'sonnet', dispatch }),
      /boom/,
    );

    const runs = db.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'knowledge_session_extract'").all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'error');
    assert.ok(runs[0].error.includes('boom'));
  });

  it('logs pipeline_run with status=skipped when dispatch throws recoverable error', async () => {
    db.prepare(`
      INSERT INTO events (timestamp, session_id, event_type, name, tool_input, seq_num, project_name)
      VALUES ('2026-04-15T10:01:00Z', ?, 'tool_call', 'Read', '{"file_path":"src/c.js"}', 1, 'Session Test')
    `).run(SESSION_ID);

    const dispatch = async () => {
      const err = new Error('ollama down');
      err.code = 'ECONNREFUSED';
      throw err;
    };

    const result = await extractKnowledgeFromSession(db, SESSION_ID, { model: 'local', dispatch });
    assert.equal(result.skipped, true);

    const runs = db.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'knowledge_session_extract'").all();
    assert.equal(runs[0].status, 'skipped');
  });
});
