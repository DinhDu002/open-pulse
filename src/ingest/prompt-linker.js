'use strict';

const {
  insertPrompt,
  getLatestPromptForSession,
  updatePromptStats,
  updatePromptTokens,
} = require('../db/prompts');

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
// Exports
// ---------------------------------------------------------------------------

module.exports = { linkEventsToPrompts, updatePromptStatsAfterInsert, distributeTokensToPrompts };
