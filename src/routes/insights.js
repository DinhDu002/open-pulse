'use strict';

const {
  queryInsights, getInsight, updateInsightFeedback, getInsightStats,
  updateInsightStatus, updateInsightActionData, deleteInsight,
} = require('../op-db');

module.exports = async function insightsRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply, parsePagination } = helpers;

  // GET /api/insights/stats — MUST be before /:id to avoid param collision
  app.get('/api/insights/stats', (req, reply) => {
    const stats = getInsightStats(db);
    reply.send(stats);
  });

  // GET /api/insights — paginated list
  app.get('/api/insights', (req, reply) => {
    const { source, status, category, target_type, project_id, search } = req.query;
    const { page, perPage } = parsePagination(req.query);
    const result = queryInsights(db, {
      source,
      status,
      category,
      target_type,
      project_id,
      search,
      page,
      per_page: perPage,
    });
    reply.send(result);
  });

  // GET /api/insights/:id
  app.get('/api/insights/:id', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    if (row.action_data) {
      try {
        row.action_data = JSON.parse(row.action_data);
      } catch {
        // keep as string if parse fails
      }
    }
    reply.send(row);
  });

  // PUT /api/insights/:id/validate
  app.put('/api/insights/:id/validate', (req, reply) => {
    const existing = getInsight(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Insight not found');
    updateInsightFeedback(db, req.params.id, 'validate');
    const updated = getInsight(db, req.params.id);
    reply.send(updated);
  });

  // PUT /api/insights/:id/reject
  app.put('/api/insights/:id/reject', (req, reply) => {
    const existing = getInsight(db, req.params.id);
    if (!existing) return errorReply(reply, 404, 'Insight not found');
    updateInsightFeedback(db, req.params.id, 'reject');
    const updated = getInsight(db, req.params.id);
    reply.send(updated);
  });

  // DELETE /api/insights/:id
  app.delete('/api/insights/:id', (req, reply) => {
    deleteInsight(db, req.params.id);
    reply.send({ ok: true });
  });
};
