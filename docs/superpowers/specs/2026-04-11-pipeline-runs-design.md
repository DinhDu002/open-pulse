# Pipeline Runs Tracking — Design Spec

## Summary

Track all internal Claude CLI invocations (knowledge extraction, knowledge scan, daily review, auto-evolve) in a single `pipeline_runs` table. Display run history with token usage stats on the project detail page.

## Motivation

Open Pulse spawns background Claude processes for knowledge extraction (post-ingest), cold-start scan (manual), and daily review (3AM cron). These runs consume tokens from the user's Max subscription but leave no trace — `OPEN_PULSE_INTERNAL=1` prevents collector hooks from recording them. Users have no visibility into how many tokens are consumed or whether runs succeed/fail.

## DB Schema

```sql
CREATE TABLE pipeline_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline      TEXT NOT NULL,        -- 'knowledge_extract' | 'knowledge_scan' | 'daily_review' | 'auto_evolve'
  project_id    TEXT,                 -- NULL for daily_review (cross-project)
  model         TEXT,                 -- 'opus' | 'sonnet' | 'haiku'
  status        TEXT NOT NULL,        -- 'success' | 'error'
  error         TEXT,                 -- error message on failure
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_ms   INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL         -- ISO timestamp
);
CREATE INDEX idx_pr_project ON pipeline_runs(project_id, created_at);
CREATE INDEX idx_pr_pipeline ON pipeline_runs(pipeline, created_at);
```

No duplication with existing tables — `knowledge_entries`, `daily_reviews`, and `auto_evolves` store domain results. This table only stores execution metadata.

### Retention

Delete rows where `created_at` exceeds `retention_cold_days` (90 days). Run in existing daily retention timer alongside event cleanup.

## Instrumentation Points

### 1. `src/knowledge/extract.js` — `callClaude()`

Currently returns only stdout and discards stderr. Modify to:
- Capture stderr
- Parse token usage from Claude CLI stderr
- Measure `duration_ms` via `Date.now()` delta
- Return `{ stdout, input_tokens, output_tokens, duration_ms }`

### 2. `src/knowledge/extract.js` — `extractKnowledgeFromPrompt()`

After `callClaude()` returns (success or error), insert a `pipeline_runs` row:
- `pipeline`: `'knowledge_extract'`
- `project_id`: from resolved project
- `model`: from opts
- Token/duration data from `callClaude()` return value
- `status`: `'success'` or `'error'`
- `error`: error message if failed

### 3. `src/knowledge/scan.js` — `scanProject()`

Same pattern as extract — after `callClaude()`, insert row with:
- `pipeline`: `'knowledge_scan'`

### 4. `src/review/pipeline.js` — `runDailyReview()`

After `execFileSync('claude', ...)` returns (or throws), insert row with:
- `pipeline`: `'daily_review'`
- `project_id`: `NULL` (cross-project)
- Parse token usage from execFileSync output/error

### Token Parsing

Claude CLI outputs token usage to stderr in a format that can be parsed. The exact format needs to be verified at implementation time. If stderr does not contain structured token data, fall back to estimating from prompt character count (rough: chars/4 for input tokens).

## API Endpoints

### `GET /api/projects/:id/pipeline-runs`

Query params:
- `pipeline` (optional) — filter by pipeline type
- `status` (optional) — filter by status
- `limit` (optional, default 20, max 100)

Response:
```json
{
  "items": [
    {
      "id": 1,
      "pipeline": "knowledge_extract",
      "model": "sonnet",
      "status": "success",
      "input_tokens": 1200,
      "output_tokens": 380,
      "duration_ms": 4200,
      "created_at": "2026-04-11T10:15:00Z"
    }
  ]
}
```

### `GET /api/pipeline-runs/stats`

Query params:
- `project_id` (optional) — scope to project
- `days` (optional, default 30)

Response:
```json
{
  "total_runs": 142,
  "total_input_tokens": 85000,
  "total_output_tokens": 23000,
  "success_count": 138,
  "error_count": 4,
  "by_pipeline": [
    { "pipeline": "knowledge_extract", "count": 120, "input_tokens": 70000, "output_tokens": 18000 },
    { "pipeline": "daily_review", "count": 22, "input_tokens": 15000, "output_tokens": 5000 }
  ]
}
```

## Frontend — Project Detail Page

Add a new section below the timeline chart in `public/modules/projects.js` `renderDetailContent()`.

### Stats Cards Row

4 cards in a grid:

| Total Runs | Total Tokens | Success Rate | Avg Duration |
|---|---|---|---|
| 142 | 108k | 97.2% | 3.8s |

Data from `GET /api/pipeline-runs/stats?project_id={id}`.

### History Table

Paginated table showing recent runs:

| Time | Pipeline | Model | Tokens (in/out) | Duration | Status |
|---|---|---|---|---|---|
| 2m ago | knowledge_extract | sonnet | 1.2k / 380 | 4.2s | ✓ |
| 5m ago | knowledge_scan | sonnet | 980 / 220 | 3.1s | ✗ |

- Pipeline column: color-coded badge (extract=blue, scan=purple, daily_review=amber)
- Status: green checkmark for success, red X for error
- Error rows: hover/click to see error message
- Default limit: 20, "Load more" button for pagination

Data from `GET /api/projects/{id}/pipeline-runs`.

## Files to Modify

| File | Change |
|---|---|
| `src/db/schema.js` | Add `pipeline_runs` table + indexes in migration |
| `src/knowledge/extract.js` | Modify `callClaude()` return shape; add run logging in `extractKnowledgeFromPrompt()` |
| `src/knowledge/scan.js` | Add run logging in `scanProject()` |
| `src/review/pipeline.js` | Add run logging in `runDailyReview()` |
| `src/retention.js` | Add `pipeline_runs` cleanup in daily retention |
| `src/routes/projects.js` | Add 2 new endpoints |
| `public/modules/projects.js` | Add stats cards + history table section |

## Out of Scope

- Auto-evolve observer logging (observer removed, re-add when observer is rebuilt)
- Token cost estimation (can derive from model + token counts client-side if needed later)
- Real-time updates (polling/SSE — table refreshes on page load only)
