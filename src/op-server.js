'use strict';

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');

const {
  createDb,
  querySuggestions,
  updateSuggestionVi,
  updateSuggestionStatus,
  insertScanResult,
  getLatestScan,
  getScanHistory,
  upsertClProject,
  upsertInstinct,
  queryInstinctsFiltered,
  getInstinct,
  getInstinctStats,
  getInstinctSuggestions,
  updateInstinct,
  updateInstinctVi,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  deleteProject,
  queryLearningActivity,
  queryLearningRecent,
  upsertComponent,
  deleteComponentsNotSeenSince,
  getComponentsByType,
  getAllComponents,
  getKgStatus, getKgGraph, getKgNodeDetail,
  insertKbNote, updateKbNote, deleteKbNote, getKbNote,
  getKbNoteBySlug, queryKbNotes, getKbNoteBacklinks, getAllKbNoteSlugs,
} = require('./op-db');
const { syncGraph } = require('./op-knowledge-graph');
const { slugify, slugifyUnique, extractBacklinks, syncNoteToDisk, deleteNoteFromDisk, discoverRelevantContent, syncNoteToGraph, removeNoteFromGraph } = require('./op-notes');
const { generateAllVaults } = require('./op-vault-generator');
const { ingestAll } = require('./op-ingest');
const { findInstinctFile, updateConfidence, archiveInstinct } = require('./op-instinct-updater');
const { runRetention } = require('./op-retention');
const { execFile, spawn } = require('child_process');
const {
  CLAUDE_DIR,
  periodToDate,
  parseFrontmatter,
  STOP_WORDS,
  extractKeywordsFromPrompts,
  parseQualifiedName,
  getInstalledPlugins,
  getKnownProjectPaths,
  getPluginComponents,
  getProjectAgents,
  readItemMetaFromFile,
  readItemMeta,
  getKnownSkills,
  getKnownAgents,
  getKnownRules,
  parseHooksFromSettings,
  getKnownHooks,
  isGitRepo,
} = require('./op-helpers');
const {
  syncAll,
  syncComponentsWithDb,
  runScan,
} = require('./op-sync');

// ---------------------------------------------------------------------------
// Paths (environment-configurable with sensible defaults)
// ---------------------------------------------------------------------------

const REPO_DIR   = process.env.OPEN_PULSE_DIR       || path.join(__dirname, '..');
const DB_PATH    = process.env.OPEN_PULSE_DB         || path.join(REPO_DIR, 'open-pulse.db');
const CONFIG_PATH = path.join(REPO_DIR, 'config.json');

let componentETag = '';
let _syncDb = null;

function syncComponents() {
  if (_syncDb) componentETag = syncComponentsWithDb(_syncDb);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: 3827,
  ingest_interval_ms: 10000,
  cl_sync_interval_ms: 60000,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// buildApp
// ---------------------------------------------------------------------------

function buildApp(opts = {}) {
  const { disableTimers = false } = opts;

  const db = createDb(DB_PATH);
  const config = loadConfig();

  // Initial sync
  syncAll(db);
  _syncDb = db;
  try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }

  const app = Fastify({ logger: false });

  // Static file serving
  const publicDir = path.join(REPO_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
  }

  // Ingestion + CL sync timers
  const timers = [];
  if (!disableTimers) {
    const dataDir = path.join(REPO_DIR, 'data');
    timers.push(setInterval(() => {
      try { ingestAll(db, dataDir); } catch { /* non-critical */ }
    }, config.ingest_interval_ms || 10000));

    timers.push(setInterval(() => {
      syncAll(db);
      try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }
    }, config.cl_sync_interval_ms || 60000));

    // Retention: run once on startup, then daily
    const retentionOpts = {
      warmDays: config.retention_warm_days ?? 7,
      coldDays: config.retention_cold_days ?? 90,
    };
    try { runRetention(db, retentionOpts); } catch { /* non-critical */ }
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    timers.push(setInterval(() => {
      try { runRetention(db, retentionOpts); } catch { /* non-critical */ }
    }, ONE_DAY_MS));

    // Suggestion analysis: handled by external agent script (launchd 3 AM daily)
    // Manual trigger available via POST /api/suggestions/analyze

    // Knowledge graph sync timer
    timers.push(setInterval(() => {
      try {
        syncGraph(db, {
          sessionLookbackDays: config.knowledge_session_lookback_days ?? 30,
          instinctMinConfidence: config.knowledge_instinct_min_confidence ?? 0.3,
          minTriggerCount: config.knowledge_pattern_min_occurrences ?? 5,
        });
      } catch { /* non-critical */ }
    }, config.knowledge_graph_interval_ms || 300000));

    // Vault generation timer
    timers.push(setInterval(() => {
      try { generateAllVaults(db); } catch { /* non-critical */ }
    }, config.knowledge_vault_interval_ms || 900000));
  }

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/api/health', async () => {
    const total_events = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    let db_size_bytes = 0;
    try { db_size_bytes = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
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

  // ── Inventory ───────────────────────────────────────────────────────────

  app.get('/api/inventory/:type', async (request, reply) => {
    const { type } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);

    // ETag check (includes period so different periods don't share cache)
    const requestETag = `${componentETag}:${period || 'all'}`;
    if (request.headers['if-none-match'] === `"${requestETag}"`) {
      reply.code(304);
      return;
    }

    const singularType = type.replace(/s$/, '');
    const validTypes = ['skill', 'agent', 'hook', 'rule'];
    if (!validTypes.includes(singularType)) {
      return { error: 'Invalid type. Use skills, agents, hooks, or rules.' };
    }

    const components = getComponentsByType(db, singularType);

    if (singularType === 'hook') {
      reply.header('etag', `"${requestETag}"`);
      return components.map(c => ({
        name: c.name,
        event: c.hook_event,
        matcher: c.hook_matcher,
        command: c.hook_command,
        project: c.project || 'global',
      }));
    }

    if (singularType === 'rule') {
      reply.header('etag', `"${requestETag}"`);
      return components.map(c => ({
        name: c.name,
        type: 'rule',
        project: c.project || 'global',
      }));
    }

    // Skills and agents: join with events for usage counts
    const eventTypeMap = { skill: 'skill_invoke', agent: 'agent_spawn' };
    const eventType = eventTypeMap[singularType];

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const usageRows = db.prepare(
      `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
       FROM events ${where} GROUP BY name`
    ).all({ eventType, since: since || undefined });

    const usageMap = new Map(usageRows.map(r => [r.name, r]));

    const items = components.map(c => {
      const usage = usageMap.get(c.name) || { count: 0, last_used: null };
      const item = {
        name: c.name,
        count: usage.count,
        last_used: usage.last_used,
        status: usage.count > 0 ? 'active' : 'unused',
        origin: 'custom',
        plugin: c.plugin || null,
        project: c.project || 'global',
      };
      if (singularType === 'agent') {
        item.agent_class = c.agent_class || 'built-in';
      }
      return item;
    });

    // Also include "built-in" agents from events that aren't on disk
    if (singularType === 'agent') {
      const knownNames = new Set(components.map(c => c.name));
      for (const [name, usage] of usageMap) {
        if (!knownNames.has(name)) {
          items.push({
            name,
            count: usage.count,
            last_used: usage.last_used,
            status: 'active',
            origin: 'custom',
            plugin: parseQualifiedName(name).plugin,
            project: 'global',
            agent_class: 'built-in',
          });
        }
      }
    }

    items.sort((a, b) => b.count - a.count);
    reply.header('etag', `"${requestETag}"`);
    return items;
  });

  app.get('/api/inventory/:type/:name', async (request) => {
    const { type, name } = request.params;
    const { period, page: pageStr, per_page: perPageStr } = request.query;
    const since = periodToDate(period);
    const page = Math.max(1, parseInt(pageStr) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(perPageStr) || 10));

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return { error: 'Invalid type' };

    const singularType = type.replace(/s$/, '');
    const comp = db.prepare(
      'SELECT * FROM components WHERE type = ? AND name = ?'
    ).get(singularType, name);
    const meta = comp
      ? { description: comp.description || '', origin: 'custom' }
      : readItemMeta(type, name);

    const conditions = ['event_type = @eventType', 'name = @name'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const allInvocations = db.prepare(
      `SELECT timestamp, detail, session_id, duration_ms, user_prompt FROM events ${where} ORDER BY timestamp DESC`
    ).all({ eventType, name, since: since || undefined });

    // Enrich each invocation with trigger source (nearest preceding skill/agent in same session)
    const triggerStmt = db.prepare(`
      SELECT name, event_type FROM events
      WHERE session_id = @sessionId
        AND event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp < @timestamp
        AND name != @currentName
      ORDER BY timestamp DESC LIMIT 1
    `);

    // Find what each invocation subsequently triggers
    const triggersStmt = db.prepare(`
      SELECT name, event_type FROM events
      WHERE session_id = @sessionId
        AND event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp > @timestamp
        AND name != @currentName
      ORDER BY timestamp ASC LIMIT 1
    `);

    const triggerCounts = new Map();

    for (const inv of allInvocations) {
      const trigger = triggerStmt.get({
        sessionId: inv.session_id,
        timestamp: inv.timestamp,
        currentName: name,
      });
      inv.triggered_by = trigger
        ? { name: trigger.name, type: trigger.event_type }
        : null;

      const triggered = triggersStmt.get({
        sessionId: inv.session_id,
        timestamp: inv.timestamp,
        currentName: name,
      });
      if (triggered) {
        const key = `${triggered.event_type}:${triggered.name}`;
        if (!triggerCounts.has(key)) {
          triggerCounts.set(key, { name: triggered.name, event_type: triggered.event_type, count: 0 });
        }
        triggerCounts.get(key).count++;
      }
    }

    const total = allInvocations.length;
    const invocations = allInvocations.slice((page - 1) * perPage, page * perPage);

    return {
      name,
      description: meta.description,
      origin: meta.origin,
      keywords: extractKeywordsFromPrompts(allInvocations),
      invocations,
      triggers: [...triggerCounts.values()],
      total,
      page,
      per_page: perPage,
    };
  });

  // ── Rules ───────────────────────────────────────────────────────────────

  app.get('/api/rules', async () => {
    return db.prepare(
      'SELECT rules_loaded, COUNT(*) as count FROM sessions WHERE rules_loaded IS NOT NULL GROUP BY rules_loaded ORDER BY count DESC'
    ).all();
  });

  // ── Unused ──────────────────────────────────────────────────────────────

  app.get('/api/unused', async () => {
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

    return { unused_skills, unused_agents, unused_rules };
  });

  // ── Errors ──────────────────────────────────────────────────────────────

  app.get('/api/errors', async (request) => {
    const { limit = 50 } = request.query;
    return db.prepare('SELECT * FROM collector_errors ORDER BY occurred_at DESC LIMIT ?').all(parseInt(limit, 10));
  });

  // ── Instincts ───────────────────────────────────────────────────────────

  app.get('/api/instincts', async (request) => {
    const { domain, source, project, confidence_min, confidence_max, search, sort, page, per_page } = request.query;
    return queryInstinctsFiltered(db, {
      domain, source, project,
      confidence_min: confidence_min != null ? parseFloat(confidence_min) : undefined,
      confidence_max: confidence_max != null ? parseFloat(confidence_max) : undefined,
      search, sort,
      page: Math.max(1, parseInt(page) || 1),
      perPage: Math.min(50, Math.max(1, parseInt(per_page) || 20)),
    });
  });

  app.get('/api/instincts/stats', async () => {
    return getInstinctStats(db);
  });

  app.get('/api/instincts/projects', async () => {
    const rows = db.prepare(`
      SELECT p.project_id AS id, p.name, p.directory, p.last_seen_at AS last_seen,
        (SELECT COUNT(*) FROM cl_instincts i WHERE i.project_id = p.project_id) AS instincts
      FROM cl_projects p
      ORDER BY p.last_seen_at DESC
    `).all();

    const projects = rows.map(row => {
      let observer_running = false;
      try {
        const pidFile = path.join(REPO_DIR, 'projects', row.id, '.observer.pid');
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid > 1) {
          try { process.kill(pid, 0); observer_running = true; } catch { /* not running */ }
        }
      } catch { /* no pid file */ }
      return { ...row, observer_running };
    });

    for (const proj of projects) {
      const counts = db.prepare(`
        SELECT s.status, COUNT(*) AS cnt FROM suggestions s
        JOIN cl_instincts i ON s.instinct_id = i.instinct_id
        WHERE i.project_id = ?
        GROUP BY s.status
      `).all(proj.id);
      proj.approved = counts.find(c => c.status === 'approved')?.cnt || 0;
      proj.dismissed = counts.find(c => c.status === 'dismissed')?.cnt || 0;
      proj.pending = counts.find(c => c.status === 'pending')?.cnt || 0;
      const total = proj.approved + proj.dismissed;
      proj.approve_rate = total > 0 ? proj.approved / total : null;
    }

    return projects;
  });

  app.post('/api/instincts/sync', async () => {
    syncAll(db);
    const instincts = db.prepare('SELECT COUNT(*) AS cnt FROM cl_instincts').get();
    const projects = db.prepare('SELECT COUNT(*) AS cnt FROM cl_projects').get();
    return { synced: true, instincts: instincts.cnt, projects: projects.cnt };
  });

  app.get('/api/instincts/observer', async (request) => {
    const { project, lines = 30 } = request.query;
    if (!project) return { error: 'project parameter required' };

    const logPath = path.join(REPO_DIR, 'projects', project, 'observer.log');
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const allLines = content.trim().split('\n');
      const n = Math.min(parseInt(lines, 10), allLines.length);
      return { log: allLines.slice(-n) };
    } catch {
      return { log: [] };
    }
  });

  app.get('/api/instincts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = getInstinct(db, id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    return inst;
  });

  app.get('/api/instincts/:id/suggestions', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    return getInstinctSuggestions(db, id);
  });

  app.put('/api/instincts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const { confidence } = request.body || {};
    if (confidence == null || typeof confidence !== 'number') {
      return reply.code(400).send({ error: 'confidence (number) required' });
    }
    updateInstinct(db, id, { confidence });
    return { success: true, id };
  });

  app.delete('/api/instincts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    deleteInstinct(db, id);
    return { success: true, id };
  });

  app.put('/api/instincts/:id/validate', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = db.prepare('SELECT instinct_id FROM cl_instincts WHERE id = ?').get(id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    const filePath = findInstinctFile(REPO_DIR, inst.instinct_id);
    if (!filePath) return reply.code(404).send({ error: 'instinct file not found on disk' });
    try {
      const result = updateConfidence(filePath, +0.15);
      db.prepare('UPDATE cl_instincts SET confidence = ? WHERE id = ?').run(result.confidence, id);
      return { success: true, id, confidence: result.confidence };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update: ' + err.message });
    }
  });

  app.put('/api/instincts/:id/reject', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = db.prepare('SELECT instinct_id FROM cl_instincts WHERE id = ?').get(id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    const filePath = findInstinctFile(REPO_DIR, inst.instinct_id);
    if (!filePath) return reply.code(404).send({ error: 'instinct file not found on disk' });
    try {
      const result = updateConfidence(filePath, -0.2);
      let archived = false;
      if (result.dismiss_count >= 3) {
        archiveInstinct(filePath);
        archived = true;
        db.prepare('DELETE FROM cl_instincts WHERE id = ?').run(id);
      } else {
        db.prepare('UPDATE cl_instincts SET confidence = ? WHERE id = ?').run(result.confidence, id);
      }
      return { success: true, id, confidence: result.confidence, dismiss_count: result.dismiss_count, archived };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update: ' + err.message });
    }
  });

  // ── Translate instinct to Vietnamese ─────────────────────────────────────

  app.post('/api/instincts/:id/translate', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = getInstinct(db, id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    if (inst.instinct_vi) return { instinct_vi: inst.instinct_vi };
    if (!inst.instinct) return reply.code(400).send({ error: 'no instinct content to translate' });

    const prompt = 'Dịch toàn bộ đoạn văn bản sau sang tiếng Việt, bao gồm cả tiêu đề (## Action → ## Hành động, ## Evidence → ## Bằng chứng, v.v.). ' +
      'Chỉ giữ nguyên: tên file, tên tool, code snippet, command. ' +
      'Chỉ trả về bản dịch, không thêm giải thích.\n\n' + inst.instinct;

    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code !== 0) {
          request.log.error({ code, stderr }, 'translate failed');
          return resolve(reply.code(500).send({ error: 'Translation failed (exit ' + code + ')' }));
        }
        const translated = stdout.trim();
        if (!translated) {
          return resolve(reply.code(500).send({ error: 'Empty translation result' }));
        }
        updateInstinctVi(db, id, translated);
        resolve({ instinct_vi: translated });
      });
      child.on('error', (err) => {
        request.log.error({ err }, 'translate spawn error');
        resolve(reply.code(500).send({ error: 'Translation failed: ' + err.message }));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  });

  // ── Projects ─────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/summary', async (request, reply) => {
    const summary = getProjectSummary(db, request.params.id);
    if (!summary) return reply.code(404).send({ error: 'Project not found' });
    return summary;
  });

  app.get('/api/projects/:id/timeline', async (request) => {
    const weeks = Math.max(1, parseInt(request.query.weeks) || 8);
    return getProjectTimeline(db, request.params.id, weeks);
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const projectId = request.params.id;

    const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    // Refuse if observer is running
    let observerRunning = false;
    try {
      const pidFile = path.join(REPO_DIR, 'projects', projectId, '.observer.pid');
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid > 1) {
        try { process.kill(pid, 0); observerRunning = true; } catch { /* not running */ }
      }
    } catch { /* no pid file */ }

    if (observerRunning) {
      return reply.code(409).send({ error: 'Observer is running. Stop it before deleting.' });
    }

    // DB deletion (transactional)
    deleteProject(db, projectId);

    // Filesystem cleanup
    const clProjectDir = path.join(REPO_DIR, 'cl', 'projects', projectId);
    try { fs.rmSync(clProjectDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    const projectDir = path.join(REPO_DIR, 'projects', projectId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    // Remove from projects.json
    const registryPath = path.join(REPO_DIR, 'projects.json');
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      delete registry[projectId];
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    } catch { /* registry may not exist */ }

    return { deleted: true, project_id: projectId };
  });

  // ── Learning ──────────────────────────────────────────────────────────────

  app.get('/api/learning/activity', async (request) => {
    const days = Math.max(1, parseInt(request.query.days) || 7);
    return queryLearningActivity(db, days);
  });

  app.get('/api/learning/recent', async (request) => {
    const limit = Math.min(20, Math.max(1, parseInt(request.query.limit) || 5));
    return queryLearningRecent(db, limit);
  });

  // ── Suggestions ─────────────────────────────────────────────────────────

  app.get('/api/suggestions', async (request) => {
    const { status, category } = request.query;
    return querySuggestions(db, status || null, category || null);
  });

  app.post('/api/suggestions/analyze', async (request, reply) => {
    const config = loadConfig();
    const agentScript = path.join(REPO_DIR, 'scripts', 'op-suggestion-agent.js');
    const timeout = config.suggestion_agent_timeout_ms || 180000;

    return new Promise((resolve) => {
      execFile(process.execPath, [agentScript], {
        cwd: REPO_DIR,
        timeout,
        env: { ...process.env, OPEN_PULSE_DIR: REPO_DIR, OP_SKIP_COLLECT: '1' },
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          reply.code(500);
          resolve({ error: 'Suggestion agent failed', detail: (stderr || error.message).slice(-500) });
        } else {
          try { resolve(JSON.parse(stdout)); }
          catch { resolve({ generated: 0, raw: stdout.slice(0, 500) }); }
        }
      });
    });
  });

  app.put('/api/suggestions/:id/approve', async (request) => {
    const { id } = request.params;
    updateSuggestionStatus(db, id, 'approved', 'user');
    return { success: true, id, status: 'approved' };
  });

  app.put('/api/suggestions/:id/dismiss', async (request) => {
    const { id } = request.params;
    updateSuggestionStatus(db, id, 'dismissed', 'user');
    return { success: true, id, status: 'dismissed' };
  });

  app.post('/api/suggestions/:id/translate', async (request, reply) => {
    const { id } = request.params;
    const all = querySuggestions(db, null, null);
    const sug = all.find(s => s.id === id);
    if (!sug) return reply.code(404).send({ error: 'not found' });
    if (sug.description_vi) return { description_vi: sug.description_vi };
    if (!sug.description) return reply.code(400).send({ error: 'no description to translate' });

    const prompt =
      'Giải thích đề xuất sau bằng tiếng Việt theo đúng format 3 dòng:\n' +
      'Nghĩa là gì: [giải thích ngắn gọn đề xuất này nói gì]\n' +
      'Vấn đề: [tại sao cần quan tâm — rủi ro hoặc cơ hội bị bỏ lỡ]\n' +
      'Cách xử lý: [hành động cụ thể nên làm]\n\n' +
      'Chỉ trả về 3 dòng trên, không thêm giải thích. Dùng đầy đủ dấu tiếng Việt.\n\n' +
      'Description: ' + sug.description + '\n' +
      'Category: ' + sug.category + '\n' +
      'Type: ' + sug.type + '\n' +
      (sug.action_data ? 'Action data: ' + sug.action_data + '\n' : '');

    return new Promise((resolve) => {
      const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code !== 0) {
          request.log.error({ code, stderr }, 'suggestion translate failed');
          return resolve(reply.code(500).send({ error: 'Translation failed (exit ' + code + ')' }));
        }
        const translated = stdout.trim();
        if (!translated) {
          return resolve(reply.code(500).send({ error: 'Empty translation result' }));
        }
        updateSuggestionVi(db, id, translated);
        resolve({ description_vi: translated });
      });
      child.on('error', (err) => {
        request.log.error({ err }, 'suggestion translate spawn error');
        resolve(reply.code(500).send({ error: 'Translation failed: ' + err.message }));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
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
    const dataDir = path.join(REPO_DIR, 'data');
    try {
      const results = ingestAll(db, dataDir);
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Knowledge Graph API ---

  app.get('/api/knowledge/status', async () => {
    return getKgStatus(db);
  });

  app.get('/api/knowledge/projects', async () => {
    const projects = db.prepare('SELECT * FROM cl_projects').all();
    return projects.map(p => {
      const vaultCount = db.prepare(
        'SELECT COUNT(*) AS c FROM kg_vault_hashes WHERE project_id = ?'
      ).get(p.project_id).c;
      return { ...p, vault_file_count: vaultCount };
    });
  });

  app.get('/api/knowledge/graph', async (request) => {
    const { type } = request.query;
    return getKgGraph(db, { type });
  });

  app.get('/api/knowledge/node/:id', async (request) => {
    const { id } = request.params;
    const decoded = decodeURIComponent(id);
    const detail = getKgNodeDetail(db, decoded);
    if (!detail) return { error: 'Node not found' };
    return detail;
  });

  app.post('/api/knowledge/sync', async () => {
    const result = syncGraph(db, {
      sessionLookbackDays: config.knowledge_session_lookback_days ?? 30,
      instinctMinConfidence: config.knowledge_instinct_min_confidence ?? 0.3,
      minTriggerCount: config.knowledge_pattern_min_occurrences ?? 5,
    });
    return result;
  });

  app.post('/api/knowledge/generate', async (request) => {
    const { project } = request.query || {};
    if (project) {
      const { generateVault } = require('./op-vault-generator');
      return generateVault(db, project);
    }
    return generateAllVaults(db);
  });

  app.post('/api/knowledge/enrich', async () => {
    try {
      const { enrichNodes } = require('./op-knowledge-enricher');
      const result = await enrichNodes(db, {});
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  app.get('/api/knowledge/config', async () => {
    return {
      knowledge_graph_interval_ms: config.knowledge_graph_interval_ms ?? 300000,
      knowledge_vault_interval_ms: config.knowledge_vault_interval_ms ?? 900000,
      knowledge_enrich_enabled: config.knowledge_enrich_enabled ?? false,
      knowledge_pattern_min_occurrences: config.knowledge_pattern_min_occurrences ?? 5,
      knowledge_session_lookback_days: config.knowledge_session_lookback_days ?? 30,
      knowledge_instinct_min_confidence: config.knowledge_instinct_min_confidence ?? 0.3,
    };
  });

  // ── Knowledge Base Notes ────────────────────────────────────────────────

  app.get('/api/knowledge/notes', async (req) => {
    const { project, search, tag, page, per_page } = req.query;
    return queryKbNotes(db, {
      projectId: project || undefined,
      search: search || undefined,
      tag: tag || undefined,
      page: parseInt(page) || 1,
      perPage: parseInt(per_page) || 20,
    });
  });

  app.get('/api/knowledge/notes/:id', async (req) => {
    const note = getKbNote(db, req.params.id);
    if (!note) return { error: 'Not found' };
    const backlinks = getKbNoteBacklinks(db, note.project_id, note.slug);
    const refs = extractBacklinks(note.body);
    return { ...note, backlinks, references: refs };
  });

  app.post('/api/knowledge/notes', async (req) => {
    const { project_id, title, body, tags } = req.body;
    if (!project_id || !title) return { error: 'project_id and title required' };
    const existingSlugs = getAllKbNoteSlugs(db, project_id);
    const slug = slugifyUnique(title, existingSlugs);
    const id = `note:${crypto.randomUUID()}`;
    const tagsJson = typeof tags === 'string' ? tags : JSON.stringify(tags || []);
    insertKbNote(db, { id, project_id, slug, title, body: body || '', tags: tagsJson });
    const note = getKbNote(db, id);
    // Sync to disk + graph
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(project_id);
    if (project?.directory) syncNoteToDisk(project.directory, note);
    syncNoteToGraph(db, note);
    return note;
  });

  app.put('/api/knowledge/notes/:id', async (req) => {
    const existing = getKbNote(db, req.params.id);
    if (!existing) return { error: 'Not found' };
    const { title, body, tags } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (body !== undefined) fields.body = body;
    if (tags !== undefined) fields.tags = typeof tags === 'string' ? tags : JSON.stringify(tags);
    if (title !== undefined && title !== existing.title) {
      const existingSlugs = getAllKbNoteSlugs(db, existing.project_id).filter(s => s !== existing.slug);
      fields.slug = slugifyUnique(title, existingSlugs);
      // Remove old disk file
      const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
      if (project?.directory) deleteNoteFromDisk(project.directory, existing.slug);
    }
    updateKbNote(db, req.params.id, fields);
    const updated = getKbNote(db, req.params.id);
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
    if (project?.directory) syncNoteToDisk(project.directory, updated);
    syncNoteToGraph(db, updated);
    return updated;
  });

  app.delete('/api/knowledge/notes/:id', async (req) => {
    const existing = getKbNote(db, req.params.id);
    if (!existing) return { error: 'Not found' };
    deleteKbNote(db, req.params.id);
    const project = db.prepare('SELECT directory FROM cl_projects WHERE project_id = ?').get(existing.project_id);
    if (project?.directory) deleteNoteFromDisk(project.directory, existing.slug);
    removeNoteFromGraph(db, existing.slug);
    return { deleted: true };
  });

  app.get('/api/knowledge/notes/:id/backlinks', async (req) => {
    const note = getKbNote(db, req.params.id);
    if (!note) return { error: 'Not found' };
    return getKbNoteBacklinks(db, note.project_id, note.slug);
  });

  app.get('/api/knowledge/autocomplete', async (req) => {
    const { project, q } = req.query;
    const results = [];
    // Note slugs
    if (project) {
      const slugs = getAllKbNoteSlugs(db, project);
      for (const s of slugs) {
        if (!q || s.includes(q.toLowerCase())) {
          results.push({ type: 'note', value: `notes/${s}`, label: s });
        }
      }
    }
    // Auto-node names from kg_nodes
    const { nodes } = getKgGraph(db);
    for (const n of nodes) {
      if (!q || n.name.toLowerCase().includes(q.toLowerCase()) || n.id.toLowerCase().includes(q.toLowerCase())) {
        const vaultPath = `${n.type}s/${n.name}`;
        results.push({ type: n.type, value: vaultPath, label: n.name });
      }
    }
    return results.slice(0, 20);
  });

  app.get('/api/knowledge/discover', async (req) => {
    const { project, context } = req.query;
    if (!project || !context) return { error: 'project and context required' };
    return discoverRelevantContent(db, project, context);
  });

  // ── Cleanup on close ───────────────────────────────────────────────────

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    db.close();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
  const config = loadConfig();
  const app = buildApp();
  app.listen({ port: config.port || 3827, host: '127.0.0.1' }, (err, address) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Open Pulse running at ${address}`);
  });
}

module.exports = { buildApp, parseQualifiedName, syncComponents };
