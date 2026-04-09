'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-server-test-${Date.now()}`);

describe('op-server', () => {
  let app;

  before(async () => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'agents'), { recursive: true });

    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed prompts test data
    const dbMod = require('../src/op-db');
    const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

    dbMod.upsertSession(testDb, {
      session_id: 'sess-prompt-api',
      started_at: '2026-04-08T10:00:00Z',
      working_directory: '/Users/test/my-project',
      model: 'claude-sonnet-4-6',
    });

    const p1Id = dbMod.insertPrompt(testDb, {
      session_id: 'sess-prompt-api',
      prompt_text: 'add authentication',
      seq_start: 1,
      timestamp: '2026-04-08T10:00:01Z',
    });
    const p2Id = dbMod.insertPrompt(testDb, {
      session_id: 'sess-prompt-api',
      prompt_text: 'run all tests',
      seq_start: 3,
      timestamp: '2026-04-08T10:01:00Z',
    });

    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-08T10:00:02Z', session_id: 'sess-prompt-api',
      event_type: 'tool_call', name: 'Read', prompt_id: p1Id, seq_num: 1,
      estimated_cost_usd: 0.01,
    });
    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-08T10:00:03Z', session_id: 'sess-prompt-api',
      event_type: 'agent_spawn', name: 'Explore', prompt_id: p1Id, seq_num: 2,
      estimated_cost_usd: 0.05,
    });
    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-08T10:01:01Z', session_id: 'sess-prompt-api',
      event_type: 'tool_call', name: 'Bash', prompt_id: p2Id, seq_num: 3,
      estimated_cost_usd: 0.02,
    });

    dbMod.updatePromptStats(testDb, p1Id, { seq_end: 2, cost: 0.01, timestamp: '2026-04-08T10:00:02Z' });
    dbMod.updatePromptStats(testDb, p1Id, { seq_end: 2, cost: 0.05, timestamp: '2026-04-08T10:00:03Z' });
    dbMod.updatePromptStats(testDb, p2Id, { seq_end: 3, cost: 0.02, timestamp: '2026-04-08T10:01:01Z' });
    testDb.close();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
  });

  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
  });

  it('GET /api/overview returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('total_sessions' in body);
    assert.ok('total_cost' in body);
  });

  it('GET /api/sessions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/scanner/latest returns null or object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scanner/latest' });
    assert.equal(res.statusCode, 200);
  });

  it('GET /api/config returns config object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('port' in body);
  });

  it('GET /api/events returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/rankings/skills returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rankings/skills' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/inventory/agents includes agent_class', async () => {
    const dbMod = require('../src/op-db');
    const db = dbMod.createDb(process.env.OPEN_PULSE_DB);

    // Create a configured agent file
    fs.writeFileSync(
      path.join(TEST_DIR, '.claude', 'agents', 'my-configured.md'),
      '---\nname: my-configured\ndescription: test\n---\nContent',
    );

    // Insert events for both configured and built-in agents
    dbMod.insertEventBatch(db, [
      {
        timestamp: '2026-04-07T01:00:00Z', session_id: 'ac-test',
        event_type: 'agent_spawn', name: 'my-configured',
        detail: 'configured agent', duration_ms: 100, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: null,
      },
      {
        timestamp: '2026-04-07T01:00:01Z', session_id: 'ac-test',
        event_type: 'agent_spawn', name: 'general-purpose',
        detail: 'built-in agent', duration_ms: 100, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: null,
      },
    ]);
    db.close();

    // Sync disk state into components table so new file is reflected
    const { syncComponents } = require('../src/op-server');
    syncComponents();

    const res = await app.inject({ method: 'GET', url: '/api/inventory/agents?period=all' });
    assert.equal(res.statusCode, 200);
    const items = JSON.parse(res.body);

    const configured = items.find(i => i.name === 'my-configured');
    assert.ok(configured, 'should find configured agent');
    assert.equal(configured.agent_class, 'configured');

    const builtin = items.find(i => i.name === 'general-purpose');
    assert.ok(builtin, 'should find built-in agent');
    assert.equal(builtin.agent_class, 'built-in');
  });

  it('GET /api/sessions/:id includes agent_class on agent_spawn events', async () => {
    const dbMod = require('../src/op-db');
    const db = dbMod.createDb(process.env.OPEN_PULSE_DB);

    dbMod.upsertSession(db, {
      session_id: 'ac-session', started_at: '2026-04-07T02:00:00Z',
      model: 'opus', working_directory: '/tmp',
    });
    dbMod.insertEventBatch(db, [
      {
        timestamp: '2026-04-07T02:00:01Z', session_id: 'ac-session',
        event_type: 'agent_spawn', name: 'my-configured',
        detail: 'test', duration_ms: 50, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: null,
      },
      {
        timestamp: '2026-04-07T02:00:02Z', session_id: 'ac-session',
        event_type: 'tool_call', name: 'Read',
        detail: 'read file', duration_ms: 10, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: null,
      },
    ]);
    db.close();

    const res = await app.inject({ method: 'GET', url: '/api/sessions/ac-session' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const agentEv = body.events.find(e => e.name === 'my-configured');
    assert.ok(agentEv, 'should find agent event');
    assert.equal(agentEv.agent_class, 'configured');
    assert.equal(agentEv.type, 'agent_spawn');

    const toolEv = body.events.find(e => e.name === 'Read');
    assert.ok(toolEv, 'should find tool event');
    assert.equal(toolEv.agent_class, undefined, 'non-agent events should not have agent_class');
  });

  it('parseQualifiedName parses plugin prefix', () => {
    const { parseQualifiedName } = require('../src/op-server');
    assert.deepEqual(parseQualifiedName('superpowers:code-reviewer'), { plugin: 'superpowers', shortName: 'code-reviewer' });
    assert.deepEqual(parseQualifiedName('code-reviewer'), { plugin: null, shortName: 'code-reviewer' });
    assert.deepEqual(parseQualifiedName('pr-review-toolkit:silent-failure-hunter'), { plugin: 'pr-review-toolkit', shortName: 'silent-failure-hunter' });
  });

  it('GET /api/inventory/agents includes plugin components', async () => {
    // Create a fake plugin structure
    const pluginDir = path.join(TEST_DIR, '.claude', 'plugins');
    const cachePath = path.join(pluginDir, 'cache', 'test-source', 'test-plugin', '1.0.0');
    fs.mkdirSync(path.join(cachePath, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(cachePath, 'agents', 'test-agent.md'),
      '---\nname: test-agent\ndescription: from plugin\n---\nContent',
    );
    fs.mkdirSync(path.join(pluginDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'test-plugin@test-source': [{
          scope: 'user',
          installPath: cachePath,
          version: '1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          lastUpdated: '2026-01-01T00:00:00Z',
        }],
      },
    }));

    // Sync disk state into components table so plugin agent is reflected
    const { syncComponents } = require('../src/op-server');
    syncComponents();

    const res = await app.inject({ method: 'GET', url: '/api/inventory/agents?period=all' });
    assert.equal(res.statusCode, 200);
    const items = JSON.parse(res.body);

    const pluginAgent = items.find(i => i.name === 'test-plugin:test-agent');
    assert.ok(pluginAgent, 'should find plugin agent');
    assert.equal(pluginAgent.plugin, 'test-plugin');
    assert.equal(pluginAgent.status, 'unused');

    // Non-plugin agents should have plugin: null
    const regular = items.find(i => i.name === 'my-configured');
    if (regular) assert.equal(regular.plugin, null);
  });

  it('syncComponents populates components table from disk', async () => {
    const skillDir = path.join(TEST_DIR, '.claude', 'skills', 'my-sync-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: A synced skill\n---\nContent');

    fs.writeFileSync(
      path.join(TEST_DIR, '.claude', 'agents', 'my-sync-agent.md'),
      '---\ndescription: A synced agent\n---\nContent'
    );

    const { syncComponents } = require('../src/op-server');
    syncComponents();

    const skillRes = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
    const skills = JSON.parse(skillRes.body);
    assert.ok(skills.some(s => s.name === 'my-sync-skill'), 'synced skill should appear');

    const agentRes = await app.inject({ method: 'GET', url: '/api/inventory/agents' });
    const agents = JSON.parse(agentRes.body);
    assert.ok(agents.some(a => a.name === 'my-sync-agent'), 'synced agent should appear');
  });

  it('syncComponents removes deleted components', async () => {
    fs.rmSync(path.join(TEST_DIR, '.claude', 'skills', 'my-sync-skill'), { recursive: true });

    const { syncComponents } = require('../src/op-server');
    syncComponents();

    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
    const skills = JSON.parse(res.body);
    assert.ok(!skills.some(s => s.name === 'my-sync-skill'), 'deleted skill should be removed');
  });

  it('inventory endpoint returns ETag header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['etag'], 'should have ETag header');
  });

  it('inventory endpoint returns 304 when ETag matches', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
    const etag = res1.headers['etag'];

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/inventory/skills',
      headers: { 'if-none-match': etag },
    });
    assert.equal(res2.statusCode, 304);
  });

  it('inventory endpoint returns 200 with new ETag after sync changes', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
    const etag1 = res1.headers['etag'];

    const newSkillDir = path.join(TEST_DIR, '.claude', 'skills', 'another-skill');
    fs.mkdirSync(newSkillDir, { recursive: true });
    fs.writeFileSync(path.join(newSkillDir, 'SKILL.md'), '---\ndescription: Another\n---\n');

    const { syncComponents } = require('../src/op-server');
    syncComponents();

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/inventory/skills',
      headers: { 'if-none-match': etag1 },
    });
    assert.equal(res2.statusCode, 200);
    assert.notEqual(res2.headers['etag'], etag1);
  });

  it('GET /api/inventory/agents/:name includes triggered_by and triggers', async () => {
    const dbMod = require('../src/op-db');
    const db = dbMod.createDb(process.env.OPEN_PULSE_DB);

    // Insert a skill_invoke followed by an agent_spawn in the same session
    dbMod.insertEventBatch(db, [
      {
        timestamp: '2026-04-06T10:00:01Z', session_id: 'trigger-test-1',
        event_type: 'skill_invoke', name: 'commit',
        detail: 'test args', duration_ms: 50, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: 'please commit',
      },
      {
        timestamp: '2026-04-06T10:00:02Z', session_id: 'trigger-test-1',
        event_type: 'agent_spawn', name: 'code-reviewer',
        detail: 'review changes', duration_ms: 200, success: 1,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        working_directory: '/tmp', model: 'opus', user_prompt: 'please commit',
      },
    ]);
    db.close();

    // Check agent detail has triggered_by pointing to the skill
    const agentRes = await app.inject({
      method: 'GET',
      url: '/api/inventory/agents/code-reviewer?period=all',
    });
    assert.equal(agentRes.statusCode, 200);
    const agentBody = JSON.parse(agentRes.body);
    assert.ok(agentBody.total >= 1, 'should have total count');
    assert.equal(agentBody.page, 1);
    assert.ok(agentBody.per_page > 0);
    assert.ok(agentBody.invocations.length >= 1, 'should have invocations');
    const inv = agentBody.invocations.find(i => i.session_id === 'trigger-test-1');
    assert.ok(inv, 'should find the test invocation');
    assert.ok(inv.triggered_by, 'should have triggered_by');
    assert.equal(inv.triggered_by.name, 'commit');
    assert.equal(inv.triggered_by.type, 'skill_invoke');

    // Check skill detail has triggers pointing to the agent
    const skillRes = await app.inject({
      method: 'GET',
      url: '/api/inventory/skills/commit?period=all',
    });
    assert.equal(skillRes.statusCode, 200);
    const skillBody = JSON.parse(skillRes.body);
    assert.ok(skillBody.triggers.length >= 1, 'should have triggers');
    const trig = skillBody.triggers.find(t => t.name === 'code-reviewer');
    assert.ok(trig, 'should find code-reviewer in triggers');
    assert.equal(trig.event_type, 'agent_spawn');
    assert.ok(trig.count >= 1);
  });

  it('GET /api/inventory/:type/:name returns trigger data from batch queries', async () => {
    const dbMod = require('../src/op-db');
    const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
    const sess = 'sess-trigger-batch-' + Date.now();
    dbMod.upsertSession(testDb, { session_id: sess, started_at: '2026-04-08T12:00:00Z', model: 'sonnet', working_directory: '/tmp' });
    dbMod.insertEventBatch(testDb, [
      { timestamp: '2026-04-08T12:00:01Z', session_id: sess, event_type: 'agent_spawn', name: 'Plan', seq_num: 1 },
      { timestamp: '2026-04-08T12:00:02Z', session_id: sess, event_type: 'skill_invoke', name: 'tdd-workflow', seq_num: 2 },
      { timestamp: '2026-04-08T12:00:03Z', session_id: sess, event_type: 'skill_invoke', name: 'tdd-workflow', seq_num: 3 },
      { timestamp: '2026-04-08T12:00:04Z', session_id: sess, event_type: 'agent_spawn', name: 'Explore', seq_num: 4 },
    ]);
    testDb.close();

    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills/tdd-workflow?period=all' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.total, 2);
    assert.ok(Array.isArray(body.triggers));
    assert.ok(Array.isArray(body.invocations));
    // Both invocations should have triggered_by = Plan (nearest preceding agent_spawn)
    for (const inv of body.invocations) {
      assert.ok(
        inv.triggered_by === null || inv.triggered_by.name === 'Plan',
        `triggered_by should be null or Plan, got: ${JSON.stringify(inv.triggered_by)}`
      );
    }
    // Explore should appear in triggers (nearest following agent_spawn)
    const exploreTrigger = body.triggers.find(t => t.name === 'Explore');
    assert.ok(exploreTrigger, 'Explore should appear in triggers');
    assert.equal(exploreTrigger.event_type, 'agent_spawn');
    // The second invocation (12:00:02) is followed by another tdd-workflow invoke at 12:00:03,
    // but that is the same name so it's excluded. Explore (12:00:04) follows both.
    // The first invocation (12:00:02) nearest following different name is tdd-workflow at 12:00:03 — excluded.
    // Actually nearest different-name following 12:00:02 is Explore at 12:00:04.
    // And nearest different-name following 12:00:03 is Explore at 12:00:04.
    assert.ok(exploreTrigger.count >= 1, 'Explore trigger count should be >= 1');
  });

  describe('knowledge graph API', () => {
    it('GET /api/knowledge/status returns stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/status' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('nodeCount' in body);
      assert.ok('edgeCount' in body);
    });

    it('GET /api/knowledge/projects returns project list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/projects' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/knowledge/graph returns nodes and edges', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/graph' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('nodes' in body);
      assert.ok('edges' in body);
    });

    it('POST /api/knowledge/sync triggers graph sync', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/knowledge/sync' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('nodes' in body);
    });

    it('POST /api/knowledge/generate triggers vault generation', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/knowledge/generate' });
      assert.equal(res.statusCode, 200);
    });

    it('GET /api/knowledge/config returns config values', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('knowledge_graph_interval_ms' in body);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('returns 404 for non-existent project', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/projects/nonexistent' });
      assert.equal(res.statusCode, 404);
    });

    it('deletes a project and returns success', async () => {
      // Seed project via internal DB
      const dbPath = process.env.OPEN_PULSE_DB;
      const { createDb, upsertClProject, insertKbNote, upsertKgVaultHash } = require('../src/op-db');
      const db = createDb(dbPath);
      const pid = 'test-del-proj';

      upsertClProject(db, {
        project_id: pid, name: 'deleteme', directory: '/tmp/deleteme',
        first_seen_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z', session_count: 0,
      });
      insertKbNote(db, {
        id: 'del-note-1', project_id: pid, slug: 'note-del',
        title: 'Note', body: 'content',
        tags: '[]', created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
      upsertKgVaultHash(db, {
        project_id: pid, file_path: 'test.md', content_hash: 'hash1',
      });

      // Create filesystem dirs and projects.json
      const clDir = path.join(TEST_DIR, 'cl', 'projects', pid);
      const projDir = path.join(TEST_DIR, 'projects', pid);
      fs.mkdirSync(clDir, { recursive: true });
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(clDir, 'test.md'), 'test');
      fs.writeFileSync(
        path.join(TEST_DIR, 'projects.json'),
        JSON.stringify({ [pid]: { id: pid, name: 'deleteme', root: '/tmp/deleteme' } })
      );

      db.close();

      // Delete the project
      const res = await app.inject({ method: 'DELETE', url: '/api/projects/' + pid });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.deleted, true);

      // Verify project summary returns 404
      const summaryRes = await app.inject({ method: 'GET', url: '/api/projects/' + pid + '/summary' });
      assert.equal(summaryRes.statusCode, 404);

      // Verify filesystem dirs removed
      assert.equal(fs.existsSync(clDir), false);
      assert.equal(fs.existsSync(projDir), false);

      // Verify projects.json entry removed
      const registry = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'projects.json'), 'utf8'));
      assert.equal(registry[pid], undefined);
    });
  });

  describe('prompts API', () => {
    it('GET /api/prompts returns paginated list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/prompts?period=all' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.prompts.length > 0);
      assert.ok(body.total > 0);
      assert.equal(body.page, 1);
      assert.equal(body.per_page, 20);
      const p = body.prompts.find(p => p.prompt_text === 'add authentication');
      assert.ok(p);
      assert.equal(p.session_id, 'sess-prompt-api');
      assert.ok(p.event_breakdown);
    });

    it('GET /api/prompts?q= filters by text', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/prompts?period=all&q=authentication' });
      const body = JSON.parse(res.body);
      assert.ok(body.prompts.every(p => p.prompt_text.includes('authentication')));
    });

    it('GET /api/prompts?session_id= filters by session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts?period=all&session_id=sess-prompt-api',
      });
      const body = JSON.parse(res.body);
      assert.ok(body.prompts.length >= 2);
      assert.ok(body.prompts.every(p => p.session_id === 'sess-prompt-api'));
    });

    it('GET /api/prompts paginates correctly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/prompts?period=all&per_page=1&page=1',
      });
      const body = JSON.parse(res.body);
      assert.equal(body.prompts.length, 1);
      assert.equal(body.per_page, 1);
    });

    it('GET /api/prompts/:id returns prompt with events', async () => {
      const listRes = await app.inject({ method: 'GET', url: '/api/prompts?period=all&q=authentication' });
      const listBody = JSON.parse(listRes.body);
      const promptId = listBody.prompts[0].id;

      const res = await app.inject({ method: 'GET', url: '/api/prompts/' + promptId });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.prompt.id, promptId);
      assert.equal(body.prompt.prompt_text, 'add authentication');
      assert.ok(body.prompt.project);
      assert.ok(Array.isArray(body.events));
      assert.ok(body.events.length >= 2);
      assert.equal(body.events[0].name, 'Read');
      assert.equal(body.events[1].name, 'Explore');
    });

    it('GET /api/prompts/:id returns 404 for nonexistent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/prompts/99999' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('pagination: /api/unused', () => {
    it('GET /api/unused returns paginated flat list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/unused' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('data' in body, 'should have data');
      assert.ok('total' in body, 'should have total');
      assert.ok('page' in body, 'should have page');
      assert.ok('per_page' in body, 'should have per_page');
      assert.ok(Array.isArray(body.data), 'data should be array');
      // Each item in data should have type and name
      for (const item of body.data) {
        assert.ok(['skill', 'agent'].includes(item.type), 'item.type should be skill/agent');
        assert.ok(typeof item.name === 'string', 'item.name should be string');
      }
    });

    it('GET /api/unused respects per_page', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/unused?per_page=1' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.per_page, 1);
      assert.ok(body.data.length <= 1);
    });
  });

  describe('route integration', () => {
    it('GET /api/health returns ok status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.status, 'ok');
      assert.ok('db_size_bytes' in body);
      assert.ok('total_events' in body);
    });

    it('GET /api/overview returns stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/overview?period=7d' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('total_sessions' in body);
      assert.ok('total_cost' in body);
    });

    it('GET /api/events returns array', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/sessions returns array', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/cost returns rows', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/cost?group_by=day' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('rows' in body);
      assert.ok(Array.isArray(body.rows));
    });

    it('GET /api/errors returns array', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/errors' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/config returns config object', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('port' in body);
    });

    it('GET /api/knowledge/status returns status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/status' });
      assert.equal(res.statusCode, 200);
    });

    it('GET /api/unused returns paginated response', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/unused' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok('data' in body);
      assert.ok('total' in body);
    });
  });

  describe('error handling', () => {
    it('GET /api/inventory/invalid returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/inventory/invalid' });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.ok(body.error);
    });

    it('GET /api/inventory/invalid/foo returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/inventory/invalid/foo' });
      assert.equal(res.statusCode, 400);
    });

    it('GET /api/sessions/nonexistent returns empty or 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent-session-id' });
      // May return 200 with empty data or 404
      assert.ok(res.statusCode === 200 || res.statusCode === 404);
    });

    it('GET /api/knowledge/discover without params returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/discover' });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('pagination clamping', () => {
    it('clamps negative page to 1', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights?page=-5&per_page=10' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.page, 1);
    });

    it('clamps per_page to max 50', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights?page=1&per_page=999' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.per_page, 50);
    });

    it('uses default per_page when not provided', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.per_page > 0);
    });
  });

  describe('insights API', () => {
    it('GET /api/insights returns paginated list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.rows));
      assert.ok(typeof body.total === 'number');
      assert.ok(typeof body.page === 'number');
      assert.ok(typeof body.per_page === 'number');
    });

    it('PUT /api/insights/:id/validate increases confidence', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-val-test',
        source: 'observer',
        category: 'workflow',
        title: 'Test Validate',
        description: 'test insight',
        confidence: 0.5,
      });
      db.close();

      const res = await app.inject({ method: 'PUT', url: '/api/insights/srv-val-test/validate' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.confidence, 0.65);
      assert.equal(body.validation_count, 1);
    });

    it('PUT /api/insights/:id/reject decreases confidence', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-rej-test',
        source: 'observer',
        category: 'workflow',
        title: 'Test Reject',
        description: 'test insight',
        confidence: 0.5,
      });
      db.close();

      const res = await app.inject({ method: 'PUT', url: '/api/insights/srv-rej-test/reject' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.confidence, 0.3);
      assert.equal(body.rejection_count, 1);
    });

    it('GET /api/insights/:id returns single insight', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-get-test',
        source: 'daily_analysis',
        category: 'cleanup',
        title: 'Clean Up Dead Code',
        description: 'Remove dead code',
        confidence: 0.7,
      });
      db.close();

      const res = await app.inject({ method: 'GET', url: '/api/insights/srv-get-test' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, 'srv-get-test');
      assert.equal(body.title, 'Clean Up Dead Code');
      assert.equal(body.source, 'daily_analysis');
    });

    it('GET /api/insights/:id returns 404 for non-existent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights/nonexistent-id' });
      assert.equal(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.ok(body.error);
    });

    it('GET /api/insights?source=observer filters by source', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-src-obs-1',
        source: 'observer',
        category: 'workflow',
        title: 'Observer Insight',
        description: 'from observer',
        confidence: 0.5,
      });
      dbMod.upsertInsight(db, {
        id: 'srv-src-daily-1',
        source: 'daily_analysis',
        category: 'cleanup',
        title: 'Daily Insight',
        description: 'from daily',
        confidence: 0.6,
      });
      db.close();

      const res = await app.inject({ method: 'GET', url: '/api/insights?source=observer' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.rows.every(r => r.source === 'observer'));
    });

    it('GET /api/insights?status=active filters by status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights?status=active' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.rows.every(r => r.status === 'active' || body.rows.length === 0));
    });

    it('GET /api/insights/stats returns counts by source and status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights/stats' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.bySource));
      assert.ok(Array.isArray(body.byStatus));
      assert.ok(Array.isArray(body.byTargetType));
    });

    it('DELETE /api/insights/:id removes insight', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-del-test',
        source: 'observer',
        category: 'workflow',
        title: 'To Delete',
        description: 'will be deleted',
        confidence: 0.5,
      });
      db.close();

      const res = await app.inject({ method: 'DELETE', url: '/api/insights/srv-del-test' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);

      // Verify it's gone
      const getRes = await app.inject({ method: 'GET', url: '/api/insights/srv-del-test' });
      assert.equal(getRes.statusCode, 404);
    });

    it('GET /api/insights respects pagination', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      for (let i = 0; i < 5; i++) {
        dbMod.upsertInsight(db, {
          id: `srv-page-test-${i}`,
          source: 'observer',
          category: 'workflow',
          title: `Insight ${i}`,
          description: `test ${i}`,
          confidence: 0.5,
        });
      }
      db.close();

      const res = await app.inject({ method: 'GET', url: '/api/insights?per_page=2&page=1' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.per_page, 2);
      assert.equal(body.page, 1);
      assert.ok(body.rows.length <= 2);
      assert.ok(body.total >= 5);
    });

    it('PUT /api/insights/:id/validate returns 404 for non-existent', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/insights/nonexistent-id/validate' });
      assert.equal(res.statusCode, 404);
    });

    it('PUT /api/insights/:id/reject returns 404 for non-existent', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/insights/nonexistent-id/reject' });
      assert.equal(res.statusCode, 404);
    });

    it('PUT /api/insights/:id/reject auto-archives after 3 rejections', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-archive-test',
        source: 'observer',
        category: 'workflow',
        title: 'Archive Test',
        description: 'test archival',
        confidence: 0.7,
      });
      db.close();

      // Reject 3 times
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'PUT', url: '/api/insights/srv-archive-test/reject' });
      }

      const res = await app.inject({ method: 'GET', url: '/api/insights/srv-archive-test' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'archived');
    });

    it('GET /api/insights/:id parses action_data JSON', async () => {
      const dbMod = require('../src/op-db');
      const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
      dbMod.upsertInsight(db, {
        id: 'srv-action-test',
        source: 'observer',
        category: 'workflow',
        title: 'Action Data Test',
        description: 'test action data',
        confidence: 0.5,
        action_data: JSON.stringify({ foo: 'bar', count: 42 }),
      });
      db.close();

      const res = await app.inject({ method: 'GET', url: '/api/insights/srv-action-test' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.action_data, { foo: 'bar', count: 42 });
    });
  });
});
