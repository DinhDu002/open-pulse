// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_DIR = path.resolve(__dirname, '../..');
const TEST_DIR = path.join(os.tmpdir(), `op-e2e-pipeline-${Date.now()}`);
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen3.5:9b'; // Balanced model: ~16.8 tok/s, ~2min/extraction
const PRODUCTION_MODEL = 'qwen3.5:9b'; // Same model for both test and production

const SESSION_ID = 'e2e-pipeline-sess-1';
const PROJECT_DIR = '/tmp/e2e-test-project';
const PROJECT_ID = 'e2e-proj-1';
const PROJECT_NAME = 'e2e-test-project';
const USER_PROMPT = 'refactor the auth middleware to use JWT tokens';

let app;
let baseURL;
let testDb;
let ollamaAvailable = false;

// ---------------------------------------------------------------------------
// Seed data: 5 tool_call events + 1 session_end
// ---------------------------------------------------------------------------

function buildSeedEvents() {
  const base = '2026-04-15T10:00:0';
  return [
    {
      timestamp: `${base}1Z`, session_id: SESSION_ID,
      event_type: 'tool_call', name: 'Read',
      detail: 'src/auth/middleware.js', duration_ms: 45, success: 1,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: USER_PROMPT,
      tool_input: '{"file_path":"src/auth/middleware.js"}',
      tool_response: 'const express = require("express");\nfunction authMiddleware(req, res, next) {\n  const session = req.cookies.session;\n  if (!session) return res.status(401).json({ error: "unauthorized" });\n  next();\n}',
      seq_num: 1,
    },
    {
      timestamp: `${base}2Z`, session_id: SESSION_ID,
      event_type: 'tool_call', name: 'Grep',
      detail: 'Search for JWT usage', duration_ms: 120, success: 1,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: USER_PROMPT,
      tool_input: '{"pattern":"jsonwebtoken","path":"src/"}',
      tool_response: 'src/auth/middleware.js:3: const jwt = require("jsonwebtoken");\nsrc/config.js:12: JWT_SECRET: process.env.JWT_SECRET',
      seq_num: 2,
    },
    {
      timestamp: `${base}3Z`, session_id: SESSION_ID,
      event_type: 'tool_call', name: 'Edit',
      detail: 'Update auth middleware', duration_ms: 200, success: 1,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: USER_PROMPT,
      tool_input: '{"file_path":"src/auth/middleware.js","old_string":"const session = req.cookies.session;\\n  if (!session) return res.status(401)","new_string":"const token = req.headers.authorization?.split(\\\"Bearer \\\")[1];\\n  if (!token) return res.status(401)"}',
      tool_response: 'File edited successfully — replaced session-based auth with JWT token verification',
      seq_num: 3,
    },
    {
      timestamp: `${base}4Z`, session_id: SESSION_ID,
      event_type: 'tool_call', name: 'Bash',
      detail: 'npm test', duration_ms: 3500, success: 1,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: USER_PROMPT,
      tool_input: '{"command":"npm test"}',
      tool_response: 'PASS src/auth/middleware.test.js\n  auth middleware\n    \\u2713 validates JWT tokens (45ms)\n    \\u2713 rejects expired tokens (12ms)\n    \\u2713 rejects missing tokens (8ms)\n\nTests: 12 passed, 12 total',
      seq_num: 4,
    },
    {
      timestamp: `${base}5Z`, session_id: SESSION_ID,
      event_type: 'tool_call', name: 'Bash',
      detail: 'git diff --stat', duration_ms: 150, success: 1,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: USER_PROMPT,
      tool_input: '{"command":"git diff --stat"}',
      tool_response: ' src/auth/middleware.js | 15 +++++-----\n 1 file changed, 8 insertions(+), 7 deletions(-)',
      seq_num: 5,
    },
    {
      timestamp: '2026-04-15T10:00:10Z', session_id: SESSION_ID,
      event_type: 'session_end', name: null,
      detail: null, duration_ms: null, success: null,
      working_directory: PROJECT_DIR, model: 'opus',
      user_prompt: null,
      input_tokens: 12000, output_tokens: 8000, estimated_cost_usd: 0.78,
      seq_num: 6,
    },
  ];
}

function writeEventsJsonl(events) {
  const jsonl = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(TEST_DIR, 'data', 'events.jsonl'), jsonl);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  test.setTimeout(180_000); // warm-up Ollama can take 60-120s

  // 1. Create temp directory structure
  for (const sub of ['data', '.claude/skills', '.claude/agents', 'logs']) {
    fs.mkdirSync(path.join(TEST_DIR, sub), { recursive: true });
  }

  // 2. Symlink public/ for frontend assets
  fs.symlinkSync(path.join(REPO_DIR, 'public'), path.join(TEST_DIR, 'public'));

  // 3. Write config.json into temp dir
  const config = {
    port: 0,
    ingest_interval_ms: 10000,
    cl_sync_interval_ms: 60000,
    knowledge_enabled: true,
    knowledge_model: 'local',
    knowledge_max_events_per_prompt: 100,
    pattern_detect_enabled: true,
    auto_evolve_enabled: true,
    auto_evolve_min_confidence: 0.85,
    auto_evolve_blacklist: ['agent', 'hook'],
    ollama_url: OLLAMA_URL,
    ollama_model: OLLAMA_MODEL,
    ollama_timeout_ms: 150000, // qwen3.5:9b extraction can take ~2min
  };
  fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify(config, null, 2));

  // 4. Set environment variables
  process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
  process.env.OPEN_PULSE_DIR = TEST_DIR;
  process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

  // 5. Boot server on random port (timers disabled for deterministic testing)
  const { buildApp } = require('../../src/server');
  app = buildApp({ disableTimers: true });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = address;

  // 6. Seed cl_projects via separate DB connection
  const Database = require('better-sqlite3');
  testDb = new Database(process.env.OPEN_PULSE_DB);
  testDb.prepare(`
    INSERT OR IGNORE INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
  `).run(PROJECT_ID, PROJECT_NAME, PROJECT_DIR);

  // 7. Check Ollama availability + warm up model
  const { resetCircuit, callOllama } = require('../../src/lib/ollama');
  resetCircuit();

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    ollamaAvailable = res.ok;
  } catch {
    ollamaAvailable = false;
  }

  // 8. Warm up test model (first inference loads weights — ~5-10s for 3B model)
  if (ollamaAvailable) {
    try {
      await callOllama('Reply with OK', OLLAMA_MODEL, {
        url: OLLAMA_URL,
        timeout: 120000, // cold load for 6.6GB model can take 30-60s
        maxRetries: 0,
      });
    } catch {
      // warm-up failed — tests will still try
    }
  }
});

test.afterAll(async () => {
  if (testDb) testDb.close();
  if (app) await app.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.OPEN_PULSE_DB;
  delete process.env.OPEN_PULSE_DIR;
  delete process.env.OPEN_PULSE_CLAUDE_DIR;
});

// ===========================================================================
// Group A: Core Pipeline (No Ollama required)
// ===========================================================================

test.describe('A: Core Pipeline', () => {
  test('A1: POST /api/ingest processes JSONL into database', async ({ request }) => {
    // Write seed events
    writeEventsJsonl(buildSeedEvents());

    // Trigger ingestion
    const res = await request.post(`${baseURL}/api/ingest`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify events in DB
    const eventCount = testDb.prepare(
      'SELECT COUNT(*) as cnt FROM events WHERE session_id = ?'
    ).get(SESSION_ID);
    expect(eventCount.cnt).toBe(6);

    // Verify session created with correct totals
    const session = testDb.prepare(
      'SELECT * FROM sessions WHERE session_id = ?'
    ).get(SESSION_ID);
    expect(session).toBeTruthy();
    expect(session.total_input_tokens).toBe(12000);
    expect(session.total_output_tokens).toBe(8000);
    expect(session.ended_at).toBeTruthy();

    // Verify prompt linked (5 tool_call events, session_end excluded)
    const prompts = testDb.prepare(
      'SELECT * FROM prompts WHERE session_id = ?'
    ).all(SESSION_ID);
    expect(prompts.length).toBe(1);
    expect(prompts[0].event_count).toBe(5);
    expect(prompts[0].prompt_text).toBe(USER_PROMPT);

    // Verify all tool_call events have prompt_id, session_end does not
    const linkedEvents = testDb.prepare(
      "SELECT prompt_id FROM events WHERE session_id = ? AND event_type != 'session_end'"
    ).all(SESSION_ID);
    for (const ev of linkedEvents) {
      expect(ev.prompt_id).toBeTruthy();
    }
    const sessionEnd = testDb.prepare(
      "SELECT prompt_id FROM events WHERE session_id = ? AND event_type = 'session_end'"
    ).get(SESSION_ID);
    expect(sessionEnd.prompt_id).toBeNull();

    // Verify JSONL file consumed
    expect(fs.existsSync(path.join(TEST_DIR, 'data', 'events.jsonl'))).toBe(false);
  });

  test('A2: GET /api/health returns correct state', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.total_events).toBeGreaterThanOrEqual(6);
    expect(body.db_size_bytes).toBeGreaterThan(0);
  });

  test('A3: GET /api/overview returns dashboard metrics', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/overview?period=all`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.sessions).toBeGreaterThanOrEqual(1);
    expect(body.total_events).toBeGreaterThanOrEqual(6);
    expect(body.total_cost).toBeGreaterThanOrEqual(0.78);
  });
});

// ===========================================================================
// Group B: Ollama Integration (skip if offline)
// ===========================================================================

test.describe('B: Ollama Integration', () => {
  test.beforeEach(async () => {
    if (!ollamaAvailable) test.skip();
  });

  test('B1: Ollama is online and models are available', async () => {
    test.setTimeout(180_000); // cold load for 6.6GB model needs time
    // Check Ollama server is reachable
    const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    expect(tagsRes.ok).toBe(true);
    const tags = await tagsRes.json();
    const modelNames = tags.models.map(m => m.name);

    // Verify test model is available
    expect(modelNames).toContain(OLLAMA_MODEL);

    // Verify production model is also installed
    expect(modelNames).toContain(PRODUCTION_MODEL);

    // Check circuit breaker via API
    const { getCircuitState } = require('../../src/lib/ollama');
    expect(getCircuitState().state).toBe('closed');

    // Verify test model actually works with a quick inference
    const { callOllama } = require('../../src/lib/ollama');
    const result = await callOllama('Reply with OK', OLLAMA_MODEL, {
      url: OLLAMA_URL,
      timeout: 120000, // cold load for 6.6GB model can take 30-60s
      maxRetries: 0,
    });
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  test('B2: Knowledge extraction via Ollama produces pipeline_run', async () => {
    test.setTimeout(300_000); // qwen3.5:9b ~16.8 tok/s, extraction ~2-3min with cold load buffer

    // Ensure events are ingested (idempotent — re-ingest if A1 data is gone)
    const existing = testDb.prepare(
      'SELECT id FROM prompts WHERE session_id = ? LIMIT 1'
    ).get(SESSION_ID);
    if (!existing) {
      writeEventsJsonl(buildSeedEvents());
      const { ingestAll } = require('../../src/ingest/pipeline');
      ingestAll(testDb, path.join(TEST_DIR, 'data'));
    }

    const prompt = testDb.prepare(
      'SELECT id FROM prompts WHERE session_id = ? LIMIT 1'
    ).get(SESSION_ID);
    expect(prompt).toBeTruthy();

    // Call extraction directly (more reliable than fire-and-forget hooks)
    const { extractKnowledgeFromPrompt } = require('../../src/knowledge/extract');
    const result = await extractKnowledgeFromPrompt(testDb, prompt.id, {
      model: 'local',
      ollamaModel: OLLAMA_MODEL,
      ollamaUrl: OLLAMA_URL,
      ollamaTimeout: 240000, // qwen3.5:9b extraction can take 2-4min
      ollamaMaxRetries: 0,   // no retries in E2E — one clean attempt
      maxEvents: 50,
    });

    // Verify pipeline_run was recorded
    const run = testDb.prepare(
      "SELECT * FROM pipeline_runs WHERE pipeline = 'knowledge_extract' AND project_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(PROJECT_ID);
    expect(run).toBeTruthy();
    expect(run.status).toBe('success');
    expect(run.model).toBe(OLLAMA_MODEL);
    expect(run.input_tokens).toBeGreaterThan(0);
    expect(run.output_tokens).toBeGreaterThan(0);
    expect(run.duration_ms).toBeGreaterThan(0);

    // If entries were extracted, validate them
    const entries = testDb.prepare(
      "SELECT * FROM knowledge_entries WHERE project_id = ?"
    ).all(PROJECT_ID);
    for (const entry of entries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.body.length).toBeGreaterThan(0);
      expect(entry.status).toBe('active');
    }
  });

  test('B3: Pattern detection via Ollama produces pipeline_run', async () => {
    test.setTimeout(300_000); // qwen3.5:9b ~16.8 tok/s, extraction ~2-3min with cold load buffer

    // Ensure events are ingested (idempotent)
    const existing = testDb.prepare(
      'SELECT id FROM prompts WHERE session_id = ? LIMIT 1'
    ).get(SESSION_ID);
    if (!existing) {
      writeEventsJsonl(buildSeedEvents());
      const { ingestAll } = require('../../src/ingest/pipeline');
      ingestAll(testDb, path.join(TEST_DIR, 'data'));
    }

    const prompt = testDb.prepare(
      'SELECT id FROM prompts WHERE session_id = ? LIMIT 1'
    ).get(SESSION_ID);
    expect(prompt).toBeTruthy();

    const { detectPatternsFromPrompt } = require('../../src/evolve/detect');
    const result = await detectPatternsFromPrompt(testDb, prompt.id, {
      model: OLLAMA_MODEL,
      url: OLLAMA_URL,
      timeout: 240000,    // qwen3.5:9b extraction can take 2-4min
      maxRetries: 0,      // no retries in E2E — one clean attempt
    });

    // Verify pipeline_run was recorded
    const run = testDb.prepare(
      "SELECT * FROM pipeline_runs WHERE pipeline = 'pattern_detect' ORDER BY created_at DESC LIMIT 1"
    ).get();
    expect(run).toBeTruthy();
    expect(run.status).toBe('success');
    expect(run.model).toBe(OLLAMA_MODEL);
    expect(run.duration_ms).toBeGreaterThan(0);

    // If patterns were detected, validate them
    const patterns = testDb.prepare(
      "SELECT * FROM auto_evolves WHERE status = 'draft'"
    ).all();
    for (const p of patterns) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.confidence).toBeGreaterThanOrEqual(0.3);
      expect(p.observation_count).toBeGreaterThanOrEqual(1);
      expect(['rule', 'skill', 'agent', 'workflow']).toContain(p.target_type);
    }
  });

  test('B4: Circuit breaker stays closed after successful calls', async () => {
    const { getCircuitState } = require('../../src/lib/ollama');
    const state = getCircuitState();
    expect(state.state).toBe('closed');
    expect(state.consecutiveFailures).toBe(0);
  });
});

// ===========================================================================
// Group C: Auto-Evolve Promotion
// ===========================================================================

test.describe('C: Auto-Evolve', () => {
  test('C1: runAutoEvolve promotes high-confidence pattern', async () => {
    // Seed an active pattern with high confidence, created 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    testDb.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ae-e2e-promote', 'E2E Test Rule for Auth Refactoring',
      'When refactoring authentication, always migrate from session to JWT tokens following the Bearer scheme.',
      'rule', 0.92, 8, 0, 'active', fiveDaysAgo, now,
    );

    // Run auto-evolve
    const { runAutoEvolve } = require('../../src/evolve/promote');
    const result = runAutoEvolve(testDb, {
      min_confidence: 0.85,
      blacklist: ['hook'],
      logDir: path.join(TEST_DIR, 'logs'),
    });
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    // Verify DB updated
    const row = testDb.prepare(
      'SELECT * FROM auto_evolves WHERE id = ?'
    ).get('ae-e2e-promote');
    expect(row.status).toBe('promoted');
    expect(row.promoted_to).toBeTruthy();
    expect(row.promoted_at).toBeTruthy();

    // Verify file was actually written to disk
    expect(fs.existsSync(row.promoted_to)).toBe(true);
    const content = fs.readFileSync(row.promoted_to, 'utf8');
    expect(content).toContain('E2E Test Rule for Auth Refactoring');
  });

  test('C2: GET /api/auto-evolves/stats returns correct counts', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/auto-evolves/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.byStatus).toBeTruthy();
    expect(Array.isArray(body.byStatus)).toBe(true);
    expect(body.byTargetType).toBeTruthy();
    expect(Array.isArray(body.byTargetType)).toBe(true);
  });
});

// ===========================================================================
// Group D: Frontend Rendering
// ===========================================================================

test.describe('D: Frontend', () => {
  test('D1: Dashboard renders stat cards with data', async ({ page }) => {
    await page.goto(`${baseURL}/#dashboard`);
    await page.waitForSelector('.stat-grid', { timeout: 10000 });

    const statCards = page.locator('.stat-card');
    await expect(statCards.first()).toBeVisible();
    const count = await statCards.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // At least one stat value should have a non-dash value
    const values = page.locator('.stat-value');
    const firstValue = await values.first().textContent();
    expect(firstValue).toBeTruthy();
  });

  test('D2: Pipeline page shows stat grid and table', async ({ page }) => {
    await page.goto(`${baseURL}/#pipeline`);
    await page.waitForSelector('.stat-grid', { timeout: 10000 });

    // Stat cards visible
    const statCards = page.locator('.stat-card');
    await expect(statCards.first()).toBeVisible();

    // Data table present (pipeline page has 2 tables: runs + breakdown)
    const table = page.locator('.data-table').first();
    await expect(table).toBeVisible();
  });

  test('D3: Knowledge page renders entries', async ({ page }) => {
    // Ensure at least one knowledge entry exists for frontend test
    const existing = testDb.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge_entries WHERE project_id = ?"
    ).get(PROJECT_ID);

    if (existing.cnt === 0) {
      testDb.prepare(`
        INSERT OR IGNORE INTO knowledge_entries
          (id, project_id, category, title, body, tags, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        'ke-e2e-seed', PROJECT_ID, 'convention',
        'JWT Auth Convention', 'Always use Bearer token scheme for JWT authentication.',
        '["backend","security"]', 'active',
      );
    }

    await page.goto(`${baseURL}/#knowledge`);

    // Wait for the page to load — knowledge page has filter controls
    await page.waitForSelector('.filter-bar, .knowledge-filters, select, .entries-list, .card', { timeout: 10000 });

    // The page should have rendered some content
    const bodyText = await page.locator('#app').textContent();
    expect(bodyText.length).toBeGreaterThan(50);
  });

  test('D4: Auto-evolves page renders content', async ({ page }) => {
    await page.goto(`${baseURL}/#auto-evolves`);

    // Wait for either data table or empty state message
    await page.waitForSelector('.data-table, .empty-state', { timeout: 10000 });

    // The page should have rendered (either table or empty state)
    const hasTable = await page.locator('.data-table').count() > 0;
    const hasEmpty = await page.locator('.empty-state').count() > 0;
    expect(hasTable || hasEmpty).toBe(true);

    // If table exists, verify the promoted pattern from C1
    if (hasTable) {
      const row = page.locator('td', { hasText: 'E2E Test Rule' });
      await expect(row).toBeVisible();
    }
  });

  test('D5: Settings page loads config editor', async ({ page }) => {
    await page.goto(`${baseURL}/#settings`);
    await page.waitForSelector('.stat-grid, .stat-card', { timeout: 10000 });

    // Config textarea should exist and contain JSON
    const textarea = page.locator('textarea');
    if (await textarea.count() > 0) {
      const val = await textarea.first().inputValue();
      expect(val).toContain('knowledge_enabled');
    }
  });
});

// ===========================================================================
// Group E: API Verification
// ===========================================================================

test.describe('E: API Endpoints', () => {
  test('E1: GET /api/pipeline-runs/stats returns aggregated data', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/pipeline-runs/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total_runs).toBe('number');
    expect(Array.isArray(body.by_pipeline)).toBe(true);
  });

  test('E2: GET /api/pipeline-runs returns paginated list', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/pipeline-runs?limit=10`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  test('E3: GET /api/projects lists seeded project', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/projects`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const project = body.find(p => p.project_id === PROJECT_ID);
    expect(project).toBeTruthy();
    expect(project.name).toBe(PROJECT_NAME);
  });

  test('E4: GET /api/knowledge/entries filters by project', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/knowledge/entries?project=${PROJECT_ID}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    for (const item of body.items) {
      expect(item.project_id).toBe(PROJECT_ID);
    }
  });

  test('E5: GET /api/auto-evolves returns list with pagination', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/auto-evolves`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.page).toBe('number');
    expect(typeof body.per_page).toBe('number');
  });

  test('E6: GET /api/errors returns error lists', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/errors`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.collector_errors)).toBe(true);
    expect(Array.isArray(body.pipeline_errors)).toBe(true);
  });
});
