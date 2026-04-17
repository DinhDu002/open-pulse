'use strict';

const { loadCompactPrompt } = require('../lib/skill-loader');
const { formatEventsForLLM } = require('../lib/format-events');
const { callOllama } = require('../lib/ollama');
const { parseJsonResponse } = require('../knowledge/extract');
const { insertPromptScore, getPromptScore } = require('./queries');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIPELINE_NAME = 'quality_score';
const MIN_SCORE = 0;
const MAX_SCORE = 100;

// ---------------------------------------------------------------------------
// validateScoreResponse
// ---------------------------------------------------------------------------

/**
 * Validates and normalises a single score response from the LLM.
 *
 * @param {object} raw
 * @returns {{ valid: boolean, score?: object, reason?: string }}
 */
function validateScoreResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, reason: 'not an object' };
  }

  const dimensions = ['efficiency', 'accuracy', 'cost_score', 'approach'];
  const score = {};

  for (const dim of dimensions) {
    const val = Number(raw[dim]);
    if (!Number.isFinite(val)) {
      return { valid: false, reason: `missing or invalid ${dim}` };
    }
    score[dim] = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(val)));
  }

  score.overall = Math.round(
    (score.efficiency + score.accuracy + score.cost_score + score.approach) / 4
  );

  score.reasoning = raw.reasoning && typeof raw.reasoning === 'object'
    ? raw.reasoning
    : null;

  return { valid: true, score };
}

// ---------------------------------------------------------------------------
// buildScorePrompt
// ---------------------------------------------------------------------------

/**
 * Builds the LLM prompt for quality scoring.
 *
 * @param {string} projectName
 * @param {string} promptText
 * @param {Array}  events
 * @returns {string|null} — null if compact prompt not available
 */
function buildScorePrompt(projectName, promptText, events) {
  const compact = loadCompactPrompt('quality-evaluator');
  if (!compact) return null;

  const eventLines = formatEventsForLLM(events);
  const truncatedPrompt = promptText && promptText.length > 500
    ? promptText.slice(0, 500) + '...'
    : (promptText || '(no prompt text)');

  return [
    `Project: ${projectName}`,
    '',
    'Score the quality of this Claude Code interaction.',
    '',
    `User prompt: ${truncatedPrompt}`,
    '',
    'Events:',
    eventLines,
    '',
    compact,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// parseScoreOutput
// ---------------------------------------------------------------------------

/**
 * Parses LLM output into a validated score object.
 * Handles both direct JSON objects and JSON arrays (takes first element).
 *
 * @param {string} text
 * @returns {{ valid: boolean, score?: object, reason?: string }}
 */
function parseScoreOutput(text) {
  if (!text) return { valid: false, reason: 'empty output' };

  // Tier 1: direct parse as object
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return validateScoreResponse(parsed);
    }
  } catch { /* fall through */ }

  // Tier 2: fenced code block (object or array)
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        return validateScoreResponse(parsed[0]);
      }
      if (parsed && typeof parsed === 'object') {
        return validateScoreResponse(parsed);
      }
    } catch { /* fall through */ }
  }

  // Tier 3: parseJsonResponse (handles arrays in other formats)
  const arr = parseJsonResponse(text);
  if (arr.length > 0) {
    return validateScoreResponse(arr[0]);
  }

  // Tier 4: greedy regex for outermost JSON object
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return validateScoreResponse(obj);
    } catch { /* fall through */ }
  }

  return { valid: false, reason: 'could not parse score from output' };
}

// ---------------------------------------------------------------------------
// scorePrompt
// ---------------------------------------------------------------------------

/**
 * Full quality scoring pipeline for a single prompt.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} promptId
 * @param {object} [opts]
 * @param {string} [opts.model]    Ollama model name
 * @param {string} [opts.url]      Ollama base URL
 * @param {number} [opts.timeout]  Ollama request timeout ms
 * @param {number} [opts.minEvents] Minimum events to score (default 3)
 * @returns {Promise<{ scored: boolean, score?: object, reason?: string }>}
 */
async function scorePrompt(db, promptId, opts = {}) {
  const minEvents = opts.minEvents ?? 3;
  const model = opts.model || 'qwen2.5:7b';

  // Already scored?
  const existing = getPromptScore(db, promptId);
  if (existing) return { scored: false, reason: 'already scored' };

  // Get prompt
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
  if (!prompt) return { scored: false, reason: 'prompt not found' };

  // Get session
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(prompt.session_id);
  if (!session) return { scored: false, reason: 'session not found' };

  // Resolve project
  const project = db.prepare(
    'SELECT * FROM cl_projects WHERE directory = ?'
  ).get(session.working_directory);
  const projectId = project ? project.project_id : null;
  const projectName = project ? (project.name || project.project_id) : 'unknown';

  // Get events
  const events = db.prepare(
    'SELECT * FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
  ).all(promptId);

  if (events.length < minEvents) {
    return { scored: false, reason: `only ${events.length} events (min ${minEvents})` };
  }

  // Build prompt
  const llmPrompt = buildScorePrompt(projectName, prompt.prompt_text, events);
  if (!llmPrompt) {
    insertPipelineRun(db, {
      pipeline: PIPELINE_NAME,
      project_id: projectId,
      model,
      status: 'skipped',
      error: 'compact prompt unavailable',
    });
    return { scored: false, reason: 'compact prompt unavailable' };
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
    return { scored: false, reason: err.message };
  }

  // Parse and validate
  const parsed = parseScoreOutput(result.output);

  insertPipelineRun(db, {
    pipeline: PIPELINE_NAME,
    project_id: projectId,
    model,
    status: parsed.valid ? 'success' : 'error',
    error: parsed.valid ? null : (parsed.reason || 'invalid score'),
    input_tokens: result.input_tokens || 0,
    output_tokens: result.output_tokens || 0,
    duration_ms: result.duration_ms,
  });

  if (!parsed.valid) {
    return { scored: false, reason: parsed.reason };
  }

  // Insert score
  insertPromptScore(db, {
    prompt_id:  promptId,
    session_id: prompt.session_id,
    project_id: projectId,
    efficiency: parsed.score.efficiency,
    accuracy:   parsed.score.accuracy,
    cost_score: parsed.score.cost_score,
    approach:   parsed.score.approach,
    overall:    parsed.score.overall,
    reasoning:  parsed.score.reasoning,
    event_count: events.length,
  });

  return { scored: true, score: parsed.score };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateScoreResponse,
  buildScorePrompt,
  parseScoreOutput,
  scorePrompt,
};
