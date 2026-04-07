'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db;
let mod;

const TEST_DB = path.join(os.tmpdir(), `op-db-test-${Date.now()}.db`);

describe('op-db', () => {
  before(() => {
    mod = require('../src/op-db');
    db = mod.createDb(TEST_DB);
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  });

  it('creates all tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('events'));
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('collector_errors'));
    assert.ok(tables.includes('cl_projects'));
    assert.ok(tables.includes('cl_instincts'));
    assert.ok(tables.includes('suggestions'));
    assert.ok(tables.includes('scan_results'));
  });

  it('insertEvent + query', () => {
    mod.insertEvent(db, {
      timestamp: '2026-04-06T10:00:00Z',
      session_id: 'test-sess-1',
      event_type: 'tool_call',
      name: 'Read',
      detail: '{"file_path":"/tmp/x"}',
      duration_ms: 50,
      success: 1,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
      working_directory: '/tmp',
      model: 'opus',
      user_prompt: null,
    });
    const rows = db.prepare('SELECT * FROM events WHERE session_id = ?').all('test-sess-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Read');
  });

  it('upsertSession + updateSessionEnd', () => {
    mod.upsertSession(db, {
      session_id: 'test-sess-2',
      started_at: '2026-04-06T10:00:00Z',
      working_directory: '/tmp',
      model: 'opus',
    });
    mod.updateSessionEnd(db, {
      session_id: 'test-sess-2',
      ended_at: '2026-04-06T10:05:00Z',
      total_tool_calls: 10,
      total_skill_invokes: 2,
      total_agent_spawns: 1,
      total_input_tokens: 5000,
      total_output_tokens: 3000,
      total_cost_usd: 0.15,
    });
    const sess = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-sess-2');
    assert.equal(sess.total_tool_calls, 10);
    assert.equal(sess.total_cost_usd, 0.15);
  });

  it('insertSuggestion + querySuggestions', () => {
    mod.insertSuggestion(db, {
      id: 'sugg-1',
      created_at: '2026-04-06T10:00:00Z',
      type: 'hook',
      confidence: 0.8,
      description: 'Auto-format after edit',
      evidence: JSON.stringify(['session:abc']),
      status: 'pending',
    });
    const rows = mod.querySuggestions(db, 'pending');
    assert.ok(rows.some(r => r.id === 'sugg-1'));
  });

  it('updateSuggestionStatus', () => {
    mod.updateSuggestionStatus(db, 'sugg-1', 'approved', 'user');
    const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get('sugg-1');
    assert.equal(row.status, 'approved');
    assert.ok(row.resolved_at);
    assert.equal(row.resolved_by, 'user');
  });

  it('insertScanResult', () => {
    mod.insertScanResult(db, {
      scanned_at: '2026-04-06T10:00:00Z',
      report: JSON.stringify({ issues: [] }),
      total_skills: 5,
      total_agents: 3,
      total_hooks: 10,
      total_rules: 8,
      issues_critical: 0,
      issues_high: 1,
      issues_medium: 2,
      issues_low: 3,
    });
    const latest = mod.getLatestScan(db);
    assert.ok(latest);
    assert.equal(latest.total_skills, 5);
  });

  it('logError', () => {
    mod.logError(db, {
      hook_type: 'pre-tool',
      error_message: 'test error',
      raw_input: 'raw',
    });
    const errors = db.prepare('SELECT * FROM collector_errors').all();
    assert.ok(errors.length > 0);
  });

  it('creates components table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('components'));
  });

  it('upsertComponent inserts and updates', () => {
    const now = '2026-04-07T10:00:00Z';
    mod.upsertComponent(db, {
      type: 'skill', name: 'test-skill', source: 'global',
      plugin: null, project: null, file_path: '/tmp/skills/test-skill',
      description: 'A test skill', agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
      first_seen_at: now, last_seen_at: now,
    });
    const row = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
    assert.ok(row);
    assert.equal(row.type, 'skill');
    assert.equal(row.description, 'A test skill');

    // Update: change last_seen_at
    const later = '2026-04-07T11:00:00Z';
    mod.upsertComponent(db, {
      type: 'skill', name: 'test-skill', source: 'global',
      plugin: null, project: null, file_path: '/tmp/skills/test-skill',
      description: 'A test skill', agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
      first_seen_at: now, last_seen_at: later,
    });
    const updated = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
    assert.equal(updated.last_seen_at, later);
    assert.equal(updated.first_seen_at, now); // preserved
  });

  it('deleteComponentsNotSeenSince removes stale rows', () => {
    const old = '2026-04-07T09:00:00Z';
    mod.upsertComponent(db, {
      type: 'skill', name: 'stale-skill', source: 'global',
      plugin: null, project: null, file_path: '/tmp/skills/stale',
      description: '', agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
      first_seen_at: old, last_seen_at: old,
    });
    const cutoff = '2026-04-07T09:30:00Z';
    mod.deleteComponentsNotSeenSince(db, cutoff);
    const row = db.prepare("SELECT * FROM components WHERE name = 'stale-skill'").get();
    assert.equal(row, undefined);
    const kept = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
    assert.ok(kept);
  });

  it('getComponentsByType returns filtered rows', () => {
    mod.upsertComponent(db, {
      type: 'agent', name: 'test-agent', source: 'global',
      plugin: null, project: null, file_path: '/tmp/agents/test-agent.md',
      description: 'An agent', agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
      first_seen_at: '2026-04-07T10:00:00Z', last_seen_at: '2026-04-07T11:00:00Z',
    });
    const skills = mod.getComponentsByType(db, 'skill');
    assert.ok(skills.every(r => r.type === 'skill'));
    const agents = mod.getComponentsByType(db, 'agent');
    assert.ok(agents.some(r => r.name === 'test-agent'));
  });

  it('getAllComponents returns all rows', () => {
    const all = mod.getAllComponents(db);
    assert.ok(all.length >= 2); // test-skill + test-agent
  });

  it('creates knowledge graph tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('kg_nodes'), 'kg_nodes table missing');
    assert.ok(tables.includes('kg_edges'), 'kg_edges table missing');
    assert.ok(tables.includes('kg_vault_hashes'), 'kg_vault_hashes table missing');
    assert.ok(tables.includes('kg_sync_state'), 'kg_sync_state table missing');
  });

  it('upsertKgNode inserts and updates', () => {
    mod.upsertKgNode(db, {
      id: 'tool:Read', type: 'tool', name: 'Read',
      properties: '{"invocations":10}',
    });
    const row = mod.getKgNode(db, 'tool:Read');
    assert.equal(row.name, 'Read');
    assert.equal(row.type, 'tool');
    assert.equal(JSON.parse(row.properties).invocations, 10);

    mod.upsertKgNode(db, {
      id: 'tool:Read', type: 'tool', name: 'Read',
      properties: '{"invocations":20}',
    });
    const updated = mod.getKgNode(db, 'tool:Read');
    assert.equal(JSON.parse(updated.properties).invocations, 20);
  });

  it('upsertKgEdge inserts and accumulates weight', () => {
    mod.upsertKgNode(db, { id: 'tool:Edit', type: 'tool', name: 'Edit', properties: '{}' });
    mod.upsertKgEdge(db, {
      source_id: 'tool:Read', target_id: 'tool:Edit',
      relationship: 'triggers', weight: 5,
    });
    let edge = mod.getKgEdges(db, 'tool:Read');
    assert.equal(edge.length, 1);
    assert.equal(edge[0].weight, 5);

    mod.upsertKgEdge(db, {
      source_id: 'tool:Read', target_id: 'tool:Edit',
      relationship: 'triggers', weight: 3,
    });
    edge = mod.getKgEdges(db, 'tool:Read');
    assert.equal(edge[0].weight, 8);
  });

  it('getKgGraph returns filtered nodes and edges', () => {
    const graph = mod.getKgGraph(db, {});
    assert.ok(graph.nodes.length >= 2);
    assert.ok(graph.edges.length >= 1);

    const toolsOnly = mod.getKgGraph(db, { type: 'tool' });
    assert.ok(toolsOnly.nodes.every(n => n.type === 'tool'));
  });

  it('upsertKgVaultHash and getKgVaultHash', () => {
    mod.upsertKgVaultHash(db, {
      project_id: 'proj1', file_path: 'tools/Read.md', content_hash: 'abc123',
    });
    const hash = mod.getKgVaultHash(db, 'proj1', 'tools/Read.md');
    assert.equal(hash, 'abc123');
    assert.equal(mod.getKgVaultHash(db, 'proj1', 'nonexistent.md'), null);
  });

  it('getKgSyncState and setKgSyncState', () => {
    mod.setKgSyncState(db, 'last_event_id', '42');
    assert.equal(mod.getKgSyncState(db, 'last_event_id'), '42');
    mod.setKgSyncState(db, 'last_event_id', '99');
    assert.equal(mod.getKgSyncState(db, 'last_event_id'), '99');
    assert.equal(mod.getKgSyncState(db, 'missing_key'), null);
  });
});
