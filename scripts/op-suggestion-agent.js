'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');
const DB_PATH = process.env.OPEN_PULSE_DB || path.join(REPO_DIR, 'open-pulse.db');
const CONFIG_PATH = path.join(REPO_DIR, 'config.json');
const PROMPT_PATH = path.join(__dirname, 'op-suggestion-prompt.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(category, key) {
  return crypto.createHash('sha256').update(`${category}:${key}`).digest('hex').slice(0, 16);
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// Security patterns (checked in Node.js, results passed to AI)
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS = {
  dangerousSandbox: /dangerouslyDisableSandbox\s*[:=]\s*true/i,
  wildcardTools: /allowedTools\s*[:=]\s*\[?\s*["']\*["']/i,
  hardcodedSecrets: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}/i,
  envSecrets: /(?:process\.env\.|(?:\$ENV\{|\$\{))(?:API[_-]?KEY|SECRET|PASSWORD|TOKEN|PRIVATE[_-]?KEY|DATABASE[_-]?URL)/i,
};

// ---------------------------------------------------------------------------
// Phase 1: Export analysis data from SQLite
// ---------------------------------------------------------------------------

function exportAnalysisData(db) {
  const now = new Date();
  const days30Ago = new Date(now - 30 * 86400000).toISOString();
  const days7Ago = new Date(now - 7 * 86400000).toISOString();

  // Components with usage stats
  const components = db.prepare(`
    SELECT c.type, c.name, c.source, c.plugin, c.project,
           c.file_path, c.description, c.agent_class,
           c.first_seen_at,
           MAX(e_all.timestamp) AS last_used,
           COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END) AS invocations_30d,
           COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END) AS invocations_7d,
           CASE WHEN COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END) > 0
             THEN ROUND(
               SUM(CASE WHEN e_all.timestamp >= ? AND e_all.success = 0 THEN 1.0 ELSE 0 END) /
               COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END), 3)
             ELSE NULL END AS error_rate_30d,
           CASE WHEN COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END) > 0
             THEN ROUND(
               SUM(CASE WHEN e_all.timestamp >= ? AND e_all.success = 0 THEN 1.0 ELSE 0 END) /
               COUNT(CASE WHEN e_all.timestamp >= ? THEN 1 END), 3)
             ELSE NULL END AS error_rate_7d,
           ROUND(AVG(CASE WHEN e_all.timestamp >= ? THEN e_all.duration_ms END)) AS avg_duration_30d_ms,
           ROUND(AVG(CASE WHEN e_all.timestamp >= ? THEN e_all.duration_ms END)) AS avg_duration_7d_ms,
           ROUND(AVG(CASE WHEN e_all.timestamp >= ?
             THEN e_all.input_tokens + e_all.output_tokens END)) AS avg_tokens_30d,
           ROUND(AVG(CASE WHEN e_all.timestamp >= ?
             THEN e_all.input_tokens + e_all.output_tokens END)) AS avg_tokens_7d,
           ROUND(SUM(CASE WHEN e_all.timestamp >= ? THEN e_all.estimated_cost_usd ELSE 0 END), 4) AS total_cost_30d_usd
    FROM components c
    LEFT JOIN events e_all ON e_all.name = c.name
      AND e_all.event_type = CASE c.type
        WHEN 'skill' THEN 'skill_invoke'
        WHEN 'agent' THEN 'agent_spawn'
        ELSE 'tool_call'
      END
    WHERE c.type IN ('skill', 'agent')
    GROUP BY c.type, c.name, c.source
  `).all(
    days30Ago, days7Ago,
    days30Ago, days30Ago, days30Ago,
    days7Ago, days7Ago, days7Ago,
    days30Ago, days7Ago,
    days30Ago, days7Ago,
    days30Ago
  );

  // Check file existence + security scan
  const securityFindings = [];
  for (const comp of components) {
    if (comp.file_path) {
      comp.file_exists = false;
      try {
        if (fs.existsSync(comp.file_path)) {
          comp.file_exists = true;
          const content = fs.readFileSync(comp.file_path, 'utf8');
          for (const [patternName, regex] of Object.entries(SECURITY_PATTERNS)) {
            if (regex.test(content)) {
              securityFindings.push({
                component: comp.name, type: comp.type,
                issue: patternName, file_path: comp.file_path,
              });
            }
          }
        }
      } catch { /* skip access errors */ }
    }
    comp.has_description = !!(comp.description && comp.description.length >= 10);
    // Attach file content for underperforming components (refinement analysis)
    const hasQualityIssue = (comp.error_rate_30d > 0.15) || (comp.error_rate_7d > 0.2);
    if (hasQualityIssue && comp.file_path && comp.file_exists) {
      try {
        comp.file_content = fs.readFileSync(comp.file_path, 'utf8').slice(0, 3000);
      } catch { /* skip access errors */ }
    }
  }

  // Sessions summary
  const sessionsSummary = db.prepare(`
    SELECT
      COUNT(*) AS total_30d,
      COUNT(CASE WHEN started_at >= ? THEN 1 END) AS total_7d,
      ROUND(AVG(total_cost_usd), 4) AS avg_cost_per_session,
      ROUND(SUM(total_cost_usd), 2) AS total_cost_30d
    FROM sessions
    WHERE started_at >= ?
  `).get(days7Ago, days30Ago);

  const modelDist = {};
  db.prepare(`
    SELECT LOWER(COALESCE(model, 'unknown')) AS m, COUNT(*) AS c
    FROM sessions WHERE started_at >= ?
    GROUP BY m ORDER BY c DESC
  `).all(days30Ago).forEach(r => { modelDist[r.m] = r.c; });

  const shortExpensive = db.prepare(`
    SELECT session_id,
           (total_tool_calls + total_skill_invokes + total_agent_spawns) AS actions,
           ROUND(total_cost_usd, 4) AS cost, model
    FROM sessions
    WHERE started_at >= ?
      AND (total_tool_calls + total_skill_invokes + total_agent_spawns) < 5
      AND total_cost_usd > 0.10
      AND ended_at IS NOT NULL
    ORDER BY total_cost_usd DESC LIMIT 10
  `).all(days30Ago);

  // Workflow pairs (A→B trigger patterns)
  const workflowPairs = db.prepare(`
    WITH ordered AS (
      SELECT session_id, name, event_type,
             LEAD(name) OVER (PARTITION BY session_id ORDER BY seq_num, timestamp) AS next_name,
             LEAD(event_type) OVER (PARTITION BY session_id ORDER BY seq_num, timestamp) AS next_type
      FROM events
      WHERE event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp >= ?
    )
    SELECT name AS "from", next_name AS "to",
           COUNT(*) AS count,
           COUNT(DISTINCT session_id) AS sessions
    FROM ordered
    WHERE next_name IS NOT NULL AND name != next_name
    GROUP BY name, next_name
    HAVING count >= 3
    ORDER BY count DESC
    LIMIT 20
  `).all(days30Ago);

  // Error clusters
  const errorClusters = db.prepare(`
    SELECT session_id, GROUP_CONCAT(DISTINCT name) AS components,
           COUNT(DISTINCT name) AS count
    FROM events
    WHERE event_type IN ('skill_invoke', 'agent_spawn')
      AND success = 0 AND timestamp >= ?
    GROUP BY session_id
    HAVING count >= 3
    ORDER BY count DESC LIMIT 10
  `).all(days30Ago);

  // Component quality signals (post-invocation followups)
  const componentQualitySignals = db.prepare(`
    WITH invocations AS (
      SELECT id, session_id, name, event_type, seq_num
      FROM events
      WHERE event_type IN ('skill_invoke', 'agent_spawn')
        AND timestamp >= ?
    ),
    followups AS (
      SELECT i.name AS component_name, i.event_type AS component_type,
             i.session_id, i.seq_num AS invoke_seq,
             COUNT(*) AS follow_count,
             SUM(CASE WHEN e2.success = 0 THEN 1 ELSE 0 END) AS error_count
      FROM invocations i
      JOIN events e2 ON e2.session_id = i.session_id
        AND e2.seq_num > i.seq_num
        AND e2.seq_num <= i.seq_num + 10
        AND e2.event_type = 'tool_call'
      GROUP BY i.name, i.event_type, i.session_id, i.seq_num
    )
    SELECT component_name, component_type,
      COUNT(DISTINCT session_id) AS sessions,
      ROUND(AVG(follow_count), 1) AS avg_followup_calls,
      ROUND(AVG(error_count), 1) AS avg_followup_errors
    FROM followups
    GROUP BY component_name, component_type
    HAVING sessions >= 2
    ORDER BY avg_followup_errors DESC, avg_followup_calls DESC
    LIMIT 20
  `).all(days30Ago);

  // Quality instincts from CL observer
  const qualityInstincts = db.prepare(`
    SELECT instinct_id, pattern, confidence, last_seen, instinct
    FROM cl_instincts WHERE category = 'component-quality'
    ORDER BY confidence DESC LIMIT 20
  `).all();

  // Agent spawn patterns (for agent_creation suggestions)
  const agentSpawns = db.prepare(`
    SELECT name,
           COUNT(*) AS spawn_count,
           COUNT(DISTINCT session_id) AS session_count
    FROM events
    WHERE event_type = 'agent_spawn' AND timestamp >= ?
    GROUP BY name
    HAVING spawn_count >= 3
    ORDER BY spawn_count DESC LIMIT 20
  `).all(days30Ago);

  // Project contexts (which projects use which components)
  const projectContexts = db.prepare(`
    SELECT working_directory AS project,
           COUNT(*) AS events_30d,
           COUNT(DISTINCT session_id) AS sessions,
           GROUP_CONCAT(DISTINCT CASE WHEN event_type IN ('skill_invoke','agent_spawn') THEN name END) AS components_used
    FROM events
    WHERE timestamp >= ? AND working_directory IS NOT NULL AND working_directory != ''
    GROUP BY working_directory
    ORDER BY events_30d DESC LIMIT 10
  `).all(days30Ago).map(r => ({
    project: r.project,
    events_30d: r.events_30d,
    sessions: r.sessions,
    components_used: r.components_used ? r.components_used.split(',') : [],
  }));

  // Co-use patterns (components frequently used in same session)
  const coUsePatterns = db.prepare(`
    SELECT a.name AS component_a, b.name AS component_b,
           COUNT(DISTINCT a.session_id) AS shared_sessions
    FROM events a
    JOIN events b ON a.session_id = b.session_id AND a.name < b.name
    WHERE a.event_type IN ('skill_invoke','agent_spawn')
      AND b.event_type IN ('skill_invoke','agent_spawn')
      AND a.timestamp >= ?
    GROUP BY a.name, b.name
    HAVING shared_sessions >= 2
    ORDER BY shared_sessions DESC LIMIT 20
  `).all(days30Ago);

  // Previous suggestions feedback (calibration)
  const prevSuggestions = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'approved' AND resolved_at >= ? THEN 1 END) AS approved_30d,
      COUNT(CASE WHEN status = 'dismissed' AND resolved_at >= ? THEN 1 END) AS dismissed_30d
    FROM suggestions
  `).get(days30Ago, days30Ago);

  const dismissedCats = {};
  db.prepare(`
    SELECT category, COUNT(*) AS c FROM suggestions
    WHERE status = 'dismissed' AND resolved_at >= ? AND category IS NOT NULL
    GROUP BY category ORDER BY c DESC
  `).all(days30Ago).forEach(r => { dismissedCats[r.category] = r.c; });

  const totalFeedback = (prevSuggestions.approved_30d || 0) + (prevSuggestions.dismissed_30d || 0);
  const approvalRate = totalFeedback > 0
    ? Math.round((prevSuggestions.approved_30d / totalFeedback) * 100) : null;

  return {
    generated_at: now.toISOString(),
    period: { from: days30Ago.split('T')[0], to: now.toISOString().split('T')[0] },
    components,
    sessions_summary: {
      ...sessionsSummary,
      model_distribution: modelDist,
      short_expensive: shortExpensive,
    },
    workflow_pairs: workflowPairs,
    error_clusters: errorClusters.map(c => ({
      session_id: c.session_id,
      components: c.components.split(','),
      count: c.count,
    })),
    security_findings: securityFindings,
    agent_spawns: agentSpawns,
    project_contexts: projectContexts,
    co_use_patterns: coUsePatterns,
    component_quality_signals: componentQualitySignals,
    quality_instincts: qualityInstincts,
    previous_suggestions: {
      ...prevSuggestions,
      approval_rate: approvalRate,
      dismissed_categories: dismissedCats,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Build prompt and invoke Claude
// ---------------------------------------------------------------------------

function buildPrompt(data, config) {
  let template;
  try { template = fs.readFileSync(PROMPT_PATH, 'utf8'); }
  catch { throw new Error(`Prompt template not found: ${PROMPT_PATH}`); }

  const maxSuggestions = config.suggestion_agent_max_suggestions || 25;
  const approvalRate = data.previous_suggestions.approval_rate;
  const dismissedCats = Object.entries(data.previous_suggestions.dismissed_categories || {})
    .map(([k, v]) => `${k} (${v}x)`).join(', ') || 'none';

  return template
    .replace('{{DATA}}', JSON.stringify(data, null, 2))
    .replace('{{MAX_SUGGESTIONS}}', String(maxSuggestions))
    .replace('{{APPROVAL_RATE}}', approvalRate != null ? String(approvalRate) : 'N/A')
    .replace('{{DISMISSED_CATEGORIES}}', dismissedCats);
}

function invokeClaude(prompt, config) {
  const model = config.suggestion_agent_model || 'opus';
  const timeout = config.suggestion_agent_timeout_ms || 180000;

  return new Promise((resolve, reject) => {
    const child = execFile('claude', [
      '--model', model,
      '--max-turns', '1',
      '--print',
      '--allowedTools', '',
      '-p', prompt,
    ], {
      timeout,
      env: {
        ...process.env,
        OP_SKIP_COLLECT: '1',
        OP_HOOK_PROFILE: 'minimal',
      },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const msg = error.killed ? 'Claude CLI timed out' : (stderr || error.message);
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });

    // Safety: kill if parent exits
    process.on('exit', () => { try { child.kill(); } catch {} });
  });
}

// ---------------------------------------------------------------------------
// Phase 3: Parse AI output into suggestion objects
// ---------------------------------------------------------------------------

function buildActionSummary(actionData, type) {
  if (!actionData || !actionData.action) return null;
  const name = actionData.name || type || 'component';
  const VERB_MAP = {
    adopt: 'Use', redirect: 'Use', create: 'Create', remove: 'Remove',
    fix: 'Fix', combine: 'Combine', downgrade: 'Downgrade',
    integrate: 'Connect', refine: 'Refine', review: 'Review',
  };
  const verb = VERB_MAP[actionData.action] || 'Update';
  return `${verb} ${type} '${name}'`;
}

function parseSuggestions(rawOutput) {
  // Find JSON array in output
  const match = rawOutput.match(/\[[\s\S]*\]/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) return [];

  const validCategories = new Set([
    'adoption', 'cleanup', 'agent_creation', 'update', 'optimization', 'integration', 'cost', 'security', 'refinement',
  ]);
  const validTypes = new Set(['skill', 'agent']);

  return parsed
    .filter(s =>
      s && typeof s === 'object' &&
      validCategories.has(s.category) &&
      validTypes.has(s.type) &&
      typeof s.description === 'string' && s.description.length > 0
    )
    .map(s => {
      const actionData = s.action_data || null;
      const actionSummary = (typeof s.action_summary === 'string' && s.action_summary.length > 0)
        ? s.action_summary.slice(0, 80)
        : buildActionSummary(actionData, s.type);
      return {
        id: generateId(s.category, s.key || `${s.type}:${s.description.slice(0, 50)}`),
        created_at: new Date().toISOString(),
        type: s.type,
        confidence: clamp(s.confidence || 0.5, 0, 0.95),
        description: s.description.slice(0, 1000),
        description_vi: typeof s.description_vi === 'string' ? s.description_vi.slice(0, 2000) : null,
        evidence: JSON.stringify(Array.isArray(s.evidence) ? s.evidence : []),
        status: 'pending',
        category: s.category,
        action_data: JSON.stringify(actionData),
        action_summary: actionSummary,
      };
    });
}

// ---------------------------------------------------------------------------
// Phase 4: Write to DB + auto-resolve stale suggestions
// ---------------------------------------------------------------------------

function autoResolveStaleSuggestions(db) {
  const existingComponents = new Set(
    db.prepare("SELECT type || ':' || name AS key FROM components").all().map(r => r.key)
  );
  const active = db.prepare(
    "SELECT id, category, action_data FROM insights WHERE status = 'active' AND source = 'daily_analysis'"
  ).all();

  let resolved = 0;
  for (const sug of active) {
    let actionData;
    try { actionData = JSON.parse(sug.action_data); } catch { continue; }
    if (!actionData || !actionData.name || !actionData.type) continue;
    const key = `${actionData.type}:${actionData.name}`;
    if (!existingComponents.has(key)) {
      db.prepare(
        "UPDATE insights SET status = 'archived', updated_at = datetime('now') WHERE id = ?"
      ).run(sug.id);
      resolved++;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Phase 5: Batch translate missing description_vi via Haiku
// ---------------------------------------------------------------------------

function translateOne(sug) {
  const prompt =
    'Giải thích đề xuất sau bằng tiếng Việt theo đúng format 3 dòng:\n' +
    'Nghĩa là gì: [giải thích ngắn gọn đề xuất này nói gì]\n' +
    'Vấn đề: [tại sao cần quan tâm — rủi ro hoặc cơ hội bị bỏ lỡ]\n' +
    'Cách xử lý: [hành động cụ thể nên làm]\n\n' +
    'Chỉ trả về 3 dòng trên, không thêm giải thích. Dùng đầy đủ dấu tiếng Việt.\n\n' +
    'Description: ' + sug.description + '\n' +
    'Category: ' + sug.category + '\n' +
    'Type: ' + sug.type + '\n' +
    (sug.action_data ? 'Action data: ' + sug.action_data + '\n' : '');

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      resolve(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
    child.on('error', () => resolve(null));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function translateMissing(db) {
  // Translation deferred — insights table doesn't have description_vi column yet
  return 0;
}

// ---------------------------------------------------------------------------
// Phase 6: Batch translate missing instinct_vi via Haiku
// ---------------------------------------------------------------------------

function translateOneInstinct(instinct) {
  const prompt =
    'Dịch toàn bộ đoạn văn bản sau sang tiếng Việt, bao gồm cả tiêu đề (## Action → ## Hành động, ## Evidence → ## Bằng chứng, v.v.). ' +
    'Chỉ giữ nguyên: tên file, tên tool, code snippet, command. ' +
    'Chỉ trả về bản dịch, không thêm giải thích.\n\n' + instinct;

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn('claude', ['--model', 'haiku', '--max-turns', '1', '--print'], {
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      resolve(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
    child.on('error', () => resolve(null));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function translateMissingInstincts(db) {
  // Translation deferred — insights table doesn't have translation column yet
  return 0;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function run() {
  const Database = require('better-sqlite3');
  const config = loadConfig();

  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');

  try {
    let generated = 0;
    let categories = {};
    let resolved = 0;

    // Phases 1-4: Generate new suggestions (non-fatal — translation still runs on failure)
    try {
      // Phase 1: Export
      const data = exportAnalysisData(db);
      const componentCount = data.components.length;

      if (componentCount > 0 || data.sessions_summary.total_30d > 0) {
        // Phase 2: Build prompt + invoke Claude
        const prompt = buildPrompt(data, config);
        const rawOutput = await invokeClaude(prompt, config);

        // Phase 3: Parse suggestions
        const suggestions = parseSuggestions(rawOutput);

        // Phase 4: Write to DB
        const { upsertInsightBatch } = require(path.join(REPO_DIR, 'src', 'op-db'));
        if (suggestions.length > 0) {
          const insights = suggestions.map(s => ({
            id: s.id,
            source: 'daily_analysis',
            category: s.category || s.type || 'general',
            target_type: null,
            title: s.action_summary || (s.description || '').slice(0, 100),
            description: s.description,
            confidence: s.confidence || 0.5,
            action_data: s.action_data || null,
            project_id: null,
          }));
          upsertInsightBatch(db, insights);
        }

        generated = suggestions.length;
        for (const s of suggestions) {
          categories[s.category] = (categories[s.category] || 0) + 1;
        }
      }

      // Auto-resolve stale suggestions
      resolved = autoResolveStaleSuggestions(db);
    } catch (err) {
      process.stderr.write(`Phases 1-4 failed (continuing with translations): ${err.message}\n`);
    }

    // Phase 5: Batch translate missing description_vi using Haiku
    const translated = await translateMissing(db);

    // Phase 6: Batch translate missing instinct_vi using Haiku
    const translatedInstincts = await translateMissingInstincts(db);

    const result = { generated, categories, resolved, translated, translated_instincts: translatedInstincts };
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  run().catch(err => {
    process.stderr.write(`Suggestion agent error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
  generateId,
  clamp,
  exportAnalysisData,
  buildPrompt,
  parseSuggestions,
  buildActionSummary,
  autoResolveStaleSuggestions,
  translateMissingInstincts,
  SECURITY_PATTERNS,
};
