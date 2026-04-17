'use strict';

const {
  getPromptScore,
  getSessionReview,
  getQualityStats,
  getQualityTrends,
  getWeeklyComparison,
} = require('../quality/queries');

module.exports = async function qualityRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply } = helpers;

  // ── Prompt score ────────────────────────────────────────────────────────

  app.get('/api/quality/prompts/:promptId', async (req, reply) => {
    const id = Number(req.params.promptId);
    if (!Number.isFinite(id)) return errorReply(reply, 400, 'invalid promptId');

    const score = getPromptScore(db, id);
    if (!score) return errorReply(reply, 404, 'score not found');

    return {
      ...score,
      reasoning: score.reasoning ? JSON.parse(score.reasoning) : null,
    };
  });

  // ── Session retrospective ──────────────────────────────────────────────

  app.get('/api/quality/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    if (!sessionId) return errorReply(reply, 400, 'missing sessionId');

    const review = getSessionReview(db, sessionId);
    if (!review) return errorReply(reply, 404, 'review not found');

    return {
      ...review,
      strengths:    JSON.parse(review.strengths || '[]'),
      improvements: JSON.parse(review.improvements || '[]'),
      suggestions:  JSON.parse(review.suggestions || '[]'),
    };
  });

  // ── Quality stats ──────────────────────────────────────────────────────

  app.get('/api/quality/stats', async (req) => {
    const { project, period } = req.query;
    return getQualityStats(db, {
      projectId: project || undefined,
      period: period || undefined,
    });
  });

  // ── Weekly comparison ───────────────────────────────────────────────────

  app.get('/api/quality/weekly', async (req) => {
    const { project, weeks } = req.query;
    return {
      weeks: getWeeklyComparison(db, {
        projectId: project || undefined,
        weeks: weeks ? Number(weeks) : 8,
      }),
    };
  });

  // ── Quality trends ─────────────────────────────────────────────────────

  app.get('/api/quality/trends', async (req) => {
    const { project, days } = req.query;
    return {
      days: getQualityTrends(db, {
        projectId: project || undefined,
        days: days ? Number(days) : 30,
      }),
    };
  });
};
