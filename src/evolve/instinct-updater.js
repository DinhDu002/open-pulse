'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter: parseFrontmatterLib } = require('../lib/frontmatter');

// ---------------------------------------------------------------------------
// YAML frontmatter parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown/yaml content.
 * Returns { meta: Object, body: string } — compatible with instinct-updater callers.
 * @param {string} content
 * @returns {{ meta: Object, body: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\s*([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }

  return { meta, body: match[2].trim() };
}

/**
 * Serialize frontmatter meta + body back to markdown.
 * @param {Object} meta
 * @param {string} body
 * @returns {string}
 */
function serializeFrontmatter(meta, body) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    const strVal = String(val);
    if (strVal.includes(':') || strVal.includes('#') || strVal.includes('"')) {
      lines.push(`${key}: "${strVal.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${strVal}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Find instinct file by ID
// ---------------------------------------------------------------------------

/**
 * Collect all instinct directories under cl/.
 * @param {string} repoDir
 * @returns {string[]}
 */
function getInstinctDirs(repoDir) {
  const clDir = path.join(repoDir, 'cl');
  const dirs = [
    path.join(clDir, 'instincts', 'personal'),
    path.join(clDir, 'instincts', 'inherited'),
  ];

  const projectsDir = path.join(clDir, 'projects');
  try {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(path.join(projectsDir, entry.name, 'instincts', 'personal'));
      dirs.push(path.join(projectsDir, entry.name, 'instincts', 'inherited'));
    }
  } catch { /* projects dir not found */ }

  return dirs;
}

/**
 * Find an instinct file by its frontmatter ID (or filename match).
 * @param {string} repoDir
 * @param {string} instinctId
 * @returns {string|null} Absolute path, or null
 */
function findInstinctFile(repoDir, instinctId) {
  if (!instinctId) return null;

  const dirs = getInstinctDirs(repoDir);

  // Pass 1: match by frontmatter id field
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.yaml'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const { meta } = parseFrontmatter(content);
          if (meta.id === instinctId) return filePath;
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir not found */ }
  }

  // Pass 2: match by filename
  for (const dir of dirs) {
    for (const ext of ['.md', '.yaml']) {
      const candidate = path.join(dir, instinctId + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* skip */ }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Confidence update
// ---------------------------------------------------------------------------

/**
 * Update confidence of an instinct file on disk.
 * @param {string} instinctPath
 * @param {number} delta  e.g. +0.15 (approve) or -0.2 (dismiss)
 * @returns {{ confidence: number, dismiss_count: number }}
 */
function updateConfidence(instinctPath, delta) {
  const content = fs.readFileSync(instinctPath, 'utf8');
  const { meta, body } = parseFrontmatter(content);

  const oldConfidence = parseFloat(meta.confidence) || 0.5;
  const newConfidence = Math.max(0.0, Math.min(0.95, parseFloat((oldConfidence + delta).toFixed(2))));
  meta.confidence = newConfidence.toFixed(2);

  if (delta > 0) {
    meta.user_validated = 'true';
  } else if (delta < 0) {
    const dismissCount = parseInt(meta.dismiss_count || '0', 10) + 1;
    meta.dismiss_count = String(dismissCount);
  }

  meta.updated_at = new Date().toISOString();

  fs.writeFileSync(instinctPath, serializeFrontmatter(meta, body), 'utf8');

  return {
    confidence: newConfidence,
    dismiss_count: parseInt(meta.dismiss_count || '0', 10),
  };
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/**
 * Move an instinct file to an archive directory.
 * @param {string} instinctPath
 * @returns {string} Path to the archived file
 */
function archiveInstinct(instinctPath) {
  const parentDir = path.dirname(instinctPath);
  const archiveDir = path.join(path.dirname(parentDir), 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(instinctPath, path.extname(instinctPath));
  const ext = path.extname(instinctPath);
  const archivePath = path.join(archiveDir, `${baseName}-${timestamp}${ext}`);

  fs.renameSync(instinctPath, archivePath);
  return archivePath;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseFrontmatter,
  serializeFrontmatter,
  getInstinctDirs,
  findInstinctFile,
  updateConfidence,
  archiveInstinct,
};
