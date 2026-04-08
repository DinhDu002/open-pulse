'use strict';

function withSuggestionDefaults(sugg) {
  return { instinct_id: null, category: null, action_data: null, description_vi: null, ...sugg };
}

const SUGGESTION_INSERT_SQL = `
  INSERT INTO suggestions (id, created_at, type, confidence, description, evidence, instinct_id, status, category, action_data, description_vi)
  VALUES (@id, @created_at, @type, @confidence, @description, @evidence, @instinct_id, @status, @category, @action_data, @description_vi)
  ON CONFLICT(id) DO UPDATE SET
    confidence     = excluded.confidence,
    description    = excluded.description,
    description_vi = excluded.description_vi,
    evidence       = excluded.evidence,
    instinct_id    = excluded.instinct_id,
    category       = excluded.category,
    action_data    = excluded.action_data
`;

function insertSuggestion(db, sugg) {
  db.prepare(SUGGESTION_INSERT_SQL).run(withSuggestionDefaults(sugg));
}

function insertSuggestionBatch(db, suggestions) {
  const insert = db.prepare(SUGGESTION_INSERT_SQL);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withSuggestionDefaults(row));
  });
  tx(suggestions);
}

function querySuggestions(db, status, category) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM suggestions ${where} ORDER BY created_at DESC`).all(...params);
}

function updateSuggestionVi(db, id, descriptionVi) {
  db.prepare('UPDATE suggestions SET description_vi = ? WHERE id = ?').run(descriptionVi, id);
}

function updateSuggestionStatus(db, id, status, resolvedBy) {
  db.prepare(`
    UPDATE suggestions SET
      status      = ?,
      resolved_at = datetime('now'),
      resolved_by = ?
    WHERE id = ?
  `).run(status, resolvedBy, id);
}

module.exports = {
  insertSuggestion,
  insertSuggestionBatch,
  querySuggestions,
  updateSuggestionVi,
  updateSuggestionStatus,
};
