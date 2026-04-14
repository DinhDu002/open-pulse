'use strict';

const MAX_RESPONSE_LENGTH = 300;

/**
 * Formats an array of hook events into a numbered text block for LLM prompts.
 *
 * Each event is rendered as:
 *   N. [event_type] name [key_field]
 *      → truncated_response (max 300 chars)
 *
 * @param {Array<{event_type: string, name: string, tool_input: string|null, tool_response: string|null}>} events
 * @returns {string}
 */
function formatEventsForLLM(events) {
  if (!events || events.length === 0) return '';

  return events.map((ev, i) => {
    let detail = '';

    // Extract key fields from tool_input JSON
    if (ev.tool_input) {
      let input = {};
      try { input = JSON.parse(ev.tool_input); } catch { /* use empty */ }

      const key = input.file_path || input.command || input.pattern
        || input.path || input.query || null;
      if (key) detail += ` [${key}]`;
    }

    // Truncate tool_response to MAX_RESPONSE_LENGTH chars
    let response = '';
    if (ev.tool_response) {
      response = String(ev.tool_response).slice(0, MAX_RESPONSE_LENGTH);
      if (ev.tool_response.length > MAX_RESPONSE_LENGTH) response += '…';
    }

    const lines = [`${i + 1}. [${ev.event_type}] ${ev.name || ''}${detail}`];
    if (response) lines.push(`   → ${response}`);
    return lines.join('\n');
  }).join('\n');
}

module.exports = { formatEventsForLLM };
