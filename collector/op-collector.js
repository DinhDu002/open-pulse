'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DETAIL_LENGTH = 500;
const MAX_STDIN = 1024 * 1024;
const MAX_PROMPT_LENGTH = 1000;

const TOKEN_RATES = {
  haiku:  { input: 0.8,  output: 4.0  },
  sonnet: { input: 3.0,  output: 15.0 },
  opus:   { input: 15.0, output: 75.0 },
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Truncate a string to maxLen characters.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/**
 * Estimate cost in USD based on model and token counts.
 * Rates are per-million tokens.
 * @param {string} model  e.g. 'opus', 'sonnet', 'haiku'
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
function estimateCost(model, inputTokens, outputTokens) {
  // Normalize model name: 'claude-opus-4-6' → 'opus', etc.
  const key = Object.keys(TOKEN_RATES).find(k => model.includes(k)) || 'sonnet';
  const rates = TOKEN_RATES[key];
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

/**
 * Append a JSON object as a newline-delimited record to a file.
 * Creates parent directories if they don't exist.
 * @param {string} filePath
 * @param {object} data
 */
function appendToFile(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n', 'utf8');
}

// ─── Repo Discovery ───────────────────────────────────────────────────────────

/**
 * Read ~/.open-pulse-path to find the repo directory.
 * @returns {string|null}
 */
function getRepoDir() {
  const pointer = path.join(os.homedir(), '.open-pulse-path');
  try {
    return fs.readFileSync(pointer, 'utf8').trim();
  } catch {
    return null;
  }
}

// ─── Last Prompt ──────────────────────────────────────────────────────────────

/**
 * Persist the last prompt for correlation with subsequent events.
 * @param {string} repoDir
 * @param {string} prompt
 */
function saveLastPrompt(repoDir, prompt) {
  const filePath = path.join(repoDir, 'data', '.last-prompt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, truncate(prompt, MAX_PROMPT_LENGTH), 'utf8');
}

/**
 * Read the persisted last prompt.
 * @param {string} repoDir
 * @returns {string}
 */
function readLastPrompt(repoDir) {
  const filePath = path.join(repoDir, 'data', '.last-prompt');
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ─── Event Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a hook payload into a structured event object.
 *
 * Returns an object with both:
 *   - Short-form fields: ts, sid, type, name, detail, dur
 *   - DB-form fields:    timestamp, session_id, event_type, etc.
 *
 * @param {string} hookType   'pre-tool' | 'post-tool' | 'stop' | 'prompt' | ...
 * @param {object} input      Parsed JSON from stdin
 * @param {string} sessionId
 * @param {string} workDir
 * @param {string} model
 * @returns {object}
 */
function parseEvent(hookType, input, sessionId, workDir, model) {
  const now = new Date().toISOString();
  const base = {
    // Short-form
    ts:  now,
    sid: sessionId,
    // DB-form
    timestamp:  now,
    session_id: sessionId,
    work_dir:   workDir,
    model,
  };

  // ── stop hook → session_end ──────────────────────────────────────────────
  if (hookType === 'stop') {
    const usage       = input.usage || {};
    const inputTokens = usage.input_tokens  || 0;
    const outTokens   = usage.output_tokens || 0;
    const costUsd     = input.cost_usd != null
      ? input.cost_usd
      : estimateCost(model, inputTokens, outTokens);

    return {
      ...base,
      // Short-form
      type: 'session_end',
      // DB-form
      event_type:          'session_end',
      input_tokens:        inputTokens,
      output_tokens:       outTokens,
      estimated_cost_usd:  costUsd,
    };
  }

  // ── tool hooks ───────────────────────────────────────────────────────────
  const toolName   = input.tool_name   || '';
  const toolInput  = input.tool_input  || {};
  const durationMs = input.duration_ms || null;

  // Skill tool
  if (toolName === 'Skill') {
    const skillName = toolInput.skill || '';
    return {
      ...base,
      // Short-form
      type:   'skill_invoke',
      name:   skillName,
      dur:    durationMs,
      detail: truncate(toolInput.args || '', MAX_DETAIL_LENGTH),
      // DB-form
      event_type:  'skill_invoke',
      duration_ms: durationMs,
    };
  }

  // Agent tool
  if (toolName === 'Agent') {
    const agentName = toolInput.subagent_type || '';
    return {
      ...base,
      // Short-form
      type:   'agent_spawn',
      name:   agentName,
      dur:    durationMs,
      detail: truncate(toolInput.description || '', MAX_DETAIL_LENGTH),
      // DB-form
      event_type:  'agent_spawn',
      duration_ms: durationMs,
    };
  }

  // Generic tool call
  const detailSource = toolInput.file_path
    || toolInput.command
    || toolInput.pattern
    || toolInput.query
    || '';

  return {
    ...base,
    // Short-form
    type:   'tool_call',
    name:   toolName,
    dur:    durationMs,
    detail: truncate(String(detailSource), MAX_DETAIL_LENGTH),
    // DB-form
    event_type:  'tool_call',
    duration_ms: durationMs,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Entry point when run as a Claude Code hook.
 *
 * Reads JSON from stdin, parses the hook type from argv[2], writes events
 * to JSONL files in data/, and passes stdin through to stdout for chaining.
 */
async function main() {
  const hookType = process.argv[2] || 'unknown';

  // Read stdin
  let rawInput = '';
  try {
    rawInput = await readStdin();
  } catch (err) {
    // Can't read stdin — bail silently
    process.exit(0);
  }

  // Always pass through to stdout for hook chaining
  process.stdout.write(rawInput);

  const repoDir = getRepoDir();
  if (!repoDir) {
    // No repo configured — skip writing
    process.exit(0);
  }

  let input = {};
  try {
    if (rawInput.trim()) {
      input = JSON.parse(rawInput);
    }
  } catch (err) {
    appendToFile(path.join(repoDir, 'data', 'errors.jsonl'), {
      ts:    new Date().toISOString(),
      error: 'json_parse_error',
      msg:   err.message,
      raw:   rawInput.slice(0, 200),
    });
    process.exit(0);
  }

  const sessionId = input.session_id || '';
  const workDir   = input.cwd        || '';
  const model     = input.model      || 'sonnet';

  try {
    // ── prompt hook: save last prompt ──────────────────────────────────────
    if (hookType === 'prompt') {
      const prompt = input.prompt || '';
      saveLastPrompt(repoDir, prompt);
      process.exit(0);
    }

    // ── all other hooks: parse + write event ───────────────────────────────
    const event = parseEvent(hookType, input, sessionId, workDir, model);
    appendToFile(path.join(repoDir, 'data', 'events.jsonl'), event);

    // ── stop: also write session summary ──────────────────────────────────
    if (hookType === 'stop') {
      const session = {
        ts:                  event.ts,
        session_id:          sessionId,
        work_dir:            workDir,
        model,
        input_tokens:        event.input_tokens,
        output_tokens:       event.output_tokens,
        estimated_cost_usd:  event.estimated_cost_usd,
        last_prompt:         readLastPrompt(repoDir),
      };
      appendToFile(path.join(repoDir, 'data', 'sessions.jsonl'), session);
    }
  } catch (err) {
    appendToFile(path.join(repoDir, 'data', 'errors.jsonl'), {
      ts:       new Date().toISOString(),
      error:    'processing_error',
      hookType,
      msg:      err.message,
    });
  }

  process.exit(0);
}

/**
 * Read up to MAX_STDIN bytes from stdin.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_STDIN) {
        reject(new Error('stdin too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { parseEvent, estimateCost, appendToFile, truncate };

if (require.main === module) {
  main().catch(err => {
    // Silent failure — hooks must not break Claude
    process.exit(0);
  });
}
