'use strict';

module.exports = async function costRoutes(app, opts) {
  const { db, helpers } = opts;
  const { periodToDate } = helpers;

  // ── Rankings ────────────────────────────────────────────────────────────

  app.get('/api/rankings/:category', async (request) => {
    const { category } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn', tools: 'tool_call' };
    const eventType = eventTypeMap[category];
    if (!eventType) return [];

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    return db.prepare(
      `SELECT name, COUNT(*) as count FROM events ${where} GROUP BY name ORDER BY count DESC`
    ).all({ eventType, since: since || undefined });
  });

  // ── Cost ────────────────────────────────────────────────────────────────

  app.get('/api/cost', async (request) => {
    const { group_by = 'day', period } = request.query;
    const since = periodToDate(period);
    const whereClause = since ? 'WHERE started_at >= @since' : '';
    const params = since ? { since } : {};

    let rows = [];
    if (group_by === 'day') {
      rows = db.prepare(
        `SELECT strftime('%Y-%m-%d', started_at) as day, COALESCE(SUM(total_cost_usd), 0) as cost
         FROM sessions ${whereClause}
         GROUP BY day ORDER BY day ASC`
      ).all(params);
    } else if (group_by === 'model') {
      rows = db.prepare(
        `SELECT model, COALESCE(SUM(total_cost_usd), 0) as cost
         FROM sessions ${whereClause}
         GROUP BY model ORDER BY cost DESC`
      ).all(params);
    } else if (group_by === 'session') {
      rows = db.prepare(
        `SELECT session_id, started_at, COALESCE(total_cost_usd, 0) as cost
         FROM sessions ${whereClause}
         ORDER BY cost DESC`
      ).all(params);
    }
    return { rows };
  });
};
