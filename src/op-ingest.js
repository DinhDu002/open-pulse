'use strict';

const fs = require('fs');
const path = require('path');
const {
  insertEventBatch, upsertSessionBatch, insertSuggestionBatch,
  insertPrompt, getLatestPromptForSession, updatePromptStats,
} = require('./op-db');

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
  };
}

function normaliseSession(raw) {
  return {
    session_id:          raw.session_id          ?? null,
    started_at:          raw.started_at          ?? raw.ended_at ?? raw.ts ?? null,
    ended_at:            raw.ended_at            ?? raw.ts ?? null,
    working_directory:   raw.working_directory   ?? raw.work_dir ?? null,
    model:               raw.model               ?? null,
    total_input_tokens:  raw.total_input_tokens  ?? raw.input_tokens ?? 0,
    total_output_tokens: raw.total_output_tokens ?? raw.output_tokens ?? 0,
    total_cost_usd:      raw.total_cost_usd      ?? raw.estimated_cost_usd ?? 0,
  };
}

function normaliseSuggestion(raw) {
  return {
    id:           raw.id           ?? null,
    created_at:   raw.created_at   ?? null,
    type:         raw.type         ?? 'unknown',
    confidence:   raw.confidence   ?? 0,
    description:  raw.description  ?? null,
    evidence:     typeof raw.evidence === 'string'
                    ? raw.evidence
                    : JSON.stringify(raw.evidence ?? null),
    instinct_id:  raw.instinct_id  ?? null,
    status:       raw.status       ?? 'pending',
    category:     raw.category     ?? null,
    action_data:  typeof raw.action_data === 'string'
                    ? raw.action_data
                    : JSON.stringify(raw.action_data ?? null),
  };
}

// ---------------------------------------------------------------------------
// Session upsert with full fields
// ---------------------------------------------------------------------------

function upsertSessionFull(db, sessions) {
  // First upsert core fields via the shared batch function
  const coreRows = sessions.map(s => ({
    session_id:        s.session_id,
    started_at:        s.started_at,
    working_directory: s.working_directory,
    model:             s.model,
  }));
  upsertSessionBatch(db, coreRows);

  // Then update token/cost fields
  const update = db.prepare(`
    UPDATE sessions SET
      ended_at            = @ended_at,
      total_input_tokens  = @total_input_tokens,
      total_output_tokens = @total_output_tokens,
      total_cost_usd      = @total_cost_usd
    WHERE session_id = @session_id
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) update.run(row);
  });
  tx(sessions);
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
// Prompt linking helpers
// ---------------------------------------------------------------------------

function linkEventsToPrompts(db, events) {
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?');
  for (const evt of events) {
    if (!evt.user_prompt || !evt.session_id) {
      evt.prompt_id = null;
      continue;
    }
    // Skip prompt linking if the session record doesn't exist yet (e.g. events
    // ingested before sessions.jsonl, or in tests that only write event files)
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
      linkEventsToPrompts(db, events);
      insertEventBatch(db, events);
      updatePromptStatsAfterInsert(db, events);
    } else if (type === 'sessions') {
      upsertSessionFull(db, rows.map(normaliseSession));
    } else if (type === 'suggestions') {
      insertSuggestionBatch(db, rows.map(normaliseSuggestion));
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
 * @param {'events'|'sessions'|'suggestions'} type
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
 * Ingest all three JSONL files from a data directory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dataDir
 * @returns {{ events: object, sessions: object, suggestions: object }}
 */
function ingestAll(db, dataDir) {
  const results = {};
  for (const type of ['events', 'sessions', 'suggestions']) {
    const filePath = path.join(dataDir, `${type}.jsonl`);
    results[type] = ingestFile(db, filePath, type);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { ingestFile, ingestAll, MAX_RETRIES };
