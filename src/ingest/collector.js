'use strict';

// Skip collection when invoked by internal knowledge extraction (prevent feedback loop)
if (process.env.OPEN_PULSE_INTERNAL === '1') {
  process.exit(0);
}

const fs = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DETAIL_LENGTH = 500;
const MAX_TOOL_DATA_LENGTH = 5000;
const MAX_STDIN = 1024 * 1024;
const MAX_PROMPT_LENGTH = 1000;

const SECRET_PATTERN = /(api_key|token|secret|password|authorization|credentials|auth)['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-\/.+=]{8,}/gi;

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
 * Redact potential secrets from a string.
 * @param {string} str
 * @returns {string}
 */
function scrubSecrets(str) {
  if (typeof str !== 'string') return str;
  return str.replace(SECRET_PATTERN, (match) => {
    const sepIdx = match.search(/[:=]/);
    if (sepIdx === -1) return '[REDACTED]';
    return match.slice(0, sepIdx + 1) + ' [REDACTED]';
  });
}

/**
 * Stringify and truncate tool data (input or response) for CL analysis.
 * @param {*} data
 * @returns {string|null}
 */
function serializeToolData(data) {
  if (data == null) return null;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return scrubSecrets(truncate(str, MAX_TOOL_DATA_LENGTH));
}

/**
 * Read a Claude Code session transcript JSONL and sum token usage
 * across all assistant turns.
 * @param {string} transcriptPath  absolute path to the .jsonl transcript
 * @returns {{ input_tokens: number, output_tokens: number }}
 */
function readTranscriptUsage(transcriptPath) {
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant') continue;
      const usage = (obj.message || {}).usage;
      if (!usage) continue;
      inputTokens += (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      outputTokens += (usage.output_tokens || 0);
    }
  } catch {
    // Transcript unreadable — fall back to zero
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/**
 * Generate a monotonic sequence number using millisecond timestamp.
 * No file I/O — eliminates .seq-* state files.
 * @returns {number}
 */
function nextSeqNum() {
  return Date.now();
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

function getRepoDir() {
  return path.resolve(__dirname, '../..');
}

// ─── Last Prompt ──────────────────────────────────────────────────────────────

/**
 * Persist the last prompt for correlation with subsequent events.
 * Scoped per session to avoid cross-contamination between concurrent sessions.
 * @param {string} repoDir
 * @param {string} sessionId
 * @param {string} prompt
 */
function saveLastPrompt(repoDir, sessionId, prompt) {
  const filePath = path.join(repoDir, 'data', `.last-prompt-${sessionId}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, truncate(prompt, MAX_PROMPT_LENGTH), 'utf8');
}

/**
 * Read the persisted last prompt for a specific session.
 * @param {string} repoDir
 * @param {string} sessionId
 * @returns {string}
 */
function readLastPrompt(repoDir, sessionId) {
  const filePath = path.join(repoDir, 'data', `.last-prompt-${sessionId}`);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Clean up per-session prompt file when session ends.
 * @param {string} repoDir
 * @param {string} sessionId
 */
function cleanLastPrompt(repoDir, sessionId) {
  const filePath = path.join(repoDir, 'data', `.last-prompt-${sessionId}`);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
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
 * @param {object} opts       { seqNum }
 * @returns {object}
 */
function parseEvent(hookType, input, sessionId, workDir, model, opts = {}) {
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
  const toolName     = input.tool_name     || '';
  const toolInput    = input.tool_input    || {};
  const toolResponse = input.tool_response ?? null;
  const durationMs   = input.duration_ms   || null;
  const success      = input.is_error != null ? !input.is_error : null;
  const seqNum       = opts.seqNum ?? null;

  // Full tool data for CL analysis (scrubbed + truncated)
  const fullInput    = serializeToolData(toolInput);
  const fullResponse = serializeToolData(toolResponse);

  // Skill tool
  if (toolName === 'Skill') {
    const skillName = toolInput.skill || '';
    return {
      ...base,
      // Short-form
      type:   'skill_invoke',
      name:   skillName,
      dur:    durationMs,
      detail: scrubSecrets(truncate(toolInput.args || '', MAX_DETAIL_LENGTH)),
      // DB-form
      event_type:    'skill_invoke',
      duration_ms:   durationMs,
      tool_input:    fullInput,
      tool_response: fullResponse,
      seq_num:       seqNum,
      success,
    };
  }

  // Agent tool
  if (toolName === 'Agent') {
    const agentName = toolInput.subagent_type || 'general-purpose';
    return {
      ...base,
      // Short-form
      type:   'agent_spawn',
      name:   agentName,
      dur:    durationMs,
      detail: scrubSecrets(truncate(toolInput.description || '', MAX_DETAIL_LENGTH)),
      // DB-form
      event_type:    'agent_spawn',
      duration_ms:   durationMs,
      tool_input:    fullInput,
      tool_response: fullResponse,
      seq_num:       seqNum,
      success,
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
    detail: scrubSecrets(truncate(String(detailSource), MAX_DETAIL_LENGTH)),
    // DB-form
    event_type:    'tool_call',
    duration_ms:   durationMs,
    tool_input:    fullInput,
    tool_response: fullResponse,
    seq_num:       seqNum,
    success,
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

  // Skip collection for automated sessions (e.g. observer's Haiku analysis)
  if (process.env.OP_SKIP_COLLECT === '1') {
    process.exit(0);
  }

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
      saveLastPrompt(repoDir, sessionId, prompt);
      process.exit(0);
    }

    // ── all other hooks: parse + write event ───────────────────────────────
    // For stop hooks: read transcript to get actual token usage
    if (hookType === 'stop' && input.transcript_path) {
      const usage = readTranscriptUsage(input.transcript_path);
      if (usage.input_tokens > 0 || usage.output_tokens > 0) {
        input.usage = usage;
      }
    }

    const seqNum = nextSeqNum();
    const event = parseEvent(hookType, input, sessionId, workDir, model, { seqNum });
    const userPrompt = readLastPrompt(repoDir, sessionId);
    const eventWithPrompt = userPrompt ? { ...event, user_prompt: userPrompt } : event;
    appendToFile(path.join(repoDir, 'data', 'events.jsonl'), eventWithPrompt);

    // Clean up per-session prompt file when session ends
    if (hookType === 'stop') {
      cleanLastPrompt(repoDir, sessionId);
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

module.exports = { parseEvent, estimateCost, readTranscriptUsage, appendToFile, truncate, scrubSecrets, serializeToolData, nextSeqNum, saveLastPrompt, readLastPrompt, cleanLastPrompt, main };

if (require.main === module) {
  main().catch(err => {
    // Silent failure — hooks must not break Claude
    process.exit(0);
  });
}
