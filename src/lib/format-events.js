'use strict';

const DEFAULT_MAX_RESPONSE = 300;
const DEFAULT_EDIT_DIFF = 150;
const DEFAULT_BASH_STDERR = 200;
const DEFAULT_TOTAL_BUDGET = 8000;

/**
 * Formats an array of hook events into a numbered text block for LLM prompts.
 *
 * Each event renders as:
 *   N. [event_type] name [key_field]
 *      → truncated response
 *      diff: -old… +new…             (for Edit/Write)
 *      stderr: …                     (for Bash, when non-empty)
 *
 * @param {Array<{event_type: string, name: string, tool_input: string|null, tool_response: string|null}>} events
 * @param {object} [opts]
 * @param {string} [opts.userPrompt]          — prepended as `User prompt: "…"`
 * @param {number} [opts.maxResponseChars=300]
 * @param {number} [opts.editDiffChars=150]   — per-side budget for Edit old/new segments
 * @param {number} [opts.bashStderrChars=200]
 * @param {number} [opts.totalBudget=8000]    — soft cap on total block length
 * @returns {string}
 */
function formatEventsForLLM(events, opts = {}) {
  const maxResponse = opts.maxResponseChars ?? DEFAULT_MAX_RESPONSE;
  const editDiff = opts.editDiffChars ?? DEFAULT_EDIT_DIFF;
  const bashStderr = opts.bashStderrChars ?? DEFAULT_BASH_STDERR;
  const totalBudget = opts.totalBudget ?? DEFAULT_TOTAL_BUDGET;

  const prefixParts = [];
  if (opts.userPrompt) {
    const trimmed = String(opts.userPrompt).trim();
    if (trimmed) {
      prefixParts.push(`User prompt: ${JSON.stringify(trimmed)}`, '');
    }
  }

  if (!events || events.length === 0) {
    return prefixParts.length > 0 ? prefixParts.join('\n').trimEnd() : '';
  }

  const rendered = events.map((ev, i) => renderEvent(ev, i, { maxResponse, editDiff, bashStderr }));
  const block = [...prefixParts, ...rendered].join('\n');

  if (block.length <= totalBudget) return block;

  // Exceeded budget: shrink per-event response cap and retry once.
  const shrinkRatio = Math.max(0.3, totalBudget / block.length);
  const shrunkResponse = Math.max(80, Math.floor(maxResponse * shrinkRatio));
  const shrunkEdit = Math.max(60, Math.floor(editDiff * shrinkRatio));
  const shrunkStderr = Math.max(80, Math.floor(bashStderr * shrinkRatio));
  const shrunk = events.map((ev, i) => renderEvent(ev, i, {
    maxResponse: shrunkResponse,
    editDiff: shrunkEdit,
    bashStderr: shrunkStderr,
  }));
  return [...prefixParts, ...shrunk].join('\n');
}

function renderEvent(ev, i, caps) {
  const { maxResponse, editDiff, bashStderr } = caps;
  let input = {};
  if (ev.tool_input) {
    try { input = JSON.parse(ev.tool_input); } catch { /* use empty */ }
  }

  const keyField = input.file_path || input.command || input.pattern
    || input.path || input.query || null;
  const detail = keyField ? ` [${keyField}]` : '';
  const lines = [`${i + 1}. [${ev.event_type}] ${ev.name || ''}${detail}`];

  if ((ev.name === 'Edit' || ev.name === 'Write') && (input.old_string || input.new_string || input.content)) {
    const oldSeg = truncate(input.old_string, editDiff);
    const newSeg = truncate(input.new_string || input.content, editDiff);
    if (oldSeg || newSeg) {
      lines.push(`   - ${oldSeg || '(empty)'}`);
      lines.push(`   + ${newSeg || '(empty)'}`);
    }
  }

  let response = '';
  if (ev.tool_response) {
    response = String(ev.tool_response).slice(0, maxResponse);
    if (ev.tool_response.length > maxResponse) response += '…';
  }
  if (response) lines.push(`   → ${response}`);

  if (ev.name === 'Bash' && ev.tool_response) {
    const stderr = extractBashStderr(ev.tool_response, bashStderr);
    if (stderr) lines.push(`   stderr: ${stderr}`);
  }

  return lines.join('\n');
}

function truncate(str, limit) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}

function extractBashStderr(rawResponse, limit) {
  try {
    const parsed = JSON.parse(rawResponse);
    const stderr = parsed && (parsed.stderr || parsed.error);
    if (!stderr) return '';
    return truncate(stderr, limit);
  } catch {
    return '';
  }
}

module.exports = { formatEventsForLLM };
