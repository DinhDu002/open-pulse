'use strict';

const path = require('path');
const os = require('os');
const { slugify } = require('./slugify');

/**
 * Return the Claude configuration directory.
 * Respects OPEN_PULSE_CLAUDE_DIR env var for test isolation.
 */
function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Return the filesystem path for a component (rule/skill/knowledge) by type and name.
 */
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

module.exports = { getClaudeDir, getComponentPath };
