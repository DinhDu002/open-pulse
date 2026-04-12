#!/usr/bin/env node
'use strict';

/**
 * Safely merge Open Pulse hooks into ~/.claude/settings.json.
 * - Backs up settings.json before modification
 * - Removes old collector/automation-suggester/suggestion-analyzer hooks
 * - Adds new collector hooks
 * - Validates JSON before and after
 */

const fs = require('fs');
const path = require('path');

const repoDir = process.argv[2] || path.join(__dirname, '..');
const claudeDir = path.join(process.env.HOME || require('os').homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');

function main() {
  // Read current settings
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    console.error('Cannot read settings.json');
    process.exit(1);
  }

  // Backup
  const backupPath = settingsPath + '.op-backup';
  fs.copyFileSync(settingsPath, backupPath);
  console.log(`  Backup: ${backupPath}`);

  if (!settings.hooks) settings.hooks = {};

  // Remove old hooks
  const oldPatterns = [
    'dashboard/collector.js',
    'automation-suggester-start.js',
    'automation-suggester-stop.js',
    'op-collector.js',
    'op-suggestion-analyzer.js',
    'ingest/collector.js',
  ];

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter(group => {
      if (!Array.isArray(group.hooks)) return true;
      group.hooks = group.hooks.filter(h => {
        const cmd = h.command || '';
        return !oldPatterns.some(p => cmd.includes(p));
      });
      return group.hooks.length > 0;
    });
  }

  // Add new hooks
  const collectorPath = path.join(repoDir, 'src', 'ingest', 'collector.js');

  // PostToolUse: collector
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: '',
    hooks: [{ type: 'command', command: `node "${collectorPath}" post-tool`, timeout: 5 }],
  });

  // UserPromptSubmit: collector
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  settings.hooks.UserPromptSubmit.push({
    hooks: [{ type: 'command', command: `node "${collectorPath}" prompt`, timeout: 5 }],
  });

  // Stop: collector + suggestion analyzer
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: `node "${collectorPath}" stop`, timeout: 10 }],
  });

  // Validate JSON
  const output = JSON.stringify(settings, null, 2);
  try {
    JSON.parse(output);
  } catch {
    console.error('Generated invalid JSON, restoring backup');
    fs.copyFileSync(backupPath, settingsPath);
    process.exit(1);
  }

  fs.writeFileSync(settingsPath, output, 'utf8');
  console.log('  Hooks registered in settings.json');
}

main();
