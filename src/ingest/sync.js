'use strict';

const path = require('path');
const crypto = require('crypto');

const {
  upsertComponent,
  deleteComponentsNotSeenSince,
} = require('../db/components');

const {
  insertScanResult,
} = require('../db/scan');

const {
  getKnownSkills,
  getKnownAgents,
  readItemMetaFromFile,
} = require('../lib/format');

const {
  getPluginComponents,
} = require('../lib/plugins');

const {
  getProjectAgents,
  getProjectSkills,
} = require('../lib/projects');

const {
  getClaudeDir,
} = require('../lib/paths');

// ---------------------------------------------------------------------------
// Component sync: filesystem → components table
// ---------------------------------------------------------------------------

function syncComponentsWithDb(db) {
  const claudeDir = getClaudeDir();
  const now = new Date().toISOString();
  const diskItems = [];

  // Global skills
  for (const name of getKnownSkills()) {
    const filePath = path.join(claudeDir, 'skills', name, 'SKILL.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'skill', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
    });
  }

  // Global agents
  for (const name of getKnownAgents()) {
    const filePath = path.join(claudeDir, 'agents', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'agent', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: 'configured',
    });
  }

  // Plugin components (skills + agents)
  for (const pItem of getPluginComponents('skills')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'skill', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: null,
    });
  }
  for (const pItem of getPluginComponents('agents')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'agent', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: 'configured',
    });
  }

  // Project agents
  for (const projAgent of getProjectAgents(db)) {
    const meta = readItemMetaFromFile(projAgent.filePath);
    diskItems.push({
      type: 'agent', name: projAgent.name, source: 'project',
      plugin: null, project: projAgent.project,
      file_path: projAgent.filePath, description: meta.description, agent_class: 'configured',
    });
  }

  // Project skills
  for (const projSkill of getProjectSkills(db)) {
    const meta = readItemMetaFromFile(projSkill.filePath);
    diskItems.push({
      type: 'skill', name: projSkill.name, source: 'project',
      plugin: null, project: projSkill.project,
      file_path: projSkill.filePath, description: meta.description, agent_class: null,
    });
  }

  // UPSERT all disk items + DELETE stale items — atomically
  const syncTx = db.transaction(() => {
    for (const item of diskItems) {
      upsertComponent(db, { ...item, first_seen_at: now, last_seen_at: now });
    }
    deleteComponentsNotSeenSince(db, now);
  });
  syncTx();

  // COMPUTE ETag and return it — content-hash over all component rows so that
  // identical disk state yields the same ETag across sync calls.
  const rows = db.prepare(`
    SELECT type, name, source, plugin, project, file_path, description, agent_class
    FROM components
    ORDER BY type, name, source, COALESCE(plugin, ''), COALESCE(project, '')
  `).all();
  return crypto
    .createHash('md5')
    .update(JSON.stringify(rows))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Scanner: inventory all components, check for unused, produce report
// ---------------------------------------------------------------------------

function runScan(db) {
  const skills = getKnownSkills();
  const agents = getKnownAgents();

  const usedSkills = new Set(
    db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'skill_invoke'").all().map(r => r.name)
  );
  const usedAgents = new Set(
    db.prepare("SELECT DISTINCT name FROM events WHERE event_type = 'agent_spawn'").all().map(r => r.name)
  );

  const usedSkillNames = [...usedSkills];
  const unusedSkills = skills.filter(s =>
    !usedSkills.has(s) && !usedSkillNames.some(u => u.startsWith(s + ':'))
  );
  const unusedAgents = agents.filter(a => !usedAgents.has(a));

  const issues = [];
  for (const s of unusedSkills) {
    issues.push({ severity: 'low', message: `Unused skill: ${s}` });
  }
  for (const a of unusedAgents) {
    issues.push({ severity: 'low', message: `Unused agent: ${a}` });
  }

  const report = {
    scanned_at: new Date().toISOString(),
    total_skills: skills.length,
    total_agents: agents.length,
    unused_skills: unusedSkills,
    unused_agents: unusedAgents,
    issues,
  };

  const issuesBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    if (issue.severity in issuesBySeverity) issuesBySeverity[issue.severity]++;
  }

  insertScanResult(db, {
    scanned_at: report.scanned_at,
    report: JSON.stringify(report),
    total_skills: report.total_skills,
    total_agents: report.total_agents,
    issues_critical: issuesBySeverity.critical,
    issues_high: issuesBySeverity.high,
    issues_medium: issuesBySeverity.medium,
    issues_low: issuesBySeverity.low,
  });

  return report;
}

module.exports = {
  syncComponentsWithDb,
  runScan,
};
