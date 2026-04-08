'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
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
} = require('../op-db');
const { findInstinctFile, updateConfidence, archiveInstinct } = require('../op-instinct-updater');
const { syncAll } = require('../op-sync');

module.exports = async function instinctsRoutes(app, opts) {
  const { db, repoDir } = opts;

  // ── Instincts ───────────────────────────────────────────────────────────
  // IMPORTANT: Static routes MUST be registered before parameterized routes

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
        const pidFile = path.join(repoDir, 'projects', row.id, '.observer.pid');
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

    const logPath = path.join(repoDir, 'projects', project, 'observer.log');
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const allLines = content.trim().split('\n');
      const n = Math.min(parseInt(lines, 10), allLines.length);
      return { log: allLines.slice(-n) };
    } catch {
      return { log: [] };
    }
  });

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

  app.get('/api/instincts/:id/suggestions', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    return getInstinctSuggestions(db, id);
  });

  app.put('/api/instincts/:id/validate', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = db.prepare('SELECT instinct_id FROM cl_instincts WHERE id = ?').get(id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    const filePath = findInstinctFile(repoDir, inst.instinct_id);
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
    const filePath = findInstinctFile(repoDir, inst.instinct_id);
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

  app.get('/api/instincts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) return reply.code(400).send({ error: 'invalid id' });
    const inst = getInstinct(db, id);
    if (!inst) return reply.code(404).send({ error: 'not found' });
    return inst;
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

  // ── Learning ──────────────────────────────────────────────────────────────

  app.get('/api/learning/activity', async (request) => {
    const days = Math.max(1, parseInt(request.query.days) || 7);
    return queryLearningActivity(db, days);
  });

  app.get('/api/learning/recent', async (request) => {
    const limit = Math.min(20, Math.max(1, parseInt(request.query.limit) || 5));
    return queryLearningRecent(db, limit);
  });
};
