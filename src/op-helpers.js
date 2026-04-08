'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_DIR = process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// Helper: period string → ISO date cutoff
// ---------------------------------------------------------------------------

function periodToDate(period) {
  if (!period || period === 'all') return null;
  const match = period.match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Keyword extraction from invocation prompts
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'to','of','in','for','on','with','at','by','from','as','into','through','during',
  'before','after','above','below','between','out','off','over','under','again','further',
  'then','once','here','there','when','where','why','how','all','both','each','few',
  'more','most','other','some','such','no','nor','not','only','own','same','so','than',
  'too','very','just','about','up','it','its','this','that','these','those','i','me',
  'my','we','our','you','your','he','him','his','she','her','they','them','their',
  'what','which','who','whom','and','but','or','if','while','because','until','although',
  'null','true','false','undefined','none',
]);

function extractKeywordsFromPrompts(invocations) {
  const freq = new Map();
  for (const inv of invocations) {
    let text = inv.user_prompt || '';
    if (!text && inv.detail) {
      try {
        const obj = JSON.parse(inv.detail);
        text = obj.args || obj.description || '';
      } catch {
        text = String(inv.detail);
      }
    }
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Filesystem scanners (use CLAUDE_DIR for real components)
// ---------------------------------------------------------------------------

function parseQualifiedName(name) {
  const idx = name.indexOf(':');
  if (idx === -1) return { plugin: null, shortName: name };
  return { plugin: name.substring(0, idx), shortName: name.substring(idx + 1) };
}

function getInstalledPlugins() {
  const jsonPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
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

function getKnownProjectPaths() {
  const plugins = getInstalledPlugins();
  const paths = new Set();
  const jsonPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
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

function readItemMetaFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseFrontmatter(content);
    return { description: meta.description || '', origin: meta.origin || 'custom' };
  } catch {
    return { description: '', origin: 'custom' };
  }
}

function readItemMeta(type, name) {
  let filePath;
  if (type === 'skills') {
    filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  } else {
    filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
  }
  return readItemMetaFromFile(filePath);
}

function getKnownSkills() {
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function getKnownAgents() {
  const agentsDir = path.join(CLAUDE_DIR, 'agents');
  try {
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

function getKnownRules() {
  const rulesDir = path.join(CLAUDE_DIR, 'rules');
  const results = [];
  try {
    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(entry.name.replace(/\.md$/, ''));
      }
    }
  } catch { /* ignore */ }
  const commonDir = path.join(rulesDir, 'common');
  try {
    for (const entry of fs.readdirSync(commonDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push('common/' + entry.name.replace(/\.md$/, ''));
      }
    }
  } catch { /* ignore */ }
  return results;
}

function parseHooksFromSettings(settingsPath, project) {
  const results = [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.hooks) return results;
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const matcher = entry.matcher || '';
        const hooks = entry.hooks || [];
        for (const hook of hooks) {
          results.push({
            name: matcher || event,
            event,
            matcher,
            command: hook.command || '',
            project,
          });
        }
      }
    }
  } catch { /* no settings.json or invalid */ }
  return results;
}

function getKnownHooks() {
  const results = parseHooksFromSettings(path.join(CLAUDE_DIR, 'settings.json'), 'global');
  for (const projPath of getKnownProjectPaths()) {
    const projSettings = path.join(projPath, '.claude', 'settings.json');
    results.push(...parseHooksFromSettings(projSettings, path.basename(projPath)));
  }
  return results;
}

/** Check if a directory is the root of a git repository. */
function isGitRepo(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory(); }
  catch { return false; }
}

module.exports = {
  CLAUDE_DIR,
  periodToDate,
  parseFrontmatter,
  STOP_WORDS,
  extractKeywordsFromPrompts,
  parseQualifiedName,
  getInstalledPlugins,
  getKnownProjectPaths,
  getPluginComponents,
  getProjectAgents,
  readItemMetaFromFile,
  readItemMeta,
  getKnownSkills,
  getKnownAgents,
  getKnownRules,
  parseHooksFromSettings,
  getKnownHooks,
  isGitRepo,
};
