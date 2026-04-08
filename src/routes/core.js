'use strict';

const path = require('path');
const fs = require('fs');
const { ingestAll } = require('../op-ingest');
const { runScan, } = require('../op-sync');
const {
  insertScanResult,
  getLatestScan,
  getScanHistory,
} = require('../op-db');
const { parseQualifiedName, getKnownAgents } = require('../op-helpers');

module.exports = async function coreRoutes(app, opts) {
  const { db, helpers, dbPath, repoDir, config } = opts;
  const { periodToDate } = helpers;

  const CONFIG_PATH = path.join(repoDir, 'config.json');

  function loadConfig() {
    const DEFAULT_CONFIG = {
      port: 3827,
      ingest_interval_ms: 10000,
      cl_sync_interval_ms: 60000,
    };
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/api/health', async () => {
    const total_events = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    let db_size_bytes = 0;
    try { db_size_bytes = fs.statSync(dbPath).size; } catch { /* ignore */ }
    return { status: 'ok', db_size_bytes, total_events };
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
    if (!rawSession) return reply.code(404).send({ error: 'Session not found' });

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

  // ── Prompts ─────────────────────────────────────────────────────────────

  app.get('/api/prompts', async (request) => {
    const {
      period = '7d', q, session_id, project,
      page: pageStr, per_page: perPageStr,
    } = request.query;

    const page = Math.max(1, parseInt(pageStr) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(perPageStr) || 20));
    const offset = (page - 1) * perPage;
    const since = periodToDate(period);

    const conditions = [];
    const params = {};

    if (since) { conditions.push('p.timestamp >= @since'); params.since = since; }
    if (q) { conditions.push('p.prompt_text LIKE @q'); params.q = '%' + q + '%'; }
    if (session_id) { conditions.push('p.session_id = @session_id'); params.session_id = session_id; }
    if (project) { conditions.push('s.working_directory LIKE @project'); params.project = '%/' + project; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const total = db.prepare(
      'SELECT COUNT(*) as count FROM prompts p LEFT JOIN sessions s ON s.session_id = p.session_id ' + where
    ).get(params).count;

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
      total_cost_usd: r.total_cost_usd, duration_ms: r.duration_ms,
      project: r.working_directory ? path.basename(r.working_directory) : null,
      event_breakdown: breakdowns[r.id] || {},
    }));

    return { prompts, total, page, per_page: perPage };
  });

  app.get('/api/prompts/:id', async (request, reply) => {
    const { id } = request.params;
    const row = db.prepare(
      'SELECT p.*, s.working_directory FROM prompts p LEFT JOIN sessions s ON s.session_id = p.session_id WHERE p.id = ?'
    ).get(id);

    if (!row) { reply.code(404); return { error: 'Prompt not found' }; }

    const events = db.prepare(
      'SELECT id, timestamp, event_type, name, detail, duration_ms, success, estimated_cost_usd, tool_input, tool_response, seq_num, model FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
    ).all(id);

    return {
      prompt: {
        id: row.id, session_id: row.session_id, prompt_text: row.prompt_text,
        timestamp: row.timestamp, event_count: row.event_count,
        total_cost_usd: row.total_cost_usd, duration_ms: row.duration_ms,
        project: row.working_directory ? path.basename(row.working_directory) : null,
      },
      events,
    };
  });

  // ── Rules ───────────────────────────────────────────────────────────────

  app.get('/api/rules', async (request) => {
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(request.query.per_page) || 50));

    const all = db.prepare(
      'SELECT rules_loaded, COUNT(*) as count FROM sessions WHERE rules_loaded IS NOT NULL GROUP BY rules_loaded ORDER BY count DESC'
    ).all();

    const total = all.length;
    const data = all.slice((page - 1) * perPage, page * perPage);
    return { data, total, page, per_page: perPage };
  });

  // ── Unused ──────────────────────────────────────────────────────────────

  app.get('/api/unused', async (request) => {
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(request.query.per_page) || 50));

    const unused_skills = db.prepare(`
      SELECT c.name FROM components c
      LEFT JOIN events e ON e.name = c.name AND e.event_type = 'skill_invoke'
      WHERE c.type = 'skill'
      GROUP BY c.id
      HAVING COUNT(e.id) = 0
    `).all().map(r => r.name);

    const unused_agents = db.prepare(`
      SELECT c.name FROM components c
      LEFT JOIN events e ON e.name = c.name AND e.event_type = 'agent_spawn'
      WHERE c.type = 'agent'
      GROUP BY c.id
      HAVING COUNT(e.id) = 0
    `).all().map(r => r.name);

    const unused_rules = db.prepare(
      "SELECT name FROM components WHERE type = 'rule'"
    ).all().map(r => r.name);

    const all = [
      ...unused_skills.map(name => ({ type: 'skill', name })),
      ...unused_agents.map(name => ({ type: 'agent', name })),
      ...unused_rules.map(name => ({ type: 'rule', name })),
    ];

    const total = all.length;
    const data = all.slice((page - 1) * perPage, page * perPage);
    return { data, total, page, per_page: perPage };
  });

  // ── Errors ──────────────────────────────────────────────────────────────

  app.get('/api/errors', async (request) => {
    const { limit = 50 } = request.query;
    return db.prepare('SELECT * FROM collector_errors ORDER BY occurred_at DESC LIMIT ?').all(parseInt(limit, 10));
  });

  // ── Scanner ─────────────────────────────────────────────────────────────

  app.post('/api/scanner/run', async () => {
    return runScan(db);
  });

  app.get('/api/scanner/history', async (request) => {
    const { limit = 10 } = request.query;
    return getScanHistory(db, parseInt(limit, 10));
  });

  app.get('/api/scanner/latest', async () => {
    return getLatestScan(db) || null;
  });

  // ── Config ──────────────────────────────────────────────────────────────

  app.get('/api/config', async () => {
    return loadConfig();
  });

  app.put('/api/config', async (request) => {
    const current = loadConfig();
    const merged = { ...current, ...request.body };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  });

  // ── Manual ingest ───────────────────────────────────────────────────────

  app.post('/api/ingest', async () => {
    const dataDir = path.join(repoDir, 'data');
    try {
      const results = ingestAll(db, dataDir);
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
};
