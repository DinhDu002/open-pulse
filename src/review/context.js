'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.resolve(__dirname, '..', '..');

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

// ---------------------------------------------------------------------------
// Phase 1: Collect work history
// ---------------------------------------------------------------------------

function collectWorkHistory(db, date, historyDays = 1) {
  const days = Math.max(1, historyDays);
  const endDate = date;
  const startMs = new Date(date + 'T00:00:00Z').getTime() - (days - 1) * 86400000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);

  const events = db.prepare(`
    SELECT event_type, name, detail, estimated_cost_usd AS cost, input_tokens, output_tokens, timestamp
    FROM events
    WHERE DATE(timestamp) BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(startDate, endDate);

  const sessions = db.prepare(`
    SELECT session_id, started_at, ended_at, model, total_cost_usd AS cost, total_input_tokens, total_output_tokens
    FROM sessions
    WHERE DATE(started_at) BETWEEN ? AND ?
    ORDER BY started_at ASC
  `).all(startDate, endDate);

  const totalCost = events.reduce((sum, e) => sum + (e.cost || 0), 0);

  return { events, sessions, totalCost, startDate, endDate };
}

// ---------------------------------------------------------------------------
// Phase 2: Scan all component files
// ---------------------------------------------------------------------------

function readDirFiles(dirPath, pattern = '.md') {
  if (!fs.existsSync(dirPath)) return [];
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        results.push({
          name: entry.name,
          path: skillFile,
          content: fs.readFileSync(skillFile, 'utf8'),
        });
      }
    } else if (entry.name.endsWith(pattern)) {
      results.push({
        name: entry.name.replace(pattern, ''),
        path: fullPath,
        content: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return results;
}

function scanAllComponents(claudeDir) {
  const dir = claudeDir || getClaudeDir();

  const rules = readDirFiles(path.join(dir, 'rules'));
  const knowledge = readDirFiles(path.join(dir, 'knowledge'));
  const skills = readDirFiles(path.join(dir, 'skills'));
  const agents = readDirFiles(path.join(dir, 'agents'));

  let hooks = [];
  const settingsPath = path.join(dir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      hooks = settings.hooks || [];
    } catch { /* ignore parse errors */ }
  }

  const memory = [];
  const projectsDir = path.join(dir, 'projects');
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memDir = path.join(projectsDir, proj.name, 'memory');
      if (fs.existsSync(memDir)) {
        memory.push(...readDirFiles(memDir));
      }
    }
  }

  let plugins = [];
  const pluginsPath = path.join(dir, 'plugins', 'installed_plugins.json');
  if (fs.existsSync(pluginsPath)) {
    try {
      plugins = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
    } catch { /* ignore */ }
  }

  return { rules, knowledge, skills, agents, hooks, memory, plugins };
}

// ---------------------------------------------------------------------------
// Phase 3: Load best practices
// ---------------------------------------------------------------------------

function loadBestPractices(repoDir) {
  const refDir = path.join(
    repoDir || REPO_DIR,
    'claude', 'skills', 'claude-code-knowledge', 'references'
  );
  if (!fs.existsSync(refDir)) return [];

  const results = [];
  const entries = fs.readdirSync(refDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    results.push({
      name: entry.name,
      content: fs.readFileSync(path.join(refDir, entry.name), 'utf8'),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Phase 5: Discover + scan project configs
// ---------------------------------------------------------------------------

function discoverProjectPaths(db, registryPath) {
  const projects = db.prepare('SELECT name, directory FROM cl_projects WHERE directory IS NOT NULL').all();

  // Merge with projects.json if available
  const regPath = registryPath || path.join(REPO_DIR, 'projects.json');
  if (fs.existsSync(regPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const knownDirs = new Set(projects.map(p => p.directory));
      for (const [, proj] of Object.entries(registry)) {
        if (proj.root && !knownDirs.has(proj.root)) {
          projects.push({ name: proj.name || path.basename(proj.root), directory: proj.root });
          knownDirs.add(proj.root);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return projects.filter(p => fs.existsSync(p.directory));
}

function scanOneProject(projectDir) {
  let claudeMd = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
  }

  const dotClaude = path.join(projectDir, '.claude');
  const rules = readDirFiles(path.join(dotClaude, 'rules'));
  const skills = readDirFiles(path.join(dotClaude, 'skills'));
  const agents = readDirFiles(path.join(dotClaude, 'agents'));
  const knowledge = readDirFiles(path.join(dotClaude, 'knowledge'));

  let hooks = [];
  const settingsPath = path.join(dotClaude, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      hooks = settings.hooks || [];
    } catch { /* ignore */ }
  }

  return { claudeMd, rules, skills, agents, knowledge, hooks };
}

function scanProjectConfigs(db, registryPath) {
  const paths = discoverProjectPaths(db, registryPath);
  const configs = {};
  for (const { name, directory } of paths) {
    configs[name] = { directory, ...scanOneProject(directory) };
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Phase 6: Knowledge entry validation context
// ---------------------------------------------------------------------------

function getKnowledgeReviewContext(db) {
  const entries = db.prepare(
    "SELECT id, project_id, title, body, source_file FROM knowledge_entries WHERE status = 'active' AND source_file IS NOT NULL"
  ).all();

  const projects = db.prepare('SELECT project_id, directory FROM cl_projects WHERE directory IS NOT NULL').all();
  const projectDirs = {};
  for (const p of projects) {
    projectDirs[p.project_id] = p.directory;
  }

  const results = [];

  for (const entry of entries) {
    const projectDir = projectDirs[entry.project_id];
    if (!projectDir) continue;

    const fullPath = path.join(projectDir, entry.source_file);
    let sourceContent = '';
    try {
      sourceContent = fs.readFileSync(fullPath, 'utf8');
    } catch {
      sourceContent = '(file not found)';
    }

    results.push({
      entry_id: entry.id,
      project_id: entry.project_id,
      title: entry.title,
      body_excerpt: entry.body.slice(0, 300),
      source_file: entry.source_file,
      source_content_excerpt: sourceContent.slice(0, 500),
    });

    if (results.length >= 30) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 4: Build prompt
// ---------------------------------------------------------------------------

function buildPrompt(history, components, practices, opts = {}) {
  const { date = new Date().toISOString().slice(0, 10), max_suggestions = 25, projectConfigs = {}, historyDays = 1 } = opts;

  const templatePath = path.join(__dirname, 'prompt.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  const formatComponents = (items) =>
    items.map(c => `#### ${c.name}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');

  // Format project configs section
  const projectNames = Object.keys(projectConfigs);
  let projectContent = 'None';
  if (projectNames.length > 0) {
    const sections = [];
    for (const [name, cfg] of Object.entries(projectConfigs)) {
      const parts = [`### Project: ${name} (${cfg.directory})`];
      if (cfg.claudeMd) parts.push(`#### CLAUDE.md\n\`\`\`\n${cfg.claudeMd}\n\`\`\``);
      if (cfg.rules.length) parts.push(`#### Rules (${cfg.rules.length})\n${formatComponents(cfg.rules)}`);
      if (cfg.skills.length) parts.push(`#### Skills (${cfg.skills.length})\n${formatComponents(cfg.skills)}`);
      if (cfg.agents.length) parts.push(`#### Agents (${cfg.agents.length})\n${formatComponents(cfg.agents)}`);
      if (cfg.knowledge.length) parts.push(`#### Knowledge (${cfg.knowledge.length})\n${formatComponents(cfg.knowledge)}`);
      if (cfg.hooks.length) parts.push(`#### Hooks\n${JSON.stringify(cfg.hooks, null, 2)}`);
      sections.push(parts.join('\n\n'));
    }
    projectContent = sections.join('\n\n---\n\n');
  }

  const startDate = history.startDate || date;
  const dateRange = startDate === date ? date : `${startDate} → ${date}`;

  const replacements = {
    '{{date}}': date,
    '{{history_days}}': String(historyDays),
    '{{date_range}}': dateRange,
    '{{work_history_json}}': JSON.stringify({
      events: history.events,
      sessions: history.sessions,
      totalCost: history.totalCost,
    }, null, 2),
    '{{rule_count}}': String(components.rules.length),
    '{{rules_content}}': formatComponents(components.rules) || 'None',
    '{{skill_count}}': String(components.skills.length),
    '{{skills_content}}': formatComponents(components.skills) || 'None',
    '{{agent_count}}': String(components.agents.length),
    '{{agents_content}}': formatComponents(components.agents) || 'None',
    '{{hooks_config}}': JSON.stringify(components.hooks, null, 2),
    '{{memory_content}}': formatComponents(components.memory) || 'None',
    '{{plugin_count}}': String(components.plugins.length),
    '{{plugins_content}}': JSON.stringify(components.plugins, null, 2),
    '{{project_count}}': String(projectNames.length),
    '{{project_configs_content}}': projectContent,
    '{{claude_code_knowledge}}': practices.map(p => `### ${p.name}\n${p.content}`).join('\n\n'),
    '{{max_suggestions}}': String(max_suggestions),
  };

  for (const [key, val] of Object.entries(replacements)) {
    template = template.replaceAll(key, val);
  }

  return template;
}

module.exports = {
  collectWorkHistory,
  scanAllComponents,
  loadBestPractices,
  buildPrompt,
  getKnowledgeReviewContext,
  // exposed for tests via pipeline re-export
  readDirFiles,
  discoverProjectPaths,
  scanOneProject,
  scanProjectConfigs,
};
