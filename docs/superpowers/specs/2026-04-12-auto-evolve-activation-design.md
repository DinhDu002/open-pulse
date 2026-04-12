# Auto-Evolve Activation — Design Spec

## Summary

Activate the auto-evolve subsystem in three sequential stages:

1. **Stage A**: Full lifecycle verification of rule promotion (create test instinct → verify auto-promote via timer → revert via UI → cleanup). No code changes.
2. **Stage B**: Fix `generateComponent()` to emit valid agent files; verify hand-written skill and agent instincts promote correctly.
3. **Stage C**: Build the missing observer (`src/evolve/observer.js`) as a standalone launchd service that uses Haiku to detect patterns from recent events every hour and emit instinct YAML files.

## Motivation

Auto-evolve was designed as a continuous learning subsystem but is currently non-functional:

- The observer (pattern detection from events) was never implemented — only a prompt template exists (`src/evolve/observer-prompt.md`). No `observer.js` has ever existed in git history.
- The cold-start seeder was removed in a prior session, leaving no mechanism to create new instinct files.
- `generateComponent()` in `promote.js` lacks a case for `agent`, so agent instincts fall through to the default branch and produce files without valid YAML frontmatter — Claude Code will not load them.
- `src/server.js` does not import any observer code and no observer timer runs.
- `config.json` is missing all `observer_*` keys; `auto_evolve_blacklist` is `["hook"]` despite CLAUDE.md documentation specifying `["agent", "hook"]`.

Result: users cannot verify the promote pipeline works for skill/agent target types, and no new patterns are ever auto-detected or auto-promoted. The subsystem exists only for rules that were hand-seeded by the now-deleted cold-start seeder.

This spec brings auto-evolve from "partially working for rules only, frozen dataset" to "auto-detecting and auto-promoting patterns for rule/knowledge/skill across active projects every hour, with agents requiring manual approval via UI".

## Stage A — Verify rule promotion (full lifecycle)

### Goal

Prove the existing sync → promote → revert pipeline works end-to-end in the real server environment: server timer fires, files actually write to `~/.claude/rules/`, and the UI revert button path works.

### Steps

1. Create test instinct file:

   ```yaml
   # cl/instincts/personal/test-verify-rule-promotion.md
   ---
   id: test-verify-rule-promotion
   name: Test Verify Rule Promotion
   description: Placeholder rule to verify auto-evolve rule promotion flow
   type: rule
   confidence: 0.9
   seen_count: 20
   source: manual-test
   scope: global
   ---

   Placeholder rule body. Safe to delete after verification.
   ```

2. Wait for next server sync cycle (60 seconds, `cl_sync_interval_ms`) or restart server.
3. Verify DB:
   ```sql
   SELECT * FROM auto_evolves WHERE title = 'Test Verify Rule Promotion';
   -- Expect: status='promoted', promoted_at NOT NULL, promoted_to NOT NULL
   ```
4. Verify filesystem: `~/.claude/rules/test-verify-rule-promotion.md` exists and contains the rule body.
5. Verify log: `logs/auto-evolve.log` contains `PROMOTED rule "Test Verify Rule Promotion"` line.
6. Verify UI: Navigate to `#auto-evolves/<id>`, confirm all fields render including `promoted_to` and `promoted_at`.
7. Click "Revert" button on UI.
8. Verify: file `~/.claude/rules/test-verify-rule-promotion.md` is deleted; DB row has `status='reverted'`.
9. Cleanup: delete `cl/instincts/personal/test-verify-rule-promotion.md`.

### Acceptance Criteria

- File appears in `~/.claude/rules/` after promote
- Revert button removes file and updates DB status atomically
- No orphan state after cleanup (no stale file, no stale DB row lingering as `active`)

### Code Changes

None. Stage A is pure verification of existing infrastructure.

## Stage B — Fix generateComponent + verify skill/agent

### Goal

Make `generateComponent()` emit valid skill and agent files, then verify the promote pipeline works for both target types with hand-written test instincts.

### Changes to `src/evolve/promote.js`

Current state (agent missing, falls through to `default` branch):

```js
function generateComponent(insight) {
  const { target_type, title, description } = insight;

  switch (target_type) {
    case 'rule':
      return `# ${title}\n\n${description}\n`;

    case 'skill':
      return [
        '---',
        `name: ${slugify(title)}`,
        `description: ${title}`,
        '---',
        '',
        `${description}`,
        '',
      ].join('\n');

    case 'knowledge':
      return `# ${title}\n\n${description}\n`;

    default:
      return `# ${title}\n\n${description}\n`;
  }
}
```

Add explicit `case 'agent'` before `default`:

```js
case 'agent':
  return [
    '---',
    `name: ${slugify(title)}`,
    `description: ${(description || title).split('\n')[0].slice(0, 200)}`,
    `model: sonnet`,
    '---',
    '',
    `${description}`,
    '',
  ].join('\n');
```

Rationale:
- `name`: slugified title (matches file path `~/.claude/agents/<slug>.md`)
- `description`: first line of description, capped at 200 chars (agents need concise descriptions for subagent dispatch)
- `model`: default `sonnet` — safe choice, mid-tier cost, user can edit after promotion
- Body: full description as instructions

Skill case stays as-is (already emits valid minimal frontmatter).

### Test instincts

Create 2 test files:

```yaml
# cl/instincts/personal/test-auto-evolve-skill.md
---
id: test-auto-evolve-skill
name: Test Auto Evolve Skill
description: Test skill created to verify auto-evolve skill promotion path
type: skill
confidence: 0.9
seen_count: 10
source: manual-test
scope: global
---

Placeholder skill body for auto-evolve pipeline testing. Safe to delete.
```

```yaml
# cl/instincts/personal/test-auto-evolve-agent.md
---
id: test-auto-evolve-agent
name: Test Auto Evolve Agent
description: Test agent created to verify auto-evolve agent promotion path
type: agent
confidence: 0.9
seen_count: 10
source: manual-test
scope: global
---

Placeholder agent body for auto-evolve pipeline testing. Safe to delete.
```

### Ordering constraint

Run Stage B verification **before** applying Stage C's `auto_evolve_blacklist: ["agent", "hook"]` config change. With the current config (`["hook"]`), agents can auto-promote; after Stage C's config update, they cannot. Order: Stage B verify → Stage B cleanup → Stage C implementation → Stage C config update.

### Acceptance Criteria

- `~/.claude/skills/test-auto-evolve-skill/SKILL.md` exists with valid YAML frontmatter (`name`, `description`)
- `~/.claude/agents/test-auto-evolve-agent.md` exists with valid YAML frontmatter (`name`, `description`, `model`)
- Unit test `test/evolve/promote.test.js` covers `generateComponent({ target_type: 'agent', ... })` returning valid frontmatter
- Revert removes both files and updates DB status

### Cleanup

1. Revert both test instincts via UI
2. Delete YAML files from `cl/instincts/personal/`
3. Verify no orphan files in `~/.claude/skills/` or `~/.claude/agents/`

## Stage C — Build observer

### Goal

Implement `src/evolve/observer.js` as a standalone launchd-triggered script that reads recent events per active project, invokes Haiku via Claude CLI to detect patterns, and writes instinct YAML files into `cl/instincts/` for subsequent sync → auto-promote.

### Execution Model

- **Launch**: new launchd service `com.open-pulse.observer`
- **Cadence**: `StartInterval: 3600` seconds (1 hour)
- **Program**: `node $REPO_DIR/src/evolve/observer.js --repo-dir $REPO_DIR`
- **Logs**: `logs/observer-stdout.log`, `logs/observer-stderr.log`
- Isolated from the Fastify server process — no shared event loop, crash independent

### Config additions (`config.json`)

```json
{
  "observer_enabled": true,
  "observer_interval_seconds": 3600,
  "observer_model": "claude-haiku-4-5-20251001",
  "observer_max_events_per_project": 500,
  "observer_active_project_window_hours": 24,
  "observer_max_projects_per_run": 5,
  "observer_confidence_cap_on_first_detect": 0.75,
  "auto_evolve_blacklist": ["agent", "hook"]
}
```

`auto_evolve_blacklist` updates from `["hook"]` to `["agent", "hook"]`. Safety rationale: agents have wide tool access and can spawn subagents; incorrect auto-promotion has high blast radius. Users must manually promote agents via the new UI button.

### Observer flow

```
observer.js entry
  ├─ parse --repo-dir arg, load config
  ├─ if !observer_enabled → exit 0
  ├─ db = createDb(DB_PATH)
  ├─ projects = queryActiveProjects(db, window_hours, max_projects_per_run)
  │   └─ projects with >=3 events in last `window_hours`, top N by event count
  └─ for each project:
     ├─ last_run_at = getKgSyncState(db, `observer_last_run_at_${project_id}`)
     │               ?? datetime('now', '-24 hours')
     ├─ events = exportEventsSince(db, project.name, last_run_at, max=500)
     ├─ if events.length < 3 → skip (observer prompt requires 3+ occurrences)
     ├─ tmpfile = /tmp/op-observer-<project_id>-<timestamp>.jsonl
     ├─ write events to tmpfile as JSONL
     ├─ snapshot existing instinct filenames in cl/instincts/ → existingFiles Set
     ├─ prompt = renderTemplate(observer-prompt.md, {
     │     analysis_path: tmpfile,
     │     instincts_dir: path.join(repoDir, 'cl/instincts'),
     │     project_id: project.project_id,
     │     project_name: project.name,
     │   })
     ├─ result = spawnSync('claude', [
     │     '--model', observer_model,
     │     '--max-turns', '8',
     │     '--print',
     │     prompt,
     │   ], { env: {...process.env, OPEN_PULSE_INTERNAL: '1'}, timeout: 120000 })
     ├─ if result.status !== 0 → log error, continue to next project
     ├─ snapshot instinct filenames again → currentFiles Set
     ├─ newFiles = currentFiles - existingFiles
     ├─ for each file in currentFiles touched during this run:
     │   ├─ normalizeInstinctFile(file, wasNew=newFiles.has(file))
     │   └─ (see normalization below)
     ├─ setKgSyncState(db, `observer_last_run_at_${project_id}`, maxEventTimestamp)
     ├─ insert pipeline_runs row (reuse existing table):
     │   - pipeline: 'auto_evolve_observer'
     │   - project_id: project.project_id
     │   - model: observer_model
     │   - status, error, duration_ms
     ├─ rm tmpfile
     └─ continue

Final: log summary (projects scanned, instincts written/updated), exit 0
```

### Claude CLI invocation details

```js
const result = spawnSync('claude', [
  '--model', config.observer_model,
  '--max-turns', '8',       // allow multiple Write tool calls per run
  '--print',                 // non-interactive mode
  prompt,
], {
  env: { ...process.env, OPEN_PULSE_INTERNAL: '1' },
  encoding: 'utf8',
  timeout: 120000,           // 2 min hard cap per project
});
```

Notes:
- `OPEN_PULSE_INTERNAL=1` prevents the collector hooks from re-recording the observer's own Claude CLI invocation (matches existing knowledge extract / daily review pattern in `src/ingest/collector.js:325`).
- Prompt stays small (~4KB): template references `{{analysis_path}}` which Haiku reads via its own Read tool. Event data never enters argv → no E2BIG risk (contrast daily review, which embeds full context in argv).
- `--max-turns 8` allows Haiku to read the JSONL, analyze, and make multiple Write tool calls (phase 1 pattern detection + phase 2 reflect confidence updates).

### Normalize instinct file (warm-up + dedup)

After Haiku writes or updates files, observer post-processes every touched file:

```js
function normalizeInstinctFile(filePath, wasNew, confidenceCap) {
  const content = fs.readFileSync(filePath, 'utf8');
  const meta = parseFrontmatter(content);
  if (!meta || !meta.name || !meta.type) return;

  const body = extractBody(content);

  // Compute canonical id (matches sync.js makeId)
  const hash = crypto
    .createHash('sha256')
    .update(`${meta.name}::${meta.type}`)
    .digest('hex')
    .substring(0, 16);
  const canonicalId = `ae-${hash}`;

  // Warm-up clamp for newly created files
  if (wasNew) {
    const currentConf = parseFloat(meta.confidence) || 0.5;
    meta.confidence = Math.min(currentConf, confidenceCap).toFixed(2);
  }

  // Ensure id field matches canonical form
  meta.id = canonicalId;

  // Write back in canonical form
  const newContent = serializeFrontmatter(meta) + '\n\n' + body;
  fs.writeFileSync(filePath, newContent, 'utf8');
}
```

This enforces:
- **Warm-up**: new files can never exceed `observer_confidence_cap_on_first_detect` (0.75) on first detection. Re-detection on subsequent runs lets `sync.js` UPSERT add +0.15 → 0.90 on run 2, crossing promote threshold. At 1-hour interval, the warm-up window is ~1–2 hours.
- **Dedup**: canonical `id` derived from `(name, type)` hash matches `sync.js:makeId()`. If two observer runs produce same-named instincts, the id hash collides → `sync.js` UPSERT merges them into one `auto_evolves` row. No duplicate promotion.

### Active project query

```js
function queryActiveProjects(db, windowHours, maxProjects) {
  return db.prepare(`
    SELECT p.project_id, p.name, COUNT(e.id) AS recent_events
    FROM cl_projects p
    JOIN events e ON e.project_name = p.name
    WHERE e.timestamp >= datetime('now', ? || ' hours')
    GROUP BY p.project_id, p.name
    HAVING recent_events >= 3
    ORDER BY recent_events DESC
    LIMIT ?
  `).all(`-${windowHours}`, maxProjects);
}
```

### Sync state tracking

Reuse existing `kg_sync_state` KV table (schema: `key TEXT PRIMARY KEY, value TEXT`):

- Key: `observer_last_run_at_${project_id}`
- Value: ISO timestamp of the latest event timestamp processed in the previous run
- If key absent: fall back to `datetime('now', '-24 hours')`

Helpers `getKgSyncState(db, key)` / `setKgSyncState(db, key, value)` already exist in `src/db/knowledge-sync.js`. The `Kg` prefix is historical (origin in knowledge graph subsystem) but the table is a generic KV store — reusing it for observer state avoids a second KV table.

### Export events since timestamp

`src/evolve/export-events.js` already exports project-scoped events. Add a new function:

```js
function exportEventsSince(db, projectName, sinceIso, maxRows) {
  const rows = db.prepare(`
    SELECT id, timestamp, session_id, event_type, name, detail,
           tool_input, tool_response, seq_num, success, user_prompt
    FROM events
    WHERE project_name = ?
      AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(projectName, sinceIso, maxRows);
  return rows;
}
```

Observer writes these as JSONL (one object per line) to the tmp file.

### Manual promote endpoint

Since agents are now blacklisted from auto-promotion, users need a way to manually force-promote an agent (or any active) instinct from the UI.

**New endpoint** `src/routes/auto-evolves.js`:

```js
app.post('/api/auto-evolves/:id/promote', async (req, reply) => {
  const { id } = req.params;
  const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  if (row.status !== 'active') {
    return reply.code(400).send({ error: `cannot promote: status=${row.status}` });
  }
  const { promoteOne } = require('../evolve/promote');
  try {
    const result = promoteOne(db, row, { logDir: path.join(repoDir, 'logs') });
    return { ok: true, promoted_to: result.filePath };
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});
```

**Refactor** `src/evolve/promote.js`: extract per-row promote logic into `promoteOne(db, row, opts)` helper. `runAutoEvolve` calls `promoteOne` in its loop. This makes the logic reusable for manual promote without duplicating file-write + DB-update code.

`promoteOne` **bypasses** the blacklist/threshold checks — caller is responsible for deciding whether a row should be promoted. The endpoint above requires `status === 'active'` but does not check blacklist or confidence threshold (manual promote = explicit user intent).

### Frontend — Promote button

In `public/modules/auto-evolves.js` → `renderDetail()`:

Add a "Promote now" button when `row.status === 'active'`, rendered in the existing `actions` div alongside the Revert button:

```js
if (row.status === 'active') {
  const promoteBtn = document.createElement('button');
  promoteBtn.className = 'btn btn-sm btn-success';
  promoteBtn.textContent = 'Promote now';
  promoteBtn.onclick = async () => {
    await post(`/auto-evolves/${id}/promote`);
    renderDetail(el, id);
  };
  actions.appendChild(promoteBtn);
}
```

Visible for all target types (user can force-promote rule, knowledge, skill, or agent). Primary use case: agent instincts that observer has flagged with high confidence but cannot auto-promote.

### install.sh update

Add step 9 (inserted before current step 8 "launchd setup" is split into two sections):

Revised step count: 9 steps total. The current launchd setup step (step 8) already creates two services (main server + daily review). Add a third service (observer) in the same step, OR add a new step 9.

**Chosen approach**: add observer setup as step 9, keeping step 8 as the existing dual-service setup. This clarifies that observer is a distinct concern.

```bash
# ── 9. Observer launchd service (runs every hour) ──
echo "[9/9] Setting up observer launchd service..."
OBSERVER_PLIST_NAME="com.open-pulse.observer"
OBSERVER_PLIST_PATH="$HOME/Library/LaunchAgents/${OBSERVER_PLIST_NAME}.plist"

if launchctl list 2>/dev/null | grep -q "$OBSERVER_PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$OBSERVER_PLIST_NAME" 2>/dev/null || true
fi

cat > "$OBSERVER_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OBSERVER_PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${REPO_DIR}/src/evolve/observer.js</string>
    <string>--repo-dir</string>
    <string>${REPO_DIR}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${REPO_DIR}/logs/observer-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_DIR}/logs/observer-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")${CLAUDE_BIN_DIR:+:${CLAUDE_BIN_DIR}}</string>
    <key>OPEN_PULSE_DIR</key>
    <string>${REPO_DIR}</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$OBSERVER_PLIST_PATH"
```

Update step counter from `[N/8]` to `[N/9]` across all echo lines in install.sh.

### uninstall.sh update

Add observer bootout + plist removal:

```bash
if launchctl list 2>/dev/null | grep -q "com.open-pulse.observer"; then
  launchctl bootout "gui/$(id -u)/com.open-pulse.observer" 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/com.open-pulse.observer.plist"
```

### Tests

**New file** `test/evolve/observer.test.js`:

Test pure logic, mock Claude CLI invocation (never actually spawn `claude`):

- `normalizeInstinctFile()`:
  - Computes canonical id matching `sync.js:makeId()`
  - Clamps confidence to 0.75 when `wasNew=true`
  - Does not clamp when `wasNew=false`
  - Sets `id` field to canonical form even if Haiku wrote a different id
  - Rounds confidence to 2 decimals (avoid float drift)
- `queryActiveProjects()`:
  - Filters to projects with `>= 3` events in window
  - Orders by `recent_events DESC`
  - Respects `LIMIT maxProjects`
  - Returns empty array when no projects active
- `exportEventsSince()`:
  - Returns events after `sinceIso` only
  - Respects `LIMIT maxRows`
  - Events ordered ASC by timestamp
- Warm-up flow integration:
  - New file with Haiku-written `confidence: 0.85` → clamped to 0.75
  - Existing file with Haiku-written `confidence: 0.85` → stays 0.85

Do NOT test `spawnSync('claude', ...)` directly — too slow and costly. Dependency-inject the CLI runner so tests can substitute a fake.

**Modify** `test/evolve/promote.test.js`:
- Add test for `generateComponent({ target_type: 'agent', title: 'Test', description: 'desc' })`
- Verify output has YAML frontmatter with `name`, `description`, `model: sonnet`

## Files to Modify

| File | Change |
|---|---|
| `src/evolve/promote.js` | Add `case 'agent'` to `generateComponent()`; extract `promoteOne(db, row, opts)` helper and call it from `runAutoEvolve` loop |
| `src/evolve/observer.js` | **NEW** — observer CLI script (main + helpers) |
| `src/evolve/export-events.js` | Add `exportEventsSince(db, projectName, sinceIso, maxRows)` helper |
| `src/routes/auto-evolves.js` | Add `POST /api/auto-evolves/:id/promote` handler |
| `public/modules/auto-evolves.js` | Add "Promote now" button in `renderDetail()` for entries with `status === 'active'` |
| `public/modules/api.js` | Verify `post()` exists with correct signature (used by new promote button) |
| `config.json` | Add observer config keys; update `auto_evolve_blacklist` to `["agent", "hook"]` |
| `scripts/install.sh` | Add step 9 creating `com.open-pulse.observer` plist; renumber all step counters |
| `scripts/uninstall.sh` | Add bootout + plist removal for `com.open-pulse.observer` |
| `test/evolve/observer.test.js` | **NEW** — observer logic tests with mocked Claude CLI |
| `test/evolve/promote.test.js` | Add test case for `agent` in `generateComponent` |
| `CLAUDE.md` | Update config table with new `observer_*` keys; add observer launchd service to commands section; note auto-evolve is now live for rule/knowledge/skill auto-promote, agent manual-promote |

## Rollout Plan

### Phase 1 — Stage A (Day 1, ~30 minutes)
- No code changes
- Verify rule promotion lifecycle end-to-end
- Proof that existing infrastructure works

### Phase 2 — Stage B (Day 1, ~2 hours)
- Fix `generateComponent()` agent case + add unit test
- Create skill and agent test instincts
- Verify full lifecycle for both types
- **Cleanup test instincts before Stage C** (otherwise Stage C config change will prevent agent auto-promote retrospectively, but the cleanup also prevents cluttering `~/.claude/`)

### Phase 3 — Stage C (Day 2, ~6 hours)
1. Implement `observer.js` with pure helpers + dependency-injected CLI runner
2. Add `promoteOne()` export + `POST /promote` route + frontend button
3. Add observer unit tests; run `npm test` green
4. Update `config.json` (observer keys + blacklist)
5. Update `install.sh` and `uninstall.sh`
6. Run `scripts/install.sh` to register the new launchd service
7. **First real run**: trigger manually via `node src/evolve/observer.js --repo-dir $PWD` before waiting for launchd
8. Inspect `logs/observer-stdout.log`, `cl/instincts/` for new files, `auto_evolves` table for new rows
9. Monitor first 24 hours for promotions, revert anything that looks wrong

### Rollback

If observer produces bad instincts:
1. Stop launchd: `launchctl bootout gui/$(id -u)/com.open-pulse.observer`
2. Set `observer_enabled: false` in `config.json`
3. Revert bad instincts via UI (or delete files from `cl/instincts/` + reset DB rows)

## Out of Scope

- Observer phase 2 "reflect" confidence decay (the prompt template describes it but full decay logic is deferred to a future iteration)
- Cross-project pattern detection (current design is strictly per-project)
- Observer UI controls (start/stop/force-run buttons) — rely on launchd + manual CLI invocation for now
- Dedicated token/cost tracking table for observer — observer reuses existing `pipeline_runs` table
- Re-introducing a cold-start seeder — observer replaces it as the sole source of instinct files going forward
- Real-time observer telemetry (SSE/WebSocket) — logs via file only
