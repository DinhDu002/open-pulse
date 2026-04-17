'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');
const { parseFrontmatter } = require('./frontmatter');

// ---------------------------------------------------------------------------
// Period → date cutoff
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
// Qualified name parsing
// ---------------------------------------------------------------------------

function parseQualifiedName(name) {
  const idx = name.indexOf(':');
  if (idx === -1) return { plugin: null, shortName: name };
  return { plugin: name.substring(0, idx), shortName: name.substring(idx + 1) };
}

// ---------------------------------------------------------------------------
// Item metadata readers
// ---------------------------------------------------------------------------

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
  const claudeDir = getClaudeDir();
  let filePath;
  if (type === 'skills') {
    filePath = path.join(claudeDir, 'skills', name, 'SKILL.md');
  } else {
    filePath = path.join(claudeDir, 'agents', name + '.md');
  }
  return readItemMetaFromFile(filePath);
}

// ---------------------------------------------------------------------------
// Component directory scanners
// ---------------------------------------------------------------------------

function getKnownSkills() {
  const skillsDir = path.join(getClaudeDir(), 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function getKnownAgents() {
  const agentsDir = path.join(getClaudeDir(), 'agents');
  try {
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

/** Check if a directory is the root of a git repository. */
function isGitRepo(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory(); }
  catch { return false; }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  '.venv', 'venv', 'vendor', 'target',
  '.next', 'coverage', '__pycache__',
]);

/**
 * Walk `roots` recursively and collect folders that contain a `.git` dir.
 * Stops descending once a git repo is found (no nested repos) and prunes
 * common build/vendor directories.
 */
function scanGitRepos(roots, opts = {}) {
  const maxDepth = opts.maxDepth ?? 6;
  const found = [];

  for (const root of roots) {
    walk(root, 0);
  }
  return found;

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    if (entries.some(e => e.isDirectory() && e.name === '.git')) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Keyword extraction
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
// HTTP helpers
// ---------------------------------------------------------------------------

function errorReply(reply, code, message) {
  return reply.code(code).send({ error: message });
}

function parsePagination(query, defaults = {}) {
  const page = Math.max(1, parseInt(query.page) || (defaults.page || 1));
  const perPage = Math.min(50, Math.max(1, parseInt(query.per_page) || (defaults.perPage || 10)));
  return { page, perPage };
}

module.exports = {
  periodToDate,
  parseQualifiedName,
  readItemMetaFromFile,
  readItemMeta,
  getKnownSkills,
  getKnownAgents,
  isGitRepo,
  scanGitRepos,
  STOP_WORDS,
  extractKeywordsFromPrompts,
  errorReply,
  parsePagination,
};
