# Daily Review — Plan Generation Feature

> Date: 2026-04-12
> Status: Draft (pending user review)

## Goal

Add a button on the daily-review detail page (`#daily-reviews/:id`) that triggers a Claude Opus session to generate an actionable plan for implementing the suggestion. The plan is for **handoff** — the user reads it, then copies a ready-to-paste handoff prompt into a fresh Claude Code session that actually applies the changes. Open Pulse never auto-executes.

## Non-goals

- Auto-execution of the plan inside Open Pulse.
- Multi-version plan history per suggestion (only the latest plan is kept).
- Cross-suggestion batch planning.
- Real-time streaming of Opus output (polling is sufficient).
- Migrating existing routes to fresh-config-read (scope kept narrow to this feature).

## User flow

1. User opens `#daily-reviews/dr-xxx`.
2. Below the Vietnamese summary card, a `[Generate Plan with Opus]` button appears (when `plan_md` is null).
3. User clicks the button.
4. UI swaps to a "Generating…" card with a spinner. Frontend starts polling `/plan-status` every 3 seconds.
5. Backend spawns `claude` CLI in the background, builds a target-aware prompt, parses output, persists `plan_md` and `handoff_prompt` to `daily_reviews`, and logs the run to `pipeline_runs`.
6. When status flips to `done`, frontend re-fetches the review and renders two cards: **Plan** (markdown, for reading) and **Handoff Prompt** (literal text, for copy-paste). Each card has its own **Copy** button. The original button becomes **Regenerate Plan**.
7. On error, frontend renders an error card with **Try Again** that re-triggers the same POST.

## Architecture

```
User clicks [Generate Plan]
        |
        v
POST /api/daily-reviews/:id/plan/generate
        |
        v
+----------------------------+
| Route handler              |
| 1. loadConfig() (fresh)    |
| 2. Check enabled           |
| 3. Check max_concurrent    |
| 4. Validate review exists  |
| 5. Check no existing run   |
| 6. INSERT pipeline_runs    |
| 7. UPDATE plan_status=running
| 8. activePlanGenerations++ |
| 9. spawn() background      |
| 10. Reply 202              |
+----------------------------+
        |
        v (background, non-blocking)
+----------------------------+
| Child process              |
| - resolveTargetFiles()     |
| - buildPlanPrompt()        |
| - claude --model opus      |
|         --output-format json
|         -p (stdin)         |
| - parsePlanOutput()        |
| - savePlan(db, ...)        |
| - updatePipelineRun(...)   |
| - activePlanGenerations--  |
+----------------------------+

Frontend (in parallel):
+----------------------------+
| Polling loop (every 3s)    |
| GET /plan-status           |
| Stop on done/error/timeout |
| Re-fetch full review       |
| Render plan + handoff cards|
+----------------------------+
```

## Schema changes

`ALTER TABLE daily_reviews ADD COLUMN IF NOT EXISTS ...` (pattern already used in `src/db/schema.js`):

| Column | Type | Purpose |
|---|---|---|
| `plan_md` | TEXT | Markdown plan content (for human reading) |
| `handoff_prompt` | TEXT | Literal prompt to copy into a fresh Claude Code session |
| `plan_status` | TEXT | NULL / `running` / `done` / `error` |
| `plan_generated_at` | TEXT | ISO timestamp of latest successful generation |
| `plan_error` | TEXT | Error message when `plan_status='error'` |
| `plan_run_id` | INTEGER | FK to `pipeline_runs.id` of the latest run |

`pipeline_runs` reuse: a new `pipeline` value `'plan_generation'` is logged per invocation. No new table.

## Config changes

Add to `config.json`:

```json
{
  "plan_generation_enabled": true,
  "plan_generation_model": "opus",
  "plan_generation_timeout_ms": 120000,
  "plan_generation_max_context_kb": 100,
  "plan_generation_max_concurrent": 3
}
```

**All config reads are fresh from disk per request.** The feature does NOT use the cached `opts.config` injected at boot. A new helper `src/lib/config.js` exposes `loadConfig()` that reads + parses `config.json` on every call.

Existing routes are not migrated in this scope.

## Backend modules

### `src/lib/config.js` (new)

```js
'use strict';
const fs = require('fs');
const path = require('path');

function loadConfig() {
  const cfgPath = process.env.OPEN_PULSE_CONFIG
    || path.resolve(__dirname, '..', '..', 'config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

module.exports = { loadConfig };
```

### `src/review/plan.js` (new)

Module-level state (in-memory, resets on restart):

```js
let activePlanGenerations = 0;
const activeReviewIds = new Set();
```

Functions:

- **`resolveTargetFiles(suggestion, claudeDir)`** — maps `target_type` → file paths to read:
  - `rule` → `~/.claude/rules/*.md` (cap 10 most recent)
  - `skill` → `~/.claude/skills/*/SKILL.md`
  - `agent` → `~/.claude/agents/*.md`
  - `hook` → entries in `~/.claude/settings.json` `hooks` block (extracted)
  - `memory` → `~/.claude/CLAUDE.md`
  - `knowledge` → `<project>/.claude/knowledge/*.md` (project resolved from `suggestion.projects` JSON, first entry)
  - `config` → `~/.claude/settings.json`
  - Always include `~/.claude/CLAUDE.md` to convey global conventions.
  - **Total content capped at `plan_generation_max_context_kb` (default 100 KB).** When capped, the function truncates oldest files first and includes a note in the prompt.

- **`buildPlanPrompt(suggestion, targetFiles, claudeMd)`** — returns a string prompt for Opus. Structure:
  ```
  You are a planning assistant for Open Pulse. Your task is to read a daily-review
  suggestion and produce (a) a clear markdown plan for the user to review and (b) a
  ready-to-paste handoff prompt for a fresh Claude Code session to actually implement
  the change.

  ## Suggestion
  Title: <title>
  Category: <category>
  Target type: <target_type>
  Action: <action>
  Description: <description>
  Reasoning: <reasoning>

  ## Target files
  ### <path1>
  <content1>
  ### <path2>
  <content2>
  ...

  ## Output format (REQUIRED)
  Respond with EXACTLY two fenced blocks, no preamble:

  ```markdown plan
  <human-readable plan: rationale, steps, file paths, snippets>
  ```

  ```text handoff
  <literal prompt the user will paste into a fresh Claude Code session>
  ```
  ```

- **`parsePlanOutput(rawOutput)`** — extracts both fenced blocks via regex (mirrors `parseReviewOutput` in `src/review/pipeline.js`). Returns `{plan_md, handoff_prompt}`. Throws if either block is missing or empty.

- **`generatePlanAsync(db, reviewId, opts)`** — orchestration. **Not detached** — runs as a normal child of the server process so it dies if the server dies (orphan rows are cleaned up at startup).
  1. Build prompt (sync, fast).
  2. `child = spawn('claude', ['--model', model, '--max-turns', '1', '--output-format', 'json', '-p'], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal'}})`.
  3. `child.stdin.write(prompt); child.stdin.end()`.
  4. Collect stdout/stderr buffers via `child.stdout.on('data', ...)` and `child.stderr.on('data', ...)`.
  5. `const killTimer = setTimeout(() => child.kill('SIGTERM'), timeout)`.
  6. On `child.on('exit', code => ...)`:
     - `clearTimeout(killTimer)`.
     - `code === 0`: parse JSON output → extract `result` → `parsePlanOutput()` → `savePlan()` + `updatePipelineRun(runId, {status:'success', tokens, duration_ms})`.
     - non-zero or parse fail: `updatePlanStatus(reviewId, 'error', stderr || parseErr.message)` + `updatePipelineRun(runId, {status:'error', error, duration_ms})`.
     - Always: `activePlanGenerations--`, `activeReviewIds.delete(reviewId)`.
  7. Returns nothing meaningful — the function returns a Promise that resolves on child exit (so the route handler can attach `.catch` for safety), but the caller does NOT await it. All persistence happens inside the exit handler.

### `src/db/pipeline-runs.js` additions

Existing `insertPipelineRun()` does not support marking a row as complete after the fact. Add:

```js
function updatePipelineRun(db, id, fields) {
  // Allowed fields: status, error, input_tokens, output_tokens, duration_ms
  const allowed = ['status', 'error', 'input_tokens', 'output_tokens', 'duration_ms'];
  const sets = [];
  const params = {id};
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

module.exports = { insertPipelineRun, updatePipelineRun, queryPipelineRuns, getPipelineRunStats };
```

### `src/review/queries.js` additions

```js
function savePlan(db, id, planMd, handoffPrompt, runId) {
  db.prepare(`
    UPDATE daily_reviews
    SET plan_md = ?, handoff_prompt = ?, plan_status = 'done',
        plan_generated_at = ?, plan_run_id = ?, plan_error = NULL
    WHERE id = ?
  `).run(planMd, handoffPrompt, new Date().toISOString(), runId, id);
}

function updatePlanStatus(db, id, status, error = null) {
  db.prepare(`
    UPDATE daily_reviews SET plan_status = ?, plan_error = ? WHERE id = ?
  `).run(status, error, id);
}

function getPlanStatus(db, id) {
  return db.prepare(`
    SELECT plan_status, plan_error, plan_run_id
    FROM daily_reviews WHERE id = ?
  `).get(id);
}
```

### `src/routes/daily-reviews.js` additions

```js
const { loadConfig } = require('../lib/config');
const plan = require('../review/plan');
const { savePlan, updatePlanStatus, getPlanStatus } = require('../review/queries');

// POST /api/daily-reviews/:id/plan/generate
app.post('/api/daily-reviews/:id/plan/generate', async (req, reply) => {
  const cfg = loadConfig();  // FRESH READ, no cache

  if (!cfg.plan_generation_enabled) {
    return errorReply(reply, 400, 'Plan generation is disabled');
  }

  if (plan.activePlanGenerations >= (cfg.plan_generation_max_concurrent || 3)) {
    return errorReply(reply, 429,
      `Plan generation at capacity (${plan.activePlanGenerations}/${cfg.plan_generation_max_concurrent})`);
  }

  const review = getDailyReview(db, req.params.id);
  if (!review) return errorReply(reply, 404, 'Daily review not found');
  if (review.plan_status === 'running') {
    return errorReply(reply, 409, 'Plan is already being generated for this review');
  }

  const runId = insertPipelineRun(db, {
    pipeline: 'plan_generation', project_id: null,
    model: cfg.plan_generation_model, status: 'running',
  });

  updatePlanStatus(db, req.params.id, 'running');
  plan.activePlanGenerations++;
  plan.activeReviewIds.add(req.params.id);

  // Kick off background, do not await
  plan.generatePlanAsync(db, req.params.id, {
    model: cfg.plan_generation_model,
    timeout: cfg.plan_generation_timeout_ms,
    max_context_kb: cfg.plan_generation_max_context_kb,
    runId,
  }).catch(err => {
    // Should never throw — generatePlanAsync handles its own errors —
    // but log just in case to avoid silent failure
    req.log.error({err}, 'plan generation kickoff failed');
  });

  reply.code(202).send({run_id: runId, status: 'running'});
});

// GET /api/daily-reviews/:id/plan-status
app.get('/api/daily-reviews/:id/plan-status', (req, reply) => {
  const status = getPlanStatus(db, req.params.id);
  if (!status) return errorReply(reply, 404, 'Daily review not found');
  reply.send(status);
});
```

Note: `getDailyReview()` returns the full row including the new plan columns — no separate fetch needed for the existing detail endpoint.

### Server startup cleanup

In `src/server.js` (or wherever DB is initialized), after `createDb()`:

```js
db.prepare(`
  UPDATE daily_reviews SET plan_status = 'error',
    plan_error = 'Server restarted during plan generation'
  WHERE plan_status = 'running'
`).run();
```

This clears orphan `running` rows from a crashed/restarted server. The in-memory counter `activePlanGenerations` resets to 0 on restart by definition.

## Frontend changes

### `public/modules/daily-reviews.js` — extend `renderDetail()`

After the Vietnamese summary card (around line 500), call `renderPlanSection(el, review)`:

```js
const activePollers = new Map();  // module-level: reviewId → intervalId

function renderPlanSection(el, review) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '20px';

  if (review.plan_status === 'running') {
    renderRunningState(card, review.id);
  } else if (review.plan_md && review.plan_status === 'done') {
    renderPlanCards(card, review);
  } else if (review.plan_status === 'error') {
    renderErrorState(card, review);
  } else {
    renderGenerateButton(card, review.id);
  }

  el.appendChild(card);
}

function startPolling(reviewId, el) {
  // Cleanup any existing poller for this review
  stopPolling(reviewId);

  const intervalId = setInterval(async () => {
    try {
      const status = await get(`/daily-reviews/${reviewId}/plan-status`);
      if (status.plan_status === 'done' || status.plan_status === 'error') {
        stopPolling(reviewId);
        renderDetail(el, reviewId);  // re-fetch & re-render full detail
      }
    } catch (err) {
      stopPolling(reviewId);
      // show error
    }
  }, 3000);

  activePollers.set(reviewId, {intervalId, startedAt: Date.now()});

  // Hard timeout: 5 minutes
  setTimeout(() => {
    if (activePollers.has(reviewId)) {
      stopPolling(reviewId);
      // re-render with timeout message
    }
  }, 5 * 60 * 1000);
}

function stopPolling(reviewId) {
  const poller = activePollers.get(reviewId);
  if (poller) {
    clearInterval(poller.intervalId);
    activePollers.delete(reviewId);
  }
}

export function unmount() {
  // Clear ALL active pollers when leaving the daily-reviews route
  for (const [id] of activePollers) stopPolling(id);
}
```

UI states:

- **Generate button** (no plan yet): primary button "Generate Plan with Opus", with a small Opus icon. On click → POST `/plan/generate` → if 202, immediately render running state + start polling. If 429 → show inline error "Server busy, try again in a few seconds". If 409 → re-fetch and render running state.

- **Running**: card with spinner, label "Claude Opus đang phân tích suggestion…", and a small "elapsed: Xs" counter updated every second. Polling active.

- **Done**:
  - Card 1 — **Plan**:
    - Title: "Plan" + small meta showing `plan_generated_at` and tokens (looked up via `plan_run_id` if needed; or just timestamp for v1).
    - Body: `<pre>` with `white-space: pre-wrap` rendering `plan_md`.
    - Button: `[Copy Plan]`.
  - Card 2 — **Handoff Prompt**:
    - Title: "Handoff Prompt"
    - Subtitle: "Copy đoạn này, paste vào 1 Claude Code session mới để bắt đầu thực thi."
    - Body: `<textarea readonly>` with `handoff_prompt` (textarea so user can scroll easily).
    - Buttons: `[Copy Handoff Prompt]` (primary) and `[Regenerate Plan]` (secondary).

- **Error**:
  - Title: "Plan generation failed"
  - Body: `plan_error` text.
  - Button: `[Try Again]` → POST `/plan/generate` again.

**Copy button behavior:**
```js
copyBtn.onclick = async () => {
  await navigator.clipboard.writeText(content);
  const orig = copyBtn.textContent;
  copyBtn.textContent = 'Copied!';
  setTimeout(() => { copyBtn.textContent = orig; }, 2000);
};
```

## Error handling

| Case | Handling |
|---|---|
| Suggestion not found | Route → 404 (sync, before spawn) |
| `plan_status === 'running'` | Route → 409, frontend shows "đang sinh plan" |
| `plan_generation_enabled === false` | Route → 400 |
| `activePlanGenerations >= max_concurrent` | Route → 429 with capacity message |
| `claude` CLI not installed | spawn `error` event → status='error', `plan_error='Claude CLI not found'` |
| Claude exits non-zero | Capture stderr → status='error', `plan_error=stderr` |
| Output missing one or both fenced blocks | `parsePlanOutput` throws → status='error', `plan_error='Failed to parse plan output'`. Raw output saved to `pipeline_runs.error` for debugging. |
| Timeout (default 120s) | `child.kill('SIGTERM')`, status='error', `plan_error='Generation timed out after 120s'` |
| Prompt > `max_context_kb` | `resolveTargetFiles` truncates context with a note; never let prompt exceed cap |
| Frontend polling > 5 min still running | `stopPolling`, render timeout message + Try Again |
| User navigates away | `unmount()` clears all active pollers |
| Server crashes mid-generation | Startup cleanup query resets orphan rows to `error` |
| Concurrent POST for same review | Per-review check (`plan_status='running'` AND `activeReviewIds.has(id)`) → 409 |

`pipeline_runs` is logged for both success and error paths. Filterable via existing `/api/pipeline-runs/*` endpoints with `pipeline=plan_generation`.

## Testing strategy

### Unit tests (`test/review/plan.test.js`)

1. **`parsePlanOutput()`**:
   - Output with both fenced blocks → returns `{plan_md, handoff_prompt}`.
   - Missing plan block → throws.
   - Missing handoff block → throws.
   - Output with preamble/postamble around blocks → still extracts correctly.
   - Empty output → throws.

2. **`resolveTargetFiles()`**:
   - `target_type='rule'` → returns paths from `rules/`.
   - `target_type='skill'` → returns SKILL.md paths.
   - `target_type=null` → returns only CLAUDE.md.
   - Total size > cap → truncates and adds a note.
   - Unknown `target_type` → returns CLAUDE.md only, logs warning.

3. **`buildPlanPrompt()`**:
   - Suggestion + 0 files → valid prompt.
   - Suggestion + N files → all file content present in prompt.
   - Output instruction always includes both fenced-block requirements.

### Integration tests (`test/routes/plan-routes.test.js`)

1. **`POST /plan/generate`**:
   - Review not found → 404.
   - Disabled → 400.
   - Capacity reached (mock counter) → 429.
   - Already running → 409.
   - Happy path → 202 with `run_id`, row updated to `plan_status='running'`.

2. **`GET /plan-status`**:
   - Returns `{plan_status, plan_error, plan_run_id}` only (lightweight).
   - Does NOT return `plan_md`/`handoff_prompt` (verified by JSON keys).

3. **End-to-end with stub**:
   - Set `OP_PLAN_TEST_STUB_OUTPUT` env var with fixed claude CLI output.
   - Test: POST generate → poll → done → fetch detail → has `plan_md` and `handoff_prompt`.

4. **Server restart cleanup**:
   - Seed `plan_status='running'` → call createDb cleanup → row becomes `error`.

### E2E test (Playwright, per "Always test UI/UX" feedback)

- Seed test DB with one daily review.
- Stub claude CLI by overriding PATH with a script that returns canned output in ~200 ms.
- Open `#daily-reviews/<id>` in headless browser.
- Click "Generate Plan with Opus".
- Verify spinner appears.
- Wait until polling completes (~3-5 s).
- Verify both cards Plan + Handoff render.
- Click each Copy button and verify clipboard contents (Playwright `page.evaluate(() => navigator.clipboard.readText())`).
- Take screenshot `daily-review-plan-generated.png`.

### Coverage

Target 80%+ on the new module per project rule.

## Decisions log

| Question | Answer | Why |
|---|---|---|
| Goal of plan? | Handoff prompt only, no auto-execute | User chose option 3 |
| Persistence? | Latest only, columns on existing table | User chose option 2 |
| Context for Opus? | Target-aware (read related files) | User chose option 2 |
| Execution model? | Async polling with `spawn` | User chose option 2; avoids known footgun of blocking event loop |
| Output format? | Plan markdown + handoff prompt as separate fenced blocks | User chose option 2 |
| Concurrency limit? | `plan_generation_max_concurrent`, default 3 | User specified |
| Config caching? | Always fresh read from disk | User specified ("luôn luôn không cache") |
| 429 retry hint? | None | User said not needed |

## Open questions

None for this scope. Future considerations (out of scope):

- Migrate other routes to fresh-config-read pattern.
- Add a job queue if `max_concurrent=3` becomes a bottleneck.
- Multi-version plan history (would require a `daily_review_plans` table).
- Streaming Opus output for live progress.
