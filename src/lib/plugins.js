'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');

/**
 * Read installed Claude Code plugins from the plugins registry JSON.
 * Returns an array of { plugin, installPath, projects }.
 */
function getInstalledPlugins() {
  const claudeDir = getClaudeDir();
  const jsonPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return Object.entries(data.plugins || {}).map(([key, installs]) => {
      const projects = [];
      for (const inst of installs) {
        if (inst.scope === 'user') {
          if (!projects.includes('global')) projects.push('global');
        } else if (inst.projectPath) {
          const name = path.basename(inst.projectPath);
          if (!projects.includes(name)) projects.push(name);
        }
      }
      return {
        plugin: key.split('@')[0],
        installPath: installs[0].installPath,
        projects: projects.length ? projects : ['global'],
      };
    });
  } catch {
    return [];
  }
}

/**
 * Return all components (agents or skills) contributed by installed plugins.
 * @param {'agents'|'skills'} type
 */
function getPluginComponents(type) {
  const plugins = getInstalledPlugins();
  const items = [];
  for (const { plugin, installPath, projects } of plugins) {
    try {
      if (type === 'agents') {
        const dir = path.join(installPath, 'agents');
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const name = f.replace(/\.md$/, '');
          items.push({ qualifiedName: `${plugin}:${name}`, plugin, projects, filePath: path.join(dir, f) });
        }
      } else if (type === 'skills') {
        const dir = path.join(installPath, 'skills');
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const skillFile = path.join(dir, e.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            items.push({ qualifiedName: `${plugin}:${e.name}`, plugin, projects, filePath: skillFile });
          }
        }
      }
    } catch { /* plugin dir may not have agents/ or skills/ */ }
  }
  return items;
}

module.exports = { getInstalledPlugins, getPluginComponents };
