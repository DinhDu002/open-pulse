'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Target type classification
// ---------------------------------------------------------------------------

function classifyTargetType(text) {
  if (!text) return null;

  const rulePatterns = [
    /\balways\b/i,
    /\bnever\b/i,
    /\bmust\b/i,
    /\bshould always\b/i,
    /\bdon't\b/i,
    /\bdo not\b/i,
    /\bavoid\b/i,
  ];
  if (rulePatterns.some(p => p.test(text))) return 'rule';

  const hookPatterns = [
    /\bautomatically\b/i,
    /\bevery time\b/i,
    /\bafter\b/i,
    /\bbefore\b/i,
    /\bon each\b/i,
  ];
  if (hookPatterns.some(p => p.test(text))) return 'hook';

  const skillPatterns = [
    /\bprocedure\b/i,
    /\bstep[- ]by[- ]step\b/i,
    /\bworkflow\b/i,
    /\bguide\b/i,
    /\bchecklist\b/i,
  ];
  if (skillPatterns.some(p => p.test(text))) return 'skill';

  const agentPatterns = [
    /\bdelegate\b/i,
    /\bspecialized agent\b/i,
    /\bsubagent\b/i,
    /\bisolat/i,
  ];
  if (agentPatterns.some(p => p.test(text))) return 'agent';

  const knowledgePatterns = [
    /\bhas \d+\b/i,
    /\bcontains\b/i,
    /\blocated at\b/i,
    /\brelationship between\b/i,
    /\bfact\b/i,
  ];
  if (knowledgePatterns.some(p => p.test(text))) return 'knowledge';

  return null;
}

// ---------------------------------------------------------------------------
// Insert / Upsert
// ---------------------------------------------------------------------------

function withInsightDefaults(insight) {
  return {
    target_type: null,
    action_data: null,
    promoted_to: null,
    project_id: null,
    confidence: 0.3,
    observation_count: 1,
    validation_count: 0,
    rejection_count: 0,
    status: 'active',
    ...insight,
  };
}

const INSIGHT_UPSERT_SQL = `
  INSERT INTO insights
    (id, source, category, target_type, title, description, confidence,
     observation_count, validation_count, rejection_count, status, action_data,
     promoted_to, project_id, created_at, updated_at)
  VALUES
    (@id, @source, @category, @target_type, @title, @description, @confidence,
     @observation_count, @validation_count, @rejection_count, @status, @action_data,
     @promoted_to, @project_id, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    observation_count = observation_count + 1,
    confidence = excluded.confidence,
    description = excluded.description,
    category = excluded.category,
    target_type = excluded.target_type,
    action_data = excluded.action_data,
    updated_at = excluded.updated_at
`;

function upsertInsight(db, insight) {
  const prepared = withInsightDefaults(insight);

  // Auto-classify target_type if not provided
  if (!prepared.target_type) {
    prepared.target_type = classifyTargetType(prepared.description || prepared.title);
  }

  // Ensure id exists (use source + title hash if not provided)
  if (!prepared.id) {
    const hash = crypto
      .createHash('sha256')
      .update(`${prepared.source}::${prepared.title}`)
      .digest('hex')
      .substring(0, 16);
    prepared.id = `insight-${hash}`;
  }

  // Ensure timestamps
  if (!prepared.created_at) prepared.created_at = new Date().toISOString();
  if (!prepared.updated_at) prepared.updated_at = new Date().toISOString();

  db.prepare(INSIGHT_UPSERT_SQL).run(prepared);
}

function upsertInsightBatch(db, insights) {
  const insert = db.prepare(INSIGHT_UPSERT_SQL);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const prepared = withInsightDefaults(row);
      if (!prepared.target_type) {
        prepared.target_type = classifyTargetType(prepared.description || prepared.title);
      }
      if (!prepared.id) {
        const hash = crypto
          .createHash('sha256')
          .update(`${prepared.source}::${prepared.title}`)
          .digest('hex')
          .substring(0, 16);
        prepared.id = `insight-${hash}`;
      }
      if (!prepared.created_at) prepared.created_at = new Date().toISOString();
      if (!prepared.updated_at) prepared.updated_at = new Date().toISOString();
      insert.run(prepared);
    }
  });
  tx(insights);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function queryInsights(db, opts = {}) {
  const { source, status, category, target_type, project_id, search, page = 1, per_page = 20 } = opts;

  // Clamp pagination
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page || 20, 100));

  const conditions = [];
  const params = [];

  if (source) { conditions.push('source = ?'); params.push(source); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }
  if (target_type) { conditions.push('target_type = ?'); params.push(target_type); }
  if (project_id) { conditions.push('project_id = ?'); params.push(project_id); }
  if (search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Get total count
  const countSql = `SELECT COUNT(*) AS cnt FROM insights ${where}`;
  const { cnt: total } = db.prepare(countSql).get(...params);

  // Get paginated results
  const offset = (p - 1) * pp;
  const sql = `
    SELECT * FROM insights ${where}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getInsight(db, id) {
  return db.prepare('SELECT * FROM insights WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Update feedback
// ---------------------------------------------------------------------------

function updateInsightFeedback(db, id, action) {
  const insight = getInsight(db, id);
  if (!insight) throw new Error(`Insight ${id} not found`);

  let confidence = insight.confidence || 0.3;
  let validationCount = insight.validation_count || 0;
  let rejectionCount = insight.rejection_count || 0;
  let status = insight.status || 'active';

  if (action === 'validate') {
    confidence = Math.min(0.95, confidence + 0.15);
    validationCount += 1;
  } else if (action === 'reject') {
    confidence = Math.max(0.0, confidence - 0.2);
    rejectionCount += 1;
    // Auto-archive after 3 rejections
    if (rejectionCount >= 3) {
      status = 'archived';
    }
  }

  db.prepare(`
    UPDATE insights SET
      confidence = ?,
      validation_count = ?,
      rejection_count = ?,
      status = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(confidence, validationCount, rejectionCount, status, id);
}

// ---------------------------------------------------------------------------
// Update status / action data
// ---------------------------------------------------------------------------

function updateInsightStatus(db, id, newStatus, promotedTo) {
  db.prepare(`
    UPDATE insights SET
      status = ?,
      promoted_to = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, promotedTo || null, id);
}

function updateInsightActionData(db, id, actionData) {
  db.prepare(`
    UPDATE insights SET
      action_data = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    typeof actionData === 'string' ? actionData : JSON.stringify(actionData),
    id
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function deleteInsight(db, id) {
  db.prepare('DELETE FROM insights WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function getInsightStats(db) {
  const bySource = db.prepare(`
    SELECT source, COUNT(*) as count FROM insights GROUP BY source ORDER BY count DESC
  `).all();

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM insights GROUP BY status ORDER BY count DESC
  `).all();

  const byTargetType = db.prepare(`
    SELECT target_type, COUNT(*) as count FROM insights
    WHERE target_type IS NOT NULL
    GROUP BY target_type ORDER BY count DESC
  `).all();

  return { bySource, byStatus, byTargetType };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyTargetType,
  upsertInsight,
  upsertInsightBatch,
  queryInsights,
  getInsight,
  updateInsightFeedback,
  updateInsightStatus,
  updateInsightActionData,
  deleteInsight,
  getInsightStats,
};
