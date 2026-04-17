'use strict';

// ---------------------------------------------------------------------------
// Prompt Scores
// ---------------------------------------------------------------------------

function insertPromptScore(db, score) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT OR IGNORE INTO prompt_scores
      (prompt_id, session_id, project_id, efficiency, accuracy, cost_score, approach, overall, reasoning, event_count, created_at)
    VALUES
      (@prompt_id, @session_id, @project_id, @efficiency, @accuracy, @cost_score, @approach, @overall, @reasoning, @event_count, @created_at)
  `).run({
    prompt_id:  score.prompt_id,
    session_id: score.session_id,
    project_id: score.project_id ?? null,
    efficiency: score.efficiency,
    accuracy:   score.accuracy,
    cost_score: score.cost_score,
    approach:   score.approach,
    overall:    score.overall,
    reasoning:  typeof score.reasoning === 'string' ? score.reasoning : JSON.stringify(score.reasoning ?? null),
    event_count: score.event_count ?? 0,
    created_at: now,
  });
}

function getPromptScore(db, promptId) {
  return db.prepare('SELECT * FROM prompt_scores WHERE prompt_id = ?').get(promptId) ?? null;
}

function getSessionScores(db, sessionId) {
  return db.prepare(
    'SELECT * FROM prompt_scores WHERE session_id = ? ORDER BY prompt_id ASC'
  ).all(sessionId);
}

function getQualityStats(db, opts = {}) {
  const { projectId, period } = opts;

  const conditions = [];
  const params = {};

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }
  if (period) {
    conditions.push("created_at >= datetime('now', @period)");
    params.period = `-${period}`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const prompts = db.prepare(`
    SELECT
      COUNT(*) AS scored_count,
      ROUND(AVG(efficiency)) AS avg_efficiency,
      ROUND(AVG(accuracy))   AS avg_accuracy,
      ROUND(AVG(cost_score)) AS avg_cost_score,
      ROUND(AVG(approach))   AS avg_approach,
      ROUND(AVG(overall))    AS avg_overall
    FROM prompt_scores ${where}
  `).get(params);

  const sessionWhere = conditions.length
    ? 'WHERE ' + conditions.map(c => c.replace('created_at', 'sr.created_at').replace('project_id', 'sr.project_id')).join(' AND ')
    : '';

  const sessions = db.prepare(`
    SELECT COUNT(*) AS reviewed_count, ROUND(AVG(overall_score)) AS avg_session_score
    FROM session_reviews sr ${sessionWhere}
  `).get(params);

  return {
    scored_count: prompts.scored_count,
    averages: {
      efficiency: prompts.avg_efficiency ?? 0,
      accuracy:   prompts.avg_accuracy ?? 0,
      cost_score: prompts.avg_cost_score ?? 0,
      approach:   prompts.avg_approach ?? 0,
      overall:    prompts.avg_overall ?? 0,
    },
    sessions_reviewed: sessions.reviewed_count,
    session_avg_score: sessions.avg_session_score ?? 0,
  };
}

function getQualityTrends(db, opts = {}) {
  const { projectId, days = 30 } = opts;

  const conditions = ["created_at >= datetime('now', '-' || @days || ' days')"];
  const params = { days };

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  return db.prepare(`
    SELECT
      date(created_at) AS date,
      ROUND(AVG(efficiency)) AS avg_efficiency,
      ROUND(AVG(accuracy))   AS avg_accuracy,
      ROUND(AVG(cost_score)) AS avg_cost_score,
      ROUND(AVG(approach))   AS avg_approach,
      ROUND(AVG(overall))    AS avg_overall,
      COUNT(*)               AS count
    FROM prompt_scores ${where}
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(params);
}

// ---------------------------------------------------------------------------
// Weekly Comparison
// ---------------------------------------------------------------------------

function getWeeklyComparison(db, opts = {}) {
  const { projectId, weeks = 8 } = opts;

  const conditions = ["created_at >= datetime('now', '-' || @totalDays || ' days')"];
  const params = { totalDays: weeks * 7 };

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT
      strftime('%Y-W', created_at) || printf('%02d', CAST(strftime('%W', created_at) AS INTEGER)) AS week,
      MIN(date(created_at))  AS start_date,
      ROUND(AVG(efficiency)) AS avg_efficiency,
      ROUND(AVG(accuracy))   AS avg_accuracy,
      ROUND(AVG(cost_score)) AS avg_cost_score,
      ROUND(AVG(approach))   AS avg_approach,
      ROUND(AVG(overall))    AS avg_overall,
      COUNT(*)               AS count
    FROM prompt_scores ${where}
    GROUP BY strftime('%Y-%W', created_at)
    ORDER BY week ASC
  `).all(params);

  const DIMS = ['efficiency', 'accuracy', 'cost_score', 'approach', 'overall'];

  return rows.map((row, i) => {
    const averages = {
      efficiency: row.avg_efficiency,
      accuracy:   row.avg_accuracy,
      cost_score: row.avg_cost_score,
      approach:   row.avg_approach,
      overall:    row.avg_overall,
    };

    let changes = null;
    if (i > 0) {
      const prev = rows[i - 1];
      changes = {};
      for (const dim of DIMS) {
        const prevVal = prev[`avg_${dim}`];
        const curVal = row[`avg_${dim}`];
        if (prevVal === 0 || prevVal == null) {
          changes[dim] = null;
        } else {
          changes[dim] = Math.round(((curVal - prevVal) / prevVal) * 1000) / 10;
        }
      }
    }

    return {
      week: row.week,
      start_date: row.start_date,
      count: row.count,
      averages,
      changes,
    };
  });
}

// ---------------------------------------------------------------------------
// Session Reviews
// ---------------------------------------------------------------------------

function insertSessionReview(db, review) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT OR IGNORE INTO session_reviews
      (session_id, project_id, overall_score, summary, strengths, improvements, suggestions,
       prompt_count, scored_count, total_cost_usd, total_events, duration_mins, created_at)
    VALUES
      (@session_id, @project_id, @overall_score, @summary, @strengths, @improvements, @suggestions,
       @prompt_count, @scored_count, @total_cost_usd, @total_events, @duration_mins, @created_at)
  `).run({
    session_id:    review.session_id,
    project_id:    review.project_id ?? null,
    overall_score: review.overall_score ?? null,
    summary:       review.summary,
    strengths:     JSON.stringify(review.strengths ?? []),
    improvements:  JSON.stringify(review.improvements ?? []),
    suggestions:   JSON.stringify(review.suggestions ?? []),
    prompt_count:  review.prompt_count ?? 0,
    scored_count:  review.scored_count ?? 0,
    total_cost_usd: review.total_cost_usd ?? 0,
    total_events:  review.total_events ?? 0,
    duration_mins: review.duration_mins ?? 0,
    created_at:    now,
  });
}

function getSessionReview(db, sessionId) {
  return db.prepare('SELECT * FROM session_reviews WHERE session_id = ?').get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  insertPromptScore,
  getPromptScore,
  getSessionScores,
  getQualityStats,
  getQualityTrends,
  getWeeklyComparison,
  insertSessionReview,
  getSessionReview,
};
