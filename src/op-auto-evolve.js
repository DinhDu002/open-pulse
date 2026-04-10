'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function makeId(title, targetType) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${targetType}`)
    .digest('hex')
    .substring(0, 16);
  return `ae-${hash}`;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, self-contained)
// ---------------------------------------------------------------------------

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) ||
        (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Component path + content generation
// ---------------------------------------------------------------------------

function getComponentPath(targetType, name) {
  const slug = slugify(name);
  const claudeDir = getClaudeDir();

  switch (targetType) {
    case 'rule':      return path.join(claudeDir, 'rules', `${slug}.md`);
    case 'skill':     return path.join(claudeDir, 'skills', slug, 'SKILL.md');
    case 'knowledge': return path.join(claudeDir, 'knowledge', `${slug}.md`);
    default:          return path.join(claudeDir, 'rules', `${slug}.md`);
  }
}

function generateComponent(insight) {
  const { target_type, title, description } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

    case 'skill':
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${title}`,
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    default:
      return `# ${title}\n\n${description}\n`;
  }
}

// ---------------------------------------------------------------------------
// Instinct sync: YAML files -> auto_evolves table
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
  INSERT INTO auto_evolves
    (id, title, description, target_type, confidence, observation_count, status, created_at, updated_at)
  VALUES
    (@id, @title, @description, @target_type, @confidence, @observation_count, 'active', @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    observation_count = @observation_count,
    confidence = MIN(0.95, auto_evolves.confidence + 0.15),
    description = @description,
    updated_at = @updated_at
  WHERE @observation_count > auto_evolves.observation_count
`;

function syncInstincts(db, instinctDir, blacklist = ['agent', 'hook']) {
  if (!fs.existsSync(instinctDir)) return 0;

  const files = fs.readdirSync(instinctDir).filter(f => f.endsWith('.md'));
  const stmt = db.prepare(UPSERT_SQL);
  let synced = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(instinctDir, file), 'utf8');
    const meta = parseYamlFrontmatter(content);
    if (!meta || !meta.name) continue;

    const targetType = meta.type || null;
    if (!targetType || blacklist.includes(targetType)) continue;

    const now = new Date().toISOString();
    stmt.run({
      id: makeId(meta.name, targetType),
      title: meta.name,
      description: meta.description || '',
      target_type: targetType,
      confidence: parseFloat(meta.confidence) || 0.05,
      observation_count: parseInt(meta.seen_count, 10) || 1,
      created_at: now,
      updated_at: now,
    });
    synced++;
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Auto-promote cycle
// ---------------------------------------------------------------------------

function runAutoEvolve(db, opts = {}) {
  const {
    min_confidence = 0.85,
    blacklist = ['agent', 'hook'],
    logDir,
  } = opts;

  const allTypes = ['rule', 'knowledge', 'skill', 'agent', 'hook'];
  const allowed = allTypes.filter(t => !blacklist.includes(t));
  const placeholders = allowed.map(() => '?').join(',');

  const ready = db.prepare(`
    SELECT * FROM auto_evolves
    WHERE status = 'active'
      AND confidence >= ?
      AND rejection_count = 0
      AND target_type IN (${placeholders})
  `).all(min_confidence, ...allowed);

  let promoted = 0;

  for (const row of ready) {
    try {
      const filePath = getComponentPath(row.target_type, row.title);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, generateComponent(row), 'utf8');

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE auto_evolves
        SET status = 'promoted', promoted_to = ?, promoted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(filePath, now, now, row.id);

      if (logDir) {
        const logPath = path.join(logDir, 'auto-evolve.log');
        const logLine = `[${now}] PROMOTED ${row.target_type} "${row.title}" -> ${filePath}\n`;
        fs.appendFileSync(logPath, logLine);
      }

      promoted++;
    } catch { /* skip individual failures */ }
  }

  return { promoted };
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

function revertAutoEvolve(db, id) {
  const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
  if (!row) throw new Error(`Auto-evolve not found: ${id}`);

  if (row.promoted_to && fs.existsSync(row.promoted_to)) {
    fs.unlinkSync(row.promoted_to);
    try {
      const dir = path.dirname(row.promoted_to);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  db.prepare(`
    UPDATE auto_evolves
    SET status = 'reverted', updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

// ---------------------------------------------------------------------------
// Query helpers (self-contained, no shared code)
// ---------------------------------------------------------------------------

function queryAutoEvolves(db, opts = {}) {
  const { status, target_type, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (target_type) { conditions.push('target_type = ?'); params.push(target_type); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM auto_evolves ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM auto_evolves ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getAutoEvolve(db, id) {
  return db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
}

function getAutoEvolveStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM auto_evolves GROUP BY status ORDER BY count DESC'
  ).all();
  const byTargetType = db.prepare(
    'SELECT target_type, COUNT(*) as count FROM auto_evolves GROUP BY target_type ORDER BY count DESC'
  ).all();
  return { byStatus, byTargetType };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  slugify,
  makeId,
  getComponentPath,
  generateComponent,
  parseYamlFrontmatter,
  syncInstincts,
  runAutoEvolve,
  revertAutoEvolve,
  queryAutoEvolves,
  getAutoEvolve,
  getAutoEvolveStats,
};
