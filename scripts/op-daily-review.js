'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

// ---------------------------------------------------------------------------
// Phase 1: Collect work history
// ---------------------------------------------------------------------------

function collectWorkHistory(db, date) {
  const events = db.prepare(`
    SELECT event_type, name, detail, estimated_cost_usd AS cost, input_tokens, output_tokens, timestamp
    FROM events
    WHERE DATE(timestamp) = ?
    ORDER BY timestamp ASC
  `).all(date);

  const sessions = db.prepare(`
    SELECT session_id, started_at, ended_at, model, total_cost_usd AS cost, total_input_tokens, total_output_tokens
    FROM sessions
    WHERE DATE(started_at) = ?
    ORDER BY started_at ASC
  `).all(date);

  const totalCost = events.reduce((sum, e) => sum + (e.cost || 0), 0);

  return { events, sessions, totalCost };
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
// Phase 4: Build prompt
// ---------------------------------------------------------------------------

function buildPrompt(history, components, practices, opts = {}) {
  const { date = new Date().toISOString().slice(0, 10), max_suggestions = 25 } = opts;

  const templatePath = path.join(__dirname, 'op-daily-review-prompt.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  const formatComponents = (items) =>
    items.map(c => `#### ${c.name}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');

  const replacements = {
    '{{date}}': date,
    '{{work_history_json}}': JSON.stringify({
      events: history.events.slice(0, 200),
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
    '{{claude_code_knowledge}}': practices.map(p => `### ${p.name}\n${p.content}`).join('\n\n'),
    '{{max_suggestions}}': String(max_suggestions),
  };

  for (const [key, val] of Object.entries(replacements)) {
    template = template.replaceAll(key, val);
  }

  return template;
}

// ---------------------------------------------------------------------------
// Phase 5: Parse + Save
// ---------------------------------------------------------------------------

function parseSuggestions(output) {
  if (!output || typeof output !== 'string') return [];

  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : output.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(s => s && s.title && s.category);
  } catch {
    return [];
  }
}

function makeReviewId(title, date) {
  const hash = crypto
    .createHash('sha256')
    .update(`${title}::${date}`)
    .digest('hex')
    .substring(0, 16);
  return `dr-${hash}`;
}

function saveSuggestions(db, suggestions, reviewDate) {
  const stmt = db.prepare(`
    INSERT INTO daily_reviews
      (id, review_date, category, title, description, target_type, action, confidence, reasoning, status, created_at)
    VALUES
      (@id, @review_date, @category, @title, @description, @target_type, @action, @confidence, @reasoning, 'pending', @created_at)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      confidence = excluded.confidence,
      reasoning = excluded.reasoning
  `);

  const tx = db.transaction((rows) => {
    for (const s of rows) {
      stmt.run({
        id: makeReviewId(s.title, reviewDate),
        review_date: reviewDate,
        category: s.category || 'general',
        title: s.title,
        description: s.description || '',
        target_type: s.target_type || null,
        action: s.action || null,
        confidence: Math.min(1.0, Math.max(0.0, s.confidence || 0.5)),
        reasoning: s.reasoning || '',
        created_at: new Date().toISOString(),
      });
    }
  });
  tx(suggestions);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function writeReport(suggestions, history, reportDir, date) {
  const dir = reportDir || path.join(REPO_DIR, 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `# Daily Review -- ${date}`,
    '',
    '## Summary',
    `- Sessions: ${history.sessions.length}`,
    `- Total cost: $${history.totalCost.toFixed(4)}`,
    `- Events: ${history.events.length}`,
    '',
    `## Suggestions (${suggestions.length} total)`,
    '',
  ];

  suggestions.forEach((s, i) => {
    lines.push(`### ${i + 1}. [${s.category}] ${s.title}`);
    lines.push(`- **Action:** ${s.action || 'N/A'}`);
    lines.push(`- **Target:** ${s.target_type || 'N/A'}`);
    lines.push(`- **Confidence:** ${s.confidence}`);
    lines.push(`- **Reasoning:** ${s.reasoning || 'N/A'}`);
    lines.push(`- **Description:** ${s.description || 'N/A'}`);
    lines.push('');
  });

  const reportPath = path.join(dir, `${date}-daily-review.md`);
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

// ---------------------------------------------------------------------------
// Query helpers (self-contained)
// ---------------------------------------------------------------------------

function queryDailyReviews(db, opts = {}) {
  const { review_date, status, category, page = 1, per_page = 20 } = opts;
  const p = Math.max(1, page);
  const pp = Math.max(1, Math.min(per_page, 100));

  const conditions = [];
  const params = [];
  if (review_date) { conditions.push('review_date = ?'); params.push(review_date); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { cnt: total } = db.prepare(`SELECT COUNT(*) AS cnt FROM daily_reviews ${where}`).get(...params);
  const offset = (p - 1) * pp;
  const rows = db.prepare(`
    SELECT * FROM daily_reviews ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pp, offset);

  return { rows, total, page: p, per_page: pp };
}

function getDailyReview(db, id) {
  return db.prepare('SELECT * FROM daily_reviews WHERE id = ?').get(id);
}

function updateDailyReviewStatus(db, id, status) {
  db.prepare('UPDATE daily_reviews SET status = ? WHERE id = ?').run(status, id);
}

function getDailyReviewStats(db) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) as count FROM daily_reviews GROUP BY status ORDER BY count DESC'
  ).all();
  const byCategory = db.prepare(
    'SELECT category, COUNT(*) as count FROM daily_reviews GROUP BY category ORDER BY count DESC'
  ).all();
  const byDate = db.prepare(
    'SELECT review_date, COUNT(*) as count FROM daily_reviews GROUP BY review_date ORDER BY review_date DESC LIMIT 30'
  ).all();
  return { byStatus, byCategory, byDate };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

async function runDailyReview(db, opts = {}) {
  const {
    date = new Date().toISOString().slice(0, 10),
    model = 'opus',
    timeout = 300000,
    max_suggestions = 25,
    reportDir,
    repoDir,
    claudeDir,
  } = opts;

  const history = collectWorkHistory(db, date);
  const components = scanAllComponents(claudeDir);
  const practices = loadBestPractices(repoDir);
  const prompt = buildPrompt(history, components, practices, { date, max_suggestions });

  let output;
  try {
    output = execFileSync('claude', [
      '--model', model,
      '--max-turns', '1',
      '--print',
      '-p', prompt,
    ], {
      timeout,
      encoding: 'utf8',
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], reportPath: null, error: err.message };
  }

  const suggestions = parseSuggestions(output).slice(0, max_suggestions);
  saveSuggestions(db, suggestions, date);
  const reportPath = writeReport(suggestions, history, reportDir, date);

  return { suggestions, reportPath };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { createDb } = require('../src/op-db');
  const DB_PATH = process.env.OPEN_PULSE_DB || path.join(REPO_DIR, 'open-pulse.db');

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
  } catch { /* use defaults */ }

  const db = createDb(DB_PATH);
  runDailyReview(db, {
    model: config.daily_review_model || 'opus',
    timeout: config.daily_review_timeout_ms || 300000,
    max_suggestions: config.daily_review_max_suggestions || 25,
  })
    .then(result => {
      console.log(`Daily review complete: ${result.suggestions.length} suggestions`);
      if (result.reportPath) console.log(`Report: ${result.reportPath}`);
      db.close();
    })
    .catch(err => {
      console.error('Daily review failed:', err);
      db.close();
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  collectWorkHistory,
  scanAllComponents,
  loadBestPractices,
  buildPrompt,
  parseSuggestions,
  saveSuggestions,
  writeReport,
  makeReviewId,
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  runDailyReview,
};
