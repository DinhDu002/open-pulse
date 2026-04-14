'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  upsertKnowledgeEntry,
  getExistingTitles,
  insertEntryHistory,
} = require('./queries');
const { insertPipelineRun } = require('../db/pipeline-runs');
const { formatEventsForLLM } = require('../lib/format-events');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'domain', 'stack', 'schema', 'api', 'feature', 'architecture',
  'convention', 'decision', 'footgun', 'contract', 'error_pattern',
]);

// ---------------------------------------------------------------------------
// loadSkillTemplate
// ---------------------------------------------------------------------------

/**
 * Reads the knowledge-extractor skill file as the source of truth for
 * extraction rules. Returns the markdown content (without YAML frontmatter)
 * or null if the file is missing.
 */
function loadSkillTemplate() {
  const skillPath = path.join(__dirname, '..', '..', 'claude', 'skills', 'knowledge-extractor', 'SKILL.md');
  try {
    const raw = fs.readFileSync(skillPath, 'utf8');
    // Strip YAML frontmatter (between --- markers)
    const stripped = raw.replace(/^---[\s\S]*?---\s*/, '');
    return stripped.trim();
  } catch {
    return null;
  }
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
 * @returns {string}
 */
function buildExtractPrompt(projectName, events, existingEntriesBlock = '') {
  const eventLines = formatEventsForLLM(events);

  const existingBlock = existingEntriesBlock || '';

  const skillTemplate = loadSkillTemplate();

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
 * @param {string} text
 * @returns {Array}
 */
function parseJsonResponse(text) {
  if (!text) return [];
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
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

  for (const entry of newEntries) {
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

  return { inserted, updated };
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
async function extractKnowledgeFromPrompt(db, promptId, opts = {}) {
  const maxEvents = opts.maxEvents ?? 50;
  const model = opts.model || 'opus';

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

  // Build prompt and call Claude CLI
  const llmPrompt = buildExtractPrompt(project.name || project.project_id, events, existingEntriesBlock);

  let claudeResult;
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

  insertPipelineRun(db, {
    pipeline: 'knowledge_extract',
    project_id: project.project_id,
    model,
    status: 'success',
    input_tokens: claudeResult.input_tokens,
    output_tokens: claudeResult.output_tokens,
    duration_ms: claudeResult.duration_ms,
  });

  const entries = parseJsonResponse(claudeResult.output);
  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  const { inserted, updated } = mergeOrUpdate(db, project.project_id, entries);

  const { renderKnowledgeVault } = require('./vault');
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadSkillTemplate,
  buildExistingEntriesBlock,
  buildExtractPrompt,
  callClaude,
  parseJsonResponse,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
};
