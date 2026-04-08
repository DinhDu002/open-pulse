'use strict';

function upsertSession(db, sess) {
  db.prepare(`
    INSERT INTO sessions (session_id, started_at, working_directory, model)
    VALUES (@session_id, @started_at, @working_directory, @model)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at        = excluded.started_at,
      working_directory = excluded.working_directory,
      model             = excluded.model
  `).run(sess);
}

function upsertSessionBatch(db, sessions) {
  const upsert = db.prepare(`
    INSERT INTO sessions (session_id, started_at, working_directory, model)
    VALUES (@session_id, @started_at, @working_directory, @model)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at        = excluded.started_at,
      working_directory = excluded.working_directory,
      model             = excluded.model
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });
  tx(sessions);
}

function updateSessionEnd(db, data) {
  db.prepare(`
    UPDATE sessions SET
      ended_at             = @ended_at,
      total_tool_calls     = @total_tool_calls,
      total_skill_invokes  = @total_skill_invokes,
      total_agent_spawns   = @total_agent_spawns,
      total_input_tokens   = @total_input_tokens,
      total_output_tokens  = @total_output_tokens,
      total_cost_usd       = @total_cost_usd
    WHERE session_id = @session_id
  `).run(data);
}

module.exports = {
  upsertSession,
  upsertSessionBatch,
  updateSessionEnd,
};
