'use strict';

const { loadSkillBody } = require('../lib/skill-loader');
const { callOllama } = require('../lib/ollama');
const { insertSessionReview, getSessionReview, getSessionScores } = require('./queries');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIPELINE_NAME = 'session_review';

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

/**
 * Builds the LLM prompt for session retrospective.
 * Uses aggregated data (scores + stats), not raw events.
 *
 * @param {object} params
 * @param {string} params.projectName
 * @param {number} params.durationMins
 * @param {number} params.promptCount
 * @param {number} params.eventCount
 * @param {number} params.totalCost
 * @param {Array}  params.scores — [{prompt_id, prompt_text, efficiency, accuracy, cost_score, approach, overall}]
 * @param {Array}  params.notableEvents — [{description}]
 * @returns {string|null}
 */
function buildReviewPrompt(params) {
  const skillBody = loadSkillBody('quality-evaluator');
  if (!skillBody) return null;

  // Extract retrospective instructions section
  const lines = skillBody.split('\n');
  let inRetro = false;
  const retroLines = [];
  for (const line of lines) {
    if (line === '## Retrospective Instructions') { inRetro = true; continue; }
    if (inRetro && line.startsWith('## ')) break;
    if (inRetro) retroLines.push(line);
  }
  const retroInstructions = retroLines.join('\n').trim();
  if (!retroInstructions) return null;

  const parts = [
    `Project: ${params.projectName}`,
    `Session duration: ${params.durationMins.toFixed(1)} minutes`,
    `Total prompts: ${params.promptCount}`,
    `Total events: ${params.eventCount}`,
    `Total cost: $${params.totalCost.toFixed(4)}`,
    '',
  ];

  if (params.scores.length > 0) {
    parts.push('## Prompt Scores');
    parts.push('| # | Prompt | Eff | Acc | Cost | Approach | Overall |');
    parts.push('|---|---|---|---|---|---|---|');
    for (let i = 0; i < params.scores.length; i++) {
      const s = params.scores[i];
      const text = s.prompt_text
        ? (s.prompt_text.length > 40 ? s.prompt_text.slice(0, 40) + '...' : s.prompt_text)
        : '(no text)';
      parts.push(`| ${i + 1} | "${text}" | ${s.efficiency} | ${s.accuracy} | ${s.cost_score} | ${s.approach} | ${s.overall} |`);
    }
    parts.push('');
  }

  if (params.notableEvents.length > 0) {
    parts.push('## Notable Events');
    for (const ne of params.notableEvents) {
      parts.push(`- ${ne}`);
    }
    parts.push('');
  }

  parts.push(retroInstructions);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// collectNotableEvents
// ---------------------------------------------------------------------------

/**
 * Extracts notable events from a session for the retrospective prompt.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @returns {string[]}
 */
function collectNotableEvents(db, sessionId) {
  const notables = [];

  // Tool failures
  const failures = db.prepare(
    "SELECT name, COUNT(*) AS cnt FROM events WHERE session_id = ? AND success = 0 GROUP BY name ORDER BY cnt DESC LIMIT 5"
  ).all(sessionId);
  for (const f of failures) {
    notables.push(`${f.cnt} tool failure(s) from ${f.name}`);
  }

  // Agent spawns
  const agents = db.prepare(
    "SELECT name, COUNT(*) AS cnt FROM events WHERE session_id = ? AND event_type = 'agent_spawn' GROUP BY name"
  ).all(sessionId);
  for (const a of agents) {
    notables.push(`Agent spawned: ${a.name} (${a.cnt}x)`);
  }

  // Skill invocations
  const skills = db.prepare(
    "SELECT name, COUNT(*) AS cnt FROM events WHERE session_id = ? AND event_type = 'skill_invoke' GROUP BY name"
  ).all(sessionId);
  for (const s of skills) {
    notables.push(`Skill invoked: ${s.name} (${s.cnt}x)`);
  }

  return notables;
}

// ---------------------------------------------------------------------------
// parseReviewOutput
// ---------------------------------------------------------------------------

/**
 * Parses LLM output for session retrospective.
 *
 * @param {string} text
 * @returns {{ valid: boolean, review?: object, reason?: string }}
 */
function parseReviewOutput(text) {
  if (!text) return { valid: false, reason: 'empty output' };

  // Try direct parse
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && parsed.summary) {
      return { valid: true, review: parsed };
    }
  } catch { /* fall through */ }

  // Try fenced code block
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && parsed.summary) {
        return { valid: true, review: parsed };
      }
    } catch { /* fall through */ }
  }

  // Greedy JSON object extraction
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && parsed.summary) {
        return { valid: true, review: parsed };
      }
    } catch { /* fall through */ }
  }

  return { valid: false, reason: 'could not parse review from output' };
}

// ---------------------------------------------------------------------------
// generateRetrospective
// ---------------------------------------------------------------------------

/**
 * Full session retrospective pipeline.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {Promise<{ generated: boolean, reason?: string }>}
 */
async function generateRetrospective(db, sessionId, opts = {}) {
  const model = opts.model || 'qwen2.5:7b';

  // Already reviewed?
  const existing = getSessionReview(db, sessionId);
  if (existing) return { generated: false, reason: 'already reviewed' };

  // Get session
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) return { generated: false, reason: 'session not found' };

  // Resolve project
  const project = db.prepare(
    'SELECT * FROM cl_projects WHERE directory = ?'
  ).get(session.working_directory);
  const projectId = project ? project.project_id : null;
  const projectName = project ? (project.name || project.project_id) : 'unknown';

  // Get prompt scores for this session
  const scores = getSessionScores(db, sessionId);

  // Enrich scores with prompt text
  const enrichedScores = scores.map(s => {
    const prompt = db.prepare('SELECT prompt_text FROM prompts WHERE id = ?').get(s.prompt_id);
    return { ...s, prompt_text: prompt ? prompt.prompt_text : null };
  });

  // Session stats
  const eventCount = db.prepare(
    'SELECT COUNT(*) AS cnt FROM events WHERE session_id = ?'
  ).get(sessionId).cnt;
  const promptCount = db.prepare(
    'SELECT COUNT(*) AS cnt FROM prompts WHERE session_id = ?'
  ).get(sessionId).cnt;

  // Skip very short sessions
  if (promptCount < 2) {
    return { generated: false, reason: 'session too short (< 2 prompts)' };
  }

  // Duration
  const durationMins = (session.started_at && session.ended_at)
    ? (new Date(session.ended_at) - new Date(session.started_at)) / 60000
    : 0;

  // Notable events
  const notableEvents = collectNotableEvents(db, sessionId);

  // Build prompt
  const llmPrompt = buildReviewPrompt({
    projectName,
    durationMins,
    promptCount,
    eventCount,
    totalCost: session.total_cost_usd || 0,
    scores: enrichedScores,
    notableEvents,
  });

  if (!llmPrompt) {
    insertPipelineRun(db, {
      pipeline: PIPELINE_NAME,
      project_id: projectId,
      model,
      status: 'skipped',
      error: 'retrospective prompt unavailable',
    });
    return { generated: false, reason: 'retrospective prompt unavailable' };
  }

  // Call Ollama
  let result;
  try {
    result = await callOllama(llmPrompt, model, {
      url: opts.url,
      timeout: opts.timeout,
    });
  } catch (err) {
    const status = (err.code === 'ECONNREFUSED' || err.code === 'CIRCUIT_OPEN' || err.name === 'TimeoutError')
      ? 'skipped' : 'error';
    insertPipelineRun(db, {
      pipeline: PIPELINE_NAME,
      project_id: projectId,
      model,
      status,
      error: err.message,
      duration_ms: 0,
    });
    return { generated: false, reason: err.message };
  }

  // Parse and validate
  const parsed = parseReviewOutput(result.output);

  insertPipelineRun(db, {
    pipeline: PIPELINE_NAME,
    project_id: projectId,
    model,
    status: parsed.valid ? 'success' : 'error',
    error: parsed.valid ? null : (parsed.reason || 'invalid review'),
    input_tokens: result.input_tokens || 0,
    output_tokens: result.output_tokens || 0,
    duration_ms: result.duration_ms,
  });

  if (!parsed.valid) {
    return { generated: false, reason: parsed.reason };
  }

  const review = parsed.review;
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((sum, s) => sum + s.overall, 0) / scores.length)
    : null;

  insertSessionReview(db, {
    session_id:    sessionId,
    project_id:    projectId,
    overall_score: overallScore,
    summary:       review.summary || '',
    strengths:     Array.isArray(review.strengths) ? review.strengths : [],
    improvements:  Array.isArray(review.improvements) ? review.improvements : [],
    suggestions:   Array.isArray(review.suggestions) ? review.suggestions : [],
    prompt_count:  promptCount,
    scored_count:  scores.length,
    total_cost_usd: session.total_cost_usd || 0,
    total_events:  eventCount,
    duration_mins: durationMins,
  });

  return { generated: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildReviewPrompt,
  collectNotableEvents,
  parseReviewOutput,
  generateRetrospective,
};
