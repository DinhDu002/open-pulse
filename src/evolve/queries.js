'use strict';

// ---------------------------------------------------------------------------
// Auto-evolve query helpers
// ---------------------------------------------------------------------------

// Escape LIKE wildcards in user-controlled strings (using ESCAPE '\\')
function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function queryAutoEvolves(db, opts = {}) {
  const { status, target_type, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (target_type) { conditions.push('target_type = ?'); params.push(target_type); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM auto_evolves ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM auto_evolves ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function queryAutoEvolvesByProject(db, projectName, opts = {}) {
  const { status, target_type, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [`projects IS NOT NULL AND projects LIKE ? ESCAPE '\\'`];
  const params = [`%"${escapeLike(projectName)}"%`];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (target_type) { conditions.push('target_type = ?'); params.push(target_type); }

  const where = 'WHERE ' + conditions.join(' AND ');
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM auto_evolves ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM auto_evolves ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getAutoEvolve(db, id) {
  return db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
}

function getAutoEvolveStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM auto_evolves GROUP BY status ORDER BY count DESC'
  ).all();
  const byTargetType = db.prepare(
    'SELECT target_type, COUNT(*) as count FROM auto_evolves GROUP BY target_type ORDER BY count DESC'
  ).all();
  return { byStatus, byTargetType };
}

module.exports = { queryAutoEvolves, queryAutoEvolvesByProject, getAutoEvolve, getAutoEvolveStats };
