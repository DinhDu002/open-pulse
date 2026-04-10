'use strict';

const path = require('path');
const fs = require('fs');
const { ingestAll } = require('../ingest/pipeline');
const {
  queryLearningActivity,
  queryLearningRecent,
} = require('../db/projects');

module.exports = async function configRoutes(app, opts) {
  const { db, helpers, repoDir } = opts;
  const { parsePagination } = helpers;

  const CONFIG_PATH = path.join(repoDir, 'config.json');

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

  // ── Errors ──────────────────────────────────────────────────────────────

  app.get('/api/errors', async (request) => {
    const { limit = 50 } = request.query;
    return db.prepare('SELECT * FROM collector_errors ORDER BY occurred_at DESC LIMIT ?').all(parseInt(limit, 10));
  });

  // ── Unused ──────────────────────────────────────────────────────────────

  app.get('/api/unused', async (request) => {
    const { page, perPage } = parsePagination(request.query, { perPage: 50 });

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

    const all = [
      ...unused_skills.map(name => ({ type: 'skill', name })),
      ...unused_agents.map(name => ({ type: 'agent', name })),
    ];

    const total = all.length;
    const data = all.slice((page - 1) * perPage, page * perPage);
    return { data, total, page, per_page: perPage };
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

  // ── Learning (legacy stubs) ───────────────────────────────────────────────

  app.get('/api/learning/activity', async (request) => {
    const days = Math.max(1, parseInt(request.query.days) || 7);
    return queryLearningActivity(db, days);
  });

  app.get('/api/learning/recent', async (request) => {
    const limit = Math.min(20, Math.max(1, parseInt(request.query.limit) || 5));
    return queryLearningRecent(db, limit);
  });
};
