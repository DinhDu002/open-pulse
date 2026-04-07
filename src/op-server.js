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
  queryInstinctsFiltered,
  getInstinct,
  getInstinctStats,
  getInstinctSuggestions,
  updateInstinct,
  deleteInstinct,
  getProjectSummary,
  getProjectTimeline,
  queryLearningActivity,
  queryLearningRecent,
  upsertComponent,
  deleteComponentsNotSeenSince,
  getComponentsByType,
  getAllComponents,
  getKgStatus, getKgGraph, getKgNodeDetail,
} = require('./op-db');
const { syncGraph } = require('./op-knowledge-graph');
const { generateAllVaults } = require('./op-vault-generator');
const { ingestAll } = require('./op-ingest');
const { findInstinctFile, updateConfidence, archiveInstinct } = require('./op-instinct-updater');
const { runRetention } = require('./op-retention');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Paths (environment-configurable with sensible defaults)
// ---------------------------------------------------------------------------

const REPO_DIR   = process.env.OPEN_PULSE_DIR       || path.join(__dirname, '..');
const CLAUDE_DIR = process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DB_PATH    = process.env.OPEN_PULSE_DB         || path.join(REPO_DIR, 'open-pulse.db');
const CONFIG_PATH = path.join(REPO_DIR, 'config.json');

let componentETag = '';

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

function parseQualifiedName(name) {
  const idx = name.indexOf(':');
  if (idx === -1) return { plugin: null, shortName: name };
  return { plugin: name.substring(0, idx), shortName: name.substring(idx + 1) };
}

function getInstalledPlugins() {
  const jsonPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return Object.entries(data.plugins || {}).map(([key, installs]) => {
      const projects = [];
      for (const inst of installs) {
        if (inst.scope === 'user') {
          if (!projects.includes('global')) projects.push('global');
        } else if (inst.projectPath) {
          const name = path.basename(inst.projectPath);
          if (!projects.includes(name)) projects.push(name);
        }
      }
      return {
        plugin: key.split('@')[0],
        installPath: installs[0].installPath,
        projects: projects.length ? projects : ['global'],
      };
    });
  } catch {
    return [];
  }
}

function getKnownProjectPaths() {
  const plugins = getInstalledPlugins();
  const paths = new Set();
  const jsonPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const installs of Object.values(data.plugins || {})) {
      for (const inst of installs) {
        if (inst.projectPath) paths.add(inst.projectPath);
      }
    }
  } catch { /* ignore */ }
  return [...paths];
}

function getPluginComponents(type) {
  const plugins = getInstalledPlugins();
  const items = [];
  for (const { plugin, installPath, projects } of plugins) {
    try {
      if (type === 'agents') {
        const dir = path.join(installPath, 'agents');
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const name = f.replace(/\.md$/, '');
          items.push({ qualifiedName: `${plugin}:${name}`, plugin, projects, filePath: path.join(dir, f) });
        }
      } else if (type === 'skills') {
        const dir = path.join(installPath, 'skills');
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const skillFile = path.join(dir, e.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            items.push({ qualifiedName: `${plugin}:${e.name}`, plugin, projects, filePath: skillFile });
          }
        }
      }
    } catch { /* plugin dir may not have agents/ or skills/ */ }
  }
  return items;
}

function getProjectAgents() {
  const projectPaths = getKnownProjectPaths();
  const items = [];
  for (const projPath of projectPaths) {
    const agentsDir = path.join(projPath, '.claude', 'agents');
    try {
      for (const f of fs.readdirSync(agentsDir)) {
        if (!f.endsWith('.md')) continue;
        const name = f.replace(/\.md$/, '');
        items.push({
          name,
          project: path.basename(projPath),
          filePath: path.join(agentsDir, f),
        });
      }
    } catch { /* no .claude/agents/ in this project */ }
  }
  return items;
}

function readItemMetaFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseFrontmatter(content);
    return { description: meta.description || '', origin: meta.origin || 'custom' };
  } catch {
    return { description: '', origin: 'custom' };
  }
}

function readItemMeta(type, name) {
  let filePath;
  if (type === 'skills') {
    filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  } else {
    filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
  }
  return readItemMetaFromFile(filePath);
}

function getKnownSkills() {
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
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

function parseHooksFromSettings(settingsPath, project) {
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
            project,
          });
        }
      }
    }
  } catch { /* no settings.json or invalid */ }
  return results;
}

function getKnownHooks() {
  const results = parseHooksFromSettings(path.join(CLAUDE_DIR, 'settings.json'), 'global');
  for (const projPath of getKnownProjectPaths()) {
    const projSettings = path.join(projPath, '.claude', 'settings.json');
    results.push(...parseHooksFromSettings(projSettings, path.basename(projPath)));
  }
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
            instinct_id: meta.id || file.replace(/\.(md|yaml)$/, ''),
            project_id: meta.project_id || (scope === 'global' ? '' : projectId),
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
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'personal'), 'global', '');
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'inherited'), 'global', '');

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
// Component sync: filesystem → components table
// ---------------------------------------------------------------------------

let _syncDb = null;

function syncComponentsWithDb(db) {
  const now = new Date().toISOString();
  const diskItems = [];

  // Global skills
  for (const name of getKnownSkills()) {
    const filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'skill', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global agents
  for (const name of getKnownAgents()) {
    const filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'agent', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global rules
  for (const name of getKnownRules()) {
    const filePath = path.join(CLAUDE_DIR, 'rules', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'rule', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Hooks (global + project)
  for (const hook of getKnownHooks()) {
    const isProject = hook.project && hook.project !== 'global';
    diskItems.push({
      type: 'hook', name: hook.name, source: isProject ? 'project' : 'global',
      plugin: null, project: hook.project || null,
      file_path: null, description: null, agent_class: null,
      hook_event: hook.event, hook_matcher: hook.matcher, hook_command: hook.command,
    });
  }

  // Plugin components (skills + agents)
  for (const pItem of getPluginComponents('skills')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'skill', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }
  for (const pItem of getPluginComponents('agents')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'agent', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Project agents
  for (const projAgent of getProjectAgents()) {
    const meta = readItemMetaFromFile(projAgent.filePath);
    diskItems.push({
      type: 'agent', name: projAgent.name, source: 'project',
      plugin: null, project: projAgent.project,
      file_path: projAgent.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // UPSERT all disk items + DELETE stale items — atomically
  const syncTx = db.transaction(() => {
    for (const item of diskItems) {
      upsertComponent(db, { ...item, first_seen_at: now, last_seen_at: now });
    }
    deleteComponentsNotSeenSince(db, now);
  });
  syncTx();

  // COMPUTE ETag
  const stats = db.prepare(
    'SELECT COUNT(*) AS cnt, MAX(last_seen_at) AS latest FROM components'
  ).get();
  componentETag = crypto
    .createHash('md5')
    .update(`${stats.cnt}:${stats.latest || ''}`)
    .digest('hex');
}

function syncComponents() {
  if (_syncDb) syncComponentsWithDb(_syncDb);
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

  const usedSkillNames = [...usedSkills];
  const unusedSkills = skills.filter(s =>
    !usedSkills.has(s) && !usedSkillNames.some(u => u.startsWith(s + ':'))
  );
  const unusedAgents = agents.filter(a => !usedAgents.has(a));

  const issues = [];
  for (const s of unusedSkills) {
    issues.push({ severity: 'low', message: `Unused skill: ${s}` });
  }
  for (const a of unusedAgents) {
    issues.push({ severity: 'low', message: `Unused agent: ${a}` });
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
    if (issue.severity in issuesBySeverity) issuesBySeverity[issue.severity]++;
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
  _syncDb = db;
  try { syncComponentsWithDb(db); } catch { /* non-critical */ }

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
      try { syncComponentsWithDb(db); } catch { /* non-critical */ }
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
