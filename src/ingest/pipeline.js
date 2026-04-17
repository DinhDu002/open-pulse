'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { insertEventBatch } = require('../db/events');
const { upsertSessionBatch, updateSessionEnd } = require('../db/sessions');
const { linkEventsToPrompts, updatePromptStatsAfterInsert, distributeTokensToPrompts } = require('./prompt-linker');
const { logError } = require('../db/components');
const { upsertClProject } = require('../db/projects');
const { loadConfig } = require('../lib/config');
const { isGitRepo } = require('../lib/format');

let _extractKnowledge = null;
let _knowledgeConfig = null;

function setKnowledgeHook(extractFn, config) {
  _extractKnowledge = extractFn;
  _knowledgeConfig = config;
}

let _detectPatterns = null;
let _patternConfig = null;

function setPatternHook(detectFn, config) {
  _detectPatterns = detectFn;
  _patternConfig = config;
}

let _scoreQuality = null;
let _qualityConfig = null;

function setQualityHook(scoreFn, config) {
  _scoreQuality = scoreFn;
  _qualityConfig = config;
}

let _generateReview = null;
let _reviewConfig = null;

function setReviewHook(reviewFn, config) {
  _generateReview = reviewFn;
  _reviewConfig = config;
}

let _extractSessionKnowledge = null;
let _sessionKnowledgeConfig = null;

function setSessionKnowledgeHook(extractFn, config) {
  _extractSessionKnowledge = extractFn;
  _sessionKnowledgeConfig = config;
}

// ---------------------------------------------------------------------------
// Project name resolution
// ---------------------------------------------------------------------------

function projectIdFromDir(workDir) {
  const hash = crypto.createHash('sha256').update(workDir).digest('hex').substring(0, 12);
  return `proj-${hash}`;
}

function resolveProjectNames(db, events) {
  const seen = new Map();
  for (const evt of events) {
    if (evt.project_name || !evt.working_directory) continue;
    const workDir = evt.working_directory;
    if (seen.has(workDir)) { evt.project_name = seen.get(workDir); continue; }

    const row = db.prepare('SELECT name FROM cl_projects WHERE directory = ?').get(workDir);
    let name;
    if (row) {
      name = row.name;
    } else {
      name = path.basename(workDir);
      // Auto-register project if workDir is a git repo. Non-git dirs still
      // get a project_name for event traceability, but are excluded from
      // the projects list (only cl_projects is shown).
      if (isGitRepo(workDir)) {
        const now = new Date().toISOString();
        upsertClProject(db, {
          project_id: projectIdFromDir(workDir),
          name,
          directory: workDir,
          first_seen_at: now,
          last_seen_at: now,
          session_count: 0,
        });
      }
    }
    seen.set(workDir, name);
    evt.project_name = name;
  }
}

// ---------------------------------------------------------------------------
// Field normalisation helpers
// ---------------------------------------------------------------------------

function normaliseEvent(raw) {
  return {
    timestamp:          raw.timestamp          ?? null,
    session_id:         raw.session_id         ?? null,
    event_type:         raw.event_type         ?? 'unknown',
    name:               raw.name               ?? null,
    detail:             raw.detail             ?? null,
    duration_ms:        raw.duration_ms        ?? null,
    success:            raw.success            ?? null,
    input_tokens:       raw.input_tokens       ?? null,
    output_tokens:      raw.output_tokens      ?? null,
    estimated_cost_usd: raw.estimated_cost_usd ?? null,
    working_directory:  raw.working_directory  ?? raw.work_dir ?? null,
    model:              raw.model              ?? null,
    user_prompt:        raw.user_prompt        ?? null,
    tool_input:         raw.tool_input         ?? null,
    tool_response:      raw.tool_response      ?? null,
    seq_num:            raw.seq_num            ?? null,
    project_name:       raw.project_name       ?? null,
  };
}


// ---------------------------------------------------------------------------
// Parse JSONL — returns { rows, errors }
// ---------------------------------------------------------------------------

function parseJsonl(content) {
  const rows = [];
  let errors = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      errors++;
    }
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

function readRetryCount(retriesPath) {
  try {
    return JSON.parse(fs.readFileSync(retriesPath, 'utf8')).count || 0;
  } catch {
    return 0;
  }
}

function writeRetryCount(retriesPath, count) {
  fs.writeFileSync(retriesPath, JSON.stringify({ count }));
}

// ---------------------------------------------------------------------------
// processContent — read, parse, and insert a .processing file
// ---------------------------------------------------------------------------

function processContent(db, processingPath, type) {
  const content = fs.readFileSync(processingPath, 'utf8');
  const { rows, errors } = parseJsonl(content);

  if (rows.length > 0) {
    if (type === 'events') {
      const events = rows.map(normaliseEvent);

      // Derive project_name from working_directory (auto-registers git repos)
      resolveProjectNames(db, events);

      // Upsert sessions from events (so prompt linking can find them)
      const sessionMap = new Map();
      for (const evt of events) {
        if (!evt.session_id) continue;
        if (!sessionMap.has(evt.session_id)) {
          sessionMap.set(evt.session_id, {
            session_id: evt.session_id,
            started_at: evt.timestamp,
            working_directory: evt.working_directory,
            model: evt.model,
          });
        }
      }
      if (sessionMap.size > 0) {
        upsertSessionBatch(db, [...sessionMap.values()]);
      }

      // Update session end fields from session_end events
      for (const evt of events) {
        if (evt.event_type === 'session_end' && evt.session_id) {
          updateSessionEnd(db, {
            session_id: evt.session_id,
            ended_at: evt.timestamp,
            total_tool_calls: 0,
            total_skill_invokes: 0,
            total_agent_spawns: 0,
            total_input_tokens: evt.input_tokens || 0,
            total_output_tokens: evt.output_tokens || 0,
            total_cost_usd: evt.estimated_cost_usd || 0,
          });

        }
      }

      linkEventsToPrompts(db, events);
      insertEventBatch(db, events);
      updatePromptStatsAfterInsert(db, events);

      // Collect prompt IDs for post-processing hooks
      const promptIds = new Set(events.map(e => e.prompt_id).filter(Boolean));

      // Fresh-read config per batch so runtime toggles take effect without restart
      const cfg = loadConfig();

      // Trigger knowledge extraction for new prompts (non-blocking)
      if (cfg.knowledge_enabled !== false && _extractKnowledge) {
        for (const pid of promptIds) {
          setImmediate(() => {
            _extractKnowledge(db, pid, _knowledgeConfig || {}).catch(err => {
              try {
                logError(db, {
                  hook_type: 'pipeline:knowledge_extract',
                  error_message: `prompt_id=${pid}: ${err.message || String(err)}`,
                  raw_input: null,
                });
              } catch { /* DB write failed — nothing more we can do */ }
            });
          });
        }
      }

      // Trigger pattern detection for new prompts (non-blocking)
      if (cfg.pattern_detect_enabled !== false && _detectPatterns) {
        for (const pid of promptIds) {
          setImmediate(() => {
            _detectPatterns(db, pid, _patternConfig || {}).catch(err => {
              try {
                logError(db, {
                  hook_type: 'pipeline:pattern_detect',
                  error_message: `prompt_id=${pid}: ${err.message || String(err)}`,
                  raw_input: null,
                });
              } catch { /* DB write failed — nothing more we can do */ }
            });
          });
        }
      }

      // Trigger quality scoring for new prompts (non-blocking)
      if (cfg.quality_scoring_enabled !== false && _scoreQuality) {
        for (const pid of promptIds) {
          setImmediate(() => {
            _scoreQuality(db, pid, _qualityConfig || {}).catch(err => {
              try {
                logError(db, {
                  hook_type: 'pipeline:quality_score',
                  error_message: `prompt_id=${pid}: ${err.message || String(err)}`,
                  raw_input: null,
                });
              } catch { /* DB write failed — nothing more we can do */ }
            });
          });
        }
      }

      // Distribute tokens proportionally across session prompts (after prompts exist)
      for (const evt of events) {
        if (evt.event_type === 'session_end' && evt.session_id) {
          const sessionTokens = (evt.input_tokens || 0) + (evt.output_tokens || 0);
          if (sessionTokens > 0) {
            distributeTokensToPrompts(db, evt.session_id, sessionTokens);
          }
        }
      }

      // Compute ended sessions once (shared by review + session-extract hooks)
      const endedSessionIds = new Set(
        events.filter(e => e.event_type === 'session_end' && e.session_id).map(e => e.session_id)
      );

      // Trigger session retrospective for ended sessions (delayed to allow scoring to complete)
      if (cfg.quality_review_enabled !== false && _generateReview) {
        for (const sid of endedSessionIds) {
          setTimeout(() => {
            _generateReview(db, sid, _reviewConfig || {}).catch(err => {
              try {
                logError(db, {
                  hook_type: 'pipeline:session_review',
                  error_message: `session_id=${sid}: ${err.message || String(err)}`,
                  raw_input: null,
                });
              } catch { /* DB write failed — nothing more we can do */ }
            });
          }, 60_000); // 60s delay: gives quality scoring time to complete for all prompts
        }
      }

      // Trigger session-level knowledge extraction after retrospective completes.
      // Opt-in (default off): config.knowledge_session_extract_enabled === true.
      // Timer is fire-and-forget — lost on server restart by design (per-prompt
      // extract already covered this session's prompts, so retry isn't needed).
      if (cfg.knowledge_session_extract_enabled === true && _extractSessionKnowledge) {
        for (const sid of endedSessionIds) {
          setTimeout(() => {
            _extractSessionKnowledge(db, sid, _sessionKnowledgeConfig || {}).catch(err => {
              try {
                logError(db, {
                  hook_type: 'pipeline:session_knowledge_extract',
                  error_message: `session_id=${sid}: ${err.message || String(err)}`,
                  raw_input: null,
                });
              } catch { /* DB write failed */ }
            });
          }, 120_000); // 120s: runs after review (60s) completes
        }
      }
    }
  }

  return { processed: rows.length, errors };
}

// ---------------------------------------------------------------------------
// ingestFile
// ---------------------------------------------------------------------------

/**
 * Atomic JSONL ingestion for a single file.
 *
 * Handles leftover .processing files from previous failures before processing
 * new .jsonl data. Uses a .retries counter to avoid infinite retry loops —
 * after MAX_RETRIES failures, the file is moved to .failed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath  - full path to the .jsonl file
 * @param {'events'} type
 * @returns {{ processed: number, errors: number }}
 */
function ingestFile(db, filePath, type) {
  const processingPath = filePath + '.processing';
  const retriesPath = filePath + '.retries';
  const failedPath = filePath + '.failed';

  let result = { processed: 0, errors: 0 };

  // 1. Retry leftover .processing file from a previous failed attempt
  if (fs.existsSync(processingPath)) {
    const count = readRetryCount(retriesPath);

    if (count >= MAX_RETRIES) {
      // Give up — move to .failed so it can be inspected manually
      fs.renameSync(processingPath, failedPath);
      try { fs.unlinkSync(retriesPath); } catch { /* already gone */ }
    } else {
      try {
        result = processContent(db, processingPath, type);
        fs.unlinkSync(processingPath);
        try { fs.unlinkSync(retriesPath); } catch { /* already gone */ }
      } catch (err) {
        writeRetryCount(retriesPath, count + 1);
        throw err;
      }
    }
  }

  // 2. Process new .jsonl file
  if (!fs.existsSync(filePath)) return result;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return result;

  fs.renameSync(filePath, processingPath);

  try {
    const newResult = processContent(db, processingPath, type);
    fs.unlinkSync(processingPath);
    return {
      processed: result.processed + newResult.processed,
      errors: result.errors + newResult.errors,
    };
  } catch (err) {
    writeRetryCount(retriesPath, 1);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ingestAll
// ---------------------------------------------------------------------------

/**
 * Ingest all JSONL files from a data directory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dataDir
 * @returns {{ events: object }}
 */
function ingestAll(db, dataDir) {
  const results = {};
  const filePath = path.join(dataDir, 'events.jsonl');
  results.events = ingestFile(db, filePath, 'events');
  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { ingestFile, ingestAll, MAX_RETRIES, setKnowledgeHook, setPatternHook, setQualityHook, setReviewHook, setSessionKnowledgeHook };
