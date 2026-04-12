'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDb } = require('../../src/db/schema');
const { upsertClProject, getProjectSummary, queryLearningActivity, queryLearningRecent } = require('../../src/db/projects');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir;
let db;

function makeDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-learning-test-'));
  return createDb(path.join(tmpDir, 'test.db'));
}

function seedProject(db, projectId = 'proj-a', name = 'Project A') {
  upsertClProject(db, {
    project_id: projectId,
    name,
    directory: `/projects/${projectId}`,
    first_seen_at: '2024-01-01T00:00:00Z',
    last_seen_at: '2024-01-10T00:00:00Z',
    session_count: 5,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

before(() => {
  db = makeDb();
  seedProject(db, 'proj-a', 'Project A');
  seedProject(db, 'proj-b', 'Project B');
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// upsertClProject dedup by directory
// ---------------------------------------------------------------------------

describe('upsertClProject dedup by directory', () => {
  test('same directory with different project_id keeps only one row', () => {
    const tmpDb = makeDb();
    upsertClProject(tmpDb, {
      project_id: 'old-id-aaa',
      name: 'my-project',
      directory: '/tmp/my-project',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-01T00:00:00Z',
      session_count: 0,
    });
    // Upsert same directory with new project_id (simulates remote being added)
    upsertClProject(tmpDb, {
      project_id: 'new-id-bbb',
      name: 'my-project',
      directory: '/tmp/my-project',
      first_seen_at: '2024-02-01T00:00:00Z',
      last_seen_at: '2024-02-01T00:00:00Z',
      session_count: 0,
    });

    const rows = tmpDb.prepare(
      "SELECT * FROM cl_projects WHERE directory = '/tmp/my-project'"
    ).all();
    assert.equal(rows.length, 1, 'should have exactly 1 row for directory');
    assert.equal(rows[0].project_id, 'new-id-bbb', 'should keep new project_id');
    tmpDb.close();
  });

  test('same project_id upsert updates normally', () => {
    const tmpDb = makeDb();
    upsertClProject(tmpDb, {
      project_id: 'same-id',
      name: 'project-v1',
      directory: '/tmp/same-project',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-01T00:00:00Z',
      session_count: 0,
    });
    upsertClProject(tmpDb, {
      project_id: 'same-id',
      name: 'project-v2',
      directory: '/tmp/same-project',
      first_seen_at: '2024-02-01T00:00:00Z',
      last_seen_at: '2024-02-01T00:00:00Z',
      session_count: 0,
    });

    const rows = tmpDb.prepare("SELECT * FROM cl_projects WHERE project_id = 'same-id'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'project-v2', 'name should be updated');
    tmpDb.close();
  });
});

// ---------------------------------------------------------------------------
// getProjectSummary
// ---------------------------------------------------------------------------

describe('getProjectSummary', () => {
  test('returns project with instinct_count field', () => {
    const summary = getProjectSummary(db, 'proj-a');
    assert.ok(summary);
    assert.equal(summary.project_id, 'proj-a');
    assert.equal(typeof summary.instinct_count, 'number');
  });

  test('returns null/undefined for non-existent project', () => {
    const summary = getProjectSummary(db, 'nonexistent-proj');
    assert.ok(summary == null);
  });
});

// ---------------------------------------------------------------------------
// queryLearningActivity
// ---------------------------------------------------------------------------

describe('queryLearningActivity', () => {
  test('returns array of daily activity', () => {
    const result = queryLearningActivity(db, 30);
    assert.ok(Array.isArray(result));
  });
});

// ---------------------------------------------------------------------------
// queryLearningRecent
// ---------------------------------------------------------------------------

describe('queryLearningRecent', () => {
  test('returns array', () => {
    const result = queryLearningRecent(db, 10);
    assert.ok(Array.isArray(result));
  });

  test('respects limit', () => {
    const result = queryLearningRecent(db, 3);
    assert.ok(result.length <= 3);
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests for projects + learning API
// ---------------------------------------------------------------------------

describe('HTTP: /api/projects and /api/learning', () => {
  let app;
  let httpDb;
  const HTTP_PL_DIR = path.join(os.tmpdir(), `op-pl-http-test-${Date.now()}`);

  before(async () => {
    fs.mkdirSync(path.join(HTTP_PL_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'rules'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(HTTP_PL_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = HTTP_PL_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(HTTP_PL_DIR, '.claude');

    delete require.cache[require.resolve('../../src/server')];
    delete require.cache[require.resolve('../../src/db/schema')];
    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed test data
    httpDb = createDb(path.join(HTTP_PL_DIR, 'test.db'));
    upsertClProject(httpDb, {
      project_id: 'pl-proj',
      name: 'PL Project',
      directory: '/pl-proj',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-10T00:00:00Z',
      session_count: 4,
    });
    httpDb.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(HTTP_PL_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    delete require.cache[require.resolve('../../src/server')];
    delete require.cache[require.resolve('../../src/db/schema')];
  });

  test('GET /api/projects/:id/summary returns project with counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/pl-proj/summary' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.project_id, 'pl-proj');
    assert.equal(typeof body.instinct_count, 'number');
  });

  test('GET /api/projects/:id/summary returns 404 for unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nonexistent-xyz/summary' });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok('error' in body);
  });

  test('GET /api/learning/activity returns daily activity array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/learning/activity?days=30' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  test('GET /api/learning/recent returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/learning/recent?limit=5' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });
});
