'use strict';

function insertPipelineRun(db, run) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO pipeline_runs (pipeline, project_id, model, status, error, input_tokens, output_tokens, duration_ms, created_at)
    VALUES (@pipeline, @project_id, @model, @status, @error, @input_tokens, @output_tokens, @duration_ms, @created_at)
  `).run({
    pipeline: run.pipeline,
    project_id: run.project_id ?? null,
    model: run.model ?? null,
    status: run.status ?? 'success',
    error: run.error ?? null,
    input_tokens: run.input_tokens ?? 0,
    output_tokens: run.output_tokens ?? 0,
    duration_ms: run.duration_ms ?? 0,
    created_at: now,
  });
  return result.lastInsertRowid;
}

function queryPipelineRuns(db, opts = {}) {
  const { projectId, pipeline, status } = opts;
  let { page = 1, perPage = 20 } = opts;
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 100);

  const conditions = [];
  const params = {};

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }
  if (pipeline) {
    conditions.push('pipeline = @pipeline');
    params.pipeline = pipeline;
  }
  if (status) {
    conditions.push('status = @status');
    params.status = status;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM pipeline_runs ${where}`).get(params).c;
  const items = db.prepare(
    `SELECT * FROM pipeline_runs ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  return { items, total, page, perPage };
}

function getPipelineRunStats(db, opts = {}) {
  const { projectId, days = 90 } = opts;

  const conditions = ["created_at >= datetime('now', '-' || @days || ' days')"];
  const params = { days };

  if (projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = projectId;
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(input_tokens) AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      AVG(duration_ms) AS avg_duration_ms
    FROM pipeline_runs ${where}
  `).get(params);

  const byPipeline = db.prepare(`
    SELECT pipeline, COUNT(*) AS count,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens
    FROM pipeline_runs ${where}
    GROUP BY pipeline
  `).all(params);

  return {
    total_runs: totals.total_runs,
    success_count: totals.success_count,
    error_count: totals.error_count,
    total_input_tokens: totals.total_input_tokens || 0,
    total_output_tokens: totals.total_output_tokens || 0,
    avg_duration_ms: Math.round(totals.avg_duration_ms || 0),
    by_pipeline: byPipeline,
  };
}

function updatePipelineRun(db, id, fields) {
  const allowed = ['status', 'error', 'input_tokens', 'output_tokens', 'duration_ms'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

function getPipelineRunTrends(db, opts = {}) {
  const { days = 30 } = opts;
  return db.prepare(`
    SELECT
      date(created_at) AS day,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM pipeline_runs
    WHERE created_at >= datetime('now', '-' || @days || ' days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all({ days });
}

module.exports = { insertPipelineRun, updatePipelineRun, queryPipelineRuns, getPipelineRunStats, getPipelineRunTrends };
