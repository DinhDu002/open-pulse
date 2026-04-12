'use strict';

const path = require('path');
const fs = require('fs');
const { callClaude } = require('../knowledge/extract');
const { savePlan, updatePlanStatus } = require('./queries');
const { updatePipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Concurrency state (in-memory, resets on server restart)
// ---------------------------------------------------------------------------

let activePlanGenerations = 0;
const activeReviewIds = new Set();

// ---------------------------------------------------------------------------
// resolveTargetFiles
// ---------------------------------------------------------------------------

function listFilesByMtime(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const matched = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (predicate(entry, full)) {
      try {
        const stat = fs.statSync(full);
        matched.push({ path: full, mtime: stat.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  matched.sort((a, b) => b.mtime - a.mtime);
  return matched.map(m => m.path);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function resolveTargetFiles(suggestion, claudeDir, maxKb) {
  const result = [];
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = readFileSafe(claudeMdPath);
  if (claudeMdContent !== null) {
    result.push({ path: claudeMdPath, content: claudeMdContent });
  }

  const targetType = suggestion && suggestion.target_type;
  const candidatePaths = [];

  switch (targetType) {
    case 'rule': {
      const rulesDir = path.join(claudeDir, 'rules');
      const rulePaths = listFilesByMtime(rulesDir, (entry) =>
        entry.isFile() && entry.name.endsWith('.md')
      ).slice(0, 10);
      candidatePaths.push(...rulePaths);
      break;
    }
    case 'skill': {
      const skillsDir = path.join(claudeDir, 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of skillEntries) {
          if (entry.isDirectory()) {
            const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
            if (fs.existsSync(skillFile)) candidatePaths.push(skillFile);
          }
        }
      }
      break;
    }
    case 'agent': {
      const agentsDir = path.join(claudeDir, 'agents');
      const agentPaths = listFilesByMtime(agentsDir, (entry) =>
        entry.isFile() && entry.name.endsWith('.md')
      );
      candidatePaths.push(...agentPaths);
      break;
    }
    case 'memory':
      // CLAUDE.md already added
      break;
    case 'config': {
      const settingsPath = path.join(claudeDir, 'settings.json');
      if (fs.existsSync(settingsPath)) candidatePaths.push(settingsPath);
      break;
    }
    case 'knowledge': {
      // Best effort: read from suggestion.projects first project
      let projects = [];
      try {
        projects = JSON.parse(suggestion.projects || '[]');
      } catch { /* ignore */ }
      if (projects.length > 0) {
        // Project path resolution is best-effort: assume project name matches dir basename
        // somewhere under home. Skip if not found.
        // For now, only include CLAUDE.md (already added).
      }
      break;
    }
    default:
      // Unknown target_type — only CLAUDE.md is included
      break;
  }

  // Read candidate file contents and append until size cap is reached
  const maxBytes = Math.max(0, maxKb * 1024);
  let currentBytes = result.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);

  for (const p of candidatePaths) {
    const content = readFileSafe(p);
    if (content === null) continue;
    const size = Buffer.byteLength(content, 'utf8');
    if (currentBytes + size > maxBytes) {
      result.push({ path: '[truncated]', content: '[truncated due to size cap]' });
      break;
    }
    result.push({ path: p, content });
    currentBytes += size;
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildPlanPrompt
// ---------------------------------------------------------------------------

function buildPlanPrompt(suggestion, targetFiles) {
  const lines = [];
  lines.push('You are a planning assistant for Open Pulse. You will read a daily-review');
  lines.push('suggestion and produce (a) a markdown plan for the user to review and (b) a');
  lines.push('ready-to-paste handoff prompt for a fresh Claude Code session to actually');
  lines.push('implement the change. Open Pulse will not auto-run anything.');
  lines.push('');
  lines.push('## Suggestion');
  lines.push(`Title: ${suggestion.title || ''}`);
  lines.push(`Category: ${suggestion.category || ''}`);
  lines.push(`Target type: ${suggestion.target_type || ''}`);
  lines.push(`Action: ${suggestion.action || ''}`);
  lines.push(`Description: ${suggestion.description || ''}`);
  lines.push(`Reasoning: ${suggestion.reasoning || ''}`);
  lines.push('');
  lines.push('## Target files');
  if (!targetFiles || targetFiles.length === 0) {
    lines.push('(no target files provided)');
  } else {
    for (const f of targetFiles) {
      lines.push(`### ${f.path}`);
      lines.push(f.content);
      lines.push('');
    }
  }
  lines.push('');
  lines.push('## Output format (REQUIRED)');
  lines.push('Respond with EXACTLY two fenced blocks, no preamble:');
  lines.push('');
  lines.push('```markdown plan');
  lines.push('<human-readable plan: rationale, steps, file paths, snippets>');
  lines.push('```');
  lines.push('');
  lines.push('```text handoff');
  lines.push('<literal prompt the user will paste into a fresh Claude Code session>');
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parsePlanOutput
// ---------------------------------------------------------------------------

function parsePlanOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') {
    throw new Error('Failed to parse plan: missing `markdown plan` block');
  }
  const planMatch = rawOutput.match(/```markdown\s+plan\s*\n([\s\S]*?)\n```/);
  const handoffMatch = rawOutput.match(/```text\s+handoff\s*\n([\s\S]*?)\n```/);
  if (!planMatch) {
    throw new Error('Failed to parse plan: missing `markdown plan` block');
  }
  if (!handoffMatch) {
    throw new Error('Failed to parse plan: missing `text handoff` block');
  }
  return {
    plan_md: planMatch[1].trim(),
    handoff_prompt: handoffMatch[1].trim(),
  };
}

// ---------------------------------------------------------------------------
// generatePlanAsync
// ---------------------------------------------------------------------------

async function generatePlanAsync(db, reviewId, opts) {
  const { model, timeout, max_context_kb, runId, suggestion, claudeDir } = opts;
  const startedAt = Date.now();
  try {
    const targetFiles = resolveTargetFiles(suggestion, claudeDir, max_context_kb);
    const prompt = buildPlanPrompt(suggestion, targetFiles);
    const result = await callClaude(prompt, model, { timeout });

    const { plan_md, handoff_prompt } = parsePlanOutput(result.output);
    savePlan(db, reviewId, plan_md, handoff_prompt, runId);
    updatePipelineRun(db, runId, {
      status: 'success',
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      duration_ms: result.duration_ms,
    });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const message = (err && err.message) ? err.message : String(err);
    updatePlanStatus(db, reviewId, 'error', message);
    updatePipelineRun(db, runId, {
      status: 'error',
      error: message,
      duration_ms,
    });
  } finally {
    activePlanGenerations--;
    activeReviewIds.delete(reviewId);
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveTargetFiles,
  buildPlanPrompt,
  parsePlanOutput,
  generatePlanAsync,
  get activePlanGenerations() { return activePlanGenerations; },
  increment() { activePlanGenerations++; },
  decrement() { activePlanGenerations--; },
  activeReviewIds,
};
