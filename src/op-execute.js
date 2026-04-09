'use strict';

const { spawn } = require('child_process');
const { getInsight, updateInsightStatus, updateInsightActionData } = require('./op-db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `claude` CLI with the given prompt, returning stdout and exit code.
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} opts.maxTurns
 * @param {number} opts.timeout
 * @returns {Promise<{exit_code: number, output: string, error: string}>}
 */
function runClaude(prompt, { model, maxTurns, timeout }) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--model', model, '--max-turns', String(maxTurns), '--print'], {
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SKIP_COLLECT: '1' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      resolve({ exit_code: code ?? 1, output: stdout.trim(), error: stderr.trim() });
    });

    child.on('error', (err) => {
      resolve({ exit_code: 1, output: '', error: err.message });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// executeInsight
// ---------------------------------------------------------------------------

/**
 * Execute an insight's claude_prompt (or fall back to description) via Sonnet.
 * Stores result in action_data.execution_result, sets status to 'executed'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} insightId
 * @returns {Promise<{exit_code: number, output: string, error: string}>}
 */
async function executeInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error(`Insight ${insightId} not found`);

  // Prefer claude_prompt from action_data if available
  let prompt = insight.description;
  if (insight.action_data) {
    try {
      const actionData = typeof insight.action_data === 'string'
        ? JSON.parse(insight.action_data)
        : insight.action_data;
      if (actionData.claude_prompt) {
        prompt = actionData.claude_prompt;
      }
    } catch {
      // keep description as fallback
    }
  }

  const result = await runClaude(prompt, {
    model: 'sonnet',
    maxTurns: 3,
    timeout: 120000,
  });

  // Merge execution_result into existing action_data
  let existing = {};
  if (insight.action_data) {
    try {
      existing = typeof insight.action_data === 'string'
        ? JSON.parse(insight.action_data)
        : insight.action_data;
    } catch {
      existing = {};
    }
  }

  const updated = {
    ...existing,
    execution_result: {
      exit_code: result.exit_code,
      output: result.output,
      error: result.error,
      executed_at: new Date().toISOString(),
    },
  };

  updateInsightActionData(db, insightId, updated);
  updateInsightStatus(db, insightId, 'executed', null);

  return result;
}

// ---------------------------------------------------------------------------
// generatePrompt
// ---------------------------------------------------------------------------

/**
 * Generate a structured action plan for an insight via Haiku.
 * Parses JSON from output (claude_prompt, implementation_steps, what_changes).
 * Stores parsed data in action_data.
 * @param {import('better-sqlite3').Database} db
 * @param {string} insightId
 * @returns {Promise<object>} parsed action data
 */
async function generatePrompt(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error(`Insight ${insightId} not found`);

  const prompt =
    'You are a Claude Code assistant. Given the following insight, generate a structured action plan.\n' +
    'Return ONLY valid JSON with exactly these fields:\n' +
    '{\n' +
    '  "claude_prompt": "A ready-to-use prompt that claude can execute to implement this insight",\n' +
    '  "implementation_steps": ["step 1", "step 2", "..."],\n' +
    '  "what_changes": "Brief description of what files/configs will change"\n' +
    '}\n\n' +
    'Insight title: ' + insight.title + '\n' +
    'Insight description: ' + insight.description + '\n' +
    (insight.category ? 'Category: ' + insight.category + '\n' : '') +
    (insight.target_type ? 'Target type: ' + insight.target_type + '\n' : '') +
    'Return only the JSON object, no markdown fences or explanation.';

  const result = await runClaude(prompt, {
    model: 'haiku',
    maxTurns: 1,
    timeout: 60000,
  });

  if (result.exit_code !== 0) {
    throw new Error(`claude exited with code ${result.exit_code}: ${result.error}`);
  }

  // Extract JSON from output (strip markdown fences if present)
  let jsonStr = result.output;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let actionData;
  try {
    actionData = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse claude output as JSON: ${err.message}\nOutput: ${result.output}`);
  }

  // Merge into existing action_data
  let existing = {};
  if (insight.action_data) {
    try {
      existing = typeof insight.action_data === 'string'
        ? JSON.parse(insight.action_data)
        : insight.action_data;
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, ...actionData };
  updateInsightActionData(db, insightId, merged);

  return merged;
}

module.exports = { executeInsight, generatePrompt };
