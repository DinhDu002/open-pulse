'use strict';

const { loadCompactPrompt } = require('../lib/skill-loader');
const { formatEventsForLLM } = require('../lib/format-events');
const { callOllama } = require('../lib/ollama');
const { parseJsonResponse } = require('../knowledge/extract');
const { makeId } = require('./sync');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES = new Set(['rule', 'skill', 'agent', 'workflow']);

// ---------------------------------------------------------------------------
// validatePattern
// ---------------------------------------------------------------------------

/**
 * Validates a single pattern entry returned by the LLM.
 *
 * @param {{ title: string, description: string, target_type: string }} entry
 * @returns {{ valid: boolean, reason?: string }}
 */
const VALID_SCOPES = new Set(['project', 'global']);

function validatePattern(entry) {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, reason: 'not an object' };
  }
  if (!entry.title || entry.title.length === 0) {
    return { valid: false, reason: 'empty title' };
  }
  if (entry.title.length > 80) {
    return { valid: false, reason: 'title exceeds 80 chars' };
  }
  if (!VALID_TARGET_TYPES.has(entry.target_type)) {
    return { valid: false, reason: `invalid target_type: ${entry.target_type}` };
  }
  if (!entry.description || entry.description.length < 20) {
    return { valid: false, reason: 'description too short (min 20 chars)' };
  }
  if (entry.scope && !VALID_SCOPES.has(entry.scope)) {
    return { valid: false, reason: `invalid scope: ${entry.scope}` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// buildPatternPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for per-prompt pattern detection using the compact skill.
 *
 * @param {string} projectName
 * @param {Array}  events
 * @returns {string}
 */
function buildPatternPrompt(projectName, events) {
  const compact = loadCompactPrompt('pattern-detector');
  const eventLines = formatEventsForLLM(events);
  return [
    `Project: ${projectName}`,
    '',
    'Analyze the following tool usage events and detect reusable behavioral patterns.',
    '',
    'Events:',
    eventLines,
    '',
    compact || '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// upsertPattern
// ---------------------------------------------------------------------------

/**
 * Inserts a new pattern or bumps confidence/observation_count on duplicate.
 *
 * New patterns get:
 *   status = 'draft'
 *   confidence = 0.3
 *   observation_count = 1
 *
 * On duplicate (same id = sha256 of title::target_type):
 *   observation_count += 1
 *   confidence = min(0.95, confidence + 0.15)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ title: string, description: string, target_type: string, evidence?: string, projects?: string[] }} entry
 * @returns {{ action: 'inserted'|'updated', id: string }}
 */
function upsertPattern(db, entry) {
  const id = makeId(entry.title, entry.target_type);
  const now = new Date().toISOString();

  const description = entry.evidence
    ? `${entry.description}\n\n## Evidence\n${entry.evidence}`
    : entry.description;

  const projects = entry.projects && entry.projects.length > 0
    ? JSON.stringify(entry.projects)
    : null;

  const existing = db.prepare(
    'SELECT id, observation_count, confidence, updated_at FROM auto_evolves WHERE id = ?'
  ).get(id);

  if (existing) {
    const newCount = existing.observation_count + 1;
    // Apply decay if not observed for >14 days, then add boost
    let baseConf = existing.confidence;
    if (existing.updated_at) {
      const daysSinceUpdate = (Date.now() - new Date(existing.updated_at).getTime()) / 86_400_000;
      if (daysSinceUpdate > 14) {
        baseConf = parseFloat(Math.max(0.1, baseConf - 0.1).toFixed(2));
      }
    }
    const newConf = parseFloat(Math.min(0.95, baseConf + 0.15).toFixed(2));
    db.prepare(`
      UPDATE auto_evolves
      SET observation_count = ?, confidence = ?, description = ?, projects = ?, updated_at = ?
      WHERE id = ?
    `).run(newCount, newConf, description, projects, now, id);
    return { action: 'updated', id };
  }

  db.prepare(`
    INSERT INTO auto_evolves
      (id, title, description, target_type, confidence, observation_count, projects, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.title, description, entry.target_type, 0.3, 1, projects, 'draft', now, now);

  return { action: 'inserted', id };
}

// ---------------------------------------------------------------------------
// detectPatternsFromPrompt
// ---------------------------------------------------------------------------

/**
 * Full pattern detection pipeline triggered after a prompt is ingested.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} promptId
 * @param {object} [opts]
 * @param {string} [opts.model]      Ollama model name (default: 'qwen2.5:7b')
 * @param {string} [opts.url]        Ollama base URL
 * @param {number} [opts.timeout]    Ollama request timeout ms
 * @returns {Promise<{inserted: number, updated: number, errors?: number, skipped?: boolean}>}
 */
async function detectPatternsFromPrompt(db, promptId, opts = {}) {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
  if (!prompt) return { inserted: 0, updated: 0, skipped: true };

  const events = db.prepare(
    'SELECT * FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
  ).all(promptId);

  // Skip if fewer than 3 events — not enough signal to detect patterns
  if (events.length < 3) return { inserted: 0, updated: 0, skipped: true };

  const projectName = events[0]?.project_name || 'unknown';
  const projectId = events[0]?.project_name || null;
  const model = opts.model || 'qwen2.5:7b';

  const llmPrompt = buildPatternPrompt(projectName, events);

  let result;
  try {
    result = await callOllama(llmPrompt, model, {
      url: opts.url,
      timeout: opts.timeout,
    });
  } catch (err) {
    const status = (err.code === 'ECONNREFUSED' || err.code === 'CIRCUIT_OPEN' || err.name === 'TimeoutError') ? 'skipped' : 'error';
    insertPipelineRun(db, {
      pipeline: 'pattern_detect',
      project_id: projectId,
      model,
      status,
      error: err.message,
      duration_ms: 0,
    });
    return { inserted: 0, updated: 0, skipped: true };
  }

  const entries = parseJsonResponse(result.output);
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const entry of entries) {
    const check = validatePattern(entry);
    if (!check.valid) { errors++; continue; }
    const upsertResult = upsertPattern(db, entry);
    if (upsertResult.action === 'inserted') inserted++;
    else updated++;
  }

  insertPipelineRun(db, {
    pipeline: 'pattern_detect',
    project_id: projectId,
    model,
    status: 'success',
    duration_ms: result.duration_ms,
    input_tokens: result.input_tokens || 0,
    output_tokens: result.output_tokens || 0,
  });

  return { inserted, updated, errors };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validatePattern,
  buildPatternPrompt,
  upsertPattern,
  detectPatternsFromPrompt,
};
