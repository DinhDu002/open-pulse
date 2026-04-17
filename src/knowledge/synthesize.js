'use strict';

const {
  markKnowledgeEntryOutdated,
  insertEntryHistory,
} = require('./queries');
const { renderKnowledgeVault } = require('./vault');
const { insertPipelineRun } = require('../db/pipeline-runs');

// ---------------------------------------------------------------------------
// Tokenization + Jaccard
// ---------------------------------------------------------------------------

// English stopwords common in knowledge-entry prose. Kept minimal on purpose —
// aggressive stopword removal hurts similarity precision on short titles.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'and', 'or', 'but', 'not', 'no',
  'do', 'does', 'did', 'has', 'have', 'had',
  'it', 'its', 'as', 'if',
]);

function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    String(text).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Keeper selection
// ---------------------------------------------------------------------------

/**
 * Picks which of two overlapping entries to keep. Longer body wins; if equal,
 * more recent updated_at wins.
 */
function pickKeeper(a, b) {
  const la = (a.body || '').length;
  const lb = (b.body || '').length;
  if (la > lb) return { keep: a, drop: b };
  if (lb > la) return { keep: b, drop: a };
  return (a.updated_at >= b.updated_at) ? { keep: a, drop: b } : { keep: b, drop: a };
}

// ---------------------------------------------------------------------------
// planSynthesize — pure function (no DB mutation) for unit testability
// ---------------------------------------------------------------------------

const DEFAULT_TITLE_THRESHOLD = 0.75;
const DEFAULT_BODY_THRESHOLD = 0.6;

/**
 * Given an array of active knowledge entries, return an ordered list of merge
 * decisions: which entries should be marked outdated and which keepId they
 * merge into. Runs two passes:
 *
 *   1. Title Jaccard ≥ titleThreshold → duplicate title wording
 *   2. Body Jaccard ≥ bodyThreshold, same (source_file, category) → same
 *      underlying topic re-described differently
 *
 * @param {Array}  entries
 * @param {object} [opts]
 * @param {number} [opts.titleThreshold=0.75]
 * @param {number} [opts.bodyThreshold=0.6]
 * @returns {Array<{keepId, dropId, reason, similarity}>}
 */
function planSynthesize(entries, opts = {}) {
  const titleThreshold = opts.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;
  const bodyThreshold = opts.bodyThreshold ?? DEFAULT_BODY_THRESHOLD;

  if (!entries || entries.length < 2) return [];

  const titleTokens = new Map();
  const bodyTokens = new Map();
  for (const e of entries) {
    titleTokens.set(e.id, tokenize(e.title));
    bodyTokens.set(e.id, tokenize(e.body));
  }

  const outdated = new Set();
  const outcomes = [];

  // Pass 1 — title similarity
  for (let i = 0; i < entries.length; i++) {
    if (outdated.has(entries[i].id)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (outdated.has(entries[j].id)) continue;
      const sim = jaccard(titleTokens.get(entries[i].id), titleTokens.get(entries[j].id));
      if (sim >= titleThreshold) {
        const { keep, drop } = pickKeeper(entries[i], entries[j]);
        outdated.add(drop.id);
        outcomes.push({
          keepId: keep.id,
          dropId: drop.id,
          reason: 'title_jaccard',
          similarity: Number(sim.toFixed(3)),
        });
      }
    }
  }

  // Pass 2 — same source_file + category, body similarity
  const groups = new Map();
  for (const e of entries) {
    if (outdated.has(e.id)) continue;
    if (!e.source_file) continue;
    const key = `${e.source_file}::${e.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (outdated.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (outdated.has(group[j].id)) continue;
        const sim = jaccard(bodyTokens.get(group[i].id), bodyTokens.get(group[j].id));
        if (sim >= bodyThreshold) {
          const { keep, drop } = pickKeeper(group[i], group[j]);
          outdated.add(drop.id);
          outcomes.push({
            keepId: keep.id,
            dropId: drop.id,
            reason: 'source_body_jaccard',
            similarity: Number(sim.toFixed(3)),
          });
        }
      }
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// applySynthesize — apply plan inside a transaction
// ---------------------------------------------------------------------------

/**
 * Writes the outcomes from planSynthesize: for each drop, record an
 * 'auto_merged' history snapshot (with merge target) and mark it outdated.
 */
function applySynthesize(db, entries, outcomes) {
  if (!outcomes || outcomes.length === 0) return;
  const byId = new Map(entries.map(e => [e.id, e]));

  const tx = db.transaction(() => {
    for (const o of outcomes) {
      const entry = byId.get(o.dropId);
      if (!entry) continue;
      insertEntryHistory(db, {
        entry_id: o.dropId,
        change_type: 'auto_merged',
        snapshot: {
          title:       entry.title,
          body:        entry.body,
          category:    entry.category,
          status:      entry.status,
          merged_into: o.keepId,
          similarity:  o.similarity,
          reason:      o.reason,
        },
      });
      markKnowledgeEntryOutdated(db, o.dropId);
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// runSynthesize — full pipeline for one project
// ---------------------------------------------------------------------------

/**
 * Runs deterministic dedup for a single project. Returns a summary; also logs
 * a pipeline_run row (status='success' or 'error').
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {object} [opts]
 * @returns {{merged:number, entries:number, outcomes:Array}|{error:string}}
 */
function runSynthesize(db, projectId, opts = {}) {
  const startTime = Date.now();
  let entries;
  try {
    entries = db.prepare(
      "SELECT * FROM knowledge_entries WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC"
    ).all(projectId);
  } catch (err) {
    insertPipelineRun(db, {
      pipeline: 'auto_synthesize',
      project_id: projectId,
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - startTime,
    });
    return { error: err.message };
  }

  if (entries.length < 2) {
    insertPipelineRun(db, {
      pipeline: 'auto_synthesize',
      project_id: projectId,
      status: 'success',
      duration_ms: Date.now() - startTime,
    });
    return { merged: 0, entries: entries.length, outcomes: [] };
  }

  let outcomes;
  try {
    outcomes = planSynthesize(entries, opts);
    applySynthesize(db, entries, outcomes);
  } catch (err) {
    insertPipelineRun(db, {
      pipeline: 'auto_synthesize',
      project_id: projectId,
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - startTime,
    });
    return { error: err.message };
  }

  insertPipelineRun(db, {
    pipeline: 'auto_synthesize',
    project_id: projectId,
    status: 'success',
    duration_ms: Date.now() - startTime,
  });

  if (outcomes.length > 0) {
    try { renderKnowledgeVault(db, projectId); } catch { /* non-critical */ }
  }

  return { merged: outcomes.length, entries: entries.length, outcomes };
}

// ---------------------------------------------------------------------------
// runSynthesizeAll — loop through every registered project
// ---------------------------------------------------------------------------

function runSynthesizeAll(db, opts = {}) {
  const projects = db.prepare('SELECT project_id FROM cl_projects').all();
  const results = {};
  for (const { project_id } of projects) {
    results[project_id] = runSynthesize(db, project_id, opts);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  tokenize,
  jaccard,
  pickKeeper,
  planSynthesize,
  applySynthesize,
  runSynthesize,
  runSynthesizeAll,
  DEFAULT_TITLE_THRESHOLD,
  DEFAULT_BODY_THRESHOLD,
};
