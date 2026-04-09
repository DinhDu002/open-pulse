'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getInsight, updateInsightStatus, getPromotableInsights, updateInsightFeedback } = require('./op-db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getComponentPath(targetType, name) {
  const slug = slugify(name);
  const claudeDir = getClaudeDir();

  switch (targetType) {
    case 'rule':      return path.join(claudeDir, 'rules', `${slug}.md`);
    case 'hook':      return path.join(claudeDir, 'hooks', `${slug}.sh`);
    case 'skill':     return path.join(claudeDir, 'skills', slug, 'SKILL.md');
    case 'agent':     return path.join(claudeDir, 'agents', `${slug}.md`);
    case 'knowledge': return path.join(claudeDir, 'knowledge', `${slug}.md`);
    default:          return path.join(claudeDir, 'rules', `${slug}.md`);
  }
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

function generateComponentContent(insight) {
  const { target_type, title, description, category, confidence } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

    case 'hook':
      return [
        '#!/bin/bash',
        `# Hook: ${title}`,
        `# Category: ${category}`,
        `# Auto-promoted from insight (confidence: ${confidence})`,
        '',
        `# ${description}`,
        'exit 0',
        '',
      ].join('\n');

    case 'skill':
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${title}`,
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');

    case 'agent':
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${title}`,
        'model: haiku',
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    default:
      return `# ${title}\n\n${description}\n`;
  }
}

// ---------------------------------------------------------------------------
// Promote / Revert
// ---------------------------------------------------------------------------

function promoteInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight || !insight.target_type) {
    throw new Error(`Insight not found or no target_type: ${insightId}`);
  }

  const filePath = getComponentPath(insight.target_type, insight.title);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, generateComponentContent(insight), 'utf8');

  updateInsightStatus(db, insightId, 'promoted', filePath);
  return { promoted_to: filePath };
}

function revertInsight(db, insightId) {
  const insight = getInsight(db, insightId);
  if (!insight) throw new Error(`Insight not found: ${insightId}`);

  if (insight.promoted_to && fs.existsSync(insight.promoted_to)) {
    fs.unlinkSync(insight.promoted_to);
    // Clean up empty parent dir (non-critical)
    try {
      const dir = path.dirname(insight.promoted_to);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  updateInsightStatus(db, insightId, 'reverted', null);
  // Lower confidence so it does not auto-promote again immediately
  updateInsightFeedback(db, insightId, 'reject');
}

// ---------------------------------------------------------------------------
// Batch promotion check
// ---------------------------------------------------------------------------

function runPromotionCheck(db) {
  const ready = getPromotableInsights(db);
  let promoted = 0;
  for (const insight of ready) {
    try {
      promoteInsight(db, insight.id);
      promoted++;
    } catch { /* skip individual failures, log non-critically */ }
  }
  return promoted;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  slugify,
  getComponentPath,
  generateComponentContent,
  promoteInsight,
  revertInsight,
  runPromotionCheck,
};
