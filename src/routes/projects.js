'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  getProjectSummary,
  deleteProject,
  upsertClProject,
} = require('../db/projects');
const { queryPipelineRuns, getPipelineRunStats, getPipelineRunTrends } = require('../db/pipeline-runs');
const { queryAutoEvolvesByProject } = require('../evolve/queries');
const { parsePagination, errorReply, isGitRepo, scanGitRepos } = require('../lib/format');
const { loadConfig } = require('../lib/config');

function projectIdFromDir(workDir) {
  const hash = crypto.createHash('sha256').update(workDir).digest('hex').substring(0, 12);
  return `proj-${hash}`;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = async function projectsRoutes(app, opts) {
  const { db, repoDir } = opts;

  // ── Projects ─────────────────────────────────────────────────────────────

  app.get('/api/projects', async () => {
    return db.prepare(`
      SELECT
        p.project_id,
        p.name,
        p.directory,
        COALESCE((
          SELECT COUNT(DISTINCT e.session_id)
          FROM events e
          WHERE e.project_name = p.name
        ), 0) AS session_count,
        p.last_seen_at
      FROM cl_projects p
      ORDER BY p.last_seen_at DESC
    `).all();
  });

  // Rescan: scan `project_scan_roots` for folders containing `.git`.
  // Drops cl_projects entries whose `.git` no longer exists, and upserts
  // any newly discovered git repos. Triggered manually via UI button.
  app.post('/api/projects/refresh', async () => {
    const cfg = loadConfig();
    const roots = (cfg.project_scan_roots || ['~/Workspace']).map(expandHome);
    const now = new Date().toISOString();
    let removed = 0;
    let added = 0;

    const existing = db.prepare(
      'SELECT project_id, directory FROM cl_projects'
    ).all();
    for (const { project_id, directory } of existing) {
      if (!directory || !isGitRepo(directory)) {
        deleteProject(db, project_id);
        removed++;
      }
    }

    const registeredDirs = new Set(
      db.prepare('SELECT directory FROM cl_projects WHERE directory IS NOT NULL').all().map(r => r.directory)
    );
    const gitDirs = scanGitRepos(roots);
    for (const dir of gitDirs) {
      if (registeredDirs.has(dir)) continue;
      upsertClProject(db, {
        project_id: projectIdFromDir(dir),
        name: path.basename(dir),
        directory: dir,
        first_seen_at: now,
        last_seen_at: now,
        session_count: 0,
      });
      added++;
    }

    const total = db.prepare('SELECT COUNT(*) AS cnt FROM cl_projects').get().cnt;
    return { added, removed, total, roots };
  });

  // List working_directory values seen in events that are NOT git repos.
  // Powers the "Other folders" tab.
  app.get('/api/projects/non-git', async () => {
    const rows = db.prepare(`
      SELECT
        working_directory AS directory,
        COUNT(DISTINCT session_id) AS session_count,
        MAX(timestamp) AS last_seen_at
      FROM events
      WHERE working_directory IS NOT NULL
      GROUP BY working_directory
      ORDER BY last_seen_at DESC
    `).all();
    return rows.filter(r => r.directory && !isGitRepo(r.directory));
  });

  app.get('/api/projects/:id/summary', async (request, reply) => {
    const summary = getProjectSummary(db, request.params.id);
    if (!summary) return reply.code(404).send({ error: 'Project not found' });
    return summary;
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const projectId = request.params.id;

    const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(projectId);
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    // DB deletion (transactional)
    deleteProject(db, projectId);

    // Filesystem cleanup
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

  app.get('/api/pipeline-runs', async (request) => {
    const pipeline = request.query.pipeline || undefined;
    const status = request.query.status || undefined;
    const projectId = request.query.project_id || undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit) || 20), 100);
    const page = Math.max(1, parseInt(request.query.page) || 1);
    return queryPipelineRuns(db, { projectId, pipeline, status, page, perPage: limit });
  });

  app.get('/api/pipeline-runs/trends', async (request) => {
    const days = Math.max(1, parseInt(request.query.days) || 30);
    return getPipelineRunTrends(db, { days });
  });

  app.get('/api/projects/:id/pipeline-runs', async (request) => {
    const projectId = request.params.id;
    const pipeline = request.query.pipeline || undefined;
    const status = request.query.status || undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit) || 20), 100);
    const page = Math.max(1, parseInt(request.query.page) || 1);
    return queryPipelineRuns(db, { projectId, pipeline, status, page, perPage: limit });
  });

  // ── Project-scoped: auto-evolves ──────────────────────────────────────────

  function lookupProjectName(projectId) {
    const row = db.prepare('SELECT name FROM cl_projects WHERE project_id = ?').get(projectId);
    return row ? row.name : null;
  }

  app.get('/api/projects/:id/auto-evolves', async (request, reply) => {
    const name = lookupProjectName(request.params.id);
    if (!name) return errorReply(reply, 404, 'Project not found');
    const { page, perPage } = parsePagination(request.query);
    return queryAutoEvolvesByProject(db, name, {
      status: request.query.status || undefined,
      target_type: request.query.target_type || undefined,
      page,
      per_page: perPage,
    });
  });

};
