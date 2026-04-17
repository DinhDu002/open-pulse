'use strict';

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');

const { createDb } = require('./db/schema');
const { extractKnowledgeFromPrompt } = require('./knowledge/extract');
const { detectPatternsFromPrompt } = require('./evolve/detect');
const { scorePrompt } = require('./quality/score');
const { generateRetrospective } = require('./quality/review');
const { ingestAll, setKnowledgeHook, setPatternHook, setQualityHook, setReviewHook } = require('./ingest/pipeline');
const { runRetention } = require('./retention');
const { parseQualifiedName } = require('./lib/format');
const { loadConfig } = require('./lib/config');
const { runAutoEvolve } = require('./evolve/promote');
const {
  syncComponentsWithDb,
} = require('./ingest/sync');

// ---------------------------------------------------------------------------
// Paths (environment-configurable with sensible defaults)
// ---------------------------------------------------------------------------

const REPO_DIR   = process.env.OPEN_PULSE_DIR       || path.join(__dirname, '..');
const DB_PATH    = process.env.OPEN_PULSE_DB         || path.join(REPO_DIR, 'open-pulse.db');

let componentETag = '';
let _syncDb = null;

function syncComponents() {
  if (_syncDb) componentETag = syncComponentsWithDb(_syncDb);
}

// ---------------------------------------------------------------------------
// buildApp
// ---------------------------------------------------------------------------

function buildApp(opts = {}) {
  const { disableTimers = false } = opts;

  const db = createDb(DB_PATH);
  const config = loadConfig();

  // Hooks are always registered; runtime enable/disable is gated in pipeline.js
  // via fresh config reads so toggles take effect without restart.
  setKnowledgeHook(extractKnowledgeFromPrompt, {
    maxEvents: config.knowledge_max_events_per_prompt ?? 50,
    model: config.knowledge_extract_model || config.knowledge_model || 'local',
    ollamaModel: config.ollama_model || 'qwen2.5:7b',
    ollamaUrl: config.ollama_url || 'http://localhost:11434',
    ollamaTimeout: config.ollama_timeout_ms || 90000,
  });

  setPatternHook(detectPatternsFromPrompt, {
    model: config.ollama_model || 'qwen2.5:7b',
    url: config.ollama_url || 'http://localhost:11434',
    timeout: config.ollama_timeout_ms || 90000,
  });

  setQualityHook(scorePrompt, {
    model: config.ollama_model || 'qwen2.5:7b',
    url: config.ollama_url || 'http://localhost:11434',
    timeout: config.ollama_timeout_ms || 90000,
    minEvents: config.quality_min_events ?? 3,
  });

  setReviewHook(generateRetrospective, {
    model: config.ollama_model || 'qwen2.5:7b',
    url: config.ollama_url || 'http://localhost:11434',
    timeout: config.ollama_timeout_ms || 90000,
  });

  // Initial sync (components only — projects are auto-registered during ingest)
  _syncDb = db;
  try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, req, reply) => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}:`, err.message);
    reply.code(500).send({ error: err.message || 'Internal server error' });
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
      try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }
    }, config.cl_sync_interval_ms || 60000));

    // Auto-evolve timer: auto-promote patterns (from detect.js/Ollama)
    if (config.auto_evolve_enabled !== false) {
      const logDir = path.join(REPO_DIR, 'logs');
      timers.push(setInterval(() => {
        try {
          runAutoEvolve(db, {
            min_confidence: config.auto_evolve_min_confidence || 0.85,
            blacklist: config.auto_evolve_blacklist || ['hook'],
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

  }

  // Create opts object to pass to all route plugins
  const routeOpts = {
    db,
    helpers: require('./lib/format'),
    dbPath: DB_PATH,
    repoDir: REPO_DIR,
    config,
    componentETagFn: () => componentETag,
    syncFn: syncComponents,
  };

  // Register route plugins
  app.register(require('./routes/health'), routeOpts);
  app.register(require('./routes/events'), routeOpts);
  app.register(require('./routes/prompts'), routeOpts);
  app.register(require('./routes/cost'), routeOpts);
  app.register(require('./routes/projects'), routeOpts);
  app.register(require('./routes/scanner'), routeOpts);
  app.register(require('./routes/config'), routeOpts);
  app.register(require('./routes/inventory'), routeOpts);
  app.register(require('./routes/knowledge'), routeOpts);
  app.register(require('./routes/auto-evolves'), routeOpts);
  app.register(require('./routes/synthesize'), routeOpts);
  app.register(require('./routes/quality'), routeOpts);

  // Ollama health check + model verification (non-blocking, informational only)
  if (config.pattern_detect_enabled !== false || config.knowledge_model === 'local') {
    const ollamaUrl = config.ollama_url || 'http://localhost:11434';
    const ollamaModel = config.ollama_model || 'qwen2.5:7b';
    const { verifyModel } = require('./lib/ollama');
    fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      .then(async res => {
        if (res.ok) {
          app.log.info(`Ollama available at ${ollamaUrl}`);
          const modelOk = await verifyModel(ollamaModel, { url: ollamaUrl });
          if (modelOk) {
            app.log.info(`Ollama model "${ollamaModel}" loaded`);
          } else {
            app.log.warn(`Ollama model "${ollamaModel}" not found — run: ollama pull ${ollamaModel}`);
          }
        } else {
          app.log.warn(`Ollama returned ${res.status} at ${ollamaUrl}`);
        }
      })
      .catch(() => {
        app.log.warn(`Ollama not available at ${ollamaUrl} — local extraction will be skipped`);
      });
  }

  // ── Cleanup on close ───────────────────────────────────────────────────

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    db.close();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function gracefulShutdown(app, signal) {
  if (app._shuttingDown) return;
  app._shuttingDown = true;
  console.log(`[${new Date().toISOString()}] ${signal} received, shutting down…`);
  const forceTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceTimer.unref();
  app.close().then(() => {
    clearTimeout(forceTimer);
    console.log('Shutdown complete');
    process.exit(0);
  }).catch(err => {
    console.error('Shutdown error:', err);
    process.exit(1);
  });
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
  process.on('SIGTERM', () => gracefulShutdown(app, 'SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown(app, 'SIGINT'));
}

module.exports = { buildApp, parseQualifiedName, syncComponents, gracefulShutdown };
