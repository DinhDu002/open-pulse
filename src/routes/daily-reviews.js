'use strict';

const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus,
  getDailyReviewStats, runDailyReview,
  queryInsights, getInsight, updateInsightStatus, getInsightStats,
} = require('../review/pipeline');

module.exports = async function dailyReviewRoutes(app, opts) {
  const { db, helpers, config } = opts;
  const { errorReply, parsePagination } = helpers;

  // GET /api/daily-reviews/stats — MUST be before /:id
  app.get('/api/daily-reviews/stats', (req, reply) => {
    reply.send(getDailyReviewStats(db));
  });

  // GET /api/daily-reviews
  app.get('/api/daily-reviews', (req, reply) => {
    const { review_date, status, category } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryDailyReviews(db, { review_date, status, category, page, per_page: perPage }));
  });

  // GET /api/daily-reviews/:id
  app.get('/api/daily-reviews/:id', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    reply.send(row);
  });

  // PUT /api/daily-reviews/:id/accept
  app.put('/api/daily-reviews/:id/accept', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    updateDailyReviewStatus(db, req.params.id, 'accepted');
    reply.send(getDailyReview(db, req.params.id));
  });

  // PUT /api/daily-reviews/:id/dismiss
  app.put('/api/daily-reviews/:id/dismiss', (req, reply) => {
    const row = getDailyReview(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Daily review not found');
    updateDailyReviewStatus(db, req.params.id, 'dismissed');
    reply.send(getDailyReview(db, req.params.id));
  });

  // POST /api/daily-reviews/run
  app.post('/api/daily-reviews/run', async (req, reply) => {
    if (config.daily_review_enabled === false) {
      return errorReply(reply, 400, 'Daily review is disabled');
    }
    try {
      const result = await runDailyReview(db, {
        date: req.body && req.body.date ? req.body.date : undefined,
        model: config.daily_review_model || 'opus',
        timeout: config.daily_review_timeout_ms || 300000,
        max_suggestions: config.daily_review_max_suggestions || 25,
        historyDays: config.daily_review_history_days || 1,
      });
      if (result.error) return errorReply(reply, 500, result.error);
      reply.send(result);
    } catch (err) {
      return errorReply(reply, 500, err.message);
    }
  });

  // --- Insight routes ---

  // GET /api/daily-reviews/insights/stats — MUST be before /:id
  app.get('/api/daily-reviews/insights/stats', (req, reply) => {
    reply.send(getInsightStats(db));
  });

  // GET /api/daily-reviews/insights
  app.get('/api/daily-reviews/insights', (req, reply) => {
    const { review_date, insight_type, status, severity } = req.query;
    const { page, perPage } = parsePagination(req.query);
    reply.send(queryInsights(db, { review_date, insight_type, status, severity, page, per_page: perPage }));
  });

  // GET /api/daily-reviews/insights/:id
  app.get('/api/daily-reviews/insights/:id', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    reply.send(row);
  });

  // PUT /api/daily-reviews/insights/:id/resolve
  app.put('/api/daily-reviews/insights/:id/resolve', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    updateInsightStatus(db, req.params.id, 'resolved');
    reply.send(getInsight(db, req.params.id));
  });

  // PUT /api/daily-reviews/insights/:id/dismiss
  app.put('/api/daily-reviews/insights/:id/dismiss', (req, reply) => {
    const row = getInsight(db, req.params.id);
    if (!row) return errorReply(reply, 404, 'Insight not found');
    updateInsightStatus(db, req.params.id, 'dismissed');
    reply.send(getInsight(db, req.params.id));
  });
};
