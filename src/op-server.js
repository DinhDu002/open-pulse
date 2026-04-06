'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');

const {
  createDb,
  querySuggestions,
  updateSuggestionStatus,
  insertScanResult,
  getLatestScan,
  getScanHistory,
  upsertClProject,
  upsertInstinct,
} = require('./op-db');
const { ingestAll } = require('./op-ingest');
const { createComponent, deleteComponent, previewComponent } = require('./op-actions');

// ---------------------------------------------------------------------------
// Paths (environment-configurable with sensible defaults)
// ---------------------------------------------------------------------------

const REPO_DIR   = process.env.OPEN_PULSE_DIR       || path.join(__dirname, '..');
const CLAUDE_DIR = process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DB_PATH    = process.env.OPEN_PULSE_DB         || path.join(REPO_DIR, 'open-pulse.db');
const CONFIG_PATH = path.join(REPO_DIR, 'config.json');

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
// Helper: period string → ISO date cutoff
// ---------------------------------------------------------------------------

function periodToDate(period) {
  if (!period || period === 'all') return null;
  const match = period.match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Keyword extraction from invocation prompts
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'to','of','in','for','on','with','at','by','from','as','into','through','during',
  'before','after','above','below','between','out','off','over','under','again','further',
  'then','once','here','there','when','where','why','how','all','both','each','few',
  'more','most','other','some','such','no','nor','not','only','own','same','so','than',
  'too','very','just','about','up','it','its','this','that','these','those','i','me',
  'my','we','our','you','your','he','him','his','she','her','they','them','their',
  'what','which','who','whom','and','but','or','if','while','because','until','although',
  'null','true','false','undefined','none',
]);

function extractKeywordsFromPrompts(invocations) {
  const freq = new Map();
  for (const inv of invocations) {
    let text = inv.user_prompt || '';
    if (!text && inv.detail) {
      try {
        const obj = JSON.parse(inv.detail);
        text = obj.args || obj.description || '';
      } catch {
        text = String(inv.detail);
      }
    }
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Filesystem scanners (use CLAUDE_DIR for real components)
// ---------------------------------------------------------------------------

function readItemMeta(type, name) {
  let filePath;
  if (type === 'skills') {
    filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  } else {
    filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseFrontmatter(content);
    return { description: meta.description || '', origin: meta.origin || 'custom' };
  } catch {
    return { description: '', origin: 'custom' };
  }
}

function getKnownSkills() {
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function getKnownAgents() {
  const agentsDir = path.join(CLAUDE_DIR, 'agents');
  try {
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

function getKnownRules() {
  const rulesDir = path.join(CLAUDE_DIR, 'rules');
  const results = [];
  try {
    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(entry.name.replace(/\.md$/, ''));
      }
    }
  } catch { /* ignore */ }
  const commonDir = path.join(rulesDir, 'common');
  try {
    for (const entry of fs.readdirSync(commonDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push('common/' + entry.name.replace(/\.md$/, ''));
      }
    }
  } catch { /* ignore */ }
  return results;
}

function getKnownHooks() {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const results = [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.hooks) return results;
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const matcher = entry.matcher || '';
        const hooks = entry.hooks || [];
        for (const hook of hooks) {
          results.push({
            name: matcher || event,
            event,
            matcher,
            command: hook.command || '',
          });
        }
      }
    }
  } catch { /* no settings.json or invalid */ }
  return results;
}

// ---------------------------------------------------------------------------
// CL sync: filesystem → DB (uses <repo>/cl/ paths)
// ---------------------------------------------------------------------------

function syncProjectsToDb(db) {
  const registryPath = path.join(REPO_DIR, 'projects.json');
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    for (const [id, meta] of Object.entries(registry)) {
      upsertClProject(db, {
        project_id: id,
        name: meta.name || id,
        directory: meta.root || null,
        first_seen_at: meta.created_at || new Date().toISOString(),
        last_seen_at: meta.last_seen || new Date().toISOString(),
        session_count: 0,
      });
    }
  } catch { /* registry not found or invalid */ }
}

function syncInstinctsToDb(db) {
  const syncDir = (dir, scope, projectId) => {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.yaml'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const meta = parseFrontmatter(content);
          const bodyMatch = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1].trim() : content;
          const now = new Date().toISOString();

          upsertInstinct(db, {
            project_id: meta.project_id || (scope === 'global' ? null : projectId),
            category: meta.domain || meta.category || 'unknown',
            pattern: meta.trigger || file.replace(/\.(md|yaml)$/, ''),
            confidence: parseFloat(meta.confidence) || 0.5,
            seen_count: 1,
            first_seen: now,
            last_seen: now,
            instinct: body,
          });
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir not found */ }
  };

  // Global instincts via <repo>/cl/ paths
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'personal'), 'global', null);
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'inherited'), 'global', null);

  // Per-project instincts
  const projectsDir = path.join(REPO_DIR, 'cl', 'projects');
  try {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      syncDir(path.join(projectsDir, entry.name, 'instincts', 'personal'), 'project', entry.name);
      syncDir(path.join(projectsDir, entry.name, 'instincts', 'inherited'), 'project', entry.name);
    }
  } catch { /* projects dir not found */ }
}

function syncAll(db) {
  try {
    syncProjectsToDb(db);
    syncInstinctsToDb(db);
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Scanner: inventory all components, check for unused, produce report
// ---------------------------------------------------------------------------

function runScan(db) {
  const skills = getKnownSkills();
  const agents = getKnownAgents();
  const hooks = getKnownHooks();
  const rules = getKnownRules();

  const usedSkills = new Set(
    db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'skill_invoke'").all().map(r => r.name)
  );
  const usedAgents = new Set(
    db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'agent_spawn'").all().map(r => r.name)
  );

  const unusedSkills = skills.filter(s => !usedSkills.has(s));
  const unusedAgents = agents.filter(a => !usedAgents.has(a));

  const issues = [];
  for (const s of unusedSkills) {
    issues.push({ level: 'low', message: `Unused skill: ${s}` });
  }
  for (const a of unusedAgents) {
    issues.push({ level: 'low', message: `Unused agent: ${a}` });
  }

  const report = {
    scanned_at: new Date().toISOString(),
    total_skills: skills.length,
    total_agents: agents.length,
    total_hooks: hooks.length,
    total_rules: rules.length,
    unused_skills: unusedSkills,
    unused_agents: unusedAgents,
    issues,
  };

  const issuesBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    if (issue.level in issuesBySeverity) issuesBySeverity[issue.level]++;
  }

  insertScanResult(db, {
    scanned_at: report.scanned_at,
    report: JSON.stringify(report),
    total_skills: report.total_skills,
    total_agents: report.total_agents,
    total_hooks: report.total_hooks,
    total_rules: report.total_rules,
    issues_critical: issuesBySeverity.critical,
    issues_high: issuesBySeverity.high,
    issues_medium: issuesBySeverity.medium,
    issues_low: issuesBySeverity.low,
  });

  return report;
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

    timers.push(setInterval(() => syncAll(db), config.cl_sync_interval_ms || 60000));
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

    const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(id)
      .map(ev => ({ ...ev, created_at: ev.timestamp, cost: ev.estimated_cost_usd }));

    return { session, events };
  });

  // ── Inventory ───────────────────────────────────────────────────────────

  app.get('/api/inventory/:type', async (request) => {
    const { type } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);

    if (type === 'hooks') {
      return getKnownHooks();
    }

    if (type === 'rules') {
      return getKnownRules().map(name => ({ name, type: 'rule' }));
    }

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return { error: 'Invalid type. Use skills, agents, hooks, or rules.' };

    const knownItems = type === 'skills' ? getKnownSkills() : getKnownAgents();

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const usageRows = db.prepare(
      `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
       FROM events ${where} GROUP BY name ORDER BY count DESC`
    ).all({ eventType, since: since || undefined });

    const seen = new Set();
    const items = [];

    for (const row of usageRows) {
      seen.add(row.name);
      const meta = readItemMeta(type, row.name);
      items.push({
        name: row.name,
        count: row.count,
        last_used: row.last_used,
        status: 'active',
        origin: meta.origin,
      });
    }

    for (const name of knownItems) {
      if (!seen.has(name)) {
        const meta = readItemMeta(type, name);
        items.push({ name, count: 0, last_used: null, status: 'unused', origin: meta.origin });
      }
    }

    return items;
  });

  app.get('/api/inventory/:type/:name', async (request) => {
    const { type, name } = request.params;
    const { period } = request.query;
    const since = periodToDate(period);

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return { error: 'Invalid type' };

    const meta = readItemMeta(type, name);

    const conditions = ['event_type = @eventType', 'name = @name'];
    if (since) conditions.push('timestamp >= @since');
    const where = 'WHERE ' + conditions.join(' AND ');

    const invocations = db.prepare(
      `SELECT timestamp, detail, session_id, duration_ms, user_prompt FROM events ${where} ORDER BY timestamp DESC`
    ).all({ eventType, name, since: since || undefined });

    return {
      name,
      description: meta.description,
      origin: meta.origin,
      keywords: extractKeywordsFromPrompts(invocations),
      invocations,
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
    const usedSkills = new Set(
      db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'skill_invoke'").all().map(r => r.name)
    );
    const usedAgents = new Set(
      db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'agent_spawn'").all().map(r => r.name)
    );

    return {
      unused_skills: getKnownSkills().filter(s => !usedSkills.has(s)),
      unused_agents: getKnownAgents().filter(a => !usedAgents.has(a)),
      unused_rules: getKnownRules(),
    };
  });

  // ── Errors ──────────────────────────────────────────────────────────────

  app.get('/api/errors', async (request) => {
    const { limit = 50 } = request.query;
    return db.prepare('SELECT * FROM collector_errors ORDER BY occurred_at DESC LIMIT ?').all(parseInt(limit, 10));
  });

  // ── Instincts ───────────────────────────────────────────────────────────

  app.get('/api/instincts', async () => {
    return db.prepare(
      `SELECT id, project_id, category, pattern, confidence, seen_count, first_seen, last_seen, instinct
       FROM cl_instincts ORDER BY project_id, category, confidence DESC`
    ).all();
  });

  app.get('/api/instincts/projects', async () => {
    const rows = db.prepare(`
      SELECT p.project_id AS id, p.name, p.directory, p.last_seen_at AS last_seen,
        (SELECT COUNT(*) FROM cl_observations o WHERE o.project_id = p.project_id) AS observations,
        (SELECT COUNT(*) FROM cl_instincts i WHERE i.project_id = p.project_id) AS instincts
      FROM cl_projects p
      ORDER BY p.last_seen_at DESC
    `).all();

    return rows.map(row => {
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

  // ── Suggestions ─────────────────────────────────────────────────────────

  app.get('/api/suggestions', async (request) => {
    const { status } = request.query;
    return querySuggestions(db, status || null);
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

  // ── Actions ─────────────────────────────────────────────────────────────

  app.post('/api/actions/create-component', async (request) => {
    return createComponent(request.body, CLAUDE_DIR);
  });

  app.delete('/api/actions/delete-component', async (request) => {
    return deleteComponent(request.body, CLAUDE_DIR);
  });

  app.get('/api/actions/preview-component', async (request) => {
    return previewComponent(request.query, CLAUDE_DIR);
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

module.exports = { buildApp };
