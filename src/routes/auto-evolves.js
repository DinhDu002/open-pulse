'use strict';

const path = require('path');
const { queryAutoEvolves, getAutoEvolve, getAutoEvolveStats } = require('../evolve/queries');
const { revertAutoEvolve } = require('../evolve/revert');
const { promoteOne } = require('../evolve/promote');

module.exports = async function autoEvolveRoutes(app, opts) {
  const { db, helpers, repoDir } = opts;
  const { errorReply, parsePagination } = helpers;

  // GET /api/auto-evolves/stats — MUST be before /:id
  app.get('/api/auto-evolves/stats', (req, reply) => {
    reply.send(getAutoEvolveStats(db));
  });

  // GET /api/auto-evolves
  app.get('/api/auto-evolves', (req, reply) => {
    const { status, target_type } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryAutoEvolves(db, { status, target_type, page, per_page: perPage }));
  });

  // GET /api/auto-evolves/:id
  app.get('/api/auto-evolves/:id', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    reply.send(row);
  });

  // PUT /api/auto-evolves/:id/revert
  app.put('/api/auto-evolves/:id/revert', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    if (row.status !== 'promoted') return errorReply(reply, 400, 'Only promoted items can be reverted');
    revertAutoEvolve(db, req.params.id);
    reply.send(getAutoEvolve(db, req.params.id));
  });

  // POST /api/auto-evolves/:id/promote — manual force-promote
  app.post('/api/auto-evolves/:id/promote', (req, reply) => {
    const row = getAutoEvolve(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
    if (row.status !== 'active') {
      return errorReply(reply, 400, `Cannot promote: status is ${row.status}`);
    }
    try {
      const result = promoteOne(db, row, { logDir: path.join(repoDir, 'logs') });
      reply.send({ ok: true, promoted_to: result.filePath });
    } catch (err) {
      return errorReply(reply, 500, err.message);
    }
  });
};
