'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

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
// NOTE: These functions now work with auto_evolves table (new system).
//       The insights table has been removed. These helpers are kept for
//       backward compatibility with existing callers and tests.
// ---------------------------------------------------------------------------

/**
 * Look up an item from auto_evolves table (replaces old getInsight).
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
function lookupItem(db, id) {
  try {
    return db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
  } catch {
    return null;
  }
}

function promoteInsight(db, insightId) {
  const insight = lookupItem(db, insightId);
  if (!insight || !insight.target_type) {
    throw new Error(`Insight not found or no target_type: ${insightId}`);
  }

  const filePath = getComponentPath(insight.target_type, insight.title);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, generateComponentContent(insight), 'utf8');

  try {
    db.prepare(
      "UPDATE auto_evolves SET status = 'promoted', promoted_to = ?, promoted_at = ? WHERE id = ?"
    ).run(filePath, new Date().toISOString(), insightId);
  } catch { /* non-critical */ }

  return { promoted_to: filePath };
}

function revertInsight(db, insightId) {
  const insight = lookupItem(db, insightId);
  if (!insight) throw new Error(`Insight not found: ${insightId}`);

  if (insight.promoted_to && fs.existsSync(insight.promoted_to)) {
    fs.unlinkSync(insight.promoted_to);
    try {
      const dir = path.dirname(insight.promoted_to);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  try {
    db.prepare(
      "UPDATE auto_evolves SET status = 'reverted', promoted_to = NULL WHERE id = ?"
    ).run(insightId);
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Batch promotion check (no-op — auto-evolve module handles promotion now)
// ---------------------------------------------------------------------------

function runPromotionCheck() {
  return 0;
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
