'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseFrontmatter, extractBody } = require('../lib/frontmatter');

// ---------------------------------------------------------------------------
// ID generation (local — only used by syncInstincts)
// ---------------------------------------------------------------------------

function makeId(title, targetType) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${targetType}`)
    .digest('hex')
    .substring(0, 16);
  return `ae-${hash}`;
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

function syncInstincts(db, repoDir, blacklist = ['hook']) {
  const clDir = path.join(repoDir, 'cl', 'instincts');
  const subdirs = ['inherited', 'personal'];
  const stmt = db.prepare(UPSERT_SQL);
  let synced = 0;

  for (const sub of subdirs) {
    const dir = path.join(clDir, sub);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const meta = parseFrontmatter(content);
      if (!meta || !meta.name) continue;

      const targetType = meta.type || null;
      if (!targetType || blacklist.includes(targetType)) continue;

      const now = new Date().toISOString();
      stmt.run({
        id: makeId(meta.name, targetType),
        title: meta.name,
        description: extractBody(content) || meta.description || '',
        target_type: targetType,
        confidence: parseFloat(meta.confidence) || 0.05,
        observation_count: parseInt(meta.seen_count, 10) || 1,
        created_at: now,
        updated_at: now,
      });
      synced++;
    }
  }

  return synced;
}

module.exports = { UPSERT_SQL, syncInstincts, makeId };
