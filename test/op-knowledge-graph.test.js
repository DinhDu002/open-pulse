'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-knowledge-graph-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-knowledge-graph', () => {
  let db, dbMod, kg;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbMod = require('../src/op-db');
    kg = require('../src/op-knowledge-graph');
    db = dbMod.createDb(TEST_DB);

    // Seed events (all named params required by better-sqlite3)
    const base = { detail: null, duration_ms: null, input_tokens: null, output_tokens: null, estimated_cost_usd: null, model: null, user_prompt: null, tool_input: null, tool_response: null };
    dbMod.insertEventBatch(db, [
      { ...base, timestamp: '2026-04-08T10:00:00Z', session_id: 's1', event_type: 'tool_call', name: 'Read', seq_num: 1, success: 1, working_directory: '/proj/a' },
      { ...base, timestamp: '2026-04-08T10:00:01Z', session_id: 's1', event_type: 'tool_call', name: 'Edit', seq_num: 2, success: 1, working_directory: '/proj/a' },
      { ...base, timestamp: '2026-04-08T10:00:02Z', session_id: 's1', event_type: 'tool_call', name: 'Read', seq_num: 3, success: 1, working_directory: '/proj/a' },
      { ...base, timestamp: '2026-04-08T10:00:03Z', session_id: 's1', event_type: 'agent_spawn', name: 'code-reviewer', seq_num: 4, success: 1, working_directory: '/proj/a' },
      { ...base, timestamp: '2026-04-08T11:00:00Z', session_id: 's2', event_type: 'tool_call', name: 'Read', seq_num: 1, success: 1, working_directory: '/proj/a' },
      { ...base, timestamp: '2026-04-08T11:00:01Z', session_id: 's2', event_type: 'tool_call', name: 'Grep', seq_num: 2, success: 1, working_directory: '/proj/a' },
    ]);

    // Seed sessions
    dbMod.upsertSession(db, { session_id: 's1', started_at: '2026-04-08T10:00:00Z', ended_at: '2026-04-08T10:30:00Z', working_directory: '/proj/a', model: 'opus', total_tool_calls: 3, total_skill_invokes: 0, total_agent_spawns: 1, total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.10 });
    dbMod.upsertSession(db, { session_id: 's2', started_at: '2026-04-08T11:00:00Z', ended_at: '2026-04-08T11:15:00Z', working_directory: '/proj/a', model: 'sonnet', total_tool_calls: 2, total_skill_invokes: 0, total_agent_spawns: 0, total_input_tokens: 500, total_output_tokens: 200, total_cost_usd: 0.03 });

    // Seed project
    dbMod.upsertClProject(db, { project_id: 'proj-a', name: 'Project A', directory: '/proj/a', first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z', session_count: 2 });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('extractNodes returns tool, component, session, project nodes', () => {
    const nodes = kg.extractNodes(db, { confidenceThreshold: 0.5, sessionDays: 30 });

    // Verify all expected types are present
    const byType = {};
    for (const n of nodes) {
      byType[n.type] = byType[n.type] || [];
      byType[n.type].push(n);
    }

    // tool nodes from tool_call events: Read, Edit, Grep
    assert.ok(byType.tool, 'should have tool nodes');
    const toolNames = byType.tool.map(n => n.name);
    assert.ok(toolNames.includes('Read'), 'Read should be a tool node');
    assert.ok(toolNames.includes('Edit'), 'Edit should be a tool node');
    assert.ok(toolNames.includes('Grep'), 'Grep should be a tool node');

    // component nodes from agent_spawn events: code-reviewer
    assert.ok(byType.component, 'should have component nodes');
    const compNames = byType.component.map(n => n.name);
    assert.ok(compNames.includes('code-reviewer'), 'code-reviewer should be a component node');

    // instinct nodes — cl_instincts is dropped, so no instinct nodes expected
    assert.ok(!byType.instinct || byType.instinct.length === 0, 'should have no instinct nodes');

    // session nodes
    assert.ok(byType.session, 'should have session nodes');
    const sessionIds = byType.session.map(n => n.id);
    assert.ok(sessionIds.includes('session:s1'), 'session s1 should be present');
    assert.ok(sessionIds.includes('session:s2'), 'session s2 should be present');

    // project nodes
    assert.ok(byType.project, 'should have project nodes');
    const projNode = byType.project.find(n => n.id === 'project:proj-a');
    assert.ok(projNode, 'project node with correct ID should exist');

    // Verify Read tool stats
    const readNode = byType.tool.find(n => n.name === 'Read');
    assert.ok(readNode, 'Read node should exist');
    assert.equal(readNode.properties.invocations, 3, 'Read should have 3 invocations');
    assert.equal(readNode.properties.sessions_used, 2, 'Read should be used in 2 sessions');
    assert.equal(readNode.properties.success_rate, 1, 'Read should have 100% success rate');
  });

  it('extractEdges returns trigger and co_occurs edges', () => {
    const edges = kg.extractEdges(db, { minTriggerCount: 1, sessionDays: 30 });

    // trigger: Read → Edit (Read is seq 1, Edit is seq 2 in s1)
    const triggerEdges = edges.filter(e => e.relationship === 'triggers');
    assert.ok(triggerEdges.length > 0, 'should have trigger edges');

    const readToEdit = triggerEdges.find(
      e => e.source_id === 'tool:Read' && e.target_id === 'tool:Edit'
    );
    assert.ok(readToEdit, 'Read → Edit trigger edge should exist');
    assert.ok(readToEdit.weight >= 1, 'trigger edge weight should be >= 1');

    // co_occurs: Read and Grep co-occur in s2
    const coOccurEdges = edges.filter(e => e.relationship === 'co_occurs');
    assert.ok(coOccurEdges.length > 0, 'should have co_occurs edges');

    const readGrepCoOccur = coOccurEdges.find(
      e => (e.source_id === 'tool:Read' && e.target_id === 'tool:Grep') ||
           (e.source_id === 'tool:Grep' && e.target_id === 'tool:Read')
    );
    assert.ok(readGrepCoOccur, 'Read and Grep should co-occur in s2');
  });

  it('extractEdges returns no learned_from edges (cl_instincts dropped)', () => {
    const edges = kg.extractEdges(db, { minTriggerCount: 1, sessionDays: 30 });
    const learnedFromEdges = edges.filter(e => e.relationship === 'learned_from');
    assert.equal(learnedFromEdges.length, 0, 'should have no learned_from edges');
  });

  it('syncGraph populates kg_nodes and kg_edges, and sets sync state', () => {
    const result = kg.syncGraph(db, {
      confidenceThreshold: 0.5,
      sessionDays: 30,
      minTriggerCount: 1,
    });

    assert.ok(result.nodes > 0, 'syncGraph should report nodes inserted');
    assert.ok(result.edges > 0, 'syncGraph should report edges inserted');

    // Verify data actually landed in DB
    const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get().c;
    assert.ok(nodeCount >= result.nodes, 'kg_nodes should have data');

    const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_edges').get().c;
    assert.ok(edgeCount >= result.edges, 'kg_edges should have data');

    // Verify sync state was set
    const lastSync = dbMod.getKgSyncState(db, 'last_sync_at');
    assert.ok(lastSync, 'last_sync_at should be set');
    assert.match(lastSync, /^\d{4}-\d{2}-\d{2}T/, 'last_sync_at should be an ISO timestamp');

    // Verify specific nodes exist in DB
    const readNode = dbMod.getKgNode(db, 'tool:Read');
    assert.ok(readNode, 'tool:Read node should be in kg_nodes');

    // Verify no instinct nodes (cl_instincts dropped)
    const instinctNode = dbMod.getKgNode(db, 'instinct:test-instinct-1');
    assert.ok(instinctNode == null, 'instinct node should not be in kg_nodes');
  });
});
