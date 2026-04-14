'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-pipeline-runs-test-${Date.now()}`);

describe('pipeline-runs queries', () => {
  let db;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    const { createDb } = require('../../src/db/schema');
    db = createDb(process.env.OPEN_PULSE_DB);
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('insertPipelineRun inserts and returns id', () => {
    const { insertPipelineRun } = require('../../src/db/pipeline-runs');
    const id = insertPipelineRun(db, {
      pipeline: 'knowledge_extract',
      project_id: 'proj-1',
      model: 'sonnet',
      status: 'success',
      input_tokens: 1200,
      output_tokens: 380,
      duration_ms: 4200,
    });
    assert.ok(id > 0);
  });

  it('queryPipelineRuns returns paginated results', () => {
    const { insertPipelineRun, queryPipelineRuns } = require('../../src/db/pipeline-runs');
    insertPipelineRun(db, { pipeline: 'knowledge_scan', project_id: 'proj-1', model: 'sonnet', status: 'success', input_tokens: 500, output_tokens: 100, duration_ms: 2000 });
    insertPipelineRun(db, { pipeline: 'knowledge_extract', project_id: 'proj-2', model: 'sonnet', status: 'success', input_tokens: 900, output_tokens: 200, duration_ms: 3000 });

    const result = queryPipelineRuns(db, { projectId: 'proj-1', page: 1, perPage: 10 });
    assert.equal(result.total, 2);
    assert.equal(result.items.length, 2);
    assert.equal(result.page, 1);
  });

  it('queryPipelineRuns filters by status', () => {
    const { queryPipelineRuns } = require('../../src/db/pipeline-runs');
    const result = queryPipelineRuns(db, { status: 'success' });
    assert.equal(result.total, 3);
  });

  it('getPipelineRunStats returns aggregated stats', () => {
    const { getPipelineRunStats } = require('../../src/db/pipeline-runs');
    const stats = getPipelineRunStats(db, { projectId: 'proj-1' });
    assert.equal(stats.total_runs, 2);
    assert.equal(stats.success_count, 2);
    assert.equal(stats.error_count, 0);
    assert.equal(stats.total_input_tokens, 1700);
    assert.equal(stats.total_output_tokens, 480);
    assert.ok(Array.isArray(stats.by_pipeline));
  });

  it('getPipelineRunStats without filter returns all', () => {
    const { getPipelineRunStats } = require('../../src/db/pipeline-runs');
    const stats = getPipelineRunStats(db, {});
    assert.equal(stats.total_runs, 3);
    assert.equal(stats.error_count, 0);
  });
});
