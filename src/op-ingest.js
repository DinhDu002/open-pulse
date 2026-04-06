'use strict';

const fs = require('fs');
const path = require('path');
const { insertEventBatch, upsertSessionBatch, insertSuggestionBatch } = require('./op-db');

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
    working_directory:  raw.working_directory  ?? null,
    model:              raw.model              ?? null,
    user_prompt:        raw.user_prompt        ?? null,
  };
}

function normaliseSession(raw) {
  return {
    session_id:          raw.session_id          ?? null,
    started_at:          raw.started_at          ?? raw.ended_at ?? null,
    ended_at:            raw.ended_at            ?? null,
    working_directory:   raw.working_directory   ?? null,
    model:               raw.model               ?? null,
    total_input_tokens:  raw.total_input_tokens  ?? 0,
    total_output_tokens: raw.total_output_tokens ?? 0,
    total_cost_usd:      raw.total_cost_usd      ?? 0,
  };
}

function normaliseSuggestion(raw) {
  return {
    id:          raw.id          ?? null,
    created_at:  raw.created_at  ?? null,
    type:        raw.type        ?? 'unknown',
    confidence:  raw.confidence  ?? 0,
    description: raw.description ?? null,
    evidence:    typeof raw.evidence === 'string'
                   ? raw.evidence
                   : JSON.stringify(raw.evidence ?? null),
    status:      raw.status      ?? 'pending',
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
// ingestFile
// ---------------------------------------------------------------------------

/**
 * Atomic JSONL ingestion for a single file.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath  - full path to the .jsonl file
 * @param {'events'|'sessions'|'suggestions'} type
 * @returns {{ processed: number, errors: number }}
 */
function ingestFile(db, filePath, type) {
  // 1. Check file exists and has content
  if (!fs.existsSync(filePath)) {
    return { processed: 0, errors: 0 };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { processed: 0, errors: 0 };
  }

  const processingPath = filePath + '.processing';

  // 2. Atomic rename: mark as in-progress
  fs.renameSync(filePath, processingPath);

  try {
    const content = fs.readFileSync(processingPath, 'utf8');
    const { rows, errors } = parseJsonl(content);

    // 3. Normalise and batch-insert
    if (rows.length > 0) {
      if (type === 'events') {
        insertEventBatch(db, rows.map(normaliseEvent));
      } else if (type === 'sessions') {
        upsertSessionFull(db, rows.map(normaliseSession));
      } else if (type === 'suggestions') {
        insertSuggestionBatch(db, rows.map(normaliseSuggestion));
      }
    }

    // 4. Success: delete the .processing file
    fs.unlinkSync(processingPath);

    return { processed: rows.length, errors };
  } catch (err) {
    // 5. Failure: rename .processing back to original for retry
    try {
      fs.renameSync(processingPath, filePath);
    } catch {
      // best-effort recovery
    }
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

module.exports = { ingestFile, ingestAll };
