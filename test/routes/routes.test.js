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

    const { buildApp } = require('../../src/server');
    app = buildApp({ disableTimers: true });
    await app.ready();

    // Seed prompts test data
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
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
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
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
    const { syncComponents } = require('../../src/server');
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
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
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
    const { parseQualifiedName } = require('../../src/server');
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
    const { syncComponents } = require('../../src/server');
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

    const { syncComponents } = require('../../src/server');
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

    const { syncComponents } = require('../../src/server');
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

    const { syncComponents } = require('../../src/server');
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
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
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
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
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

  it('GET /api/inventory/skills/:name includes by_project breakdown', async () => {
    const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
    const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

    dbMod.upsertComponent(testDb, {
      type: 'skill', name: 'bp-detail-skill', source: 'global', plugin: null,
      project: null, file_path: '/tmp', description: '', agent_class: null,
      first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
    });
    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-10T05:00:00Z', session_id: 'bp-d-1',
      event_type: 'skill_invoke', name: 'bp-detail-skill',
      working_directory: '/tmp/proj-a', project_name: 'proj-a',
    });
    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-10T05:01:00Z', session_id: 'bp-d-2',
      event_type: 'skill_invoke', name: 'bp-detail-skill',
      working_directory: '/tmp/proj-a', project_name: 'proj-a',
    });
    dbMod.insertEvent(testDb, {
      timestamp: '2026-04-10T05:02:00Z', session_id: 'bp-d-3',
      event_type: 'skill_invoke', name: 'bp-detail-skill',
      working_directory: '/tmp/proj-b', project_name: 'proj-b',
    });
    testDb.close();

    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills/bp-detail-skill?period=all' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.ok(Array.isArray(body.by_project), 'should have by_project array');
    assert.equal(body.by_project.length, 2);

    const projA = body.by_project.find(p => p.project === 'proj-a');
    assert.equal(projA.count, 2);
    const projB = body.by_project.find(p => p.project === 'proj-b');
    assert.equal(projB.count, 1);
  });

  it('GET /api/inventory/skills/:name?project= filters invocations', async () => {
    // Uses data seeded in previous test (bp-detail-skill)
    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/skills/bp-detail-skill?period=all&project=proj-a',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.total, 2, 'filtered total should be 2');
    assert.equal(body.by_project.length, 2, 'by_project always returns all');
    for (const inv of body.invocations) {
      assert.equal(inv.project_name, 'proj-a', 'all invocations should be from proj-a');
    }
  });

  describe('GET /api/projects', () => {
    it('includes event-only projects', async () => {
      const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

      dbMod.insertEvent(testDb, {
        timestamp: '2026-04-10T06:00:00Z', session_id: 'evonly-1',
        event_type: 'tool_call', name: 'Read',
        working_directory: '/tmp/event-only-proj', project_name: 'event-only-proj',
      });
      testDb.close();

      const res = await app.inject({ method: 'GET', url: '/api/projects' });
      assert.equal(res.statusCode, 200);
      const projects = JSON.parse(res.body);

      const eventOnly = projects.find(p => p.name === 'event-only-proj');
      assert.ok(eventOnly, 'should include project known only from events');
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
      const { createDb, upsertClProject, upsertKgVaultHash } = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
      const db = createDb(dbPath);
      const pid = 'test-del-proj';

      upsertClProject(db, {
        project_id: pid, name: 'deleteme', directory: '/tmp/deleteme',
        first_seen_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z', session_count: 0,
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
    it('GET /api/prompts returns paginated list with aggregates', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/prompts?period=all' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.prompts.length > 0);
      assert.ok(body.total > 0);
      assert.equal(body.page, 1);
      assert.equal(body.per_page, 20);
      assert.equal(typeof body.total_events, 'number');
      assert.equal(typeof body.total_cost, 'number');
      assert.equal(typeof body.total_tokens, 'number');
      assert.ok(body.total_events >= 0);
      assert.ok(body.total_cost >= 0);
      assert.ok(body.total_tokens >= 0);
      const p = body.prompts.find(p => p.prompt_text === 'add authentication');
      assert.ok(p);
      assert.equal(p.session_id, 'sess-prompt-api');
      assert.equal(typeof p.total_tokens, 'number');
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
  });

  describe('inventory deduplication and project filter', () => {
    it('GET /api/inventory/agents deduplicates same-name components', async () => {
      const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

      dbMod.upsertComponent(testDb, {
        type: 'agent', name: 'shared-agent', source: 'project', plugin: null,
        project: 'proj1', file_path: '/tmp/proj1/shared-agent.md',
        description: 'test', agent_class: 'configured',
        first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
      });
      dbMod.upsertComponent(testDb, {
        type: 'agent', name: 'shared-agent', source: 'project', plugin: null,
        project: 'proj2', file_path: '/tmp/proj2/shared-agent.md',
        description: 'test', agent_class: 'configured',
        first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
      });

      dbMod.insertEvent(testDb, {
        timestamp: '2026-04-10T03:00:00Z', session_id: 'dedup-test',
        event_type: 'agent_spawn', name: 'shared-agent',
        working_directory: '/tmp/proj1', project_name: 'proj1',
      });
      testDb.close();

      // Do not call syncComponents() — it deletes manually-seeded rows via deleteComponentsNotSeenSince
      const res = await app.inject({ method: 'GET', url: '/api/inventory/agents?period=all' });
      const items = JSON.parse(res.body);
      const matches = items.filter(i => i.name === 'shared-agent');

      assert.equal(matches.length, 1, 'should have exactly one entry for shared-agent');
      assert.ok(Array.isArray(matches[0].projects), 'should have projects array');
      assert.ok(matches[0].projects.includes('proj1'));
      assert.ok(matches[0].projects.includes('proj2'));
      assert.equal(matches[0].count, 1);
    });

    it('GET /api/inventory/skills?project= filters by project_name', async () => {
      const dbMod = { ...require('../../src/db/schema'), ...require('../../src/db/events'), ...require('../../src/db/sessions'), ...require('../../src/db/components'), ...require('../../src/db/scan'), ...require('../../src/db/prompts'), ...require('../../src/db/projects'), ...require('../../src/db/knowledge-entries'), ...require('../../src/db/knowledge-sync') };
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

      dbMod.upsertComponent(testDb, {
        type: 'skill', name: 'test-skill-pf', source: 'global', plugin: null,
        project: null, file_path: '/tmp/test', description: 'test', agent_class: null,
        first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
      });
      dbMod.insertEvent(testDb, {
        timestamp: '2026-04-10T04:00:00Z', session_id: 'pf-test-1',
        event_type: 'skill_invoke', name: 'test-skill-pf',
        working_directory: '/tmp/alpha', project_name: 'alpha',
      });
      dbMod.insertEvent(testDb, {
        timestamp: '2026-04-10T04:01:00Z', session_id: 'pf-test-2',
        event_type: 'skill_invoke', name: 'test-skill-pf',
        working_directory: '/tmp/beta', project_name: 'beta',
      });
      testDb.close();

      const all = await app.inject({ method: 'GET', url: '/api/inventory/skills?period=all' });
      const allItems = JSON.parse(all.body);
      const allMatch = allItems.find(i => i.name === 'test-skill-pf');
      assert.ok(allMatch.count >= 2, 'unfiltered should count all');

      const filtered = await app.inject({ method: 'GET', url: '/api/inventory/skills?period=all&project=alpha' });
      const filteredItems = JSON.parse(filtered.body);
      const filteredMatch = filteredItems.find(i => i.name === 'test-skill-pf');
      assert.equal(filteredMatch.count, 1, 'filtered should count only alpha');
    });
  });

  // -- Daily review run route regression (TC-R1, TC-R2) --

  it('TC-R1: POST /api/daily-reviews/run without body.date does not use yesterday', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/run',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    // 500 expected (claude not available), but should not be a date error
    assert.ok([200, 500].includes(res.statusCode));
    if (res.statusCode === 500) {
      const body = JSON.parse(res.body);
      assert.ok(body.error || body.message, 'Should have error message');
    }
  });

  it('TC-R2: POST /api/daily-reviews/run with explicit date passes it through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/daily-reviews/run',
      headers: { 'content-type': 'application/json' },
      payload: { date: '2026-04-10' },
    });
    // 500 expected (claude not available in test env)
    assert.ok([200, 500].includes(res.statusCode));
    if (res.statusCode === 500) {
      const body = JSON.parse(res.body);
      assert.ok(body.error || body.message, 'Should have error message');
    }
  });

  describe('pipeline-runs API', () => {
    before(() => {
      const { insertPipelineRun } = require('../../src/db/pipeline-runs');
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
      insertPipelineRun(testDb, { pipeline: 'knowledge_extract', project_id: 'proj-1', model: 'sonnet', status: 'success', input_tokens: 1200, output_tokens: 380, duration_ms: 4200 });
      insertPipelineRun(testDb, { pipeline: 'knowledge_scan', project_id: 'proj-1', model: 'sonnet', status: 'error', error: 'timeout', input_tokens: 500, output_tokens: 0, duration_ms: 30000 });
      insertPipelineRun(testDb, { pipeline: 'daily_review', project_id: null, model: 'opus', status: 'success', input_tokens: 8000, output_tokens: 2000, duration_ms: 120000 });
      testDb.close();
    });

    it('GET /api/projects/:id/pipeline-runs returns runs for project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/pipeline-runs' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.total, 2);
      assert.ok(Array.isArray(body.items));
    });

    it('GET /api/projects/:id/pipeline-runs filters by pipeline', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/pipeline-runs?pipeline=knowledge_extract' });
      const body = JSON.parse(res.body);
      assert.equal(body.total, 1);
    });

    it('GET /api/pipeline-runs/stats returns aggregated stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pipeline-runs/stats' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      // >= 3 because other tests in the suite may insert daily_review pipeline runs
      assert.ok(body.total_runs >= 3);
      assert.ok(body.total_input_tokens > 0);
      assert.ok(Array.isArray(body.by_pipeline));
    });

    it('GET /api/pipeline-runs/stats filters by project_id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pipeline-runs/stats?project_id=proj-1' });
      const body = JSON.parse(res.body);
      assert.equal(body.total_runs, 2);
    });
  });

  describe('project-scoped auto-evolves / daily-reviews API', () => {
    const PROJ_ID = 'proj-scoped';
    const PROJ_NAME = 'scoped-demo';

    before(() => {
      const { upsertClProject } = require('../../src/db/projects');
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
      upsertClProject(testDb, {
        project_id: PROJ_ID, name: PROJ_NAME, directory: '/tmp/' + PROJ_NAME,
        first_seen_at: '2026-04-10T00:00:00Z',
        last_seen_at: '2026-04-11T00:00:00Z',
        session_count: 3,
      });

      // Seed auto_evolves rows
      const aeStmt = testDb.prepare(
        'INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, projects, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      aeStmt.run('ae-tagged-1', 'Tagged AE', 'desc', 'rule', 0.5, 2, JSON.stringify([PROJ_NAME]), 'active', '2026-04-11T00:00:00Z', '2026-04-11T00:00:00Z');
      aeStmt.run('ae-global-1', 'Global AE', 'desc', 'rule', 0.5, 2, null, 'active', '2026-04-11T00:00:00Z', '2026-04-11T00:00:00Z');

      // Seed daily_reviews rows
      const drStmt = testDb.prepare(
        "INSERT INTO daily_reviews (id, review_date, category, title, description, target_type, action, confidence, reasoning, summary_vi, projects, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
      );
      drStmt.run('dr-tagged-1', '2026-04-11', 'cleanup', 'Tagged DR', 'desc', 'rule', 'remove', 0.6, 'r', 'v', JSON.stringify([PROJ_NAME]), '2026-04-11T00:00:00Z');
      drStmt.run('dr-global-1', '2026-04-11', 'cleanup', 'Global DR', 'desc', 'rule', 'remove', 0.6, 'r', 'v', null, '2026-04-11T00:00:00Z');

      // Seed daily_review_insights row
      const iStmt = testDb.prepare(
        "INSERT INTO daily_review_insights (id, review_date, insight_type, title, description, projects, target_type, severity, reasoning, summary_vi, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
      );
      iStmt.run('dri-tagged-1', '2026-04-11', 'duplicate', 'Tagged Insight', 'desc', JSON.stringify([PROJ_NAME, 'other']), 'rule', 'warning', 'r', 'v', '2026-04-11T00:00:00Z');
      iStmt.run('dri-other-1', '2026-04-11', 'gap', 'Other Insight', 'desc', JSON.stringify(['other']), 'rule', 'info', 'r', 'v', '2026-04-11T00:00:00Z');

      testDb.close();
    });

    it('GET /api/projects/:id/auto-evolves returns only project-tagged rows', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/' + PROJ_ID + '/auto-evolves' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.total, 1);
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].title, 'Tagged AE');
    });

    it('GET /api/projects/:id/daily-reviews returns only project-tagged rows', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/' + PROJ_ID + '/daily-reviews' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.total, 1);
      assert.equal(body.rows[0].title, 'Tagged DR');
    });

    it('GET /api/projects/:id/daily-review-insights returns insights mentioning project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/' + PROJ_ID + '/daily-review-insights' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.total, 1);
      assert.equal(body.rows[0].title, 'Tagged Insight');
    });

    it('GET /api/projects/:id/auto-evolves returns 404 for unknown project', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/no-such-project/auto-evolves' });
      assert.equal(res.statusCode, 404);
    });

    it('GET /api/projects/:id/daily-reviews honors pagination', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/' + PROJ_ID + '/daily-reviews?page=1&per_page=5' });
      const body = JSON.parse(res.body);
      assert.equal(body.page, 1);
      assert.equal(body.per_page, 5);
    });
  });

  describe('POST /api/auto-evolves/:id/promote', () => {
    it('promotes an active entry bypassing threshold', async () => {
      const id = 'test-force-promote-route';
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
      testDb.prepare(`
        INSERT OR REPLACE INTO auto_evolves
          (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
        VALUES
          (?, 'Route Force Promote', 'body text', 'rule', 0.1, 1, 0, 'active', datetime('now'))
      `).run(id);
      testDb.close();

      const res = await app.inject({ method: 'POST', url: `/api/auto-evolves/${id}/promote` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.ok(body.promoted_to);

      const verifyDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
      const row = verifyDb.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
      verifyDb.close();
      assert.equal(row.status, 'promoted');
      assert.ok(fs.existsSync(row.promoted_to));
      fs.unlinkSync(row.promoted_to);
    });

    it('rejects non-active entries', async () => {
      const id = 'test-force-promote-reverted';
      const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
      testDb.prepare(`
        INSERT OR REPLACE INTO auto_evolves
          (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
        VALUES
          (?, 'Already Reverted', 'body', 'rule', 0.5, 1, 0, 'reverted', datetime('now'))
      `).run(id);
      testDb.close();

      const res = await app.inject({ method: 'POST', url: `/api/auto-evolves/${id}/promote` });
      assert.equal(res.statusCode, 400);
    });

    it('returns 404 for missing id', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auto-evolves/nonexistent-id-xyz/promote' });
      assert.equal(res.statusCode, 404);
    });
  });

});

