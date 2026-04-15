'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-queries-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('evolve/queries — updateAutoEvolve & deleteAutoEvolve', () => {
  let db, queries;
  const SEED_ID = 'test-ae-001';
  const SEED_ROW = {
    id: SEED_ID,
    title: 'Test pattern',
    description: 'Original description',
    target_type: 'rule',
    confidence: 0.5,
    observation_count: 3,
    rejection_count: 0,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = require('../../src/db/schema').createDb(TEST_DB);
    queries = require('../../src/evolve/queries');
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM auto_evolves');
    db.prepare(`
      INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      SEED_ROW.id, SEED_ROW.title, SEED_ROW.description, SEED_ROW.target_type,
      SEED_ROW.confidence, SEED_ROW.observation_count, SEED_ROW.rejection_count,
      SEED_ROW.status, SEED_ROW.created_at, SEED_ROW.updated_at
    );
  });

  // -- updateAutoEvolve --

  describe('updateAutoEvolve', () => {
    it('updates description and bumps updated_at', () => {
      queries.updateAutoEvolve(db, SEED_ID, { description: 'New description' });
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.description, 'New description');
      assert.notEqual(row.updated_at, SEED_ROW.updated_at);
    });

    it('clamps confidence above 1 to 1.0', () => {
      queries.updateAutoEvolve(db, SEED_ID, { confidence: 1.5 });
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.confidence, 1.0);
    });

    it('clamps confidence below 0 to 0', () => {
      queries.updateAutoEvolve(db, SEED_ID, { confidence: -0.5 });
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.confidence, 0);
    });

    it('updates status, projects, and observation_count', () => {
      queries.updateAutoEvolve(db, SEED_ID, {
        status: 'promoted',
        projects: '["open-pulse"]',
        observation_count: 10,
      });
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.status, 'promoted');
      assert.equal(row.projects, '["open-pulse"]');
      assert.equal(row.observation_count, 10);
    });

    it('with empty fields is a no-op (updated_at unchanged)', () => {
      queries.updateAutoEvolve(db, SEED_ID, {});
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.updated_at, SEED_ROW.updated_at);
    });

    it('ignores unknown keys', () => {
      queries.updateAutoEvolve(db, SEED_ID, { bogus: 'value' });
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row.updated_at, SEED_ROW.updated_at);
      assert.equal(row.description, SEED_ROW.description);
    });
  });

  // -- deleteAutoEvolve --

  describe('deleteAutoEvolve', () => {
    it('removes the row', () => {
      queries.deleteAutoEvolve(db, SEED_ID);
      const row = queries.getAutoEvolve(db, SEED_ID);
      assert.equal(row, undefined);
    });

    it('on missing id does not throw', () => {
      assert.doesNotThrow(() => {
        queries.deleteAutoEvolve(db, 'nonexistent-id');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// queryAllAutoEvolves (bulk, unpaginated)
// ---------------------------------------------------------------------------

describe('queryAllAutoEvolves', () => {
  let db, tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-ae-bulk-'));
    const { createDb } = require('../../src/db/schema');
    db = createDb(path.join(tmpDir, 'test.db'));
    const stmt = db.prepare('INSERT INTO auto_evolves (id, title, target_type, confidence, status, projects, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    stmt.run('ae-b1', 'P1', 'rule', 0.3, 'draft', '["alpha"]', '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z');
    stmt.run('ae-b2', 'P2', 'skill', 0.5, 'active', '["alpha"]', '2026-04-10T01:00:00Z', '2026-04-10T01:00:00Z');
    stmt.run('ae-b3', 'P3', 'rule', 0.3, 'draft', '["beta"]', '2026-04-10T02:00:00Z', '2026-04-10T02:00:00Z');
  });
  after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns all rows as flat array', () => {
    const { queryAllAutoEvolves } = require('../../src/evolve/queries');
    const rows = queryAllAutoEvolves(db, {});
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 3);
  });

  it('filters by project', () => {
    const { queryAllAutoEvolves } = require('../../src/evolve/queries');
    assert.equal(queryAllAutoEvolves(db, { project: 'alpha' }).length, 2);
  });

  it('filters by status', () => {
    const { queryAllAutoEvolves } = require('../../src/evolve/queries');
    assert.equal(queryAllAutoEvolves(db, { status: 'draft' }).length, 2);
  });

  it('respects limit', () => {
    const { queryAllAutoEvolves } = require('../../src/evolve/queries');
    assert.equal(queryAllAutoEvolves(db, { limit: 2 }).length, 2);
  });
});
