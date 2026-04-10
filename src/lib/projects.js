'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');
const { getInstalledPlugins } = require('./plugins');

/**
 * Return all known project paths from the installed plugins registry.
 */
function getKnownProjectPaths() {
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
  return [...paths];
}

/**
 * Return all project-scoped agents found in .claude/agents/ under known project paths.
 */
function getProjectAgents() {
  const projectPaths = getKnownProjectPaths();
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

module.exports = { getKnownProjectPaths, getProjectAgents };
