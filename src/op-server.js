'use strict';

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');

const { createDb } = require('./op-db');
const { syncGraph } = require('./op-knowledge-graph');
const { generateAllVaults } = require('./op-vault-generator');
const { ingestAll } = require('./op-ingest');
const { runRetention } = require('./op-retention');
const { parseQualifiedName } = require('./op-helpers');
const { syncInstincts, runAutoEvolve } = require('./op-auto-evolve');
const {
  syncAll,
  syncComponentsWithDb,
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

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    reply.code(500).send({ error: 'Internal server error' });
  });

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

    // Auto-evolve timer: sync instincts + auto-promote
    if (config.auto_evolve_enabled !== false) {
      const instinctDir = path.join(REPO_DIR, 'cl', 'instincts');
      const logDir = path.join(REPO_DIR, 'logs');
      timers.push(setInterval(() => {
        try {
          syncInstincts(db, instinctDir, config.auto_evolve_blacklist || ['agent', 'hook']);
          runAutoEvolve(db, {
            min_confidence: config.auto_evolve_min_confidence || 0.85,
            blacklist: config.auto_evolve_blacklist || ['agent', 'hook'],
            logDir,
          });
        } catch { /* non-critical */ }
      }, config.cl_sync_interval_ms || 60000));
    }

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

    // Daily review: handled by external script (launchd 3 AM daily)
    // Manual trigger available via POST /api/daily-reviews/run

    // Knowledge graph sync timer (skip if no new events)
    let _lastKgEventCount = 0;
    timers.push(setInterval(() => {
      try {
        const currentCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
        if (currentCount === _lastKgEventCount) return;
        syncGraph(db, {
          sessionLookbackDays: config.knowledge_session_lookback_days ?? 30,
          instinctMinConfidence: config.knowledge_instinct_min_confidence ?? 0.3,
          minTriggerCount: config.knowledge_pattern_min_occurrences ?? 5,
        });
        _lastKgEventCount = currentCount;
      } catch { /* non-critical */ }
    }, config.knowledge_graph_interval_ms || 300000));

    // Vault generation timer
    timers.push(setInterval(() => {
      try { generateAllVaults(db); } catch { /* non-critical */ }
    }, config.knowledge_vault_interval_ms || 900000));
  }

  // Create opts object to pass to all route plugins
  const routeOpts = {
    db,
    helpers: require('./op-helpers'),
    dbPath: DB_PATH,
    repoDir: REPO_DIR,
    config,
    componentETagFn: () => componentETag,
  };

  // Register route plugins
  app.register(require('./routes/core'), routeOpts);
  app.register(require('./routes/inventory'), routeOpts);
  app.register(require('./routes/knowledge'), routeOpts);
  app.register(require('./routes/auto-evolves'), routeOpts);
  app.register(require('./routes/daily-reviews'), routeOpts);

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
