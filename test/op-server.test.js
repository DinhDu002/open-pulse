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
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'rules'), { recursive: true });

    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();
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

  it('GET /api/suggestions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/suggestions' });
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

  it('PUT /api/suggestions/:id/approve sets status', async () => {
    const dbMod = require('../src/op-db');
    const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
    dbMod.insertSuggestion(db, {
      id: 'sugg-approve-1', created_at: '2026-04-06T10:00:00Z',
      type: 'hook', confidence: 0.6, description: 'test suggestion',
      evidence: '[]', instinct_id: null, status: 'pending',
    });
    db.close();

    const res = await app.inject({ method: 'PUT', url: '/api/suggestions/sugg-approve-1/approve' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
  });

  it('PUT /api/suggestions/:id/dismiss sets status', async () => {
    const dbMod = require('../src/op-db');
    const db = dbMod.createDb(process.env.OPEN_PULSE_DB);
    dbMod.insertSuggestion(db, {
      id: 'sugg-dismiss-1', created_at: '2026-04-06T10:00:00Z',
      type: 'rule', confidence: 0.7, description: 'test suggestion',
      evidence: '[]', instinct_id: null, status: 'pending',
    });
    db.close();

    const res = await app.inject({ method: 'PUT', url: '/api/suggestions/sugg-dismiss-1/dismiss' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'dismissed');
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
});
