'use strict';

const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus,
  getDailyReviewStats, runDailyReview,
  queryInsights, getInsight, updateInsightStatus, getInsightStats,
} = require('../review/pipeline');
const { loadConfig } = require('../lib/config');
const { updatePlanStatus, getPlanStatus } = require('../review/queries');
const { insertPipelineRun } = require('../db/pipeline-runs');
const { getClaudeDir } = require('../lib/paths');
const plan = require('../review/plan');

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
        dryRun: req.body && req.body.dry_run === true,
      });
      if (result.error) return errorReply(reply, 500, result.error);
      reply.send(result);
    } catch (err) {
      return errorReply(reply, 500, err.message);
    }
  });

  // POST /api/daily-reviews/:id/plan/generate
  app.post('/api/daily-reviews/:id/plan/generate', async (req, reply) => {
    const cfg = loadConfig();  // FRESH READ — no cache

    if (cfg.plan_generation_enabled === false) {
      return errorReply(reply, 400, 'Plan generation is disabled');
    }
    const maxConcurrent = cfg.plan_generation_max_concurrent || 3;
    if (plan.activePlanGenerations >= maxConcurrent) {
      return errorReply(reply, 429,
        `Plan generation at capacity (${plan.activePlanGenerations}/${maxConcurrent})`);
    }

    const review = getDailyReview(db, req.params.id);
    if (!review) return errorReply(reply, 404, 'Daily review not found');
    if (review.plan_status === 'running' || plan.activeReviewIds.has(req.params.id)) {
      return errorReply(reply, 409, 'Plan is already being generated for this review');
    }

    const runId = insertPipelineRun(db, {
      pipeline: 'plan_generation',
      project_id: null,
      model: cfg.plan_generation_model || 'opus',
      status: 'running',
    });

    updatePlanStatus(db, req.params.id, 'running');
    plan.increment();
    plan.activeReviewIds.add(req.params.id);

    // Kick off background, do NOT await
    plan.generatePlanAsync(db, req.params.id, {
      model: cfg.plan_generation_model || 'opus',
      timeout: cfg.plan_generation_timeout_ms || 120000,
      max_context_kb: cfg.plan_generation_max_context_kb || 100,
      runId,
      suggestion: review,
      claudeDir: process.env.OPEN_PULSE_CLAUDE_DIR || getClaudeDir(),
    }).catch(err => {
      console.error('plan generation kickoff failed:', err);
    });

    reply.code(202).send({ run_id: runId, status: 'running' });
  });

  // GET /api/daily-reviews/:id/plan-status
  app.get('/api/daily-reviews/:id/plan-status', (req, reply) => {
    const status = getPlanStatus(db, req.params.id);
    if (!status) return errorReply(reply, 404, 'Daily review not found');
    reply.send(status);
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
