# Knowledge Graph & Obsidian Vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auto-updating knowledge graph in Open Pulse that materializes as Obsidian-compatible vault files in each project's `.claude/knowledge/` directory.

**Architecture:** Two-Pass pipeline — Pass 1 deterministic (SQL → graph upsert, 5min timer), Vault Generator (graph → .md per project, 15min timer), Pass 2 LLM enrichment (Haiku, on-demand). Graph stored in SQLite edge tables (`kg_nodes` + `kg_edges`). Frontend uses Cytoscape.js for interactive graph exploration.

**Tech Stack:** Node.js, better-sqlite3, Fastify 5, Cytoscape.js (CDN), Haiku 4.5 (Pass 2)

**Spec:** `docs/superpowers/specs/2026-04-08-knowledge-graph-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `src/op-knowledge-graph.js` | Pass 1: extract entities/edges from existing tables → upsert into kg_nodes/kg_edges |
| `src/op-vault-generator.js` | Generate .md vault files per project from graph data, SHA-256 skip |
| `src/op-knowledge-enricher.js` | Pass 2: Haiku LLM enrichment of node summaries |
| `public/modules/knowledge.js` | Frontend: Graph Explorer (Cytoscape.js) + Projects & Sync tab |
| `test/op-knowledge-graph.test.js` | Tests for graph extraction + upsert |
| `test/op-vault-generator.test.js` | Tests for vault generation |
| `test/op-knowledge-enricher.test.js` | Tests for LLM enrichment |

### Modified Files
| File | Changes |
|---|---|
| `src/op-db.js` | Add 4 tables (kg_nodes, kg_edges, kg_vault_hashes, kg_sync_state) + query functions |
| `src/op-server.js` | Add 2 timers (graph sync, vault gen) + 8 API routes under `/api/knowledge/*` |
| `public/index.html` | Add Cytoscape.js CDN + "Knowledge" nav link |
| `public/modules/router.js` | Add `knowledge` route entry |
| `config.json` | Add `knowledge_*` config keys |

---

## Task 1: Database Schema

**Files:**
- Modify: `src/op-db.js`
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing test for new tables**

In `test/op-db.test.js`, add inside the existing `describe('op-db', ...)` block, after the last `it(...)`:

```javascript
  it('creates knowledge graph tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('kg_nodes'), 'kg_nodes table missing');
    assert.ok(tables.includes('kg_edges'), 'kg_edges table missing');
    assert.ok(tables.includes('kg_vault_hashes'), 'kg_vault_hashes table missing');
    assert.ok(tables.includes('kg_sync_state'), 'kg_sync_state table missing');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-db.test.js`
Expected: FAIL — "kg_nodes table missing"

- [ ] **Step 3: Add tables to SCHEMA in op-db.js**

In `src/op-db.js`, append to the `SCHEMA` template literal (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS kg_nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  properties  TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);

CREATE TABLE IF NOT EXISTS kg_edges (
  source_id     TEXT NOT NULL REFERENCES kg_nodes(id),
  target_id     TEXT NOT NULL REFERENCES kg_nodes(id),
  relationship  TEXT NOT NULL,
  weight        REAL DEFAULT 1.0,
  properties    TEXT DEFAULT '{}',
  valid_from    TEXT,
  valid_to      TEXT,
  PRIMARY KEY (source_id, target_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_rel    ON kg_edges(relationship);

CREATE TABLE IF NOT EXISTS kg_vault_hashes (
  project_id    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE TABLE IF NOT EXISTS kg_sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-db.test.js`
Expected: ALL PASS

- [ ] **Step 5: Write failing tests for KG query functions**

In `test/op-db.test.js`, add after the previous new test:

```javascript
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/op-db.test.js`
Expected: FAIL — "mod.upsertKgNode is not a function"

- [ ] **Step 7: Implement KG query functions in op-db.js**

Add before the `module.exports` block in `src/op-db.js`:

```javascript
function upsertKgNode(db, node) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_nodes (id, type, name, properties, created_at, updated_at)
    VALUES (@id, @type, @name, @properties, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      type       = excluded.type,
      name       = excluded.name,
      properties = excluded.properties,
      updated_at = @now
  `).run({ ...node, now });
}

function upsertKgNodeBatch(db, nodes) {
  const stmt = db.prepare(`
    INSERT INTO kg_nodes (id, type, name, properties, created_at, updated_at)
    VALUES (@id, @type, @name, @properties, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      type       = excluded.type,
      name       = excluded.name,
      properties = excluded.properties,
      updated_at = @now
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({ ...row, now });
  });
  tx(nodes);
}

function getKgNode(db, id) {
  return db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) || null;
}

function upsertKgEdge(db, edge) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_edges (source_id, target_id, relationship, weight, properties, valid_from, valid_to)
    VALUES (@source_id, @target_id, @relationship, @weight, @properties, @valid_from, @valid_to)
    ON CONFLICT(source_id, target_id, relationship) DO UPDATE SET
      weight     = kg_edges.weight + excluded.weight,
      properties = excluded.properties,
      valid_to   = excluded.valid_to
  `).run({
    properties: '{}', valid_from: now, valid_to: null,
    ...edge,
  });
}

function upsertKgEdgeBatch(db, edges) {
  const stmt = db.prepare(`
    INSERT INTO kg_edges (source_id, target_id, relationship, weight, properties, valid_from, valid_to)
    VALUES (@source_id, @target_id, @relationship, @weight, @properties, @valid_from, @valid_to)
    ON CONFLICT(source_id, target_id, relationship) DO UPDATE SET
      weight     = kg_edges.weight + excluded.weight,
      properties = excluded.properties,
      valid_to   = excluded.valid_to
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({
      properties: '{}', valid_from: now, valid_to: null,
      ...row,
    });
  });
  tx(edges);
}

function getKgEdges(db, nodeId) {
  return db.prepare(
    'SELECT * FROM kg_edges WHERE source_id = ? AND valid_to IS NULL'
  ).all(nodeId);
}

function getKgGraph(db, { type } = {}) {
  const conditions = [];
  const params = {};
  if (type) { conditions.push('n.type = @type'); params.type = type; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const nodes = db.prepare(`SELECT * FROM kg_nodes n ${where}`).all(params);
  const nodeIds = new Set(nodes.map(n => n.id));

  const edges = db.prepare(
    'SELECT * FROM kg_edges WHERE valid_to IS NULL'
  ).all().filter(e => nodeIds.has(e.source_id) || nodeIds.has(e.target_id));

  return { nodes, edges };
}

function getKgNodeDetail(db, id) {
  const node = db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id);
  if (!node) return null;
  const outgoing = db.prepare(
    'SELECT * FROM kg_edges WHERE source_id = ? AND valid_to IS NULL'
  ).all(id);
  const incoming = db.prepare(
    'SELECT * FROM kg_edges WHERE target_id = ? AND valid_to IS NULL'
  ).all(id);
  return { ...node, outgoing, incoming };
}

function upsertKgVaultHash(db, { project_id, file_path, content_hash }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_vault_hashes (project_id, file_path, content_hash, generated_at)
    VALUES (@project_id, @file_path, @content_hash, @now)
    ON CONFLICT(project_id, file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      generated_at = @now
  `).run({ project_id, file_path, content_hash, now });
}

function getKgVaultHash(db, project_id, file_path) {
  const row = db.prepare(
    'SELECT content_hash FROM kg_vault_hashes WHERE project_id = ? AND file_path = ?'
  ).get(project_id, file_path);
  return row ? row.content_hash : null;
}

function getKgVaultHashes(db, project_id) {
  return db.prepare(
    'SELECT file_path, content_hash FROM kg_vault_hashes WHERE project_id = ?'
  ).all(project_id);
}

function setKgSyncState(db, key, value) {
  db.prepare(`
    INSERT INTO kg_sync_state (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ key, value });
}

function getKgSyncState(db, key) {
  const row = db.prepare('SELECT value FROM kg_sync_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getKgStatus(db) {
  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get().c;
  const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM kg_edges WHERE valid_to IS NULL').get().c;
  const lastSync = getKgSyncState(db, 'last_sync_at');
  const lastVaultGen = getKgSyncState(db, 'last_vault_gen_at');
  const lastEnrich = getKgSyncState(db, 'last_enrich_at');
  return { nodeCount, edgeCount, lastSync, lastVaultGen, lastEnrich };
}
```

Add to `module.exports`:

```javascript
  upsertKgNode,
  upsertKgNodeBatch,
  getKgNode,
  upsertKgEdge,
  upsertKgEdgeBatch,
  getKgEdges,
  getKgGraph,
  getKgNodeDetail,
  upsertKgVaultHash,
  getKgVaultHash,
  getKgVaultHashes,
  setKgSyncState,
  getKgSyncState,
  getKgStatus,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/op-db.test.js`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add knowledge graph schema and query functions

Add 4 new tables (kg_nodes, kg_edges, kg_vault_hashes, kg_sync_state)
and CRUD functions for graph upsert, vault hash tracking, and sync state."
```

---

## Task 2: Knowledge Graph Engine (Pass 1)

**Files:**
- Create: `src/op-knowledge-graph.js`
- Test: `test/op-knowledge-graph.test.js`

- [ ] **Step 1: Write failing test for node extraction**

Create `test/op-knowledge-graph.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db;
let dbMod;
let kgMod;

const TEST_DB = path.join(os.tmpdir(), `op-kg-test-${Date.now()}.db`);

describe('op-knowledge-graph', () => {
  before(() => {
    dbMod = require('../src/op-db');
    kgMod = require('../src/op-knowledge-graph');
    db = dbMod.createDb(TEST_DB);

    dbMod.insertEventBatch(db, [
      { timestamp: '2026-04-08T10:00:00Z', session_id: 's1', event_type: 'tool_call', name: 'Read', seq_num: 1, success: 1, working_directory: '/proj/a' },
      { timestamp: '2026-04-08T10:00:01Z', session_id: 's1', event_type: 'tool_call', name: 'Edit', seq_num: 2, success: 1, working_directory: '/proj/a' },
      { timestamp: '2026-04-08T10:00:02Z', session_id: 's1', event_type: 'tool_call', name: 'Read', seq_num: 3, success: 1, working_directory: '/proj/a' },
      { timestamp: '2026-04-08T10:00:03Z', session_id: 's1', event_type: 'agent_spawn', name: 'code-reviewer', seq_num: 4, success: 1, working_directory: '/proj/a' },
      { timestamp: '2026-04-08T11:00:00Z', session_id: 's2', event_type: 'tool_call', name: 'Read', seq_num: 1, success: 1, working_directory: '/proj/a' },
      { timestamp: '2026-04-08T11:00:01Z', session_id: 's2', event_type: 'tool_call', name: 'Grep', seq_num: 2, success: 1, working_directory: '/proj/a' },
    ]);

    dbMod.upsertSession(db, {
      session_id: 's1', started_at: '2026-04-08T10:00:00Z', ended_at: '2026-04-08T10:30:00Z',
      working_directory: '/proj/a', model: 'opus',
      total_tool_calls: 3, total_skill_invokes: 0, total_agent_spawns: 1,
      total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.10,
    });
    dbMod.upsertSession(db, {
      session_id: 's2', started_at: '2026-04-08T11:00:00Z', ended_at: '2026-04-08T11:15:00Z',
      working_directory: '/proj/a', model: 'sonnet',
      total_tool_calls: 2, total_skill_invokes: 0, total_agent_spawns: 0,
      total_input_tokens: 500, total_output_tokens: 200, total_cost_usd: 0.03,
    });

    dbMod.upsertInstinct(db, {
      instinct_id: 'test-instinct-1', project_id: 'proj-a',
      category: 'workflow', pattern: 'prefer Read over cat',
      confidence: 0.85, seen_count: 5,
      first_seen: '2026-04-01T00:00:00Z', last_seen: '2026-04-08T00:00:00Z',
      instinct: 'Use Read tool instead of Bash cat',
    });

    dbMod.upsertClProject(db, {
      project_id: 'proj-a', name: 'Project A', directory: '/proj/a',
      first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 2,
    });
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  });

  it('extractNodes returns tool, component, instinct, session, project nodes', () => {
    const nodes = kgMod.extractNodes(db, { sessionLookbackDays: 30 });
    const types = new Set(nodes.map(n => n.type));
    assert.ok(types.has('tool'), 'should have tool nodes');
    assert.ok(types.has('session'), 'should have session nodes');
    assert.ok(types.has('instinct'), 'should have instinct nodes');
    assert.ok(types.has('project'), 'should have project nodes');

    const readNode = nodes.find(n => n.id === 'tool:Read');
    assert.ok(readNode, 'should have tool:Read node');
    const props = JSON.parse(readNode.properties);
    assert.ok(props.invocations >= 3, 'Read should have >= 3 invocations');
  });

  it('extractEdges returns trigger and co_occurs edges', () => {
    const edges = kgMod.extractEdges(db, { minTriggerCount: 1 });
    assert.ok(edges.length > 0, 'should have edges');

    const triggers = edges.filter(e => e.relationship === 'triggers');
    assert.ok(triggers.length > 0, 'should have trigger edges');
    const readEdit = triggers.find(e => e.source_id === 'tool:Read' && e.target_id === 'tool:Edit');
    assert.ok(readEdit, 'should have Read->Edit trigger');
  });

  it('extractEdges returns learned_from edges for instincts', () => {
    const edges = kgMod.extractEdges(db, { minTriggerCount: 1 });
    const learnedFrom = edges.filter(e => e.relationship === 'learned_from');
    assert.ok(learnedFrom.length > 0, 'should have learned_from edges');
  });

  it('syncGraph populates kg_nodes and kg_edges', () => {
    const result = kgMod.syncGraph(db, { minTriggerCount: 1 });
    assert.ok(result.nodes > 0, 'should upsert nodes');

    const readNode = dbMod.getKgNode(db, 'tool:Read');
    assert.ok(readNode, 'tool:Read should exist in kg_nodes');

    const status = dbMod.getKgSyncState(db, 'last_sync_at');
    assert.ok(status, 'should set last_sync_at');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-knowledge-graph.test.js`
Expected: FAIL — cannot find module `../src/op-knowledge-graph`

- [ ] **Step 3: Implement op-knowledge-graph.js**

Create `src/op-knowledge-graph.js`:

```javascript
'use strict';

const {
  upsertKgNodeBatch,
  upsertKgEdgeBatch,
  setKgSyncState,
} = require('./op-db');

function extractNodes(db, opts = {}) {
  const lookback = opts.sessionLookbackDays ?? 30;
  const minConf = opts.instinctMinConfidence ?? 0.3;
  const nodes = [];

  const tools = db.prepare(`
    SELECT name, event_type,
           COUNT(*) AS invocations,
           COUNT(DISTINCT session_id) AS sessions_used,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
           MAX(timestamp) AS last_used
    FROM events
    WHERE name IS NOT NULL AND event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
    GROUP BY name, event_type
  `).all();

  for (const t of tools) {
    const type = t.event_type === 'tool_call' ? 'tool' : 'component';
    const id = type === 'component' ? `component:${t.name}` : `tool:${t.name}`;
    nodes.push({
      id, type, name: t.name,
      properties: JSON.stringify({
        event_type: t.event_type,
        invocations: t.invocations,
        sessions_used: t.sessions_used,
        success_rate: t.invocations > 0 ? +(t.successes / t.invocations).toFixed(3) : null,
        last_used: t.last_used,
      }),
    });
  }

  const components = db.prepare('SELECT * FROM components').all();
  for (const c of components) {
    const id = `component:${c.type}:${c.name}`;
    if (nodes.some(n => n.id === id)) continue;
    nodes.push({
      id, type: 'component', name: c.name,
      properties: JSON.stringify({
        component_type: c.type, source: c.source,
        plugin: c.plugin, project: c.project, description: c.description,
      }),
    });
  }

  const instincts = db.prepare(
    'SELECT * FROM cl_instincts WHERE confidence >= ?'
  ).all(minConf);
  for (const inst of instincts) {
    nodes.push({
      id: `instinct:${inst.instinct_id}`, type: 'instinct', name: inst.pattern || inst.instinct_id,
      properties: JSON.stringify({
        category: inst.category, confidence: inst.confidence,
        seen_count: inst.seen_count, project_id: inst.project_id,
        instinct: inst.instinct ? inst.instinct.slice(0, 500) : '',
      }),
    });
  }

  const sessions = db.prepare(
    "SELECT * FROM sessions WHERE started_at > datetime('now', '-' || ? || ' days')"
  ).all(lookback);
  for (const s of sessions) {
    nodes.push({
      id: `session:${s.session_id}`, type: 'session', name: s.session_id.slice(0, 8),
      properties: JSON.stringify({
        started_at: s.started_at, ended_at: s.ended_at, model: s.model,
        working_directory: s.working_directory, total_tool_calls: s.total_tool_calls,
        total_cost_usd: s.total_cost_usd,
      }),
    });
  }

  const projects = db.prepare('SELECT * FROM cl_projects').all();
  for (const p of projects) {
    nodes.push({
      id: `project:${p.project_id}`, type: 'project', name: p.name || p.project_id,
      properties: JSON.stringify({ directory: p.directory, session_count: p.session_count }),
    });
  }

  return nodes;
}

function extractEdges(db, opts = {}) {
  const minTriggers = opts.minTriggerCount ?? 5;
  const edges = [];

  const triggerPairs = db.prepare(`
    WITH seq AS (
      SELECT session_id, name, event_type, seq_num,
             LEAD(name) OVER (PARTITION BY session_id ORDER BY seq_num) AS next_name,
             LEAD(event_type) OVER (PARTITION BY session_id ORDER BY seq_num) AS next_type
      FROM events
      WHERE name IS NOT NULL
        AND event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
    )
    SELECT name, event_type, next_name, next_type, COUNT(*) AS cnt
    FROM seq
    WHERE next_name IS NOT NULL AND name != next_name
    GROUP BY name, event_type, next_name, next_type
    HAVING cnt >= @minTriggers
  `).all({ minTriggers });

  for (const p of triggerPairs) {
    const sourceId = p.event_type === 'tool_call' ? `tool:${p.name}` : `component:${p.name}`;
    const targetId = p.next_type === 'tool_call' ? `tool:${p.next_name}` : `component:${p.next_name}`;
    edges.push({ source_id: sourceId, target_id: targetId, relationship: 'triggers', weight: p.cnt });
  }

  const coOccurs = db.prepare(`
    WITH tools_per_session AS (
      SELECT DISTINCT session_id, name
      FROM events
      WHERE name IS NOT NULL AND event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
    )
    SELECT a.name AS name_a, b.name AS name_b, COUNT(DISTINCT a.session_id) AS cnt
    FROM tools_per_session a
    JOIN tools_per_session b ON a.session_id = b.session_id AND a.name < b.name
    GROUP BY a.name, b.name
    HAVING cnt >= @minTriggers
  `).all({ minTriggers });

  for (const c of coOccurs) {
    edges.push({ source_id: `tool:${c.name_a}`, target_id: `tool:${c.name_b}`, relationship: 'co_occurs', weight: c.cnt });
  }

  const instincts = db.prepare(
    "SELECT instinct_id, project_id FROM cl_instincts WHERE project_id IS NOT NULL AND project_id != ''"
  ).all();
  for (const inst of instincts) {
    edges.push({ source_id: `instinct:${inst.instinct_id}`, target_id: `project:${inst.project_id}`, relationship: 'learned_from', weight: 1 });
  }

  const suggestions = db.prepare(
    "SELECT instinct_id FROM suggestions WHERE instinct_id IS NOT NULL AND instinct_id != '' GROUP BY instinct_id"
  ).all();
  for (const s of suggestions) {
    edges.push({ source_id: `instinct:${s.instinct_id}`, target_id: `instinct:${s.instinct_id}`, relationship: 'has_suggestion', weight: 1 });
  }

  return edges;
}

function syncGraph(db, opts = {}) {
  const nodes = extractNodes(db, opts);
  const edges = extractEdges(db, opts);

  if (nodes.length > 0) upsertKgNodeBatch(db, nodes);
  if (edges.length > 0) upsertKgEdgeBatch(db, edges);

  setKgSyncState(db, 'last_sync_at', new Date().toISOString());

  const patternEdges = edges.filter(e => e.relationship === 'triggers' && e.weight >= (opts.patternMinOccurrences ?? 5));
  const patternNodes = [];
  for (const e of patternEdges) {
    const srcName = e.source_id.split(':').pop();
    const tgtName = e.target_id.split(':').pop();
    const id = `pattern:${srcName}-${tgtName}`.toLowerCase();
    patternNodes.push({
      id, type: 'pattern', name: `${srcName}\u2192${tgtName}`,
      properties: JSON.stringify({ occurrences: e.weight }),
    });
  }
  if (patternNodes.length > 0) upsertKgNodeBatch(db, patternNodes);

  return { nodes: nodes.length + patternNodes.length, edges: edges.length };
}

module.exports = { extractNodes, extractEdges, syncGraph };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-knowledge-graph.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/op-knowledge-graph.js test/op-knowledge-graph.test.js
git commit -m "feat: add knowledge graph engine (Pass 1)

Extracts tool, component, instinct, session, project nodes and
trigger, co_occurs, learned_from edges from existing Open Pulse data.
syncGraph orchestrates the full extraction + upsert pipeline."
```

---

## Task 3: Vault Generator

**Files:**
- Create: `src/op-vault-generator.js`
- Test: `test/op-vault-generator.test.js`

- [ ] **Step 1: Write failing test**

Create `test/op-vault-generator.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db;
let dbMod;
let vaultMod;

const TEST_DB = path.join(os.tmpdir(), `op-vault-test-${Date.now()}.db`);
const TEST_PROJECT_DIR = path.join(os.tmpdir(), `op-vault-proj-${Date.now()}`);

describe('op-vault-generator', () => {
  before(() => {
    dbMod = require('../src/op-db');
    vaultMod = require('../src/op-vault-generator');
    db = dbMod.createDb(TEST_DB);

    fs.mkdirSync(TEST_PROJECT_DIR, { recursive: true });

    dbMod.upsertClProject(db, {
      project_id: 'test-proj', name: 'Test Project', directory: TEST_PROJECT_DIR,
      first_seen_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 5,
    });

    dbMod.upsertKgNode(db, { id: 'tool:Read', type: 'tool', name: 'Read',
      properties: '{"invocations":100,"sessions_used":20,"success_rate":0.98,"last_used":"2026-04-08"}' });
    dbMod.upsertKgNode(db, { id: 'tool:Edit', type: 'tool', name: 'Edit',
      properties: '{"invocations":50,"sessions_used":15,"success_rate":0.95,"last_used":"2026-04-08"}' });
    dbMod.upsertKgNode(db, { id: 'instinct:test-inst', type: 'instinct', name: 'test instinct',
      properties: '{"confidence":0.85,"category":"workflow","project_id":"test-proj"}' });
    dbMod.upsertKgNode(db, { id: 'project:test-proj', type: 'project', name: 'Test Project',
      properties: JSON.stringify({ directory: TEST_PROJECT_DIR, session_count: 5 }) });

    dbMod.upsertKgEdge(db, { source_id: 'tool:Read', target_id: 'tool:Edit', relationship: 'triggers', weight: 25 });
    dbMod.upsertKgEdge(db, { source_id: 'instinct:test-inst', target_id: 'project:test-proj', relationship: 'learned_from', weight: 1 });
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
    try { fs.rmSync(TEST_PROJECT_DIR, { recursive: true }); } catch {}
  });

  it('generateVault creates index.md and tool files', () => {
    const result = vaultMod.generateVault(db, 'test-proj');
    assert.ok(result.filesWritten > 0, 'should write files');

    const vaultDir = path.join(TEST_PROJECT_DIR, '.claude', 'knowledge');
    assert.ok(fs.existsSync(path.join(vaultDir, 'index.md')), 'index.md should exist');
    assert.ok(fs.existsSync(path.join(vaultDir, 'tools', 'Read.md')), 'tools/Read.md should exist');

    const indexContent = fs.readFileSync(path.join(vaultDir, 'index.md'), 'utf8');
    assert.ok(indexContent.includes('[[tools/Read]]'), 'index should link to Read');
  });

  it('generateVault skips unchanged files (SHA-256)', () => {
    const first = vaultMod.generateVault(db, 'test-proj');
    const second = vaultMod.generateVault(db, 'test-proj');
    assert.ok(second.filesSkipped > 0, 'should skip files on second run');
  });

  it('renderToolPage generates valid markdown with backlinks', () => {
    const node = dbMod.getKgNode(db, 'tool:Read');
    const edges = dbMod.getKgEdges(db, 'tool:Read');
    const md = vaultMod.renderToolPage(node, edges);
    assert.ok(md.includes('# Read'), 'should have title');
    assert.ok(md.includes('[[tools/Edit]]'), 'should have backlink to Edit');
    assert.ok(md.includes('---'), 'should have frontmatter');
  });

  it('generateAllVaults processes all projects', () => {
    const result = vaultMod.generateAllVaults(db);
    assert.equal(result.projects, 1);
  });

  it('nodeIdToPath maps id to correct file path', () => {
    assert.equal(vaultMod.nodeIdToPath('tool:Read'), 'tools/Read.md');
    assert.equal(vaultMod.nodeIdToPath('instinct:my-inst'), 'instincts/my-inst.md');
    assert.equal(vaultMod.nodeIdToPath('pattern:read-edit'), 'patterns/read-edit.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-vault-generator.test.js`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement op-vault-generator.js**

Create `src/op-vault-generator.js` — see spec for full implementation. Key functions:

- `nodeIdToPath(id)` — maps node ID to vault file path
- `renderToolPage(node, edges)` — generates tool markdown with backlinks
- `renderInstinctPage(node)` — generates instinct markdown
- `renderComponentPage(node, edges)` — generates component markdown
- `renderPatternPage(node)` — generates pattern markdown
- `renderIndexPage(nodes, edges, projectName)` — generates index TOC
- `generateVault(db, projectId)` — per-project vault generation with SHA-256 skip
- `generateAllVaults(db)` — iterate all projects

The full implementation is in the spec document. The vault generator:
1. Queries graph data from kg_nodes/kg_edges
2. Filters out session nodes (too noisy for vault)
3. Renders each node as a markdown file using templates
4. SHA-256 hashes content, skips writes if hash matches kg_vault_hashes
5. Creates directory structure under `{project_dir}/.claude/knowledge/`
6. Updates `kg_sync_state` with last_vault_gen_at

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-vault-generator.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/op-vault-generator.js test/op-vault-generator.test.js
git commit -m "feat: add vault generator (graph to md per project)

Generates Obsidian-compatible markdown files with backlinks from
knowledge graph data. SHA-256 content hashing skips unchanged files.
Per-project output to .claude/knowledge/ directory."
```

---

## Task 4: Server Integration (Timers + API Routes)

**Files:**
- Modify: `src/op-server.js`
- Modify: `config.json`
- Test: `test/op-server.test.js`

- [ ] **Step 1: Add config keys to config.json**

Append to `config.json` object:

```json
  "knowledge_graph_interval_ms": 300000,
  "knowledge_vault_interval_ms": 900000,
  "knowledge_enrich_enabled": false,
  "knowledge_enrich_interval_ms": 86400000,
  "knowledge_enrich_auto_threshold": 50,
  "knowledge_pattern_min_occurrences": 5,
  "knowledge_session_lookback_days": 30,
  "knowledge_instinct_min_confidence": 0.3,
  "knowledge_vault_max_index_items": 10
```

- [ ] **Step 2: Write failing tests for knowledge API**

Add to `test/op-server.test.js` inside the existing `describe` block:

```javascript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/op-server.test.js`
Expected: FAIL — 404 on `/api/knowledge/status`

- [ ] **Step 4: Add imports, timers, and routes to op-server.js**

Add imports:

```javascript
const { syncGraph } = require('./op-knowledge-graph');
const { generateAllVaults } = require('./op-vault-generator');
```

Add timers in the `if (!disableTimers)` block:

```javascript
    timers.push(setInterval(() => {
      try {
        syncGraph(db, {
          sessionLookbackDays: config.knowledge_session_lookback_days ?? 30,
          instinctMinConfidence: config.knowledge_instinct_min_confidence ?? 0.3,
          minTriggerCount: config.knowledge_pattern_min_occurrences ?? 5,
        });
      } catch { /* non-critical */ }
    }, config.knowledge_graph_interval_ms || 300000));

    timers.push(setInterval(() => {
      try { generateAllVaults(db); } catch { /* non-critical */ }
    }, config.knowledge_vault_interval_ms || 900000));
```

Add 8 API routes (see spec for exact implementations): status, projects, graph, node detail, sync, generate, enrich, config.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/op-server.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/op-server.js config.json test/op-server.test.js
git commit -m "feat: add knowledge graph API routes and timers

8 new endpoints under /api/knowledge/* for graph status, exploration,
sync, vault generation, and enrichment triggers.
Timers: graph sync (5min), vault generation (15min)."
```

---

## Task 5: Frontend — Knowledge Module

**Files:**
- Create: `public/modules/knowledge.js`
- Modify: `public/index.html`
- Modify: `public/modules/router.js`

- [ ] **Step 1: Add Cytoscape.js CDN and nav link to index.html**

After dayjs CDN script:
```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.4/cytoscape.min.js"></script>
```

After "Learning" nav link:
```html
      <a href="#knowledge" class="nav-link">Knowledge</a>
```

- [ ] **Step 2: Add knowledge route to router.js**

Add to `ROUTES`: `knowledge: () => import('./knowledge.js'),`

Add to `NO_PERIOD`: `'knowledge'`

- [ ] **Step 3: Create knowledge.js**

Create `public/modules/knowledge.js` with two tabs:

**Tab 1: Graph Explorer** — Cytoscape.js interactive graph, type filter, search, node detail panel
**Tab 2: Projects & Sync** — summary cards, project table with Sync/Enrich buttons

Full implementation in spec. Key patterns:
- Follows `mount(el)/unmount()` pattern from other modules
- Uses `get()/post()` from `api.js`
- Cytoscape.js with cose layout, color-coded by node type
- Click node shows detail panel with connections

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add public/modules/knowledge.js public/index.html public/modules/router.js
git commit -m "feat: add knowledge graph frontend module

Graph Explorer tab with Cytoscape.js interactive visualization.
Projects & Sync tab with status cards and per-project sync/enrich."
```

---

## Task 6: LLM Enricher (Pass 2)

**Files:**
- Create: `src/op-knowledge-enricher.js`
- Test: `test/op-knowledge-enricher.test.js`

- [ ] **Step 1: Write failing test**

Create `test/op-knowledge-enricher.test.js` with tests for:
- `buildEnrichmentPrompt(db, nodeId)` — returns prompt string
- `applyEnrichment(db, nodeId, summary)` — updates node properties
- `getUnenrichedNodes(db)` — returns nodes without summary

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-knowledge-enricher.test.js`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement op-knowledge-enricher.js**

Key functions:
- `buildEnrichmentPrompt(db, nodeId)` — builds context from node + neighbors
- `applyEnrichment(db, nodeId, summary)` — merges summary into properties JSON
- `getUnenrichedNodes(db)` — filters nodes missing summary field
- `enrichNodes(db, opts)` — async, calls Haiku API, requires ANTHROPIC_API_KEY
- `callHaiku(apiKey, prompt)` — fetch to anthropic API

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-knowledge-enricher.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/op-knowledge-enricher.js test/op-knowledge-enricher.test.js
git commit -m "feat: add knowledge graph LLM enricher (Pass 2)

Haiku-based enrichment for node summaries. Builds context-aware prompts
from graph data. Requires ANTHROPIC_API_KEY. On-demand trigger."
```

---

## Task 7: Update Docs and Full Verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Update tables: 9 → 13 tables, add knowledge API endpoints, new files, new config keys.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: Manual verification**

```bash
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/knowledge/status
curl -s -X POST http://127.0.0.1:3827/api/knowledge/sync
curl -s http://127.0.0.1:3827/api/knowledge/graph
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with knowledge graph components"
```

---

## Summary

| Task | Files | Tests | Description |
|------|-------|-------|-------------|
| 1 | op-db.js | 5 new | Schema + KG query functions |
| 2 | op-knowledge-graph.js | 4 new | Pass 1 engine (extract + upsert) |
| 3 | op-vault-generator.js | 5 new | Graph to md per project |
| 4 | op-server.js, config.json | 6 new | Timers + 8 API routes |
| 5 | knowledge.js, index.html, router.js | — | Frontend module |
| 6 | op-knowledge-enricher.js | 3 new | Pass 2 Haiku enrichment |
| 7 | CLAUDE.md | — | Docs + full verification |
