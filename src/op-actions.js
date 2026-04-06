'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * Returns the file path for a given component type and name.
 * @param {string} type - 'skill' | 'agent' | 'hook' | 'rule'
 * @param {string} name
 * @param {string} claudeDir
 * @returns {string}
 */
function getComponentPath(type, name, claudeDir = DEFAULT_CLAUDE_DIR) {
  switch (type) {
    case 'skill':
      return path.join(claudeDir, 'skills', name, 'SKILL.md');
    case 'agent':
      return path.join(claudeDir, 'agents', `${name}.md`);
    case 'hook':
      return path.join(claudeDir, 'scripts', 'hooks', `${name}.js`);
    case 'rule':
      return path.join(claudeDir, 'rules', `${name}.md`);
    default:
      throw new Error(`Unknown component type: ${type}`);
  }
}

/**
 * Creates a component file. Returns {success, path} or {success: false, error}.
 * @param {{ type: string, name: string, content: string }} opts
 * @param {string} claudeDir
 */
function createComponent(opts, claudeDir = DEFAULT_CLAUDE_DIR) {
  const { type, name, content = '' } = opts;
  const filePath = getComponentPath(type, name, claudeDir);

  if (fs.existsSync(filePath)) {
    return { success: false, error: `Component already exists: ${filePath}` };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Removes hook entries from settings.json, backing up first.
 * @param {string} hookName
 * @param {string} claudeDir
 */
function removeHookFromSettings(hookName, claudeDir = DEFAULT_CLAUDE_DIR) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  const raw = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(raw);

  // Back up before modifying
  fs.writeFileSync(`${settingsPath}.bak`, raw, 'utf8');

  if (settings.hooks) {
    // hooks is an object keyed by event type; each value is an array of hook configs
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (Array.isArray(entries)) {
        settings.hooks[event] = entries.filter((entry) => {
          const matcher = entry.matcher || entry.name || '';
          return !matcher.includes(hookName);
        });
      }
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Deletes a component. For skills: removes the whole directory.
 * For hooks: also removes the entry from settings.json.
 * @param {{ type: string, name: string }} opts
 * @param {string} claudeDir
 */
function deleteComponent(opts, claudeDir = DEFAULT_CLAUDE_DIR) {
  const { type, name } = opts;
  const filePath = getComponentPath(type, name, claudeDir);

  try {
    if (type === 'skill') {
      const skillDir = path.dirname(filePath);
      if (!fs.existsSync(skillDir)) {
        return { success: false, error: `Component not found: ${skillDir}` };
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      return { success: true, path: skillDir };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Component not found: ${filePath}` };
    }

    fs.rmSync(filePath, { force: true });

    if (type === 'hook') {
      removeHookFromSettings(name, claudeDir);
    }

    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Returns path info without creating anything.
 * @param {{ type: string, name: string }} opts
 * @param {string} claudeDir
 * @returns {{ path: string, exists: boolean, type: string, name: string }}
 */
function previewComponent(opts, claudeDir = DEFAULT_CLAUDE_DIR) {
  const { type, name } = opts;
  const filePath = getComponentPath(type, name, claudeDir);
  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    type,
    name,
  };
}

module.exports = { createComponent, deleteComponent, previewComponent, getComponentPath };
