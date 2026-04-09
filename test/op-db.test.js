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

  it('creates prompts table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('prompts'));
  });

  it('events table has prompt_id column', () => {
    const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
    assert.ok(cols.includes('prompt_id'));
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
      type: 'skill',
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

  // ─── prompts ───────────────────────────────────────────────────────────────

  describe('prompts', () => {
    before(() => {
      // Seed sessions required by prompts FK constraint
      for (const sid of ['sess-prompt-1', 'sess-prompt-2', 'sess-prompt-3', 'sess-prompt-4']) {
        mod.upsertSession(db, {
          session_id: sid,
          started_at: '2026-04-08T10:00:00Z',
          working_directory: '/tmp',
          model: 'haiku',
        });
      }
    });

    it('insertPrompt creates a prompt record', () => {
      const id = mod.insertPrompt(db, {
        session_id: 'sess-prompt-1',
        prompt_text: 'add auth feature',
        seq_start: 1,
        timestamp: '2026-04-08T10:00:00Z',
      });
      assert.ok(id > 0);
      const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
      assert.equal(row.session_id, 'sess-prompt-1');
      assert.equal(row.prompt_text, 'add auth feature');
      assert.equal(row.seq_start, 1);
      assert.equal(row.event_count, 0);
    });

    it('getLatestPromptForSession returns most recent prompt', () => {
      mod.insertPrompt(db, {
        session_id: 'sess-prompt-2',
        prompt_text: 'first prompt',
        seq_start: 1,
        timestamp: '2026-04-08T10:00:00Z',
      });
      const id2 = mod.insertPrompt(db, {
        session_id: 'sess-prompt-2',
        prompt_text: 'second prompt',
        seq_start: 5,
        timestamp: '2026-04-08T10:01:00Z',
      });
      const latest = mod.getLatestPromptForSession(db, 'sess-prompt-2');
      assert.equal(latest.id, id2);
      assert.equal(latest.prompt_text, 'second prompt');
    });

    it('getLatestPromptForSession returns undefined when no prompts', () => {
      const result = mod.getLatestPromptForSession(db, 'nonexistent-session');
      assert.equal(result, undefined);
    });

    it('updatePromptStats increments event_count and cost', () => {
      const id = mod.insertPrompt(db, {
        session_id: 'sess-prompt-3',
        prompt_text: 'test prompt',
        seq_start: 1,
        timestamp: '2026-04-08T10:00:00Z',
      });
      mod.updatePromptStats(db, id, {
        seq_end: 3,
        cost: 0.05,
        timestamp: '2026-04-08T10:00:30Z',
      });
      mod.updatePromptStats(db, id, {
        seq_end: 4,
        cost: 0.10,
        timestamp: '2026-04-08T10:01:00Z',
      });
      const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
      assert.equal(row.event_count, 2);
      assert.ok(Math.abs(row.total_cost_usd - 0.15) < 0.001);
      assert.equal(row.seq_end, 4);
    });

    it('insertEvent includes prompt_id', () => {
      const promptId = mod.insertPrompt(db, {
        session_id: 'sess-prompt-4',
        prompt_text: 'with prompt_id',
        seq_start: 1,
        timestamp: '2026-04-08T10:00:00Z',
      });
      mod.insertEvent(db, {
        timestamp: '2026-04-08T10:00:05Z',
        session_id: 'sess-prompt-4',
        event_type: 'tool_call',
        name: 'Read',
        prompt_id: promptId,
      });
      const evt = db.prepare(
        'SELECT prompt_id FROM events WHERE session_id = ? AND name = ?'
      ).get('sess-prompt-4', 'Read');
      assert.equal(evt.prompt_id, promptId);
    });
  });

  // ─── deleteProject ─────────────────────────────────────────────────────────

  describe('deleteProject', () => {
    const P1 = 'del-proj-1';
    const P2 = 'del-proj-2';

    before(() => {
      // Seed two projects with instincts, suggestions, kb_notes, vault_hashes
      for (const pid of [P1, P2]) {
        mod.upsertClProject(db, {
          project_id: pid, name: pid, directory: '/tmp/' + pid,
          first_seen_at: '2026-01-01T00:00:00Z',
          last_seen_at: '2026-01-01T00:00:00Z',
          session_count: 0,
        });
        mod.upsertInstinct(db, {
          instinct_id: pid + '-inst-1', project_id: pid,
          category: 'test', pattern: 'p', confidence: 0.5,
          seen_count: 1, first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z', instinct: 'body',
        });
        mod.upsertInstinct(db, {
          instinct_id: pid + '-inst-2', project_id: pid,
          category: 'test', pattern: 'q', confidence: 0.7,
          seen_count: 1, first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z', instinct: 'body2',
        });
        mod.insertSuggestion(db, {
          id: pid + '-sugg-1', created_at: '2026-01-01T00:00:00Z',
          type: 'adoption', confidence: 0.6,
          description: 'test suggestion', evidence: 'ev',
          status: 'pending',
        });
        mod.insertKbNote(db, {
          id: pid + '-note-1', project_id: pid, slug: 'note-1',
          title: 'Test Note', body: 'content',
          tags: '[]', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        });
        mod.upsertKgVaultHash(db, {
          project_id: pid, file_path: 'test.md', content_hash: 'hash-' + pid,
        });
      }
    });

    it('deletes project and all related data', () => {
      const result = mod.deleteProject(db, P1);
      assert.equal(result.deleted, true);

      // Project row gone
      const proj = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(P1);
      assert.equal(proj, undefined);

      // Instincts gone
      const instincts = db.prepare('SELECT * FROM cl_instincts WHERE project_id = ?').all(P1);
      assert.equal(instincts.length, 0);

      // kb_notes gone
      const notes = db.prepare('SELECT * FROM kb_notes WHERE project_id = ?').all(P1);
      assert.equal(notes.length, 0);

      // vault_hashes gone
      const hashes = db.prepare('SELECT * FROM kg_vault_hashes WHERE project_id = ?').all(P1);
      assert.equal(hashes.length, 0);
    });

    it('returns deleted: false for non-existent project', () => {
      const result = mod.deleteProject(db, 'no-such-project');
      assert.equal(result.deleted, false);
    });

    it('does not affect other projects', () => {
      // P2 data should be untouched
      const proj = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(P2);
      assert.ok(proj);
      assert.equal(proj.name, P2);

      const instincts = db.prepare('SELECT * FROM cl_instincts WHERE project_id = ?').all(P2);
      assert.equal(instincts.length, 2);

      const notes = db.prepare('SELECT * FROM kb_notes WHERE project_id = ?').all(P2);
      assert.equal(notes.length, 1);

      const hashes = db.prepare('SELECT * FROM kg_vault_hashes WHERE project_id = ?').all(P2);
      assert.equal(hashes.length, 1);
    });
  });

  // ─── insights ──────────────────────────────────────────────────────────────

  describe('insights', () => {
    it('creates insights table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);
      assert.ok(tables.includes('insights'));
    });

    it('upsertInsight inserts new insight with all fields', () => {
      mod.upsertInsight(db, {
        id: 'insight-001',
        source: 'observer',
        category: 'pattern',
        target_type: 'rule',
        title: 'Always use immutable data',
        description: 'Immutable data should always be used',
        confidence: 0.85,
        observation_count: 1,
        validation_count: 0,
        rejection_count: 0,
        status: 'active',
        action_data: '{"type":"rule"}',
        project_id: 'proj-1',
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      const row = mod.getInsight(db, 'insight-001');
      assert.ok(row);
      assert.equal(row.source, 'observer');
      assert.equal(row.title, 'Always use immutable data');
      assert.equal(row.confidence, 0.85);
      assert.equal(row.target_type, 'rule');
      assert.equal(row.observation_count, 1);
    });

    it('upsertInsight increments observation_count on conflict', () => {
      mod.upsertInsight(db, {
        id: 'insight-002',
        source: 'observer',
        category: 'pattern',
        title: 'Test insight',
        description: 'Test description',
        confidence: 0.5,
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      const first = mod.getInsight(db, 'insight-002');
      assert.equal(first.observation_count, 1);

      // Upsert again with different confidence
      mod.upsertInsight(db, {
        id: 'insight-002',
        source: 'observer',
        category: 'pattern',
        title: 'Test insight',
        description: 'Updated description',
        confidence: 0.7,
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      const updated = mod.getInsight(db, 'insight-002');
      assert.equal(updated.observation_count, 2);
      assert.equal(updated.confidence, 0.7);
      assert.equal(updated.description, 'Updated description');
    });

    it('queryInsights filters by source and status', () => {
      mod.upsertInsight(db, {
        id: 'insight-filter-003',
        source: 'filter-observer',
        category: 'pattern',
        title: 'Active insight',
        description: 'This should be active',
        status: 'active',
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      mod.upsertInsight(db, {
        id: 'insight-filter-004',
        source: 'filter-observer',
        category: 'pattern',
        title: 'Archived insight',
        description: 'This should be archived',
        status: 'archived',
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      mod.upsertInsight(db, {
        id: 'insight-filter-005',
        source: 'filter-validator',
        category: 'pattern',
        title: 'Another source insight',
        description: 'From different source',
        status: 'active',
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      // Query by source and status
      const result = mod.queryInsights(db, {
        source: 'filter-observer',
        status: 'active',
      });

      assert.equal(result.rows.length, 1);
      assert.ok(result.rows.every(r => r.source === 'filter-observer' && r.status === 'active'));
      assert.ok(result.total >= 1);
    });

    it('updateInsightFeedback adjusts confidence on validate', () => {
      mod.upsertInsight(db, {
        id: 'insight-006',
        source: 'observer',
        category: 'pattern',
        title: 'Test validate',
        description: 'Test',
        confidence: 0.5,
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      mod.updateInsightFeedback(db, 'insight-006', 'validate');
      const row = mod.getInsight(db, 'insight-006');

      assert.equal(row.confidence, 0.65); // 0.5 + 0.15
      assert.equal(row.validation_count, 1);
    });

    it('updateInsightFeedback archives after 3 rejections', () => {
      mod.upsertInsight(db, {
        id: 'insight-007',
        source: 'observer',
        category: 'pattern',
        title: 'Test reject',
        description: 'Test',
        confidence: 0.8,
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      mod.updateInsightFeedback(db, 'insight-007', 'reject');
      let row = mod.getInsight(db, 'insight-007');
      assert.equal(row.rejection_count, 1);
      assert.equal(row.status, 'active');

      mod.updateInsightFeedback(db, 'insight-007', 'reject');
      row = mod.getInsight(db, 'insight-007');
      assert.equal(row.rejection_count, 2);
      assert.equal(row.status, 'active');

      mod.updateInsightFeedback(db, 'insight-007', 'reject');
      row = mod.getInsight(db, 'insight-007');
      assert.equal(row.rejection_count, 3);
      assert.equal(row.status, 'archived');
    });

    it('classifyTargetType returns correct types from keywords', () => {
      assert.equal(mod.classifyTargetType('you should always do this'), 'rule');
      assert.equal(mod.classifyTargetType('never use mutable state'), 'rule');
      assert.equal(mod.classifyTargetType('automatically run tests'), 'hook');
      assert.equal(mod.classifyTargetType('before saving, validate data'), 'hook');
      assert.equal(mod.classifyTargetType('step-by-step procedure'), 'skill');
      assert.equal(mod.classifyTargetType('workflow guide'), 'skill');
      assert.equal(mod.classifyTargetType('delegate to specialized agent'), 'agent');
      assert.equal(mod.classifyTargetType('isolated subagent'), 'agent');
      assert.equal(mod.classifyTargetType('this fact contains important data'), 'knowledge');
      assert.equal(mod.classifyTargetType('has 10 items'), 'knowledge');
      assert.equal(mod.classifyTargetType('no keywords here'), null);
    });

    it('queryInsights supports pagination', () => {
      // Insert 5 insights
      for (let i = 0; i < 5; i++) {
        mod.upsertInsight(db, {
          id: `insight-page-${i}`,
          source: 'observer',
          category: 'pattern',
          title: `Test ${i}`,
          description: 'Test',
          created_at: '2026-04-09T10:00:00Z',
          updated_at: '2026-04-09T10:00:00Z',
        });
      }

      const page1 = mod.queryInsights(db, { source: 'observer', page: 1, per_page: 2 });
      assert.equal(page1.rows.length, 2);
      assert.equal(page1.page, 1);
      assert.equal(page1.per_page, 2);
      assert.ok(page1.total >= 5);

      const page2 = mod.queryInsights(db, { source: 'observer', page: 2, per_page: 2 });
      assert.equal(page2.rows.length, 2);
      assert.equal(page2.page, 2);

      // Verify no duplicates between pages
      const ids1 = new Set(page1.rows.map(r => r.id));
      const ids2 = new Set(page2.rows.map(r => r.id));
      for (const id of ids1) {
        assert.ok(!ids2.has(id), `Duplicate ID ${id} across pages`);
      }
    });

    it('deleteInsight removes insight', () => {
      mod.upsertInsight(db, {
        id: 'insight-delete-test',
        source: 'observer',
        category: 'pattern',
        title: 'To delete',
        description: 'Delete me',
        created_at: '2026-04-09T10:00:00Z',
        updated_at: '2026-04-09T10:00:00Z',
      });

      let row = mod.getInsight(db, 'insight-delete-test');
      assert.ok(row);

      mod.deleteInsight(db, 'insight-delete-test');
      row = mod.getInsight(db, 'insight-delete-test');
      assert.equal(row, undefined);
    });

    it('getInsightStats returns counts by source/status/target_type', () => {
      const stats = mod.getInsightStats(db);
      assert.ok(stats.bySource);
      assert.ok(Array.isArray(stats.bySource));
      assert.ok(stats.byStatus);
      assert.ok(stats.byTargetType);
    });
  });
});
