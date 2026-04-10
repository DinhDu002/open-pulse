'use strict';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function insertPrompt(db, p) {
  const result = db.prepare(`
    INSERT INTO prompts (session_id, prompt_text, seq_start, timestamp)
    VALUES (@session_id, @prompt_text, @seq_start, @timestamp)
  `).run({
    session_id: p.session_id,
    prompt_text: p.prompt_text,
    seq_start: p.seq_start,
    timestamp: p.timestamp,
  });
  return Number(result.lastInsertRowid);
}

function getLatestPromptForSession(db, sessionId) {
  return db.prepare(
    'SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId);
}

function updatePromptStats(db, promptId, { seq_end, cost, timestamp }) {
  db.prepare(`
    UPDATE prompts
    SET event_count = event_count + 1,
        total_cost_usd = total_cost_usd + @cost,
        seq_end = @seq_end,
        duration_ms = CAST(
          (julianday(@timestamp) - julianday(timestamp)) * 86400000 AS INTEGER
        )
    WHERE id = @id
  `).run({ id: promptId, seq_end, cost: cost || 0, timestamp });
}

function updatePromptTokens(db, promptId, tokens) {
  db.prepare('UPDATE prompts SET total_tokens = @tokens WHERE id = @id')
    .run({ id: promptId, tokens });
}

module.exports = {
  insertPrompt,
  getLatestPromptForSession,
  updatePromptStats,
  updatePromptTokens,
};
