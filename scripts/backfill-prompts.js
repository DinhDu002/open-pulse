'use strict';

const path = require('path');

function run(db) {
  const sessions = db.prepare(
    `SELECT DISTINCT e.session_id FROM events e
     INNER JOIN sessions s ON s.session_id = e.session_id
     WHERE e.prompt_id IS NULL AND e.user_prompt IS NOT NULL
     ORDER BY e.session_id`
  ).all();

  let totalPrompts = 0;

  const processSession = db.transaction((sessionId) => {
    const events = db.prepare(
      `SELECT id, timestamp, user_prompt, seq_num, estimated_cost_usd
       FROM events
       WHERE session_id = ? AND prompt_id IS NULL
         AND event_type != 'session_end'
       ORDER BY seq_num`
    ).all(sessionId);

    let currentPromptId = null;
    let currentPromptText = null;

    for (const evt of events) {
      if (!evt.user_prompt) continue;

      if (evt.user_prompt !== currentPromptText) {
        const result = db.prepare(
          `INSERT INTO prompts (session_id, prompt_text, seq_start, timestamp)
           VALUES (?, ?, ?, ?)`
        ).run(sessionId, evt.user_prompt, evt.seq_num ?? 0, evt.timestamp);
        currentPromptId = Number(result.lastInsertRowid);
        currentPromptText = evt.user_prompt;
        totalPrompts++;
      }

      db.prepare('UPDATE events SET prompt_id = ? WHERE id = ?')
        .run(currentPromptId, evt.id);
      db.prepare(
        `UPDATE prompts
         SET event_count = event_count + 1,
             total_cost_usd = total_cost_usd + ?,
             seq_end = ?,
             duration_ms = CAST(
               (julianday(?) - julianday(timestamp)) * 86400000 AS INTEGER
             )
         WHERE id = ?`
      ).run(evt.estimated_cost_usd ?? 0, evt.seq_num ?? 0, evt.timestamp, currentPromptId);
    }
  });

  for (const { session_id } of sessions) {
    processSession(session_id);
  }

  return { sessions: sessions.length, prompts: totalPrompts };
}

// CLI entry point
if (require.main === module) {
  const repoDir = process.argv.includes('--repo-dir')
    ? process.argv[process.argv.indexOf('--repo-dir') + 1]
    : path.resolve(__dirname, '..');
  const dbPath = process.env.OPEN_PULSE_DB
    || path.join(repoDir, 'open-pulse.db');
  const { createDb } = require(path.join(repoDir, 'src', 'op-db'));
  const db = createDb(dbPath);
  const result = run(db);
  console.log(
    'Backfill complete: ' + result.sessions + ' sessions, '
    + result.prompts + ' prompts created'
  );
  db.close();
}

module.exports = { run };
