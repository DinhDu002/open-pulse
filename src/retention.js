'use strict';

/**
 * Three-tier storage retention for Open Pulse events.
 *
 * Tier 1 — Hot (0-7 days):  Full events with tool_input/tool_response.
 * Tier 2 — Warm (7-90 days): Compact — NULL out tool_input and tool_response.
 * Tier 3 — Cold (90+ days):  Delete events entirely.
 *
 * Sessions are never deleted (lightweight, useful for long-term analytics).
 */

/**
 * Run all retention tiers.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {number} [opts.warmDays=7]   Days before compacting tool data
 * @param {number} [opts.coldDays=90]  Days before deleting events
 * @returns {{ compacted: number, deleted: number }}
 */
function runRetention(db, opts = {}) {
  const warmDays = opts.warmDays ?? 7;
  const coldDays = opts.coldDays ?? 90;

  // Tier 2: Compact warm events (NULL out tool_input/tool_response)
  const compactResult = db.prepare(`
    UPDATE events
    SET tool_input = NULL, tool_response = NULL
    WHERE timestamp < datetime('now', '-' || @warmDays || ' days')
      AND (tool_input IS NOT NULL OR tool_response IS NOT NULL)
  `).run({ warmDays });

  // Tier 3: Delete cold events
  const deleteResult = db.prepare(`
    DELETE FROM events
    WHERE timestamp < datetime('now', '-' || @coldDays || ' days')
  `).run({ coldDays });

  // Tier 3: Delete cold pipeline_runs
  const pipelineDeleteResult = db.prepare(`
    DELETE FROM pipeline_runs
    WHERE created_at < datetime('now', '-' || @coldDays || ' days')
  `).run({ coldDays });

  // Tier 3: Delete cold prompt_scores
  const scoresDeleteResult = db.prepare(`
    DELETE FROM prompt_scores
    WHERE created_at < datetime('now', '-' || @coldDays || ' days')
  `).run({ coldDays });

  // Tier 3: Delete cold session_reviews
  const reviewsDeleteResult = db.prepare(`
    DELETE FROM session_reviews
    WHERE created_at < datetime('now', '-' || @coldDays || ' days')
  `).run({ coldDays });

  return {
    compacted: compactResult.changes,
    deleted: deleteResult.changes + pipelineDeleteResult.changes + scoresDeleteResult.changes + reviewsDeleteResult.changes,
  };
}

module.exports = { runRetention };
