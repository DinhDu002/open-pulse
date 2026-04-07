'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDb,
  upsertClProject,
  insertObservation,
  upsertInstinct,
  insertSuggestion,
  queryObservations,
  getObservation,
  queryObservationActivity,
  queryInstinctsFiltered,
  getInstinctStats,
  getInstinctObservations,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  queryLearningActivity,
  queryLearningRecent,
} = require('../src/op-db');

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

function seedObservation(db, overrides = {}) {
  const defaults = {
    observed_at: '2024-01-05T12:00:00Z',
    project_id: 'proj-a',
    session_id: 'sess-1',
    category: 'coding',
    observation: 'Test observation text',
    raw_context: null,
    instinct_id: null,
  };
  return db.prepare(`
    INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
    VALUES (@observed_at, @project_id, @session_id, @category, @observation, @raw_context, @instinct_id)
  `).run({ ...defaults, ...overrides });
}

function seedInstinct(db, overrides = {}) {
  const defaults = {
    project_id: 'proj-a',
    category: 'coding',
    pattern: 'Test pattern',
    confidence: 0.5,
    seen_count: 3,
    first_seen: '2024-01-01T00:00:00Z',
    last_seen: '2024-01-10T00:00:00Z',
    instinct: 'Test instinct body',
  };
  upsertInstinct(db, { ...defaults, ...overrides });
  return db.prepare('SELECT * FROM cl_instincts ORDER BY id DESC LIMIT 1').get();
}

function seedSuggestion(db, overrides = {}) {
  const defaults = {
    id: `sugg-${Date.now()}-${Math.random()}`,
    created_at: '2024-01-05T12:00:00Z',
    type: 'hook',
    confidence: 0.7,
    description: 'Test suggestion',
    evidence: null,
    instinct_id: null,
    status: 'pending',
  };
  insertSuggestion(db, { ...defaults, ...overrides });
  return db.prepare('SELECT * FROM suggestions WHERE id = ?').get((overrides.id || defaults.id));
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
// Migration: instinct_id column
// ---------------------------------------------------------------------------

describe('DB migration: instinct_id on cl_observations', () => {
  test('instinct_id column exists after createDb', () => {
    const col = db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('cl_observations') WHERE name = 'instinct_id'"
    ).get();
    assert.equal(col.cnt, 1);
  });

  test('index on instinct_id exists', () => {
    const idx = db.prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='index' AND name='idx_cl_observations_instinct'"
    ).get();
    assert.equal(idx.cnt, 1);
  });

  test('can insert observation with instinct_id', () => {
    const res = seedObservation(db, { instinct_id: 42 });
    assert.ok(res.lastInsertRowid > 0);
    const row = db.prepare('SELECT instinct_id FROM cl_observations WHERE id = ?').get(res.lastInsertRowid);
    assert.equal(row.instinct_id, 42);
  });
});

// ---------------------------------------------------------------------------
// queryObservations
// ---------------------------------------------------------------------------

describe('queryObservations', () => {
  let obsIds = [];

  before(() => {
    // Insert a known set
    obsIds = [
      seedObservation(db, { project_id: 'proj-a', category: 'coding', observation: 'alpha pattern found', observed_at: '2024-02-01T00:00:00Z' }).lastInsertRowid,
      seedObservation(db, { project_id: 'proj-a', category: 'testing', observation: 'beta pattern found', observed_at: '2024-02-02T00:00:00Z' }).lastInsertRowid,
      seedObservation(db, { project_id: 'proj-b', category: 'coding', observation: 'gamma note', observed_at: '2024-02-03T00:00:00Z' }).lastInsertRowid,
    ];
  });

  test('returns all observations without filters', () => {
    const result = queryObservations(db, {});
    assert.ok(result.total >= 3);
    assert.ok(Array.isArray(result.items));
    assert.equal(typeof result.page, 'number');
    assert.equal(typeof result.per_page, 'number');
  });

  test('filters by project', () => {
    const result = queryObservations(db, { project: 'proj-b' });
    assert.ok(result.items.every(r => r.project_id === 'proj-b'));
  });

  test('filters by category', () => {
    const result = queryObservations(db, { category: 'testing' });
    assert.ok(result.items.every(r => r.category === 'testing'));
  });

  test('filters by from date', () => {
    const result = queryObservations(db, { from: '2024-02-02T00:00:00Z' });
    assert.ok(result.items.every(r => r.observed_at >= '2024-02-02T00:00:00Z'));
  });

  test('filters by to date', () => {
    const result = queryObservations(db, { to: '2024-02-01T23:59:59Z' });
    assert.ok(result.items.every(r => r.observed_at <= '2024-02-01T23:59:59Z'));
  });

  test('filters by instinct_id', () => {
    const instinctId = 99;
    seedObservation(db, { instinct_id: instinctId, observation: 'linked to instinct' });
    const result = queryObservations(db, { instinct_id: instinctId });
    assert.ok(result.items.length >= 1);
    assert.ok(result.items.every(r => r.instinct_id === instinctId));
  });

  test('filters by search text', () => {
    const result = queryObservations(db, { search: 'alpha' });
    assert.ok(result.items.length >= 1);
    assert.ok(result.items.every(r => r.observation.toLowerCase().includes('alpha')));
  });

  test('paginates correctly', () => {
    const page1 = queryObservations(db, { page: 1, perPage: 2 });
    const page2 = queryObservations(db, { page: 2, perPage: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.page, 1);
    assert.equal(page1.per_page, 2);
    // page2 items should differ from page1
    const ids1 = page1.items.map(r => r.id);
    const ids2 = page2.items.map(r => r.id);
    assert.ok(!ids1.some(id => ids2.includes(id)));
  });

  test('total reflects filter, not page size', () => {
    const result = queryObservations(db, { project: 'proj-a', perPage: 1 });
    assert.ok(result.total > result.items.length);
  });
});

// ---------------------------------------------------------------------------
// getObservation
// ---------------------------------------------------------------------------

describe('getObservation', () => {
  test('returns single observation by id', () => {
    const res = seedObservation(db, { observation: 'unique get obs' });
    const obs = getObservation(db, res.lastInsertRowid);
    assert.ok(obs);
    assert.equal(obs.observation, 'unique get obs');
  });

  test('returns null/undefined for non-existent id', () => {
    const obs = getObservation(db, 999999);
    assert.ok(obs == null);
  });
});

// ---------------------------------------------------------------------------
// queryObservationActivity
// ---------------------------------------------------------------------------

describe('queryObservationActivity', () => {
  test('returns array of { date, count }', () => {
    const result = queryObservationActivity(db, 30);
    assert.ok(Array.isArray(result));
    if (result.length > 0) {
      assert.ok('date' in result[0]);
      assert.ok('count' in result[0]);
    }
  });

  test('limits to given number of days', () => {
    const result = queryObservationActivity(db, 7);
    // All dates should be within last 7 days or earlier
    assert.ok(Array.isArray(result));
  });
});

// ---------------------------------------------------------------------------
// queryInstinctsFiltered
// ---------------------------------------------------------------------------

describe('queryInstinctsFiltered', () => {
  before(() => {
    seedInstinct(db, { project_id: 'proj-a', category: 'workflow', pattern: 'Always plan first', confidence: 0.8 });
    seedInstinct(db, { project_id: 'proj-a', category: 'coding', pattern: 'Use immutable data', confidence: 0.25 });
    seedInstinct(db, { project_id: 'proj-b', category: 'testing', pattern: 'Write tests before code', confidence: 0.55 });
  });

  test('returns paginated result shape', () => {
    const result = queryInstinctsFiltered(db, {});
    assert.ok(Array.isArray(result.items));
    assert.equal(typeof result.total, 'number');
    assert.equal(typeof result.page, 'number');
    assert.equal(typeof result.per_page, 'number');
  });

  test('filters by project', () => {
    const result = queryInstinctsFiltered(db, { project: 'proj-b' });
    assert.ok(result.items.every(r => r.project_id === 'proj-b'));
  });

  test('filters by category', () => {
    const result = queryInstinctsFiltered(db, { category: 'workflow' });
    assert.ok(result.items.every(r => r.category === 'workflow'));
  });

  test('filters by confidence_min', () => {
    const result = queryInstinctsFiltered(db, { confidence_min: 0.5 });
    assert.ok(result.items.every(r => r.confidence >= 0.5));
  });

  test('filters by confidence_max', () => {
    const result = queryInstinctsFiltered(db, { confidence_max: 0.4 });
    assert.ok(result.items.every(r => r.confidence <= 0.4));
  });

  test('filters by search in pattern', () => {
    const result = queryInstinctsFiltered(db, { search: 'immutable' });
    assert.ok(result.items.length >= 1);
    assert.ok(result.items.every(r => r.pattern.toLowerCase().includes('immutable') || r.instinct.toLowerCase().includes('immutable')));
  });

  test('paginates correctly', () => {
    // Insert enough to fill 2 pages
    for (let i = 0; i < 5; i++) {
      seedInstinct(db, { pattern: `Pagination pattern ${i}`, project_id: 'proj-a' });
    }
    const page1 = queryInstinctsFiltered(db, { page: 1, perPage: 3 });
    const page2 = queryInstinctsFiltered(db, { page: 2, perPage: 3 });
    assert.equal(page1.items.length, 3);
    const ids1 = page1.items.map(r => r.id);
    const ids2 = page2.items.map(r => r.id);
    assert.ok(!ids1.some(id => ids2.includes(id)));
  });
});

// ---------------------------------------------------------------------------
// getInstinctStats
// ---------------------------------------------------------------------------

describe('getInstinctStats', () => {
  test('returns byDomain array', () => {
    const stats = getInstinctStats(db);
    assert.ok('byDomain' in stats);
    assert.ok(Array.isArray(stats.byDomain));
    if (stats.byDomain.length > 0) {
      assert.ok('domain' in stats.byDomain[0]);
      assert.ok('count' in stats.byDomain[0]);
    }
  });

  test('returns confidenceDistribution array', () => {
    const stats = getInstinctStats(db);
    assert.ok('confidenceDistribution' in stats);
    assert.ok(Array.isArray(stats.confidenceDistribution));
    if (stats.confidenceDistribution.length > 0) {
      assert.ok('bucket' in stats.confidenceDistribution[0]);
      assert.ok('count' in stats.confidenceDistribution[0]);
    }
  });

  test('confidence buckets are low/medium/high', () => {
    const stats = getInstinctStats(db);
    const buckets = stats.confidenceDistribution.map(r => r.bucket);
    for (const b of buckets) {
      assert.ok(['low', 'medium', 'high'].includes(b));
    }
  });

  test('byDomain uses category as domain', () => {
    const stats = getInstinctStats(db);
    // domains should match existing categories
    assert.ok(stats.byDomain.length > 0);
  });
});

// ---------------------------------------------------------------------------
// getInstinctObservations
// ---------------------------------------------------------------------------

describe('getInstinctObservations', () => {
  test('returns observations linked to instinct', () => {
    const inst = seedInstinct(db, { pattern: 'Linked instinct pattern' });
    seedObservation(db, { instinct_id: inst.id, observation: 'linked obs 1' });
    seedObservation(db, { instinct_id: inst.id, observation: 'linked obs 2' });

    const obs = getInstinctObservations(db, inst.id);
    assert.ok(Array.isArray(obs));
    assert.ok(obs.length >= 2);
    assert.ok(obs.every(o => o.instinct_id === inst.id));
  });

  test('returns empty array for instinct with no observations', () => {
    const inst = seedInstinct(db, { pattern: 'Lonely instinct' });
    const obs = getInstinctObservations(db, inst.id);
    assert.ok(Array.isArray(obs));
    assert.equal(obs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// getInstinctSuggestions
// ---------------------------------------------------------------------------

describe('getInstinctSuggestions', () => {
  test('returns suggestions linked to instinct', () => {
    const inst = seedInstinct(db, { pattern: 'Suggestion source instinct' });
    seedSuggestion(db, { id: `sugg-inst-1-${inst.id}`, instinct_id: String(inst.id) });
    seedSuggestion(db, { id: `sugg-inst-2-${inst.id}`, instinct_id: String(inst.id) });

    const suggs = getInstinctSuggestions(db, inst.id);
    assert.ok(Array.isArray(suggs));
    assert.ok(suggs.length >= 2);
  });

  test('returns empty array for instinct with no suggestions', () => {
    const inst = seedInstinct(db, { pattern: 'No suggestions instinct' });
    const suggs = getInstinctSuggestions(db, inst.id);
    assert.ok(Array.isArray(suggs));
    assert.equal(suggs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// updateInstinct
// ---------------------------------------------------------------------------

describe('updateInstinct', () => {
  test('updates confidence', () => {
    const inst = seedInstinct(db, { confidence: 0.5, pattern: 'Update target' });
    updateInstinct(db, inst.id, { confidence: 0.75 });
    const updated = db.prepare('SELECT confidence FROM cl_instincts WHERE id = ?').get(inst.id);
    assert.equal(updated.confidence, 0.75);
  });

  test('clamps confidence to 0.0 minimum', () => {
    const inst = seedInstinct(db, { confidence: 0.5, pattern: 'Clamp min target' });
    updateInstinct(db, inst.id, { confidence: -0.5 });
    const updated = db.prepare('SELECT confidence FROM cl_instincts WHERE id = ?').get(inst.id);
    assert.equal(updated.confidence, 0.0);
  });

  test('clamps confidence to 0.95 maximum', () => {
    const inst = seedInstinct(db, { confidence: 0.5, pattern: 'Clamp max target' });
    updateInstinct(db, inst.id, { confidence: 1.5 });
    const updated = db.prepare('SELECT confidence FROM cl_instincts WHERE id = ?').get(inst.id);
    assert.equal(updated.confidence, 0.95);
  });
});

// ---------------------------------------------------------------------------
// deleteInstinct
// ---------------------------------------------------------------------------

describe('deleteInstinct', () => {
  test('deletes instinct by id', () => {
    const inst = seedInstinct(db, { pattern: 'To be deleted' });
    deleteInstinct(db, inst.id);
    const row = db.prepare('SELECT * FROM cl_instincts WHERE id = ?').get(inst.id);
    assert.ok(row == null);
  });

  test('no error when deleting non-existent id', () => {
    assert.doesNotThrow(() => deleteInstinct(db, 999999));
  });
});

// ---------------------------------------------------------------------------
// getProjectSummary
// ---------------------------------------------------------------------------

describe('getProjectSummary', () => {
  test('returns project with instinct_count, observation_count, suggestion_counts', () => {
    // proj-a has data from earlier seeds
    const summary = getProjectSummary(db, 'proj-a');
    assert.ok(summary);
    assert.equal(summary.project_id, 'proj-a');
    assert.equal(typeof summary.instinct_count, 'number');
    assert.equal(typeof summary.observation_count, 'number');
    assert.ok('suggestion_counts' in summary);
    assert.equal(typeof summary.suggestion_counts.pending, 'number');
    assert.equal(typeof summary.suggestion_counts.approved, 'number');
    assert.equal(typeof summary.suggestion_counts.dismissed, 'number');
  });

  test('returns null/undefined for non-existent project', () => {
    const summary = getProjectSummary(db, 'nonexistent-proj');
    assert.ok(summary == null);
  });

  test('counts are accurate', () => {
    // Use a fresh project for accurate counting
    seedProject(db, 'proj-count', 'Count Project');
    seedInstinct(db, { project_id: 'proj-count', pattern: 'Count instinct 1' });
    seedInstinct(db, { project_id: 'proj-count', pattern: 'Count instinct 2' });
    seedObservation(db, { project_id: 'proj-count', observation: 'Count obs 1' });

    const summary = getProjectSummary(db, 'proj-count');
    assert.equal(summary.instinct_count, 2);
    assert.equal(summary.observation_count, 1);
  });
});

// ---------------------------------------------------------------------------
// getProjectTimeline
// ---------------------------------------------------------------------------

describe('getProjectTimeline', () => {
  test('returns array of weekly data', () => {
    const timeline = getProjectTimeline(db, 'proj-a', 4);
    assert.ok(Array.isArray(timeline));
  });

  test('timeline items have required fields', () => {
    // Seed a fresh project for predictable timeline
    seedProject(db, 'proj-timeline', 'Timeline Project');
    seedInstinct(db, { project_id: 'proj-timeline', pattern: 'Timeline instinct', confidence: 0.6 });
    const timeline = getProjectTimeline(db, 'proj-timeline', 8);
    assert.ok(Array.isArray(timeline));
    if (timeline.length > 0) {
      assert.ok('week' in timeline[0]);
      assert.ok('instinct_count' in timeline[0]);
      assert.ok('avg_confidence' in timeline[0]);
    }
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

  test('activity items have date and counts', () => {
    const result = queryLearningActivity(db, 30);
    if (result.length > 0) {
      assert.ok('date' in result[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// queryLearningRecent
// ---------------------------------------------------------------------------

describe('queryLearningRecent', () => {
  test('returns array of mixed items', () => {
    const result = queryLearningRecent(db, 10);
    assert.ok(Array.isArray(result));
  });

  test('items have required fields', () => {
    const result = queryLearningRecent(db, 10);
    if (result.length > 0) {
      const item = result[0];
      assert.ok('kind' in item);
      assert.ok('id' in item);
      assert.ok('timestamp' in item);
      assert.ok('title' in item);
      assert.ok(['instinct', 'suggestion'].includes(item.kind));
    }
  });

  test('respects limit', () => {
    const result = queryLearningRecent(db, 3);
    assert.ok(result.length <= 3);
  });

  test('ordered by timestamp descending', () => {
    const result = queryLearningRecent(db, 20);
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i - 1].timestamp >= result[i].timestamp);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests for instincts API
// ---------------------------------------------------------------------------

describe('HTTP: /api/instincts', () => {
  let app;
  let httpInstinctId;
  const HTTP_INST_DIR = path.join(os.tmpdir(), `op-inst-http-test-${Date.now()}`);

  before(async () => {
    fs.mkdirSync(path.join(HTTP_INST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_INST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_INST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_INST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_INST_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_INST_DIR, '.claude', 'rules'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(HTTP_INST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = HTTP_INST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(HTTP_INST_DIR, '.claude');

    // op-server caches require — delete so new env vars take effect
    delete require.cache[require.resolve('../src/op-server')];
    delete require.cache[require.resolve('../src/op-db')];
    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed test data
    const httpDb = createDb(path.join(HTTP_INST_DIR, 'test.db'));
    upsertClProject(httpDb, {
      project_id: 'inst-proj',
      name: 'Instinct Project',
      directory: '/inst-proj',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-10T00:00:00Z',
      session_count: 3,
    });
    upsertInstinct(httpDb, {
      project_id: 'inst-proj',
      category: 'workflow',
      pattern: 'Always plan before coding',
      confidence: 0.8,
      seen_count: 5,
      first_seen: '2024-01-01T00:00:00Z',
      last_seen: '2024-01-10T00:00:00Z',
      instinct: 'Planning is essential',
    });
    upsertInstinct(httpDb, {
      project_id: 'inst-proj',
      category: 'testing',
      pattern: 'Write tests first',
      confidence: 0.3,
      seen_count: 2,
      first_seen: '2024-01-02T00:00:00Z',
      last_seen: '2024-01-09T00:00:00Z',
      instinct: 'TDD approach works',
    });
    httpInstinctId = httpDb.prepare('SELECT id FROM cl_instincts ORDER BY id LIMIT 1').get().id;
    httpDb.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(HTTP_INST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    delete require.cache[require.resolve('../src/op-server')];
    delete require.cache[require.resolve('../src/op-db')];
  });

  test('GET /api/instincts returns paginated result', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('items' in body, 'body should have items');
    assert.ok('total' in body, 'body should have total');
    assert.ok('page' in body, 'body should have page');
    assert.ok('per_page' in body, 'body should have per_page');
    assert.ok(Array.isArray(body.items));
    assert.ok(body.total >= 2);
  });

  test('GET /api/instincts filters by domain (category)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts?domain=workflow' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.every(r => r.category === 'workflow'));
  });

  test('GET /api/instincts filters by confidence_min', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts?confidence_min=0.5' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.every(r => r.confidence >= 0.5));
  });

  test('GET /api/instincts filters by search', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts?search=plan' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.length >= 1);
    assert.ok(body.items.every(r =>
      r.pattern.toLowerCase().includes('plan') || (r.instinct || '').toLowerCase().includes('plan')
    ));
  });

  test('GET /api/instincts/stats returns byDomain and confidenceDistribution', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts/stats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('byDomain' in body);
    assert.ok('confidenceDistribution' in body);
    assert.ok(Array.isArray(body.byDomain));
    assert.ok(Array.isArray(body.confidenceDistribution));
  });

  test('GET /api/instincts/:id/observations returns array', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instincts/${httpInstinctId}/observations` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  test('GET /api/instincts/:id/suggestions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instincts/${httpInstinctId}/suggestions` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  test('PUT /api/instincts/:id updates confidence', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/instincts/${httpInstinctId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confidence: 0.55 }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.id, httpInstinctId);

    // Verify the update via list endpoint
    const listRes = await app.inject({ method: 'GET', url: `/api/instincts?confidence_min=0.5&confidence_max=0.6` });
    const list = JSON.parse(listRes.body);
    assert.ok(list.items.some(r => r.id === httpInstinctId));
  });

  test('DELETE /api/instincts/:id deletes the instinct', async () => {
    // Seed a fresh instinct to delete
    const tmpDb = createDb(path.join(HTTP_INST_DIR, 'test.db'));
    upsertInstinct(tmpDb, {
      project_id: 'inst-proj',
      category: 'delete-me',
      pattern: 'To be deleted via HTTP',
      confidence: 0.5,
      seen_count: 1,
      first_seen: '2024-01-01T00:00:00Z',
      last_seen: '2024-01-01T00:00:00Z',
      instinct: 'Delete test body',
    });
    const deleteId = tmpDb.prepare("SELECT id FROM cl_instincts WHERE pattern = 'To be deleted via HTTP' LIMIT 1").get().id;
    tmpDb.close();

    const res = await app.inject({ method: 'DELETE', url: `/api/instincts/${deleteId}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.id, deleteId);

    // Verify gone
    const listRes = await app.inject({ method: 'GET', url: '/api/instincts?search=To+be+deleted+via+HTTP' });
    const list = JSON.parse(listRes.body);
    assert.equal(list.total, 0);
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests for observations API
// ---------------------------------------------------------------------------

describe('HTTP: /api/observations', () => {
  let app;
  const HTTP_TEST_DIR = path.join(os.tmpdir(), `op-obs-http-test-${Date.now()}`);

  before(async () => {
    fs.mkdirSync(path.join(HTTP_TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_TEST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_TEST_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_TEST_DIR, '.claude', 'rules'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(HTTP_TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = HTTP_TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(HTTP_TEST_DIR, '.claude');

    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed test data directly into the test DB
    const httpDb = createDb(path.join(HTTP_TEST_DIR, 'test.db'));
    upsertClProject(httpDb, {
      project_id: 'http-proj',
      name: 'HTTP Project',
      directory: '/http-proj',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-10T00:00:00Z',
      session_count: 2,
    });
    httpDb.prepare(`
      INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('2024-06-01T00:00:00Z', 'http-proj', 'sess-http-1', 'coding', 'HTTP test observation alpha', null, null);
    httpDb.prepare(`
      INSERT INTO cl_observations (observed_at, project_id, session_id, category, observation, raw_context, instinct_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('2024-06-02T00:00:00Z', 'http-proj', 'sess-http-2', 'testing', 'HTTP test observation beta', null, null);
    httpDb.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(HTTP_TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
  });

  test('GET /api/observations returns paginated result', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('items' in body, 'body should have items');
    assert.ok('total' in body, 'body should have total');
    assert.ok('page' in body, 'body should have page');
    assert.ok('per_page' in body, 'body should have per_page');
    assert.ok(Array.isArray(body.items));
  });

  test('GET /api/observations filters by category', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations?category=coding' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.every(r => r.category === 'coding'));
  });

  test('GET /api/observations filters by search', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations?search=alpha' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.items.length >= 1);
    assert.ok(body.items.every(r => r.observation.toLowerCase().includes('alpha')));
  });

  test('GET /api/observations respects page and per_page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations?page=1&per_page=1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.page, 1);
    assert.equal(body.per_page, 1);
    assert.equal(body.items.length, 1);
  });

  test('GET /api/observations/activity returns array of { date, count }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations/activity' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      assert.ok('date' in body[0]);
      assert.ok('count' in body[0]);
    }
  });

  test('GET /api/observations/activity accepts days param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations/activity?days=14' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  test('GET /api/observations/:id returns single observation', async () => {
    // First get a valid id from the list
    const listRes = await app.inject({ method: 'GET', url: '/api/observations' });
    const list = JSON.parse(listRes.body);
    assert.ok(list.total >= 1, 'need at least one observation');
    const id = list.items[0].id;

    const res = await app.inject({ method: 'GET', url: `/api/observations/${id}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, id);
    assert.ok('observation' in body);
    assert.ok('category' in body);
  });

  test('GET /api/observations/:id returns 404 for missing id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/observations/999999' });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok('error' in body);
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests for projects + learning API
// ---------------------------------------------------------------------------

describe('HTTP: /api/projects and /api/learning', () => {
  let app;
  let httpDb;
  let projInstinctId;
  const HTTP_PL_DIR = path.join(os.tmpdir(), `op-pl-http-test-${Date.now()}`);

  before(async () => {
    fs.mkdirSync(path.join(HTTP_PL_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(HTTP_PL_DIR, '.claude', 'rules'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(HTTP_PL_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = HTTP_PL_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(HTTP_PL_DIR, '.claude');

    delete require.cache[require.resolve('../src/op-server')];
    delete require.cache[require.resolve('../src/op-db')];
    const { buildApp } = require('../src/op-server');
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
    upsertInstinct(httpDb, {
      project_id: 'pl-proj',
      category: 'workflow',
      pattern: 'Always plan before coding',
      confidence: 0.8,
      seen_count: 5,
      first_seen: '2024-01-01T00:00:00Z',
      last_seen: '2024-01-10T00:00:00Z',
      instinct: 'Planning is essential',
    });
    projInstinctId = httpDb.prepare('SELECT id FROM cl_instincts WHERE project_id = ? LIMIT 1').get('pl-proj').id;
    // Seed a suggestion linked to this instinct
    insertSuggestion(httpDb, {
      id: `pl-sugg-1`,
      created_at: '2024-01-05T12:00:00Z',
      type: 'hook',
      confidence: 0.7,
      description: 'PL project suggestion',
      evidence: null,
      instinct_id: String(projInstinctId),
      status: 'pending',
    });
    httpDb.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(HTTP_PL_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    delete require.cache[require.resolve('../src/op-server')];
    delete require.cache[require.resolve('../src/op-db')];
  });

  test('GET /api/projects/:id/summary returns project with counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/pl-proj/summary' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.project_id, 'pl-proj');
    assert.equal(typeof body.instinct_count, 'number');
    assert.equal(typeof body.observation_count, 'number');
    assert.ok('suggestion_counts' in body);
    assert.equal(typeof body.suggestion_counts.pending, 'number');
    assert.equal(typeof body.suggestion_counts.approved, 'number');
    assert.equal(typeof body.suggestion_counts.dismissed, 'number');
  });

  test('GET /api/projects/:id/summary returns 404 for unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nonexistent-xyz/summary' });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok('error' in body);
  });

  test('GET /api/projects/:id/timeline returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/pl-proj/timeline?weeks=4' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
  });

  test('GET /api/learning/activity returns daily activity array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/learning/activity?days=30' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      assert.ok('date' in body[0]);
      assert.ok('count' in body[0]);
    }
  });

  test('GET /api/learning/recent returns array with kind field', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/learning/recent?limit=5' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      assert.ok('kind' in body[0]);
      assert.ok(['instinct', 'suggestion'].includes(body[0].kind));
    }
  });

  test('GET /api/suggestions?project=pl-proj filters by project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/suggestions?project=pl-proj' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
    assert.ok(body.every(s => s.instinct_id === String(projInstinctId)));
  });
});
