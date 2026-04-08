'use strict';

function upsertInstinct(db, inst) {
  db.prepare(`
    INSERT INTO cl_instincts
      (instinct_id, project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct)
    VALUES
      (@instinct_id, @project_id, @category, @pattern, @confidence, @seen_count, @first_seen, @last_seen, @instinct)
    ON CONFLICT(project_id, instinct_id) DO UPDATE SET
      category   = excluded.category,
      pattern    = excluded.pattern,
      confidence = excluded.confidence,
      seen_count = seen_count + 1,
      last_seen  = excluded.last_seen,
      instinct   = excluded.instinct
  `).run(inst);
}

const INSTINCT_SORT_PRESETS = {
  confidence: 'confidence DESC, seen_count DESC, last_seen DESC',
  recent:     'last_seen DESC',
  seen:       'seen_count DESC, last_seen DESC',
  newest:     'first_seen DESC',
};

function queryInstinctsFiltered(db, { domain, source, project, category, confidence_min, confidence_max, search, sort, page, perPage } = {}) {
  const conditions = [];
  const params = {};

  if (project) { conditions.push('project_id = @project'); params.project = project; }
  // domain and category both map to the category column; domain takes precedence
  const cat = domain || category;
  if (cat) { conditions.push('category = @cat'); params.cat = cat; }
  // source is reserved for future use — no-op for now
  if (confidence_min != null) { conditions.push('confidence >= @confidence_min'); params.confidence_min = confidence_min; }
  if (confidence_max != null) { conditions.push('confidence <= @confidence_max'); params.confidence_max = confidence_max; }
  if (search) {
    conditions.push('(pattern LIKE @search OR instinct LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cl_instincts ${where}`).get(params).cnt;

  const p = Math.max(1, page || 1);
  const pp = Math.min(50, Math.max(1, perPage || 20));
  const offset = (p - 1) * pp;

  const orderBy = INSTINCT_SORT_PRESETS[sort] || INSTINCT_SORT_PRESETS.confidence;

  const items = db.prepare(
    `SELECT * FROM cl_instincts ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: pp, offset });

  return { items, total, page: p, per_page: pp };
}

function getInstinctStats(db) {
  const byDomain = db.prepare(`
    SELECT category AS domain, COUNT(*) AS count
    FROM cl_instincts
    GROUP BY category
    ORDER BY count DESC
  `).all();

  const rawDist = db.prepare(`
    SELECT
      CASE
        WHEN confidence < 0.3  THEN 'low'
        WHEN confidence < 0.6  THEN 'medium'
        ELSE 'high'
      END AS bucket,
      COUNT(*) AS count
    FROM cl_instincts
    GROUP BY bucket
  `).all();

  return { byDomain, confidenceDistribution: rawDist };
}

function getInstinctSuggestions(db, id) {
  const inst = db.prepare('SELECT instinct_id FROM cl_instincts WHERE id = ?').get(id);
  if (!inst || !inst.instinct_id) return [];
  return db.prepare(
    'SELECT * FROM suggestions WHERE instinct_id = ? ORDER BY created_at DESC'
  ).all(inst.instinct_id);
}

function getInstinct(db, id) {
  return db.prepare(
    `SELECT i.*, p.name AS project_name
     FROM cl_instincts i
     LEFT JOIN cl_projects p ON p.project_id = i.project_id
     WHERE i.id = ?`
  ).get(id) || null;
}

function updateInstinct(db, id, { confidence }) {
  const clamped = Math.min(0.95, Math.max(0.0, confidence));
  db.prepare('UPDATE cl_instincts SET confidence = ? WHERE id = ?').run(clamped, id);
}

function updateInstinctVi(db, id, text) {
  db.prepare('UPDATE cl_instincts SET instinct_vi = ? WHERE id = ?').run(text, id);
}

function deleteInstinct(db, id) {
  db.prepare('DELETE FROM cl_instincts WHERE id = ?').run(id);
}

module.exports = {
  upsertInstinct,
  INSTINCT_SORT_PRESETS,
  queryInstinctsFiltered,
  getInstinctStats,
  getInstinctSuggestions,
  getInstinct,
  updateInstinct,
  updateInstinctVi,
  deleteInstinct,
};
