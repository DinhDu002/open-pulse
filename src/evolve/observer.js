#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { parseFrontmatter, extractBody } = require('../lib/frontmatter');

// ---------------------------------------------------------------------------
// Active project query
// ---------------------------------------------------------------------------

/**
 * Find projects that have recent events (at least 3 in the window).
 * Returns rows with project_id, name, directory, and recent_events count,
 * ordered by event count DESC and capped at maxProjects.
 */
function queryActiveProjects(db, windowHours, maxProjects) {
  return db.prepare(`
    SELECT p.project_id, p.name, p.directory, COUNT(e.id) AS recent_events
    FROM cl_projects p
    JOIN events e ON e.working_directory LIKE p.directory || '%'
    WHERE e.timestamp >= datetime('now', ?)
    GROUP BY p.project_id, p.name, p.directory
    HAVING recent_events >= 3
    ORDER BY recent_events DESC
    LIMIT ?
  `).all(`-${windowHours} hours`, maxProjects);
}

// ---------------------------------------------------------------------------
// Frontmatter serialization (inverse of parseFrontmatter in src/lib/frontmatter.js)
// ---------------------------------------------------------------------------

/**
 * Serialize a plain object into a YAML frontmatter block.
 * Produces `---\n<key>: <value>\n...\n---\n`. Does not escape YAML special
 * characters — callers must pre-sanitize values that could contain them.
 */
function serializeFrontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Instinct file normalization: canonical id + warm-up confidence clamp
// ---------------------------------------------------------------------------

/**
 * Rewrite an instinct YAML file in place to:
 * 1. Replace the id field with the canonical hash (matches sync.js:makeId)
 * 2. Clamp confidence to confidenceCap when wasNew=true (warm-up)
 * 3. Round confidence to 2 decimals to avoid float drift
 *
 * Silently no-ops if the file has no frontmatter or is missing name/type.
 */
function normalizeInstinctFile(filePath, wasNew, confidenceCap) {
  const content = fs.readFileSync(filePath, 'utf8');
  const meta = parseFrontmatter(content);
  if (!meta || !meta.name || !meta.type) return;

  const body = extractBody(content);

  const hash = crypto
    .createHash('sha256')
    .update(`${meta.name}::${meta.type}`)
    .digest('hex')
    .substring(0, 16);
  meta.id = `ae-${hash}`;

  const currentConf = parseFloat(meta.confidence);
  if (Number.isFinite(currentConf)) {
    const clamped = wasNew ? Math.min(currentConf, confidenceCap) : currentConf;
    meta.confidence = clamped.toFixed(2);
  }

  const newContent = serializeFrontmatter(meta) + '\n' + body + '\n';
  fs.writeFileSync(filePath, newContent, 'utf8');
}

module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
  normalizeInstinctFile,
};
