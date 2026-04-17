'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');
const { getInstalledPlugins } = require('./plugins');

/**
 * Return all known project paths.
 *
 * Sources:
 *   1. ~/.claude/plugins/installed_plugins.json (projectPath field)
 *   2. cl_projects.directory column (when a DB handle is supplied)
 *
 * @param {import('better-sqlite3').Database} [db] Optional sqlite db handle.
 */
function getKnownProjectPaths(db) {
  const claudeDir = getClaudeDir();
  const paths = new Set();
  const jsonPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const installs of Object.values(data.plugins || {})) {
      for (const inst of installs) {
        if (inst.projectPath) paths.add(inst.projectPath);
      }
    }
  } catch { /* ignore */ }

  if (db) {
    try {
      const rows = db
        .prepare('SELECT DISTINCT directory FROM cl_projects WHERE directory IS NOT NULL')
        .all();
      for (const row of rows) {
        if (row.directory) paths.add(row.directory);
      }
    } catch { /* table missing or query error — ignore */ }
  }

  return [...paths];
}

/**
 * Return all project-scoped agents found in .claude/agents/ under known project paths.
 *
 * @param {import('better-sqlite3').Database} [db] Optional sqlite db handle,
 *   forwarded to getKnownProjectPaths so cl_projects.directory entries are included.
 */
function getProjectAgents(db) {
  const projectPaths = getKnownProjectPaths(db);
  const items = [];
  for (const projPath of projectPaths) {
    const agentsDir = path.join(projPath, '.claude', 'agents');
    try {
      for (const f of fs.readdirSync(agentsDir)) {
        if (!f.endsWith('.md')) continue;
        const name = f.replace(/\.md$/, '');
        items.push({
          name,
          project: path.basename(projPath),
          filePath: path.join(agentsDir, f),
        });
      }
    } catch { /* no .claude/agents/ in this project */ }
  }
  return items;
}

/**
 * Return all project-scoped skills found in .claude/skills/ under known project paths.
 *
 * Two conventions supported per entry inside .claude/skills/:
 *   - Directory with SKILL.md: `.claude/skills/<name>/SKILL.md`
 *       → name = directory name. Directories without SKILL.md are skipped.
 *   - Standalone markdown file: `.claude/skills/<name>.md`
 *       → name = basename without `.md`.
 *
 * @param {import('better-sqlite3').Database} [db] Optional sqlite db handle.
 * @returns {Array<{ name: string, project: string, filePath: string }>}
 */
function getProjectSkills(db) {
  const projectPaths = getKnownProjectPaths(db);
  const items = [];
  for (const projPath of projectPaths) {
    const skillsDir = path.join(projPath, '.claude', 'skills');
    let entries;
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue; // no .claude/skills/ in this project
    }
    for (const entry of entries) {
      const entryPath = path.join(skillsDir, entry.name);
      // Resolve symlinks: check real stat for directory/file classification.
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(entryPath);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        const skillFile = path.join(entryPath, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue; // skip dir without SKILL.md
        items.push({
          name: entry.name,
          project: path.basename(projPath),
          filePath: skillFile,
        });
      } else if (isFile && entry.name.endsWith('.md')) {
        items.push({
          name: entry.name.replace(/\.md$/, ''),
          project: path.basename(projPath),
          filePath: entryPath,
        });
      }
    }
  }
  return items;
}

module.exports = { getKnownProjectPaths, getProjectAgents, getProjectSkills };
