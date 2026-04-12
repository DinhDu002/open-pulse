'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-plan-routes-test-${Date.now()}`);

// ---------------------------------------------------------------------------
// Mock callClaude BEFORE any module loads it
// ---------------------------------------------------------------------------

const STUB_OUTPUT_OK = '```markdown plan\n# Mock Plan\nStep 1: do something.\nStep 2: verify.\n```\n\n```text handoff\nMock handoff prompt content for session.\n```';

let mockCallClaudeImpl = null;

function installMock() {
  // Wipe cached modules so the mock is picked up
  for (const key of Object.keys(require.cache)) {
    if (key.includes('open-pulse/src/')) delete require.cache[key];
  }
  const extract = require('../../src/knowledge/extract');
  // Replace callClaude with a controllable stub
  extract.callClaude = async (prompt, model, opts) => {
    if (mockCallClaudeImpl) return mockCallClaudeImpl(prompt, model, opts);
    return {
      output: STUB_OUTPUT_OK,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      duration_ms: 200,
    };
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('plan generation routes', () => {
  let app;
  let testDb;

  before(async () => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'agents'), { recursive: true });

    // Seed CLAUDE.md so resolveTargetFiles has something to read
    fs.writeFileSync(path.join(TEST_DIR, '.claude', 'CLAUDE.md'), '# Test CLAUDE.md');
    fs.writeFileSync(path.join(TEST_DIR, '.claude', 'rules', 'sample.md'), '# Sample rule');

    // Write a temp config.json so loadConfig() can read it
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({
      port: 3828,
      plan_generation_enabled: true,
      plan_generation_model: 'opus',
      plan_generation_timeout_ms: 5000,
      plan_generation_max_context_kb: 100,
      plan_generation_max_concurrent: 3,
    }));

    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');
    process.env.OPEN_PULSE_CONFIG = path.join(TEST_DIR, 'config.json');

    installMock();

    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

    // Seed a daily review row to operate on
    testDb.prepare(`
      INSERT INTO daily_reviews
        (id, review_date, category, title, description, target_type, action,
         confidence, reasoning, summary_vi, status, created_at)
      VALUES
        ('dr-test-1', '2026-04-12', 'refinement', 'Test suggestion',
         'Test description', 'rule', 'create', 0.9, 'Test reasoning',
         'Test summary', 'pending', '2026-04-12T10:00:00Z')
    `).run();
  });

  after(async () => {
    if (testDb) testDb.close();
    if (app) await app.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    delete process.env.OPEN_PULSE_CONFIG;
  });

  beforeEach(() => {
    mockCallClaudeImpl = null;
    // Reset plan_status so each test starts fresh
    testDb.prepare(`UPDATE daily_reviews
                    SET plan_status = NULL, plan_md = NULL, handoff_prompt = NULL,
                        plan_error = NULL, plan_generated_at = NULL, plan_run_id = NULL
                    WHERE id = 'dr-test-1'`).run();
    // Reset concurrency counter
    const plan = require('../../src/review/plan');
    while (plan.activePlanGenerations > 0) plan.decrement();
    plan.activeReviewIds.clear();
  });

  it('returns 404 when daily review does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/nonexistent/plan/generate',
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /not found/i);
  });

  it('returns 400 when plan_generation_enabled is false', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({
      port: 3828,
      plan_generation_enabled: false,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/dr-test-1/plan/generate',
    });
    assert.equal(res.statusCode, 400);
    // Restore config
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({
      port: 3828,
      plan_generation_enabled: true,
      plan_generation_model: 'opus',
      plan_generation_timeout_ms: 5000,
      plan_generation_max_context_kb: 100,
      plan_generation_max_concurrent: 3,
    }));
  });

  it('returns 429 when concurrency limit is reached', async () => {
    const plan = require('../../src/review/plan');
    // Manually fill the counter
    plan.increment(); plan.increment(); plan.increment();

    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/dr-test-1/plan/generate',
    });
    assert.equal(res.statusCode, 429);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /capacity/i);

    plan.decrement(); plan.decrement(); plan.decrement();
  });

  it('happy path: 202 then plan saved after async completion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/dr-test-1/plan/generate',
    });
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'running');
    assert.ok(body.run_id, 'run_id present');

    // Wait for async generation to complete (mock is fast)
    for (let i = 0; i < 30; i++) {
      const row = testDb.prepare('SELECT plan_status, plan_md, handoff_prompt FROM daily_reviews WHERE id = ?').get('dr-test-1');
      if (row.plan_status === 'done') break;
      await new Promise(r => setTimeout(r, 50));
    }

    const finalRow = testDb.prepare('SELECT plan_status, plan_md, handoff_prompt, plan_run_id FROM daily_reviews WHERE id = ?').get('dr-test-1');
    assert.equal(finalRow.plan_status, 'done');
    assert.ok(finalRow.plan_md.includes('Mock Plan'));
    assert.ok(finalRow.handoff_prompt.includes('Mock handoff'));
    assert.ok(finalRow.plan_run_id, 'plan_run_id linked');

    // pipeline_runs should have a success row
    const runs = testDb.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'plan_generation' ORDER BY id DESC LIMIT 1").all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'success');
    assert.ok(runs[0].input_tokens > 0);
    assert.ok(runs[0].output_tokens > 0);
  });

  it('returns 409 when plan is already running', async () => {
    // Manually set status to running
    testDb.prepare(`UPDATE daily_reviews SET plan_status = 'running' WHERE id = 'dr-test-1'`).run();
    const plan = require('../../src/review/plan');
    plan.activeReviewIds.add('dr-test-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/dr-test-1/plan/generate',
    });
    assert.equal(res.statusCode, 409);

    plan.activeReviewIds.delete('dr-test-1');
  });

  it('GET /plan-status returns only status fields, not plan_md', async () => {
    // Seed a done plan
    testDb.prepare(`
      UPDATE daily_reviews
      SET plan_status = 'done', plan_md = 'Big plan content', handoff_prompt = 'Big handoff',
          plan_run_id = 99
      WHERE id = 'dr-test-1'
    `).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/daily-reviews/dr-test-1/plan-status',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.plan_status, 'done');
    assert.equal(body.plan_run_id, 99);
    assert.ok(!('plan_md' in body), 'plan_md not included in status response');
    assert.ok(!('handoff_prompt' in body), 'handoff_prompt not included');
  });

  it('GET /plan-status returns 404 for nonexistent review', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/daily-reviews/nonexistent/plan-status',
    });
    assert.equal(res.statusCode, 404);
  });

  it('on parse failure, status flips to error and pipeline_runs records error', async () => {
    mockCallClaudeImpl = async () => ({
      output: 'no fenced blocks here at all',
      input_tokens: 50, output_tokens: 25, cost_usd: 0, duration_ms: 100,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/dr-test-1/plan/generate',
    });
    assert.equal(res.statusCode, 202);

    // Wait for async error path
    for (let i = 0; i < 30; i++) {
      const row = testDb.prepare('SELECT plan_status FROM daily_reviews WHERE id = ?').get('dr-test-1');
      if (row.plan_status === 'error') break;
      await new Promise(r => setTimeout(r, 50));
    }

    const row = testDb.prepare('SELECT plan_status, plan_error FROM daily_reviews WHERE id = ?').get('dr-test-1');
    assert.equal(row.plan_status, 'error');
    assert.match(row.plan_error, /missing.*markdown plan/i);

    const lastRun = testDb.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'plan_generation' ORDER BY id DESC LIMIT 1").get();
    assert.equal(lastRun.status, 'error');
    assert.match(lastRun.error, /missing/i);
  });
});

// ---------------------------------------------------------------------------
// Server restart cleanup
// ---------------------------------------------------------------------------

describe('server restart cleanup for orphan running plans', () => {
  it('flips plan_status from running to error on createDb', () => {
    const tmpDb = path.join(os.tmpdir(), `op-cleanup-test-${Date.now()}.db`);
    const { createDb } = require('../../src/db/schema');
    let db = createDb(tmpDb);
    db.prepare(`
      INSERT INTO daily_reviews
        (id, review_date, category, title, status, plan_status, created_at)
      VALUES
        ('dr-orphan', '2026-04-12', 'test', 'Orphan', 'pending', 'running', '2026-04-12T00:00:00Z')
    `).run();
    db.close();

    // Re-open: createDb should run the cleanup query
    db = createDb(tmpDb);
    const row = db.prepare("SELECT plan_status, plan_error FROM daily_reviews WHERE id = 'dr-orphan'").get();
    assert.equal(row.plan_status, 'error');
    assert.match(row.plan_error, /restarted/i);
    db.close();

    fs.unlinkSync(tmpDb);
  });
});
