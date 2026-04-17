'use strict';

const { spawn } = require('child_process');

const {
  upsertKnowledgeEntry,
  getExistingTitles,
  insertEntryHistory,
} = require('./queries');
const { insertPipelineRun, updatePipelineRun } = require('../db/pipeline-runs');
const { formatEventsForLLM } = require('../lib/format-events');
const { loadSkillBody, loadCompactPrompt } = require('../lib/skill-loader');
const { callOllama } = require('../lib/ollama');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'domain', 'stack', 'schema', 'api', 'feature', 'architecture',
  'convention', 'decision', 'footgun', 'contract', 'error_pattern',
]);

const VALID_TAGS = new Set([
  'backend', 'frontend', 'database', 'api', 'testing', 'deployment',
  'config', 'security', 'performance', 'migration', 'cli', 'hooks',
]);

const MIN_BODY_LENGTH = 50;
const MAX_TITLE_LENGTH = 80;
const MIN_TAGS = 1;
const MAX_TAGS = 3;

// Fallback tag per category when LLM provides no valid tags.
const CATEGORY_DEFAULT_TAG = {
  domain: 'backend',
  stack: 'backend',
  schema: 'database',
  api: 'api',
  feature: 'backend',
  architecture: 'backend',
  convention: 'backend',
  decision: 'backend',
  footgun: 'backend',
  contract: 'api',
  error_pattern: 'backend',
};

// ---------------------------------------------------------------------------
// validateKnowledgeEntry
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a single knowledge entry from LLM output.
 *
 * Hard rejects (return valid:false):
 *   - missing/empty title, title > 80 chars
 *   - missing/empty body, body < 50 chars
 *   - body missing any of: "[Trigger]:", "[Detail]:", "Consequence"
 *   - tags field present but not an array
 *
 * Soft normalizations (return valid:true with corrected entry):
 *   - tags filtered to VALID_TAGS subset
 *   - tags clamped to 1..3 (defaults to category-mapped tag if empty)
 *   - category fallback happens downstream in mergeOrUpdate
 *
 * @param {object} entry
 * @returns {{ valid: boolean, reason?: string, entry?: object }}
 */
function validateKnowledgeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, reason: 'not an object' };
  }
  if (!entry.title || entry.title.length === 0) {
    return { valid: false, reason: 'empty title' };
  }
  if (entry.title.length > MAX_TITLE_LENGTH) {
    return { valid: false, reason: `title exceeds ${MAX_TITLE_LENGTH} chars` };
  }
  if (!entry.body || entry.body.length === 0) {
    return { valid: false, reason: 'empty body' };
  }
  if (entry.body.length < MIN_BODY_LENGTH) {
    return { valid: false, reason: `body shorter than ${MIN_BODY_LENGTH} chars` };
  }
  if (!entry.body.includes('Consequence')) {
    return { valid: false, reason: 'body missing Consequence' };
  }
  if (!entry.body.includes('[Trigger]:')) {
    return { valid: false, reason: 'body missing [Trigger]:' };
  }
  if (!entry.body.includes('[Detail]:')) {
    return { valid: false, reason: 'body missing [Detail]:' };
  }
  if (entry.tags !== undefined && entry.tags !== null && !Array.isArray(entry.tags)) {
    return { valid: false, reason: 'tags must be an array' };
  }

  // Normalize tags: filter to valid vocabulary, dedupe, clamp to 1..3.
  const rawTags = Array.isArray(entry.tags) ? entry.tags : [];
  const seen = new Set();
  const filtered = [];
  for (const t of rawTags) {
    if (typeof t !== 'string') continue;
    const norm = t.trim().toLowerCase();
    if (!VALID_TAGS.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    filtered.push(norm);
    if (filtered.length >= MAX_TAGS) break;
  }
  if (filtered.length < MIN_TAGS) {
    const fallback = CATEGORY_DEFAULT_TAG[entry.category] || 'backend';
    filtered.push(fallback);
  }

  return {
    valid: true,
    entry: { ...entry, tags: filtered },
  };
}

// ---------------------------------------------------------------------------
// buildExistingEntriesBlock — context-aware entry block for extraction prompt
// ---------------------------------------------------------------------------

function buildExistingEntriesBlock(db, projectId, affectedFiles) {
  const entries = db.prepare(
    "SELECT title, body, source_file, category FROM knowledge_entries WHERE project_id = ? AND status = 'active'"
  ).all(projectId);

  if (entries.length === 0) return '';

  const affectedSet = new Set(affectedFiles);

  const related = [];
  const other = [];

  for (const e of entries) {
    if (e.source_file && affectedSet.has(e.source_file)) {
      related.push(e);
    } else {
      other.push(e);
    }
  }

  const lines = [];

  if (related.length > 0) {
    lines.push(
      '',
      'Related entries (UPDATE these if the events above contradict their content —',
      'emit the same title with corrected body to trigger an update):',
    );
    for (const e of related) {
      lines.push(`- "${e.title}" [source: ${e.source_file}]`);
      lines.push(`  Body: ${e.body}`);
    }
  }

  if (other.length > 0) {
    lines.push(
      '',
      'Other entries (update if clearly contradicted, otherwise skip):',
    );
    for (const e of other) {
      const excerpt = e.body.length > 100 ? e.body.slice(0, 100) + '…' : e.body;
      lines.push(`- "${e.title}" — ${excerpt}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildExtractPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for post-ingest extraction.
 *
 * @param {string} projectName
 * @param {Array}  events  — [{name, event_type, tool_input, tool_response}]
 * @param {string} existingEntriesBlock
 * @param {string} [userPrompt] — user prompt text, prepended to event block
 * @returns {string}
 */
function buildExtractPrompt(projectName, events, existingEntriesBlock = '', userPrompt = '') {
  const eventLines = formatEventsForLLM(events, { userPrompt });

  const existingBlock = existingEntriesBlock || '';

  const skillTemplate = loadSkillBody('knowledge-extractor');

  if (skillTemplate) {
    return [
      `Project: ${projectName}`,
      '',
      'Analyze the following tool usage events from a Claude Code session and extract',
      'reusable project knowledge that would help future sessions.',
      existingBlock,
      'Events:',
      eventLines,
      '',
      '--- ENTRY FORMAT AND RULES ---',
      '',
      skillTemplate,
      '',
      '--- END FORMAT AND RULES ---',
      '',
      'Extract knowledge entries as a JSON array following the format above.',
      'Respond with a JSON array only. No explanation.',
    ].join('\n');
  }

  // Fallback if skill file is missing — minimal hardcoded rules
  return [
    `Project: ${projectName}`,
    '',
    'Analyze the following tool usage events from a Claude Code session and extract',
    'reusable project knowledge that would help future sessions.',
    existingBlock,
    'Events:',
    eventLines,
    '',
    'Extract knowledge entries as a JSON array. Each entry:',
    '  { "category": "<category>", "title": "<short title>", "body": "<detailed explanation>",',
    '    "source_file": "<file path if relevant, else null>", "tags": ["<tag>", ...] }',
    '',
    'Valid categories: domain, stack, schema, api, feature, architecture, convention,',
    '                  decision, footgun, contract, error_pattern',
    '',
    'Rules:',
    '- Only extract knowledge that CANNOT be derived by reading the source code directly',
    '- Each entry must be ACTIONABLE',
    '- Return [] if nothing genuinely new is found',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// buildCompactExtractPrompt
// ---------------------------------------------------------------------------

/**
 * Builds a compact LLM prompt using the skill's compact instructions section.
 * Used for the Ollama (local) extraction path.
 *
 * @param {string} projectName
 * @param {Array}  events
 * @returns {string|null} — null if compact prompt not available in the skill file
 */
function buildCompactExtractPrompt(projectName, events, existingTitles = [], userPrompt = '') {
  const compact = loadCompactPrompt('knowledge-extractor');
  if (!compact) return null;
  const eventLines = formatEventsForLLM(events, { userPrompt });

  const parts = [
    `Project: ${projectName}`,
    '',
  ];

  if (existingTitles.length > 0) {
    parts.push(
      'Existing entries (do NOT duplicate — update only if events contradict):',
      ...existingTitles.map(t => `- ${t}`),
      '',
    );
  }

  parts.push(
    'Events:',
    eventLines,
    '',
    compact,
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// callClaude
// ---------------------------------------------------------------------------

/**
 * Calls Claude via CLI (`claude -p --output-format json`).
 * Uses the user's Max subscription.
 * Sets OPEN_PULSE_INTERNAL=1 to prevent collector hooks from firing.
 *
 * @param {string} prompt
 * @param {string} [model]
 * @param {object} [opts]
 * @returns {Promise<{output: string, input_tokens: number, output_tokens: number, cost_usd: number, duration_ms: number}>}
 */
function callClaude(prompt, model = 'opus', opts = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = ['-p', '--model', model, '--no-session-persistence', '--output-format', 'json'];
    const proc = spawn('claude', args, {
      env: { ...process.env, OPEN_PULSE_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let killTimer = null;
    let timedOut = false;
    if (opts.timeout) {
      killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, opts.timeout);
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    proc.on('close', code => {
      if (killTimer) clearTimeout(killTimer);
      const duration_ms = Date.now() - startTime;
      if (timedOut) {
        const err = new Error(`claude CLI timed out after ${opts.timeout}ms`);
        err.duration_ms = duration_ms;
        return reject(err);
      }
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          const usage = parsed.usage || {};
          resolve({
            output: parsed.result || '',
            input_tokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
            output_tokens: usage.output_tokens || 0,
            cost_usd: parsed.total_cost_usd || 0,
            duration_ms: parsed.duration_ms || duration_ms,
          });
        } catch {
          // Fallback: treat stdout as plain text if JSON parse fails
          resolve({ output: stdout, input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms });
        }
      } else {
        const err = new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
        err.stderr = stderr;
        err.duration_ms = duration_ms;
        reject(err);
      }
    });

    proc.on('error', err => {
      if (killTimer) clearTimeout(killTimer);
      err.duration_ms = Date.now() - startTime;
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// parseJsonResponse
// ---------------------------------------------------------------------------

/**
 * Extracts a JSON array from LLM response text.
 *
 * Three-tier strategy:
 *   1. Direct JSON.parse (clean responses)
 *   2. Extract from fenced code blocks
 *   3. Non-greedy regex fallback
 *
 * @param {string} text
 * @returns {Array}
 */
function parseJsonResponse(text) {
  if (!text) return [];

  // Tier 1: direct parse
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }

  // Tier 2: fenced code block
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      const arr = JSON.parse(fenced[1].trim());
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through */ }
  }

  // Tier 3: non-greedy regex
  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through */ }
  }

  return [];
}

// ---------------------------------------------------------------------------
// mergeOrUpdate
// ---------------------------------------------------------------------------

/**
 * Upsert knowledge entries into DB and return insert/update counts.
 *
 * Distinguishes insert vs update by comparing created_at === updated_at on
 * the returned row. A fresh insert will have both equal; an update will have
 * updated_at > created_at.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {Array}  newEntries — [{category, title, body, source_file, tags}]
 * @returns {{ inserted: number, updated: number }}
 */
function mergeOrUpdate(db, projectId, newEntries) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const rejectReasons = [];

  for (const raw of newEntries) {
    const check = validateKnowledgeEntry(raw);
    if (!check.valid) {
      skipped++;
      rejectReasons.push(check.reason || 'unknown');
      continue;
    }

    const entry = check.entry;
    const category = VALID_CATEGORIES.has(entry.category) ? entry.category : 'domain';
    const title = entry.title || 'Untitled';

    // Query existing entry BEFORE upsert to capture old state for history
    const existing = db.prepare(
      'SELECT * FROM knowledge_entries WHERE project_id = @project_id AND title = @title COLLATE NOCASE'
    ).get({ project_id: projectId, title });

    const result = upsertKnowledgeEntry(db, {
      project_id:  projectId,
      category,
      title,
      body:        entry.body || '',
      source_file: entry.source_file || null,
      tags:        entry.tags || [],
    });

    if (result.created_at === result.updated_at) {
      // New entry — record 'created' snapshot
      inserted++;
      insertEntryHistory(db, {
        entry_id: result.id,
        change_type: 'created',
        snapshot: { title: result.title, body: result.body, category: result.category, status: result.status },
      });
    } else {
      // Updated entry — record 'updated' snapshot with OLD state
      updated++;
      insertEntryHistory(db, {
        entry_id: result.id,
        change_type: 'updated',
        snapshot: { title: existing.title, body: existing.body, category: existing.category, status: existing.status },
      });
    }
  }

  return { inserted, updated, skipped, rejectReasons };
}

// ---------------------------------------------------------------------------
// extractKnowledgeFromPrompt
// ---------------------------------------------------------------------------

/**
 * Full extraction pipeline triggered after a prompt is ingested.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} promptId
 * @param {object} [opts]
 * @param {number} [opts.maxEvents=50]
 * @returns {Promise<{extracted:number, inserted:number, updated:number}|{message:string}>}
 */
const VALID_EXTRACT_MODELS = new Set(['local', 'haiku', 'sonnet', 'opus']);

async function extractKnowledgeFromPrompt(db, promptId, opts = {}) {
  const maxEvents = opts.maxEvents ?? 50;
  const requestedModel = opts.model || 'local';
  if (!VALID_EXTRACT_MODELS.has(requestedModel)) {
    console.warn(`[knowledge/extract] unknown model "${requestedModel}", falling back to "opus"`);
  }
  const model = VALID_EXTRACT_MODELS.has(requestedModel) ? requestedModel : 'opus';

  // Get prompt
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
  if (!prompt) return { message: `Prompt ${promptId} not found` };

  // Get session
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(prompt.session_id);
  if (!session) return { message: `Session ${prompt.session_id} not found` };

  // Resolve project via working_directory
  const project = db.prepare(
    'SELECT * FROM cl_projects WHERE directory = ?'
  ).get(session.working_directory);
  if (!project) return { message: `No project found for directory: ${session.working_directory}` };

  // Get events for this prompt
  const events = db.prepare(
    'SELECT name, event_type, tool_input, tool_response FROM events WHERE prompt_id = ? ORDER BY seq_num ASC LIMIT ?'
  ).all(promptId, maxEvents);

  if (events.length === 0) return { message: 'No events for this prompt' };

  // Extract affected file paths from events
  const affectedFiles = [];
  for (const ev of events) {
    if (!ev.tool_input) continue;
    try {
      const input = JSON.parse(ev.tool_input);
      const filePath = input.file_path || input.path;
      if (filePath) affectedFiles.push(filePath);
    } catch { /* ignore */ }
  }

  // Build context-aware existing entries block
  const existingEntriesBlock = buildExistingEntriesBlock(db, project.project_id, affectedFiles);

  // Build prompt and call LLM (Claude CLI or local Ollama)
  const projectName = project.name || project.project_id;
  const userPromptText = prompt.prompt_text || '';
  const llmPrompt = buildExtractPrompt(projectName, events, existingEntriesBlock, userPromptText);

  let claudeResult;
  if (model === 'local') {
    // Get existing titles for dedup context
    const existingTitles = db.prepare(
      "SELECT title FROM knowledge_entries WHERE project_id = ? AND status = 'active'"
    ).all(project.project_id).map(r => r.title);
    const compactPrompt = buildCompactExtractPrompt(projectName, events, existingTitles, userPromptText);
    if (!compactPrompt) {
      insertPipelineRun(db, {
        pipeline: 'knowledge_extract',
        project_id: project.project_id,
        model: opts.ollamaModel || 'qwen2.5:7b',
        status: 'skipped',
        error: 'compact prompt unavailable',
      });
      return { inserted: 0, updated: 0, skipped: true };
    }
    try {
      const ollamaResult = await callOllama(compactPrompt, opts.ollamaModel || 'qwen2.5:7b', {
        url: opts.ollamaUrl,
        timeout: opts.ollamaTimeout,
        ...(opts.ollamaMaxRetries != null && { maxRetries: opts.ollamaMaxRetries }),
      });
      claudeResult = {
        output: ollamaResult.output,
        input_tokens: ollamaResult.input_tokens || 0,
        output_tokens: ollamaResult.output_tokens || 0,
        cost_usd: 0,
        duration_ms: ollamaResult.duration_ms,
      };
    } catch (err) {
      const status = (err.code === 'ECONNREFUSED' || err.code === 'CIRCUIT_OPEN' || err.name === 'TimeoutError') ? 'skipped' : 'error';
      insertPipelineRun(db, {
        pipeline: 'knowledge_extract',
        project_id: project.project_id,
        model: opts.ollamaModel || 'qwen2.5:7b',
        status,
        error: err.message,
        duration_ms: 0,
      });
      return { inserted: 0, updated: 0, skipped: true };
    }
  } else {
    try {
      claudeResult = await callClaude(llmPrompt, model);
    } catch (err) {
      insertPipelineRun(db, {
        pipeline: 'knowledge_extract',
        project_id: project.project_id,
        model,
        status: 'error',
        error: err.message,
        duration_ms: err.duration_ms || 0,
      });
      throw err;
    }
  }

  const effectiveModel = model === 'local' ? (opts.ollamaModel || 'qwen2.5:7b') : model;
  const runId = insertPipelineRun(db, {
    pipeline: 'knowledge_extract',
    project_id: project.project_id,
    model: effectiveModel,
    status: 'success',
    input_tokens: claudeResult.input_tokens,
    output_tokens: claudeResult.output_tokens,
    duration_ms: claudeResult.duration_ms,
  });

  const entries = parseJsonResponse(claudeResult.output);
  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated, skipped, rejectReasons } = mergeOrUpdate(db, project.project_id, entries);

  if (rejectReasons && rejectReasons.length > 0) {
    updatePipelineRun(db, runId, {
      error: `${skipped}/${entries.length} entries rejected: ${summarizeRejects(rejectReasons)}`,
    });
  }

  const { renderKnowledgeVault } = require('./vault');
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated, skipped };
}

/**
 * Condenses a list of rejection reasons into "reason1 (x3), reason2 (x1)" form.
 * Keeps logs concise when an LLM produces many malformed entries.
 */
function summarizeRejects(reasons) {
  const counts = new Map();
  for (const r of reasons) counts.set(r, (counts.get(r) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} (x${n})`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildExistingEntriesBlock,
  buildExtractPrompt,
  buildCompactExtractPrompt,
  callClaude,
  parseJsonResponse,
  validateKnowledgeEntry,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
  VALID_CATEGORIES,
  VALID_TAGS,
};
