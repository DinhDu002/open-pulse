'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-quality-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('quality queries', () => {
  let db;
  let queries;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { createDb } = require('../../src/db/schema');
    db = createDb(TEST_DB);
    queries = require('../../src/quality/queries');

    // Seed a session + prompts for FK references
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, model)
      VALUES ('sess-q1', '2026-04-15T10:00:00Z', 'sonnet')
    `).run();
    db.prepare(`
      INSERT INTO prompts (id, session_id, prompt_text, seq_start, timestamp)
      VALUES (100, 'sess-q1', 'Fix the login bug', 1, '2026-04-15T10:01:00Z')
    `).run();
    db.prepare(`
      INSERT INTO prompts (id, session_id, prompt_text, seq_start, timestamp)
      VALUES (101, 'sess-q1', 'Add unit tests', 10, '2026-04-15T10:05:00Z')
    `).run();
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── insertPromptScore ──────────────────────────────────────────────────

  it('insertPromptScore inserts a score and getPromptScore retrieves it', () => {
    queries.insertPromptScore(db, {
      prompt_id:  100,
      session_id: 'sess-q1',
      project_id: 'proj-test',
      efficiency: 85,
      accuracy:   90,
      cost_score: 70,
      approach:   80,
      overall:    81,
      reasoning:  { efficiency: 'Minimal retries', accuracy: 'All tools succeeded' },
      event_count: 12,
    });

    const score = queries.getPromptScore(db, 100);
    assert.ok(score, 'should return a row');
    assert.equal(score.prompt_id, 100);
    assert.equal(score.session_id, 'sess-q1');
    assert.equal(score.project_id, 'proj-test');
    assert.equal(score.efficiency, 85);
    assert.equal(score.accuracy, 90);
    assert.equal(score.cost_score, 70);
    assert.equal(score.approach, 80);
    assert.equal(score.overall, 81);
    assert.equal(score.event_count, 12);
    assert.ok(score.created_at);

    const reasoning = JSON.parse(score.reasoning);
    assert.equal(reasoning.efficiency, 'Minimal retries');
  });

  it('insertPromptScore ignores duplicate prompt_id', () => {
    const result = queries.insertPromptScore(db, {
      prompt_id:  100,
      session_id: 'sess-q1',
      efficiency: 50,
      accuracy:   50,
      cost_score: 50,
      approach:   50,
      overall:    50,
    });
    assert.equal(result.changes, 0, 'should not insert duplicate');

    const score = queries.getPromptScore(db, 100);
    assert.equal(score.efficiency, 85, 'original score should remain');
  });

  it('getPromptScore returns null for unknown prompt_id', () => {
    const score = queries.getPromptScore(db, 9999);
    assert.equal(score, null);
  });

  // ── getSessionScores ───────────────────────────────────────────────────

  it('getSessionScores returns all scores for a session', () => {
    queries.insertPromptScore(db, {
      prompt_id:  101,
      session_id: 'sess-q1',
      project_id: 'proj-test',
      efficiency: 60,
      accuracy:   75,
      cost_score: 65,
      approach:   90,
      overall:    73,
      event_count: 8,
    });

    const scores = queries.getSessionScores(db, 'sess-q1');
    assert.equal(scores.length, 2);
    assert.equal(scores[0].prompt_id, 100);
    assert.equal(scores[1].prompt_id, 101);
  });

  it('getSessionScores returns empty array for unknown session', () => {
    const scores = queries.getSessionScores(db, 'sess-unknown');
    assert.deepEqual(scores, []);
  });

  // ── getQualityStats ────────────────────────────────────────────────────

  it('getQualityStats returns correct averages', () => {
    const stats = queries.getQualityStats(db, {});
    assert.equal(stats.scored_count, 2);
    // (85+60)/2 = 72.5 → 73 rounded
    assert.equal(stats.averages.efficiency, 73);
    // (90+75)/2 = 82.5 → 83
    assert.equal(stats.averages.accuracy, 83);
    assert.equal(stats.averages.overall, 77);
  });

  it('getQualityStats filters by project_id', () => {
    const stats = queries.getQualityStats(db, { projectId: 'proj-test' });
    assert.equal(stats.scored_count, 2);

    const empty = queries.getQualityStats(db, { projectId: 'proj-nonexistent' });
    assert.equal(empty.scored_count, 0);
    assert.equal(empty.averages.overall, 0);
  });

  // ── getQualityTrends ──────────────────────────────────────────────────

  it('getQualityTrends returns daily aggregates', () => {
    const trends = queries.getQualityTrends(db, { days: 30 });
    assert.ok(trends.length >= 1, 'should have at least one day');
    const day = trends[0];
    assert.ok(day.date, 'should have date field');
    assert.ok(day.avg_overall !== undefined, 'should have avg_overall');
    assert.ok(day.count >= 1, 'should have count');
  });

  // ── Session Reviews ────────────────────────────────────────────────────

  it('insertSessionReview inserts and getSessionReview retrieves it', () => {
    queries.insertSessionReview(db, {
      session_id:    'sess-q1',
      project_id:    'proj-test',
      overall_score: 77,
      summary:       'Good session overall with room for improvement on cost.',
      strengths:     ['Consistent use of TDD', 'Clean tool selection'],
      improvements:  ['High token usage on prompt #2', 'Excessive retries'],
      suggestions:   ['Consider using agent delegation for complex tasks'],
      prompt_count:  2,
      scored_count:  2,
      total_cost_usd: 0.45,
      total_events:  20,
      duration_mins: 15.5,
    });

    const review = queries.getSessionReview(db, 'sess-q1');
    assert.ok(review, 'should return a row');
    assert.equal(review.session_id, 'sess-q1');
    assert.equal(review.overall_score, 77);
    assert.ok(review.summary.includes('Good session'));
    assert.equal(review.prompt_count, 2);
    assert.equal(review.scored_count, 2);
    assert.equal(review.total_cost_usd, 0.45);
    assert.equal(review.duration_mins, 15.5);

    const strengths = JSON.parse(review.strengths);
    assert.equal(strengths.length, 2);
    assert.ok(strengths[0].includes('TDD'));

    const suggestions = JSON.parse(review.suggestions);
    assert.equal(suggestions.length, 1);
  });

  it('insertSessionReview ignores duplicate session_id', () => {
    const result = queries.insertSessionReview(db, {
      session_id: 'sess-q1',
      summary:    'Duplicate review',
    });
    assert.equal(result.changes, 0);

    const review = queries.getSessionReview(db, 'sess-q1');
    assert.ok(review.summary.includes('Good session'), 'original should remain');
  });

  it('getSessionReview returns null for unknown session', () => {
    const review = queries.getSessionReview(db, 'sess-unknown');
    assert.equal(review, null);
  });

  // ── getQualityStats includes session review stats ──────────────────────

  it('getQualityStats includes session review counts', () => {
    const stats = queries.getQualityStats(db, {});
    assert.equal(stats.sessions_reviewed, 1);
    assert.equal(stats.session_avg_score, 77);
  });
});
