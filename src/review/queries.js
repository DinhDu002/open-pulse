'use strict';

// ---------------------------------------------------------------------------
// daily_reviews table query helpers
// ---------------------------------------------------------------------------

function queryDailyReviews(db, opts = {}) {
  const { review_date, status, category, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (review_date) { conditions.push('review_date = ?'); params.push(review_date); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM daily_reviews ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM daily_reviews ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getDailyReview(db, id) {
  return db.prepare('SELECT * FROM daily_reviews WHERE id = ?').get(id);
}

function updateDailyReviewStatus(db, id, status) {
  db.prepare('UPDATE daily_reviews SET status = ? WHERE id = ?').run(status, id);
}

function getDailyReviewStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM daily_reviews GROUP BY status ORDER BY count DESC'
  ).all();
  const byCategory = db.prepare(
    'SELECT category, COUNT(*) as count FROM daily_reviews GROUP BY category ORDER BY count DESC'
  ).all();
  const byDate = db.prepare(
    'SELECT review_date, COUNT(*) as count FROM daily_reviews GROUP BY review_date ORDER BY review_date DESC LIMIT 30'
  ).all();
  return { byStatus, byCategory, byDate };
}

// ---------------------------------------------------------------------------
// daily_review_insights table query helpers
// ---------------------------------------------------------------------------

function queryInsights(db, opts = {}) {
  const { review_date, insight_type, status, severity, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (review_date) { conditions.push('review_date = ?'); params.push(review_date); }
  if (insight_type) { conditions.push('insight_type = ?'); params.push(insight_type); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (severity) { conditions.push('severity = ?'); params.push(severity); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM daily_review_insights ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM daily_review_insights ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getInsight(db, id) {
  return db.prepare('SELECT * FROM daily_review_insights WHERE id = ?').get(id);
}

function updateInsightStatus(db, id, status) {
  db.prepare('UPDATE daily_review_insights SET status = ? WHERE id = ?').run(status, id);
}

function getInsightStats(db) {
  const byType = db.prepare(
    'SELECT insight_type, COUNT(*) as count FROM daily_review_insights GROUP BY insight_type ORDER BY count DESC'
  ).all();
  const bySeverity = db.prepare(
    'SELECT severity, COUNT(*) as count FROM daily_review_insights GROUP BY severity ORDER BY count DESC'
  ).all();
  const byDate = db.prepare(
    'SELECT review_date, COUNT(*) as count FROM daily_review_insights GROUP BY review_date ORDER BY review_date DESC LIMIT 30'
  ).all();
  return { byType, bySeverity, byDate };
}

module.exports = {
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  queryInsights,
  getInsight,
  updateInsightStatus,
  getInsightStats,
};
