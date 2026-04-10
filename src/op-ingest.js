'use strict';

const fs = require('fs');
const path = require('path');
const {
  insertEventBatch, upsertSessionBatch, updateSessionEnd,
  insertPrompt, getLatestPromptForSession, updatePromptStats, updatePromptTokens,
} = require('./op-db');

let _extractKnowledge = null;
let _knowledgeConfig = null;

function setKnowledgeHook(extractFn, config) {
  _extractKnowledge = extractFn;
  _knowledgeConfig = config;
}

// ---------------------------------------------------------------------------
// Project name resolution
// ---------------------------------------------------------------------------

function resolveProjectName(db, workDir) {
  if (!workDir) return null;
  const row = db.prepare(
    'SELECT name FROM cl_projects WHERE directory = ?'
  ).get(workDir);
  return row ? row.name : path.basename(workDir);
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
// Token distribution
// ---------------------------------------------------------------------------

function distributeTokensToPrompts(db, sessionId, totalTokens) {
  const prompts = db.prepare(
    'SELECT id, event_count FROM prompts WHERE session_id = ?'
  ).all(sessionId);
  if (prompts.length === 0) return;

  const totalEvents = prompts.reduce((s, p) => s + (p.event_count || 0), 0);
  if (totalEvents === 0) {
    // Equal split when no events yet
    const perPrompt = Math.round(totalTokens / prompts.length);
    for (const p of prompts) {
      updatePromptTokens(db, p.id, perPrompt);
    }
  } else {
    for (const p of prompts) {
      const tokens = Math.round(totalTokens * (p.event_count / totalEvents));
      updatePromptTokens(db, p.id, tokens);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt linking helpers
// ---------------------------------------------------------------------------

function linkEventsToPrompts(db, events) {
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?');
  for (const evt of events) {
    if (!evt.user_prompt || !evt.session_id || evt.event_type === 'session_end') {
      evt.prompt_id = null;
      continue;
    }
    // Skip prompt linking if the session record doesn't exist yet
    if (!sessionExists.get(evt.session_id)) {
      evt.prompt_id = null;
      continue;
    }
    const latest = getLatestPromptForSession(db, evt.session_id);
    if (latest && latest.prompt_text === evt.user_prompt) {
      evt.prompt_id = latest.id;
    } else {
      evt.prompt_id = insertPrompt(db, {
        session_id: evt.session_id,
        prompt_text: evt.user_prompt,
        seq_start: evt.seq_num ?? 0,
        timestamp: evt.timestamp,
      });
    }
  }
}

function updatePromptStatsAfterInsert(db, events) {
  for (const evt of events) {
    if (evt.prompt_id) {
      updatePromptStats(db, evt.prompt_id, {
        seq_end: evt.seq_num ?? 0,
        cost: evt.estimated_cost_usd ?? 0,
        timestamp: evt.timestamp,
      });
    }
  }
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

      // Derive project_name from working_directory
      for (const evt of events) {
        if (!evt.project_name && evt.working_directory) {
          evt.project_name = resolveProjectName(db, evt.working_directory);
        }
      }

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

      // Trigger knowledge extraction for new prompts (non-blocking)
      if (_extractKnowledge) {
        const promptIds = new Set(events.map(e => e.prompt_id).filter(Boolean));
        for (const pid of promptIds) {
          setImmediate(() => {
            _extractKnowledge(db, pid, _knowledgeConfig || {}).catch(() => {});
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

module.exports = { ingestFile, ingestAll, MAX_RETRIES, setKnowledgeHook };
