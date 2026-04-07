'use strict';

const dbMod = require('./op-db');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTS = {
  confidenceThreshold: 0.5,
  sessionDays: 90,
  minTriggerCount: 2,
  patternMinWeight: 3,
};

// ---------------------------------------------------------------------------
// extractNodes
// ---------------------------------------------------------------------------

/**
 * Extract node entities from existing Open Pulse tables.
 * Returns array of { id, type, name, properties } objects.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.confidenceThreshold=0.5] - Min confidence for instinct nodes
 * @param {number} [opts.sessionDays=90]           - How many days back to pull sessions
 * @returns {Array<{id: string, type: string, name: string, properties: object}>}
 */
function extractNodes(db, opts = {}) {
  const { confidenceThreshold, sessionDays } = { ...DEFAULT_OPTS, ...opts };
  const nodes = [];

  // ------------------------------------------------------------------
  // 1. Tool / component nodes from events
  // ------------------------------------------------------------------
  const toolRows = db.prepare(`
    SELECT
      name,
      event_type,
      COUNT(*)                                    AS invocations,
      COUNT(DISTINCT session_id)                  AS sessions_used,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END), 4) AS success_rate,
      MAX(timestamp)                              AS last_used
    FROM events
    WHERE event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
      AND name IS NOT NULL
    GROUP BY name, event_type
  `).all();

  for (const row of toolRows) {
    const isComponent = row.event_type === 'skill_invoke' || row.event_type === 'agent_spawn';
    const nodeType = isComponent ? 'component' : 'tool';
    const id = `${nodeType}:${row.name}`;
    nodes.push({
      id,
      type: nodeType,
      name: row.name,
      properties: {
        event_type: row.event_type,
        invocations: row.invocations,
        sessions_used: row.sessions_used,
        success_rate: row.success_rate,
        last_used: row.last_used,
      },
    });
  }

  // Build set of names already captured from events
  const eventNames = new Set(toolRows.map(r => r.name));

  // ------------------------------------------------------------------
  // 2. Component nodes from components table (not already in events)
  // ------------------------------------------------------------------
  const compRows = db.prepare(`
    SELECT type, name, description, first_seen_at, last_seen_at
    FROM components
  `).all();

  for (const row of compRows) {
    if (eventNames.has(row.name)) continue; // already captured from events
    const id = `component:${row.type}:${row.name}`;
    nodes.push({
      id,
      type: 'component',
      name: row.name,
      properties: {
        component_type: row.type,
        description: row.description,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
      },
    });
  }

  // ------------------------------------------------------------------
  // 3. Instinct nodes (confidence >= threshold)
  // ------------------------------------------------------------------
  const instinctRows = db.prepare(`
    SELECT instinct_id, project_id, category, pattern, confidence, seen_count, last_seen
    FROM cl_instincts
    WHERE confidence >= ?
      AND instinct_id IS NOT NULL
  `).all(confidenceThreshold);

  for (const row of instinctRows) {
    nodes.push({
      id: `instinct:${row.instinct_id}`,
      type: 'instinct',
      name: row.pattern || row.instinct_id,
      properties: {
        project_id: row.project_id,
        category: row.category,
        confidence: row.confidence,
        seen_count: row.seen_count,
        last_seen: row.last_seen,
      },
    });
  }

  // ------------------------------------------------------------------
  // 4. Session nodes (last N days)
  // ------------------------------------------------------------------
  const sessionRows = db.prepare(`
    SELECT session_id, started_at, ended_at, model,
           total_tool_calls, total_cost_usd, working_directory
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
  `).all(sessionDays);

  for (const row of sessionRows) {
    nodes.push({
      id: `session:${row.session_id}`,
      type: 'session',
      name: row.session_id,
      properties: {
        started_at: row.started_at,
        ended_at: row.ended_at,
        model: row.model,
        total_tool_calls: row.total_tool_calls,
        total_cost_usd: row.total_cost_usd,
        working_directory: row.working_directory,
      },
    });
  }

  // ------------------------------------------------------------------
  // 5. Project nodes
  // ------------------------------------------------------------------
  const projectRows = db.prepare(`
    SELECT project_id, name, directory, session_count
    FROM cl_projects
  `).all();

  for (const row of projectRows) {
    nodes.push({
      id: `project:${row.project_id}`,
      type: 'project',
      name: row.name || row.project_id,
      properties: {
        directory: row.directory,
        session_count: row.session_count,
      },
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// extractEdges
// ---------------------------------------------------------------------------

/**
 * Extract relationship edges from existing data.
 * Returns array of { source_id, target_id, relationship, weight } objects.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.minTriggerCount=2] - Minimum count for a trigger edge
 * @param {number} [opts.sessionDays=90]    - How many days back to consider events
 * @returns {Array<{source_id: string, target_id: string, relationship: string, weight: number}>}
 */
function extractEdges(db, opts = {}) {
  const { minTriggerCount, sessionDays } = { ...DEFAULT_OPTS, ...opts };
  const edges = [];

  // ------------------------------------------------------------------
  // 1. Trigger edges: tool A immediately followed by tool B in same session
  //    Uses LEAD window function to find consecutive pairs.
  // ------------------------------------------------------------------
  const triggerRows = db.prepare(`
    WITH ordered AS (
      SELECT
        session_id,
        name                                         AS src_name,
        event_type                                   AS src_type,
        LEAD(name)       OVER (PARTITION BY session_id ORDER BY seq_num) AS tgt_name,
        LEAD(event_type) OVER (PARTITION BY session_id ORDER BY seq_num) AS tgt_type
      FROM events
      WHERE event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
        AND name IS NOT NULL
        AND seq_num IS NOT NULL
        AND timestamp >= datetime('now', '-' || ? || ' days')
    )
    SELECT
      src_name, src_type,
      tgt_name, tgt_type,
      COUNT(*) AS cnt
    FROM ordered
    WHERE tgt_name IS NOT NULL
    GROUP BY src_name, tgt_name
    HAVING cnt >= ?
  `).all(sessionDays, minTriggerCount);

  for (const row of triggerRows) {
    const srcType = row.src_type === 'tool_call' ? 'tool' : 'component';
    const tgtType = row.tgt_type === 'tool_call' ? 'tool' : 'component';
    edges.push({
      source_id: `${srcType}:${row.src_name}`,
      target_id: `${tgtType}:${row.tgt_name}`,
      relationship: 'triggers',
      weight: row.cnt,
    });
  }

  // ------------------------------------------------------------------
  // 2. Co-occurrence edges: two tools used in the same session
  // ------------------------------------------------------------------
  const coOccurRows = db.prepare(`
    SELECT
      a.name   AS name_a,
      a.event_type AS type_a,
      b.name   AS name_b,
      b.event_type AS type_b,
      COUNT(DISTINCT a.session_id) AS session_count
    FROM events a
    JOIN events b
      ON a.session_id = b.session_id
      AND a.name < b.name
    WHERE a.event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
      AND b.event_type IN ('tool_call', 'skill_invoke', 'agent_spawn')
      AND a.name IS NOT NULL
      AND b.name IS NOT NULL
      AND a.timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY a.name, b.name
    HAVING session_count >= 1
  `).all(sessionDays);

  for (const row of coOccurRows) {
    const typeA = row.type_a === 'tool_call' ? 'tool' : 'component';
    const typeB = row.type_b === 'tool_call' ? 'tool' : 'component';
    edges.push({
      source_id: `${typeA}:${row.name_a}`,
      target_id: `${typeB}:${row.name_b}`,
      relationship: 'co_occurs',
      weight: row.session_count,
    });
  }

  // ------------------------------------------------------------------
  // 3. Learned_from edges: instinct → project
  // ------------------------------------------------------------------
  const instinctRows = db.prepare(`
    SELECT instinct_id, project_id, confidence
    FROM cl_instincts
    WHERE instinct_id IS NOT NULL
      AND project_id IS NOT NULL
  `).all();

  for (const row of instinctRows) {
    edges.push({
      source_id: `instinct:${row.instinct_id}`,
      target_id: `project:${row.project_id}`,
      relationship: 'learned_from',
      weight: row.confidence || 1.0,
    });
  }

  // ------------------------------------------------------------------
  // 4. Has_suggestion edges: instinct → suggestion
  // ------------------------------------------------------------------
  const suggRows = db.prepare(`
    SELECT id, instinct_id, confidence
    FROM suggestions
    WHERE instinct_id IS NOT NULL
  `).all();

  for (const row of suggRows) {
    edges.push({
      source_id: `instinct:${row.instinct_id}`,
      target_id: `suggestion:${row.id}`,
      relationship: 'has_suggestion',
      weight: row.confidence || 1.0,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// syncGraph
// ---------------------------------------------------------------------------

/**
 * Orchestrator: extract nodes + edges, upsert into kg tables, derive pattern nodes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.confidenceThreshold]
 * @param {number} [opts.sessionDays]
 * @param {number} [opts.minTriggerCount]
 * @param {number} [opts.patternMinWeight] - Min weight for deriving pattern nodes
 * @returns {{ nodes: number, edges: number }}
 */
function syncGraph(db, opts = {}) {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const { patternMinWeight } = merged;

  // Extract raw nodes and edges
  const nodes = extractNodes(db, merged);
  const edges = extractEdges(db, merged);

  // Derive pattern nodes from high-weight trigger edges
  const patternNodes = [];
  const patternEdges = [];
  const seenPatterns = new Set();

  for (const edge of edges) {
    if (edge.relationship !== 'triggers') continue;
    if (edge.weight < patternMinWeight) continue;

    // Strip type prefix for readability: "tool:Read" → "Read"
    const srcName = edge.source_id.replace(/^[^:]+:/, '');
    const tgtName = edge.target_id.replace(/^[^:]+:/, '');
    const patternId = `pattern:${srcName}-${tgtName}`;

    if (seenPatterns.has(patternId)) continue;
    seenPatterns.add(patternId);

    patternNodes.push({
      id: patternId,
      type: 'pattern',
      name: `${srcName} → ${tgtName}`,
      properties: {
        source: edge.source_id,
        target: edge.target_id,
        weight: edge.weight,
      },
    });

    patternEdges.push({
      source_id: edge.source_id,
      target_id: patternId,
      relationship: 'part_of_pattern',
      weight: edge.weight,
    });
    patternEdges.push({
      source_id: patternId,
      target_id: edge.target_id,
      relationship: 'part_of_pattern',
      weight: edge.weight,
    });
  }

  const allNodes = [...nodes, ...patternNodes];
  const allEdges = [...edges, ...patternEdges];

  // Serialize properties to JSON strings for storage
  const dbNodes = allNodes.map(n => ({
    id: n.id,
    type: n.type,
    name: n.name,
    properties: JSON.stringify(n.properties || {}),
  }));

  // Filter edges: only keep those where both source and target exist as nodes
  // (FK enforcement is ON, so referencing non-existent nodes would fail)
  const nodeIds = new Set(dbNodes.map(n => n.id));
  const dbEdges = allEdges
    .filter(e => nodeIds.has(e.source_id) && nodeIds.has(e.target_id))
    .map(e => ({
      source_id: e.source_id,
      target_id: e.target_id,
      relationship: e.relationship,
      weight: e.weight,
    }));

  // Upsert into DB
  if (dbNodes.length > 0) {
    dbMod.upsertKgNodeBatch(db, dbNodes);
  }
  if (dbEdges.length > 0) {
    dbMod.upsertKgEdgeBatch(db, dbEdges);
  }

  // Record sync timestamp
  dbMod.setKgSyncState(db, 'last_sync_at', new Date().toISOString());

  return {
    nodes: allNodes.length,
    edges: allEdges.length,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  extractNodes,
  extractEdges,
  syncGraph,
};
