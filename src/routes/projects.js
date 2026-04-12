'use strict';

const path = require('path');
const fs = require('fs');
const {
  getProjectSummary,
  getProjectTimeline,
  deleteProject,
} = require('../db/projects');
const { queryPipelineRuns, getPipelineRunStats } = require('../db/pipeline-runs');

module.exports = async function projectsRoutes(app, opts) {
  const { db, repoDir } = opts;

  // ── Projects ─────────────────────────────────────────────────────────────

  app.get('/api/projects', async () => {
    const registered = db.prepare(
      'SELECT project_id, name, directory, session_count, last_seen_at FROM cl_projects ORDER BY last_seen_at DESC'
    ).all();

    const registeredNames = new Set(registered.map(r => r.name));
    const eventOnly = db.prepare(
      "SELECT DISTINCT project_name AS name FROM events WHERE project_name IS NOT NULL"
    ).all().filter(r => !registeredNames.has(r.name));

    return [
      ...registered.map(r => ({ project_id: r.project_id, name: r.name, directory: r.directory, session_count: r.session_count, last_seen_at: r.last_seen_at })),
      ...eventOnly.map(r => ({ name: r.name, directory: null, session_count: 0, last_seen_at: null })),
    ];
  });

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
      const pidFile = path.join(repoDir, 'projects', projectId, '.observer.pid');
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
    const clProjectDir = path.join(repoDir, 'cl', 'projects', projectId);
    try { fs.rmSync(clProjectDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    const projectDir = path.join(repoDir, 'projects', projectId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    // Remove from projects.json
    const registryPath = path.join(repoDir, 'projects.json');
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      delete registry[projectId];
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    } catch { /* registry may not exist */ }

    return { deleted: true, project_id: projectId };
  });

  // ── Pipeline Runs ─────────────────────────────────────────────────────────

  app.get('/api/pipeline-runs/stats', async (request) => {
    const projectId = request.query.project_id || undefined;
    const days = Math.max(1, parseInt(request.query.days) || 90);
    return getPipelineRunStats(db, { projectId, days });
  });

  app.get('/api/projects/:id/pipeline-runs', async (request) => {
    const projectId = request.params.id;
    const pipeline = request.query.pipeline || undefined;
    const status = request.query.status || undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit) || 20), 100);
    const page = Math.max(1, parseInt(request.query.page) || 1);
    return queryPipelineRuns(db, { projectId, pipeline, status, page, perPage: limit });
  });
};
