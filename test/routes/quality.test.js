'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-quality-routes-${Date.now()}`);

describe('quality routes', () => {
  let app;

  before(async () => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'agents'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed data directly
    const Database = require('better-sqlite3');
    const db = new Database(process.env.OPEN_PULSE_DB);

    db.prepare(`
      INSERT INTO sessions (session_id, started_at, ended_at, model, total_cost_usd)
      VALUES ('sess-qr', '2026-04-15T10:00:00Z', '2026-04-15T10:30:00Z', 'sonnet', 0.45)
    `).run();
    db.prepare(`
      INSERT INTO prompts (id, session_id, prompt_text, seq_start, timestamp)
      VALUES (200, 'sess-qr', 'Fix the login bug', 1, '2026-04-15T10:01:00Z')
    `).run();
    db.prepare(`
      INSERT INTO prompt_scores (prompt_id, session_id, project_id, efficiency, accuracy, cost_score, approach, overall, reasoning, event_count, created_at)
      VALUES (200, 'sess-qr', 'proj-qr', 85, 90, 70, 80, 81, '{"efficiency":"Good"}', 10, '2026-04-15T10:05:00Z')
    `).run();

    // Week-before data for weekly comparison tests
    db.prepare(`
      INSERT INTO prompts (id, session_id, prompt_text, seq_start, timestamp)
      VALUES (201, 'sess-qr', 'Refactor auth module', 11, '2026-04-07T14:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO prompt_scores (prompt_id, session_id, project_id, efficiency, accuracy, cost_score, approach, overall, reasoning, event_count, created_at)
      VALUES (201, 'sess-qr', 'proj-qr', 70, 75, 60, 65, 68, '{"efficiency":"Average"}', 8, '2026-04-07T14:05:00Z')
    `).run();
    db.prepare(`
      INSERT INTO session_reviews (session_id, project_id, overall_score, summary, strengths, improvements, suggestions, prompt_count, scored_count, total_cost_usd, total_events, duration_mins, created_at)
      VALUES ('sess-qr', 'proj-qr', 81, 'Good session overall.', '["TDD approach"]', '["Reduce retries"]', '["Use agents"]', 1, 1, 0.45, 10, 30.0, '2026-04-15T10:35:00Z')
    `).run();

    db.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── GET /api/quality/prompts/:promptId ──────────────────────────────────

  it('returns prompt score by id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/prompts/200' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.prompt_id, 200);
    assert.equal(body.efficiency, 85);
    assert.equal(body.accuracy, 90);
    assert.equal(body.overall, 81);
    assert.ok(body.reasoning, 'should parse reasoning JSON');
    assert.equal(body.reasoning.efficiency, 'Good');
  });

  it('returns 404 for unknown prompt score', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/prompts/9999' });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for invalid promptId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/prompts/abc' });
    assert.equal(res.statusCode, 400);
  });

  // ── GET /api/quality/sessions/:sessionId ────────────────────────────────

  it('returns session review', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/sessions/sess-qr' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.session_id, 'sess-qr');
    assert.equal(body.overall_score, 81);
    assert.ok(body.summary.includes('Good session'));
    assert.ok(Array.isArray(body.strengths));
    assert.ok(Array.isArray(body.improvements));
    assert.ok(Array.isArray(body.suggestions));
    assert.equal(body.strengths[0], 'TDD approach');
  });

  it('returns 404 for unknown session review', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/sessions/sess-unknown' });
    assert.equal(res.statusCode, 404);
  });

  // ── GET /api/quality/stats ──────────────────────────────────────────────

  it('returns quality stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/stats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.scored_count >= 1);
    assert.ok(body.averages);
    assert.ok(body.averages.overall >= 0);
    assert.ok(body.sessions_reviewed >= 1);
  });

  it('returns stats filtered by project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/stats?project=proj-qr' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.scored_count, 2);
  });

  // ── GET /api/quality/trends ─────────────────────────────────────────────

  // ── GET /api/quality/weekly ──────────────────────────────────────────────

  it('returns weekly comparison with % changes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/weekly?weeks=52' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.weeks));
    assert.equal(body.weeks.length, 2);

    // First week (older) has no changes
    const w1 = body.weeks[0];
    assert.equal(w1.changes, null);
    assert.equal(w1.averages.efficiency, 70);
    assert.ok(w1.count >= 1);
    assert.ok(w1.week);
    assert.ok(w1.start_date);

    // Second week has % changes
    const w2 = body.weeks[1];
    assert.ok(w2.changes !== null);
    assert.equal(w2.averages.efficiency, 85);
    // efficiency: ((85-70)/70)*100 = 21.4
    assert.equal(w2.changes.efficiency, 21.4);
    // accuracy: ((90-75)/75)*100 = 20.0
    assert.equal(w2.changes.accuracy, 20.0);
  });

  it('returns weekly data filtered by project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/weekly?project=proj-qr&weeks=52' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.weeks.length >= 2);
  });

  it('returns empty weeks for unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/weekly?project=no-such-project' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.weeks.length, 0);
  });

  // ── GET /api/quality/trends ─────────────────────────────────────────────

  it('returns quality trends', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quality/trends?days=30' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.days));
    assert.ok(body.days.length >= 1);
    const day = body.days[0];
    assert.ok(day.date);
    assert.ok(day.avg_overall !== undefined);
  });
});
