'use strict';

function withEventDefaults(evt) {
  return {
    detail: null, duration_ms: null, success: null,
    input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    working_directory: null, model: null, user_prompt: null,
    tool_input: null, tool_response: null, seq_num: null, prompt_id: null,
    project_name: null,
    ...evt,
  };
}

function insertEvent(db, evt) {
  db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num, prompt_id, project_name)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num, @prompt_id, @project_name)
  `).run(withEventDefaults(evt));
}

function insertEventBatch(db, events) {
  const insert = db.prepare(`
    INSERT INTO events
      (timestamp, session_id, event_type, name, detail, duration_ms, success,
       input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
       tool_input, tool_response, seq_num, prompt_id, project_name)
    VALUES
      (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
       @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
       @tool_input, @tool_response, @seq_num, @prompt_id, @project_name)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) insert.run(withEventDefaults(row));
  });
  tx(events);
}

module.exports = {
  insertEvent,
  insertEventBatch,
};
