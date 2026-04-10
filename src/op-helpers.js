'use strict';
// Shim: re-export from lib/ for backward compatibility during migration
const { parseFrontmatter } = require('./lib/frontmatter');
const { getClaudeDir } = require('./lib/paths');
const { getInstalledPlugins, getPluginComponents } = require('./lib/plugins');
const { getKnownProjectPaths, getProjectAgents } = require('./lib/projects');
const format = require('./lib/format');

module.exports = {
  CLAUDE_DIR: getClaudeDir(),
  parseFrontmatter,
  ...format,
  getInstalledPlugins,
  getPluginComponents,
  getKnownProjectPaths,
  getProjectAgents,
};
