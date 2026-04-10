'use strict';

const { parseQualifiedName, getKnownAgents } = require('../op-helpers');

module.exports = async function eventsRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply } = helpers;

  // ── Events ──────────────────────────────────────────────────────────────

  app.get('/api/events', async (request) => {
    const { type, name, from, to, limit = 100, offset = 0 } = request.query;
    const conditions = [];
    const params = {};

    if (type) { conditions.push('event_type = @type'); params.type = type; }
    if (name) { conditions.push('name = @name'); params.name = name; }
    if (from) { conditions.push('timestamp >= @from'); params.from = from; }
    if (to) { conditions.push('timestamp <= @to'); params.to = to; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.limit = parseInt(limit, 10);
    params.offset = parseInt(offset, 10);

    return db.prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`).all(params);
  });

  // ── Sessions ────────────────────────────────────────────────────────────

  app.get('/api/sessions', async (request) => {
    const { from, to, limit = 50, offset = 0 } = request.query;
    const conditions = [];
    const params = {};

    if (from) { conditions.push('started_at >= @from'); params.from = from; }
    if (to) { conditions.push('started_at <= @to'); params.to = to; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.limit = parseInt(limit, 10);
    params.offset = parseInt(offset, 10);

    const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT @limit OFFSET @offset`).all(params);
    return rows.map(s => ({
      ...s,
      cwd: s.working_directory,
      total_cost: s.total_cost_usd,
      tool_count: s.total_tool_calls,
      duration_ms: s.ended_at && s.started_at
        ? new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()
        : null,
    }));
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const rawSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
    if (!rawSession) return errorReply(reply, 404, 'Session not found');

    const session = {
      ...rawSession,
      cwd: rawSession.working_directory,
      total_cost: rawSession.total_cost_usd,
      duration_ms: rawSession.ended_at && rawSession.started_at
        ? new Date(rawSession.ended_at).getTime() - new Date(rawSession.started_at).getTime()
        : null,
    };

    const knownAgentSet = new Set(getKnownAgents());
    const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(id)
      .map(ev => {
        const isAgent = ev.event_type === 'agent_spawn';
        const { plugin } = isAgent ? parseQualifiedName(ev.name) : { plugin: null };
        return {
          ...ev,
          type: ev.event_type,
          created_at: ev.timestamp,
          cost: ev.estimated_cost_usd,
          agent_class: isAgent
            ? (knownAgentSet.has(ev.name) ? 'configured' : 'built-in')
            : undefined,
          plugin: plugin || undefined,
        };
      });

    return { session, events };
  });
};
