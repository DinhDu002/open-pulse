'use strict';

const fs = require('fs');
const { verifyModel, getCircuitState } = require('../lib/ollama');

module.exports = async function healthRoutes(app, opts) {
  const { db, helpers, dbPath, config } = opts;
  const { periodToDate } = helpers;

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/api/health', async () => {
    const total_events = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    let db_size_bytes = 0;
    try { db_size_bytes = fs.statSync(dbPath).size; } catch { /* ignore */ }
    return { status: 'ok', db_size_bytes, total_events };
  });

  // ── Ollama Health ───────────────────────────────────────────────────────

  app.get('/api/health/ollama', async () => {
    const ollamaUrl = config.ollama_url || 'http://localhost:11434';
    const ollamaModel = config.ollama_model || 'qwen2.5:7b';

    let serverOk = false;
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      serverOk = res.ok;
    } catch { /* unreachable */ }

    let modelOk = false;
    if (serverOk) {
      modelOk = await verifyModel(ollamaModel, { url: ollamaUrl });
    }

    return {
      status: serverOk ? 'online' : 'offline',
      url: ollamaUrl,
      model: ollamaModel,
      model_loaded: modelOk,
      circuit_breaker: getCircuitState(),
    };
  });

  // ── Overview ────────────────────────────────────────────────────────────

  app.get('/api/overview', async (request) => {
    const { period } = request.query;
    const since = periodToDate(period);

    const evWhere = since ? 'WHERE timestamp >= @since' : '';
    const sessWhere = since ? 'WHERE started_at >= @since' : '';
    const rankWhere = since ? 'WHERE timestamp >= @since AND' : 'WHERE';
    const p = since ? { since } : {};

    const total_sessions = db.prepare(`SELECT COUNT(*) as c FROM sessions ${sessWhere}`).get(p).c;
    const total_cost = db.prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) as s FROM sessions ${sessWhere}`).get(p).s;
    const total_events = db.prepare(`SELECT COUNT(*) as c FROM events ${evWhere}`).get(p).c;
    const total_errors = db.prepare('SELECT COUNT(*) as c FROM collector_errors').get().c;

    const avg_session_cost = total_sessions > 0 ? Math.round((total_cost / total_sessions) * 100) / 100 : 0;
    const durWhere = since ? 'WHERE started_at >= @since AND ended_at IS NOT NULL' : 'WHERE ended_at IS NOT NULL';
    const avgDur = total_sessions > 0
      ? db.prepare(`SELECT AVG((julianday(ended_at) - julianday(started_at)) * 86400000) as d FROM sessions ${durWhere}`).get(p)?.d
      : null;

    const topSkills = db.prepare(
      `SELECT name, COUNT(*) as count FROM events ${rankWhere} event_type = 'skill_invoke' GROUP BY name ORDER BY count DESC LIMIT 5`
    ).all(p);
    const topAgents = db.prepare(
      `SELECT name, COUNT(*) as count FROM events ${rankWhere} event_type = 'agent_spawn' GROUP BY name ORDER BY count DESC LIMIT 5`
    ).all(p);
    const topTools = db.prepare(
      `SELECT name, COUNT(*) as count FROM events ${rankWhere} event_type = 'tool_call' GROUP BY name ORDER BY count DESC LIMIT 5`
    ).all(p);

    return {
      sessions: total_sessions, total_sessions,
      total_cost, total_events,
      errors: total_errors, total_errors,
      avg_session_cost,
      avg_session_duration: avgDur ? Math.round(avgDur) : null,
      top_skills: topSkills, top_agents: topAgents, top_tools: topTools,
    };
  });
};
