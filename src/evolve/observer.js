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

module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
};
