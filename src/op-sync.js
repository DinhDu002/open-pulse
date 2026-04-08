'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');

const {
  upsertClProject,
  upsertInstinct,
  deleteProject,
  upsertComponent,
  deleteComponentsNotSeenSince,
  insertScanResult,
} = require('./op-db');

const {
  parseFrontmatter,
  getKnownSkills,
  getKnownAgents,
  getKnownRules,
  getKnownHooks,
  getPluginComponents,
  getProjectAgents,
  readItemMetaFromFile,
  isGitRepo,
  CLAUDE_DIR,
} = require('./op-helpers');

// ---------------------------------------------------------------------------
// CL sync: filesystem → DB (uses <repo>/cl/ paths)
// ---------------------------------------------------------------------------

function syncProjectsToDb(db) {
  const registryPath = path.join(REPO_DIR, 'projects.json');
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const validIds = new Set();
    for (const [id, meta] of Object.entries(registry)) {
      if (!meta.root || !isGitRepo(meta.root)) continue;
      validIds.add(id);
      upsertClProject(db, {
        project_id: id,
        name: meta.name || id,
        directory: meta.root || null,
        first_seen_at: meta.created_at || new Date().toISOString(),
        last_seen_at: meta.last_seen || new Date().toISOString(),
        session_count: 0,
      });
    }

    // Cleanup: remove orphaned projects (not in registry or not a git repo)
    const dbProjects = db.prepare('SELECT project_id FROM cl_projects').all();
    for (const { project_id } of dbProjects) {
      if (!validIds.has(project_id)) {
        deleteProject(db, project_id);
      }
    }
  } catch { /* registry not found or invalid */ }
}

function syncInstinctsToDb(db) {
  const syncDir = (dir, scope, projectId) => {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.yaml'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const meta = parseFrontmatter(content);
          const bodyMatch = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1].trim() : content;
          const now = new Date().toISOString();

          upsertInstinct(db, {
            instinct_id: meta.id || file.replace(/\.(md|yaml)$/, ''),
            project_id: meta.project_id || (scope === 'global' ? '' : projectId),
            category: meta.domain || meta.category || 'unknown',
            pattern: meta.trigger || file.replace(/\.(md|yaml)$/, ''),
            confidence: parseFloat(meta.confidence) || 0.5,
            seen_count: 1,
            first_seen: now,
            last_seen: now,
            instinct: body,
          });
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir not found */ }
  };

  // Global instincts via <repo>/cl/ paths
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'personal'), 'global', '');
  syncDir(path.join(REPO_DIR, 'cl', 'instincts', 'inherited'), 'global', '');

  // Per-project instincts (only for projects that exist in cl_projects)
  const validProjectIds = new Set(
    db.prepare('SELECT project_id FROM cl_projects').all().map(r => r.project_id)
  );
  const projectsDir = path.join(REPO_DIR, 'cl', 'projects');
  try {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validProjectIds.has(entry.name)) continue;
      syncDir(path.join(projectsDir, entry.name, 'instincts', 'personal'), 'project', entry.name);
      syncDir(path.join(projectsDir, entry.name, 'instincts', 'inherited'), 'project', entry.name);
    }
  } catch { /* projects dir not found */ }
}

let _lastSyncMtimes = { projects: 0, instincts: 0 };

function syncAll(db) {
  const registryPath = path.join(REPO_DIR, 'projects.json');
  const instinctsDir = path.join(REPO_DIR, 'cl', 'instincts');

  let projectsMtime = 0;
  let instinctsMtime = 0;
  try { projectsMtime = fs.statSync(registryPath).mtimeMs; } catch { /* missing */ }
  try { instinctsMtime = fs.statSync(instinctsDir).mtimeMs; } catch { /* missing */ }

  if (projectsMtime === _lastSyncMtimes.projects && instinctsMtime === _lastSyncMtimes.instincts) {
    return; // No changes
  }

  try {
    syncProjectsToDb(db);
    syncInstinctsToDb(db);
    _lastSyncMtimes = { projects: projectsMtime, instincts: instinctsMtime };
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Component sync: filesystem → components table
// ---------------------------------------------------------------------------

function syncComponentsWithDb(db) {
  const now = new Date().toISOString();
  const diskItems = [];

  // Global skills
  for (const name of getKnownSkills()) {
    const filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'skill', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global agents
  for (const name of getKnownAgents()) {
    const filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'agent', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global rules
  for (const name of getKnownRules()) {
    const filePath = path.join(CLAUDE_DIR, 'rules', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'rule', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Hooks (global + project)
  for (const hook of getKnownHooks()) {
    const isProject = hook.project && hook.project !== 'global';
    diskItems.push({
      type: 'hook', name: hook.name, source: isProject ? 'project' : 'global',
      plugin: null, project: hook.project || null,
      file_path: null, description: null, agent_class: null,
      hook_event: hook.event, hook_matcher: hook.matcher, hook_command: hook.command,
    });
  }

  // Plugin components (skills + agents)
  for (const pItem of getPluginComponents('skills')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'skill', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }
  for (const pItem of getPluginComponents('agents')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'agent', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Project agents
  for (const projAgent of getProjectAgents()) {
    const meta = readItemMetaFromFile(projAgent.filePath);
    diskItems.push({
      type: 'agent', name: projAgent.name, source: 'project',
      plugin: null, project: projAgent.project,
      file_path: projAgent.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
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

  // COMPUTE ETag and return it
  const stats = db.prepare(
    'SELECT COUNT(*) AS cnt, MAX(last_seen_at) AS latest FROM components'
  ).get();
  return crypto
    .createHash('md5')
    .update(`${stats.cnt}:${stats.latest || ''}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Scanner: inventory all components, check for unused, produce report
// ---------------------------------------------------------------------------

function runScan(db) {
  const skills = getKnownSkills();
  const agents = getKnownAgents();
  const hooks = getKnownHooks();
  const rules = getKnownRules();

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
    total_hooks: hooks.length,
    total_rules: rules.length,
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
    total_hooks: report.total_hooks,
    total_rules: report.total_rules,
    issues_critical: issuesBySeverity.critical,
    issues_high: issuesBySeverity.high,
    issues_medium: issuesBySeverity.medium,
    issues_low: issuesBySeverity.low,
  });

  return report;
}

module.exports = {
  syncProjectsToDb,
  syncInstinctsToDb,
  syncAll,
  syncComponentsWithDb,
  runScan,
};
