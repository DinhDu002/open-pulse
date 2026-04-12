'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  collectWorkHistory, scanAllComponents, loadBestPractices, buildPrompt,
  getKnowledgeReviewContext,
  discoverProjectPaths, scanOneProject, scanProjectConfigs,
} = require('./context');
const {
  queryDailyReviews, getDailyReview, updateDailyReviewStatus, getDailyReviewStats,
  queryInsights, getInsight, updateInsightStatus, getInsightStats,
} = require('./queries');
const { insertPipelineRun } = require('../db/pipeline-runs');

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

function parseReviewOutput(output) {
  if (!output || typeof output !== 'string') return { suggestions: [], insights: [] };

  // Try labeled blocks first: ```json suggestions and ```json insights
  const sugMatch = output.match(/```json\s+suggestions\s*\n([\s\S]*?)\n```/);
  const insMatch = output.match(/```json\s+insights\s*\n([\s\S]*?)\n```/);

  if (sugMatch || insMatch) {
    let suggestions = [];
    let insights = [];
    if (sugMatch) {
      try {
        const parsed = JSON.parse(sugMatch[1].trim());
        if (Array.isArray(parsed)) suggestions = parsed.filter(s => s && s.title && s.category);
      } catch { /* ignore */ }
    }
    if (insMatch) {
      try {
        const parsed = JSON.parse(insMatch[1].trim());
        if (Array.isArray(parsed)) insights = parsed.filter(i => i && i.title && i.insight_type);
      } catch { /* ignore */ }
    }
    return { suggestions, insights };
  }

  // Fallback: single unlabeled block treated as suggestions
  return { suggestions: parseSuggestions(output), insights: [] };
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

function makeInsightId(title, date) {
  const hash = crypto
    .createHash('sha256')
    .update(`insight::${title}::${date}`)
    .digest('hex')
    .substring(0, 16);
  return `dri-${hash}`;
}

function saveInsights(db, insights, reviewDate) {
  const stmt = db.prepare(`
    INSERT INTO daily_review_insights
      (id, review_date, insight_type, title, description, projects, target_type, severity, reasoning, summary_vi, status, created_at)
    VALUES
      (@id, @review_date, @insight_type, @title, @description, @projects, @target_type, @severity, @reasoning, @summary_vi, 'pending', @created_at)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      severity = excluded.severity,
      reasoning = excluded.reasoning,
      summary_vi = excluded.summary_vi
  `);

  const tx = db.transaction((rows) => {
    for (const ins of rows) {
      stmt.run({
        id: makeInsightId(ins.title, reviewDate),
        review_date: reviewDate,
        insight_type: ins.insight_type || 'gap',
        title: ins.title,
        description: ins.description || '',
        projects: JSON.stringify(ins.projects || []),
        target_type: ins.target_type || null,
        severity: ins.severity || 'info',
        reasoning: ins.reasoning || '',
        summary_vi: ins.summary_vi || '',
        created_at: new Date().toISOString(),
      });
    }
  });
  tx(insights);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function writeReport(suggestions, history, reportDir, date, insights = []) {
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

  if (insights.length > 0) {
    lines.push(`## Cross-Project Insights (${insights.length} total)`);
    lines.push('');
    insights.forEach((ins, i) => {
      lines.push(`### ${i + 1}. [${ins.insight_type}] ${ins.title}`);
      lines.push(`- **Severity:** ${ins.severity || 'info'}`);
      lines.push(`- **Projects:** ${(ins.projects || []).join(', ') || 'N/A'}`);
      lines.push(`- **Target:** ${ins.target_type || 'N/A'}`);
      lines.push(`- **Reasoning:** ${ins.reasoning || 'N/A'}`);
      lines.push(`- **Description:** ${ins.description || 'N/A'}`);
      lines.push('');
    });
  }

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
    historyDays = 1,
    reportDir,
    repoDir,
    claudeDir,
    dryRun = false,
  } = opts;

  const history = collectWorkHistory(db, date, historyDays);
  const components = scanAllComponents(claudeDir);
  const projectConfigs = scanProjectConfigs(db);
  const practices = loadBestPractices(repoDir);
  const knowledgeContext = getKnowledgeReviewContext(db);
  const prompt = buildPrompt(history, components, practices, {
    date,
    max_suggestions,
    projectConfigs,
    historyDays,
  }, knowledgeContext);

  const promptSize = Buffer.byteLength(prompt, 'utf8');
  console.log(`Prompt size: ${promptSize} bytes (${(promptSize / 1024).toFixed(1)} KB)`);

  if (dryRun) {
    return { suggestions: [], insights: [], reportPath: null, dryRun: true, promptSize };
  }

  let output;
  let reviewTokens = { input_tokens: 0, output_tokens: 0 };
  const startTime = Date.now();
  try {
    const rawOutput = execFileSync('claude', [
      '--model', model,
      '--max-turns', '1',
      '-p',
      '--output-format', 'json',
    ], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
      maxBuffer: 50 * 1024 * 1024,
    });
    try {
      const parsed = JSON.parse(rawOutput);
      output = parsed.result || rawOutput;
      const usage = parsed.usage || {};
      reviewTokens = {
        input_tokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
        output_tokens: usage.output_tokens || 0,
      };
    } catch {
      output = rawOutput;
    }
    insertPipelineRun(db, {
      pipeline: 'daily_review',
      project_id: null,
      model,
      status: 'success',
      input_tokens: reviewTokens.input_tokens,
      output_tokens: reviewTokens.output_tokens,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    insertPipelineRun(db, {
      pipeline: 'daily_review',
      project_id: null,
      model,
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - startTime,
    });
    console.error('Claude invocation failed:', err.message);
    return { suggestions: [], insights: [], reportPath: null, error: err.message };
  }

  const { suggestions: rawSuggestions, insights: rawInsights } = parseReviewOutput(output);
  const suggestions = rawSuggestions.slice(0, max_suggestions);
  const insights = rawInsights;

  saveSuggestions(db, suggestions, date);
  saveInsights(db, insights, date);
  const reportPath = writeReport(suggestions, history, reportDir, date, insights);

  return { suggestions, insights, reportPath };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { createDb } = require('../db/schema');
  const DB_PATH = process.env.OPEN_PULSE_DB || path.join(REPO_DIR, 'open-pulse.db');

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
  } catch { /* use defaults */ }

  const db = createDb(DB_PATH);
  const dryRun = process.argv.includes('--dry-run');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  runDailyReview(db, {
    date: yesterday,
    model: config.daily_review_model || 'opus',
    timeout: config.daily_review_timeout_ms || 300000,
    max_suggestions: config.daily_review_max_suggestions || 25,
    historyDays: config.daily_review_history_days || 1,
    dryRun,
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
  parseReviewOutput,
  saveSuggestions,
  writeReport,
  makeReviewId,
  queryDailyReviews,
  getDailyReview,
  updateDailyReviewStatus,
  getDailyReviewStats,
  runDailyReview,
  saveInsights,
  makeInsightId,
  queryInsights,
  getInsight,
  updateInsightStatus,
  getInsightStats,
  discoverProjectPaths,
  scanOneProject,
  scanProjectConfigs,
};
