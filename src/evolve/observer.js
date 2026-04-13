#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { parseFrontmatter, extractBody } = require('../lib/frontmatter');
const { exportEventsSince } = require('./export-events');
const { getKgSyncState, setKgSyncState } = require('../db/knowledge-sync');

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

// ---------------------------------------------------------------------------
// Instinct snapshot: list all .md files under cl/instincts/{inherited,personal}
// ---------------------------------------------------------------------------

function snapshotInstinctFiles(instinctsRoot) {
  const out = new Set();
  for (const sub of ['inherited', 'personal']) {
    const dir = path.join(instinctsRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) out.add(path.join(dir, f));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt template rendering
// ---------------------------------------------------------------------------

function renderObserverPrompt(templatePath, vars) {
  let tpl = fs.readFileSync(templatePath, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    tpl = tpl.split(`{{${key}}}`).join(val);
  }
  return tpl;
}

// ---------------------------------------------------------------------------
// Process a single project: query events, invoke CLI, post-process files
// ---------------------------------------------------------------------------

/**
 * Process one active project: reads events since the per-project cursor,
 * skips if below the 3-event minimum, writes JSONL to a tmpfile, renders
 * the observer prompt template, invokes the injected runClaude({model, prompt}),
 * then normalizes every instinct file touched during the run. Updates the
 * cursor to the timestamp of the latest event processed.
 *
 * Returns { status: 'success', events, input_tokens, output_tokens }
 *      or { status: 'skipped', reason, events }
 * Throws if exportEventsSince or runClaude fails catastrophically.
 */
function processProject(db, opts) {
  const { project, repoDir, config, runClaude } = opts;
  const minEvents = 3;

  const cursorKey = `observer_last_run_at_${project.project_id}`;
  const cursor = getKgSyncState(db, cursorKey)
    || new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const events = exportEventsSince(
    db,
    project.directory,
    cursor,
    config.observer_max_events_per_project
  );

  if (events.length < minEvents) {
    return { status: 'skipped', reason: 'below_min_events', events: events.length };
  }

  const tmpFile = path.join(
    require('os').tmpdir(),
    `op-observer-${project.project_id}-${Date.now()}.jsonl`
  );
  fs.writeFileSync(tmpFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const instinctsRoot = path.join(repoDir, 'cl', 'instincts');
  fs.mkdirSync(path.join(instinctsRoot, 'personal'), { recursive: true });
  fs.mkdirSync(path.join(instinctsRoot, 'inherited'), { recursive: true });

  const before = snapshotInstinctFiles(instinctsRoot);

  const prompt = renderObserverPrompt(
    path.join(__dirname, 'observer-prompt.md'),
    {
      analysis_path: tmpFile,
      instincts_dir: path.join(instinctsRoot, 'personal'),
      project_id: project.project_id,
      project_name: project.name,
    }
  );

  let cliResult;
  try {
    cliResult = runClaude({
      model: config.observer_model,
      prompt,
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
  }

  // Post-process all instinct files touched during this run
  const after = snapshotInstinctFiles(instinctsRoot);
  for (const filePath of after) {
    const wasNew = !before.has(filePath);
    try {
      normalizeInstinctFile(filePath, wasNew, config.observer_confidence_cap_on_first_detect);
    } catch { /* skip malformed files */ }
  }

  // Advance cursor to the latest event timestamp
  if (events.length > 0) {
    setKgSyncState(db, cursorKey, events[events.length - 1].timestamp);
  }

  return {
    status: 'success',
    events: events.length,
    input_tokens: cliResult?.usage?.input_tokens || 0,
    output_tokens: cliResult?.usage?.output_tokens || 0,
  };
}

module.exports = {
  queryActiveProjects,
  serializeFrontmatter,
  normalizeInstinctFile,
  snapshotInstinctFiles,
  renderObserverPrompt,
  processProject,
};
