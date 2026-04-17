'use strict';

const path = require('path');
const fs = require('fs');
const { slugify } = require('../lib/slugify');
const { getComponentPath } = require('../lib/paths');

// ---------------------------------------------------------------------------
// Component content generation
// ---------------------------------------------------------------------------

function generateComponent(insight) {
  const { target_type, title, description } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

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

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    case 'agent': {
      const rawFirstLine = (description || title).split('\n')[0].trim().slice(0, 200);
      const firstLine = rawFirstLine || title;
      const name = slugify(title) || 'unnamed-agent';
      return [
        '---',
        `name: ${name}`,
        `description: ${firstLine}`,
        'model: sonnet',
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');
    }

    default:
      return `# ${title}\n\n${description}\n`;
  }
}

// ---------------------------------------------------------------------------
// Auto-promote cycle
// ---------------------------------------------------------------------------

// Promote a single active row. Bypasses blacklist/threshold checks —
// caller is responsible for deciding whether the row should be promoted.
// Returns { filePath } on success; throws on failure.
function promoteOne(db, row, opts = {}) {
  const { logDir } = opts;

  const filePath = getComponentPath(row.target_type, row.title);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, generateComponent(row), 'utf8');

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE auto_evolves
    SET status = 'promoted', promoted_to = ?, promoted_at = ?, updated_at = ?
    WHERE id = ?
  `).run(filePath, now, now, row.id);

  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'auto-evolve.log');
    const logLine = `[${now}] PROMOTED ${row.target_type} "${row.title}" -> ${filePath}\n`;
    fs.appendFileSync(logPath, logLine);
  }

  return { filePath };
}

function runAutoEvolve(db, opts = {}) {
  const {
    min_confidence = 0.85,
    blacklist = ['hook'],
    logDir,
  } = opts;

  const allTypes = ['rule', 'knowledge', 'skill', 'agent', 'hook'];
  const allowed = allTypes.filter(t => !blacklist.includes(t));
  const placeholders = allowed.map(() => '?').join(',');

  // Require at least 3 days between first observation (created_at) and last (updated_at)
  // to prevent burst-promotion from rapid repeated detections
  const ready = db.prepare(`
    SELECT * FROM auto_evolves
    WHERE status = 'active'
      AND confidence >= ?
      AND rejection_count = 0
      AND target_type IN (${placeholders})
      AND (julianday(updated_at) - julianday(created_at)) >= 3
  `).all(min_confidence, ...allowed);

  let promoted = 0;

  for (const row of ready) {
    try {
      promoteOne(db, row, { logDir });
      promoted++;
    } catch { /* skip individual failures */ }
  }

  return { promoted };
}

module.exports = { generateComponent, runAutoEvolve, promoteOne };
