'use strict';

const path = require('path');

module.exports = async function promptsRoutes(app, opts) {
  const { db, helpers } = opts;
  const { periodToDate, errorReply, parsePagination } = helpers;

  // ── Prompts ─────────────────────────────────────────────────────────────

  app.get('/api/prompts', async (request) => {
    const {
      period = '7d', q, session_id, project,
    } = request.query;

    const { page, perPage } = parsePagination(request.query, { perPage: 20 });
    const offset = (page - 1) * perPage;
    const since = periodToDate(period);

    const conditions = [];
    const params = {};

    if (since) { conditions.push('p.timestamp >= @since'); params.since = since; }
    if (q) { conditions.push('p.prompt_text LIKE @q'); params.q = '%' + q + '%'; }
    if (session_id) { conditions.push('p.session_id = @session_id'); params.session_id = session_id; }
    if (project) { conditions.push('s.working_directory LIKE @project'); params.project = '%/' + project; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const agg = db.prepare(
      'SELECT COUNT(*) as count, COALESCE(SUM(p.event_count), 0) as total_events, COALESCE(SUM(p.total_cost_usd), 0) as total_cost, COALESCE(SUM(p.total_tokens), 0) as total_tokens FROM prompts p LEFT JOIN sessions s ON s.session_id = p.session_id ' + where
    ).get(params);
    const total = agg.count;

    const rows = db.prepare(
      'SELECT p.*, s.working_directory FROM prompts p LEFT JOIN sessions s ON s.session_id = p.session_id '
      + where + ' ORDER BY p.timestamp DESC LIMIT @limit OFFSET @offset'
    ).all({ ...params, limit: perPage, offset });

    // Event breakdown per prompt
    const breakdowns = {};
    const promptIds = rows.map(r => r.id);
    if (promptIds.length > 0) {
      const placeholders = promptIds.map(() => '?').join(',');
      const bdRows = db.prepare(
        'SELECT prompt_id, event_type, COUNT(*) as count FROM events WHERE prompt_id IN (' + placeholders + ') GROUP BY prompt_id, event_type'
      ).all(...promptIds);
      for (const r of bdRows) {
        if (!breakdowns[r.prompt_id]) breakdowns[r.prompt_id] = {};
        breakdowns[r.prompt_id][r.event_type] = r.count;
      }
    }

    const prompts = rows.map(r => ({
      id: r.id, session_id: r.session_id, prompt_text: r.prompt_text,
      timestamp: r.timestamp, event_count: r.event_count,
      total_cost_usd: r.total_cost_usd, total_tokens: r.total_tokens || 0,
      duration_ms: r.duration_ms,
      project: r.working_directory ? path.basename(r.working_directory) : null,
      event_breakdown: breakdowns[r.id] || {},
    }));

    return { prompts, total, total_events: agg.total_events, total_cost: agg.total_cost, total_tokens: agg.total_tokens, page, per_page: perPage };
  });

  app.get('/api/prompts/:id', async (request, reply) => {
    const { id } = request.params;
    const row = db.prepare(
      'SELECT p.*, s.working_directory FROM prompts p LEFT JOIN sessions s ON s.session_id = p.session_id WHERE p.id = ?'
    ).get(id);

    if (!row) return errorReply(reply, 404, 'Prompt not found');

    const events = db.prepare(
      'SELECT id, timestamp, event_type, name, detail, duration_ms, success, estimated_cost_usd, tool_input, tool_response, seq_num, model FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
    ).all(id);

    return {
      prompt: {
        id: row.id, session_id: row.session_id, prompt_text: row.prompt_text,
        timestamp: row.timestamp, event_count: row.event_count,
        total_cost_usd: row.total_cost_usd, total_tokens: row.total_tokens || 0,
        duration_ms: row.duration_ms,
        project: row.working_directory ? path.basename(row.working_directory) : null,
      },
      events,
    };
  });
};
