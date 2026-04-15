'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DIR = path.join(os.tmpdir(), `op-synth-integ-${Date.now()}`);

describe('synthesize integration', () => {
  let app;
  // Knowledge entry IDs captured from insertKnowledgeEntry return values
  let keId1; // 'Always use strict mode'
  let keId2; // 'Strict mode required' (duplicate of keId1)
  let keId3; // 'API uses JSON'

  before(async () => {
    const projectDir = path.join(TEST_DIR, 'integ-project');
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'rules'), { recursive: true });
    // Vault render writes to <project.directory>/.claude/knowledge/
    fs.mkdirSync(path.join(projectDir, '.claude', 'knowledge'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

    // Clear require cache
    delete require.cache[require.resolve('../../src/server')];
    delete require.cache[require.resolve('../../src/db/schema')];
    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed data
    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');

    const db = createDb(process.env.OPEN_PULSE_DB);
    upsertClProject(db, {
      project_id: 'integ-proj', name: 'Integration Project', directory: projectDir,
      first_seen_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-04-15T00:00:00Z', session_count: 10,
    });

    // Knowledge entries: 2 duplicates + 1 unique — capture IDs
    const ke1 = insertKnowledgeEntry(db, { project_id: 'integ-proj', category: 'convention', title: 'Always use strict mode', body: 'Use strict mode in all files.', tags: ['backend'] });
    const ke2 = insertKnowledgeEntry(db, { project_id: 'integ-proj', category: 'convention', title: 'Strict mode required', body: 'All JS files must use strict.', tags: ['backend'] });
    const ke3 = insertKnowledgeEntry(db, { project_id: 'integ-proj', category: 'api', title: 'API uses JSON', body: 'All endpoints return JSON.', tags: ['api'] });
    keId1 = ke1.id;
    keId2 = ke2.id;
    keId3 = ke3.id;

    // Auto-evolve drafts
    db.prepare('INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, status, projects, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('ae-integ-1', 'Run tests before commit', 'User always runs npm test before git commit', 'rule', 0.3, 3, 'draft', '["Integration Project"]', '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z');
    db.prepare('INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, status, projects, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('ae-integ-2', 'Test before committing', 'Same as above, duplicate', 'rule', 0.3, 1, 'draft', '["Integration Project"]', '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z');
    db.prepare('INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, status, projects, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('ae-integ-3', 'Use TDD workflow', 'Write test first then implement', 'skill', 0.5, 2, 'draft', '["Integration Project"]', '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z');

    db.close();
  });

  after(async () => {
    await app.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
  });

  it('full synthesize flow: fetch → update → merge → promote', async () => {
    // a. GET /api/synthesize/data?project=Integration Project — verify structure
    const dataRes = await app.inject({
      method: 'GET',
      url: '/api/synthesize/data',
      query: { project: 'Integration Project' },
    });
    assert.equal(dataRes.statusCode, 200);
    const data = JSON.parse(dataRes.body);
    assert.ok(data.projects, 'response has projects array');
    assert.equal(data.projects.length, 1);
    assert.equal(data.projects[0].project.name, 'Integration Project');
    assert.ok(data.projects[0].knowledge_entries, 'has knowledge_entries');
    assert.ok(data.projects[0].auto_evolves, 'has auto_evolves');
    assert.ok(data.totals, 'response has totals');
    assert.equal(data.totals.knowledge_entries, 3);
    assert.equal(data.totals.auto_evolves, 3);

    // b. PUT /api/knowledge/entries/:id with improved body — verify 200
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/knowledge/entries/${keId1}`,
      payload: { body: 'Always use strict mode in all JavaScript and Node.js files for safety.' },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = JSON.parse(updateRes.body);
    assert.ok(updated.body.includes('JavaScript and Node.js'));

    // c. PUT /api/knowledge/entries/:dupId/outdated — mark duplicate as outdated
    const outdatedRes = await app.inject({
      method: 'PUT',
      url: `/api/knowledge/entries/${keId2}/outdated`,
    });
    assert.equal(outdatedRes.statusCode, 200);
    const outdated = JSON.parse(outdatedRes.body);
    assert.equal(outdated.status, 'outdated');

    // d. POST /api/knowledge/vault/render — trigger vault re-render
    const vaultRes = await app.inject({
      method: 'POST',
      url: '/api/knowledge/vault/render',
      payload: { project_id: 'integ-proj' },
    });
    assert.equal(vaultRes.statusCode, 200);
    const vault = JSON.parse(vaultRes.body);
    assert.equal(vault.rendered, true);
    assert.equal(vault.project_id, 'integ-proj');

    // e. PUT /api/auto-evolves/ae-integ-1 — update pattern with improved description
    const aeUpdateRes = await app.inject({
      method: 'PUT',
      url: '/api/auto-evolves/ae-integ-1',
      payload: { description: 'Always run npm test before git commit to catch regressions', confidence: 0.9, observation_count: 4, status: 'active' },
    });
    assert.equal(aeUpdateRes.statusCode, 200);
    const aeUpdated = JSON.parse(aeUpdateRes.body);
    assert.equal(aeUpdated.confidence, 0.9);
    assert.equal(aeUpdated.status, 'active');
    assert.equal(aeUpdated.observation_count, 4);

    // f. DELETE /api/auto-evolves/ae-integ-2 — remove duplicate
    const aeDeleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/auto-evolves/ae-integ-2',
    });
    assert.equal(aeDeleteRes.statusCode, 200);
    const aeDeleted = JSON.parse(aeDeleteRes.body);
    assert.equal(aeDeleted.deleted, true);

    // g. POST /api/auto-evolves/ae-integ-1/promote — promote the updated pattern
    const promoteRes = await app.inject({
      method: 'POST',
      url: '/api/auto-evolves/ae-integ-1/promote',
    });
    assert.equal(promoteRes.statusCode, 200);
    const promoted = JSON.parse(promoteRes.body);
    assert.equal(promoted.ok, true);
    assert.ok(promoted.promoted_to, 'has promoted_to path');
    // Verify the file was written
    assert.ok(fs.existsSync(promoted.promoted_to), 'promoted file exists on disk');
  });

  it('empty project returns zero totals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/synthesize/data',
      query: { project: 'nonexistent' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.totals.knowledge_entries, 0);
    assert.equal(data.totals.auto_evolves, 0);
  });

  it('all projects mode returns multiple projects', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/synthesize/data',
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.projects.length >= 1, 'at least one project');
    // Verify our seeded project is in the list
    const integ = data.projects.find(p => p.project.name === 'Integration Project');
    assert.ok(integ, 'Integration Project present in all-projects response');
  });
});
