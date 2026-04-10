'use strict';

const { spawn } = require('child_process');

const {
  upsertKnowledgeEntry,
  getExistingTitles,
} = require('./queries');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'domain', 'stack', 'schema', 'api', 'feature', 'architecture',
  'convention', 'decision', 'footgun', 'contract', 'error_pattern',
]);

// ---------------------------------------------------------------------------
// buildExtractPrompt
// ---------------------------------------------------------------------------

/**
 * Builds LLM prompt for post-ingest extraction.
 *
 * @param {string} projectName
 * @param {Array}  events  — [{name, event_type, tool_input, tool_response}]
 * @param {string[]} existingTitles
 * @returns {string}
 */
function buildExtractPrompt(projectName, events, existingTitles = []) {
  const eventLines = events.map((ev, i) => {
    let detail = '';

    // Extract key fields from tool_input JSON
    if (ev.tool_input) {
      let input = {};
      try { input = JSON.parse(ev.tool_input); } catch { /* use empty */ }

      const key = input.file_path || input.command || input.pattern
        || input.path || input.query || null;
      if (key) detail += ` [${key}]`;
    }

    // Truncate tool_response to 300 chars
    let response = '';
    if (ev.tool_response) {
      response = String(ev.tool_response).slice(0, 300);
      if (ev.tool_response.length > 300) response += '…';
    }

    const lines = [`${i + 1}. [${ev.event_type}] ${ev.name || ''}${detail}`];
    if (response) lines.push(`   → ${response}`);
    return lines.join('\n');
  }).join('\n');

  const existingBlock = existingTitles.length
    ? `\nExisting knowledge titles (avoid duplicating these — compare case-insensitively):\n${existingTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

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
    '- Focus on: WHY decisions were made, gotchas/footguns encountered, non-obvious conventions,',
    '  edge cases discovered during development, integration quirks',
    '- Do NOT extract: file/module descriptions, API endpoint lists, tech stack enumerations,',
    '  database schema descriptions, configuration key listings, generic programming best practices',
    '- Skip anything already in the existing titles list (compare case-insensitively)',
    '- Each entry must be ACTIONABLE — it should change how a developer approaches the code,',
    '  not just describe what exists',
    '- Prefer updating an existing entry over creating a near-duplicate',
    '- Return [] if nothing genuinely new and reusable is found (this is the expected common case)',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// callClaude
// ---------------------------------------------------------------------------

/**
 * Calls Claude via CLI (`claude -p`). Uses the user's Max subscription.
 * Sets OPEN_PULSE_INTERNAL=1 to prevent collector hooks from firing.
 *
 * @param {string} prompt
 * @param {string} [model]
 * @returns {Promise<string>} response text
 */
function callClaude(prompt, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--no-session-persistence'];
    const proc = spawn('claude', args, {
      env: { ...process.env, OPEN_PULSE_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', err => {
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

    const result = upsertKnowledgeEntry(db, {
      project_id:  projectId,
      category,
      title:       entry.title || 'Untitled',
      body:        entry.body || '',
      source_file: entry.source_file || null,
      tags:        entry.tags || [],
    });

    // created_at === updated_at → just inserted; otherwise updated
    if (result.created_at === result.updated_at) {
      inserted++;
    } else {
      updated++;
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
  const model = opts.model || 'sonnet';

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

  // Get existing titles for dedup
  const existingTitles = getExistingTitles(db, project.project_id);

  // Build prompt and call Claude CLI
  const llmPrompt = buildExtractPrompt(project.name || project.project_id, events, existingTitles);
  const rawResponse = await callClaude(llmPrompt, model);
  const entries = parseJsonResponse(rawResponse);

  if (entries.length === 0) return { extracted: 0, inserted: 0, updated: 0 };

  // Merge into DB
  const { inserted, updated } = mergeOrUpdate(db, project.project_id, entries);

  // Render vault (lazy-require to avoid circular dependency)
  const { renderKnowledgeVault } = require('./vault');
  renderKnowledgeVault(db, project.project_id);

  return { extracted: entries.length, inserted, updated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildExtractPrompt,
  callClaude,
  parseJsonResponse,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
};
