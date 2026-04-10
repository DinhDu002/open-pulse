'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { collectWorkHistory, scanAllComponents, loadBestPractices, buildPrompt } = require('./context');
const { queryDailyReviews, getDailyReview, updateDailyReviewStatus, getDailyReviewStats } = require('./queries');

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Parse + Save
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
      (id, review_date, category, title, description, target_type, action, confidence, reasoning, summary_vi, status, created_at)
    VALUES
      (@id, @review_date, @category, @title, @description, @target_type, @action, @confidence, @reasoning, @summary_vi, 'pending', @created_at)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      confidence = excluded.confidence,
      reasoning = excluded.reasoning,
      summary_vi = excluded.summary_vi
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
        summary_vi: s.summary_vi || '',
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
  const { createDb } = require('../op-db');
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
