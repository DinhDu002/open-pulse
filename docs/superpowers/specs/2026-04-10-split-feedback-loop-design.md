# Split Feedback Loop — Design Spec

Split the current unified feedback loop into 2 independent flows: auto-evolve (autonomous) and daily review (comprehensive analysis).

## Context

The current system uses a single `insights` table serving both CL Observer auto-promotion and daily AI suggestion analysis. The user wants:

1. **Flow 1 (Auto-evolve):** Autonomous component promotion without user intervention
2. **Flow 2 (Daily Review):** Comprehensive daily analysis at 3 AM with actionable suggestions

Both flows must be **completely independent** — no shared code, separate DB tables, separate UI modules.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Evolve scope | Create new components only, never modify existing files |
| 2 | Safety | Blacklist `agent` and `hook` from auto-promotion |
| 3 | Confidence source | Observer auto-increments +0.15 per re-observation (cap 0.95) |
| 4 | Logging | File log (`logs/auto-evolve.log`) + DB + UI |
| 5 | Component scan depth | Read full file contents for all component types |
| 6 | Best practices source | `claude-code-knowledge` skill (8 reference docs) |
| 7 | Daily review output | DB suggestions + markdown report |
| 8 | Flow 2 vs Flow 1 conflict | Flow 2 only suggests, never auto-reverts |
| 9 | Module coupling | Zero shared code between flows |
| 10 | DB separation | 2 new tables, delete `insights` table and all related code |

## Flow 1: Auto-evolve

### Module: `src/op-auto-evolve.js`

Autonomous promotion of observer-detected patterns into Claude Code components.

### Pipeline (runs every 60s via server timer)

```
1. Query auto_evolves WHERE:
   - status = 'active'
   - confidence >= 0.85
   - rejection_count = 0
   - target_type IN ('rule', 'knowledge', 'skill')

2. For each qualifying insight:
   a. Generate component content (self-contained logic)
      - rule → ~/.claude/rules/{slug}.md
      - knowledge → ~/.claude/knowledge/{slug}.md
      - skill → ~/.claude/skills/{slug}/SKILL.md
   b. Write file to disk
   c. UPDATE auto_evolves SET status='promoted', promoted_to=path, promoted_at=now
   d. Append to logs/auto-evolve.log:
      [ISO timestamp] PROMOTED {type} "{title}" → {path}

3. Instinct ingestion (replaces CL sync for this flow):
   op-auto-evolve.js scans instinct YAML files in cl/instincts/
   → UPSERT into auto_evolves (by SHA-256 id from title + target_type)
   → New instinct: INSERT with confidence=0.05, observation_count=1
   → Existing instinct with higher observation_count:
     UPDATE observation_count, confidence = Math.min(0.95, confidence + 0.15)
```

### Database Table

```sql
CREATE TABLE auto_evolves (
  id TEXT PRIMARY KEY,              -- SHA-256 from title + target_type
  title TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL,        -- rule | knowledge | skill
  confidence REAL DEFAULT 0.05,
  observation_count INTEGER DEFAULT 1,
  rejection_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',     -- active | promoted | reverted
  promoted_to TEXT,                 -- file path when promoted
  created_at TEXT NOT NULL,
  updated_at TEXT,
  promoted_at TEXT
);
```

### API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auto-evolves` | List all auto-evolves (filter: status, target_type) |
| GET | `/api/auto-evolves/stats` | Counts by status, target_type |
| GET | `/api/auto-evolves/:id` | Single detail |
| PUT | `/api/auto-evolves/:id/revert` | Manual revert: delete file, set status='reverted' |

### Config

```json
{
  "auto_evolve_enabled": true,
  "auto_evolve_blacklist": ["agent", "hook"],
  "auto_evolve_min_confidence": 0.85
}
```

### Exported Functions

- `runAutoEvolve(db)` — run one promotion cycle
- `generateComponent(insight)` — generate file content for a given insight
- `writeComponentFile(type, slug, content)` — write file to disk
- `syncObserverConfidence(db)` — increment confidence when observation_count grows

## Flow 2: Daily Review

### Module: `scripts/op-daily-review.js`

Comprehensive daily analysis combining work history, all component contents, and best practices.

### Pipeline (runs daily at 3 AM via launchd)

```
Phase 1 — Collect work history:
  Query events WHERE timestamp >= today 00:00 UTC+7
  Aggregate: sessions, tools, costs, errors, patterns

Phase 2 — Scan all component files (full content):
  - ~/.claude/rules/*.md
  - ~/.claude/knowledge/*.md
  - ~/.claude/skills/*/SKILL.md
  - ~/.claude/agents/*.md
  - ~/.claude/hooks/ (config from settings.json)
  - ~/.claude/projects/*/memory/**
  - ~/.claude/plugins/installed_plugins.json + cache files

Phase 3 — Load best practices:
  Read 8 reference docs from claude/skills/claude-code-knowledge/references/

Phase 4 — Invoke Opus:
  Prompt = work_history + component_contents + best_practices
  Spawn: claude --model opus --max-turns 1 --print
  Timeout: 300s (configurable)

Phase 5 — Save results:
  a. Parse JSON suggestions → INSERT INTO daily_reviews
     (source='daily_review', status='pending')
  b. Write report: reports/YYYY-MM-DD-daily-review.md
     Content: day summary, suggestion list, detailed analysis
```

### Prompt Template: `scripts/op-daily-review-prompt.md`

```markdown
# Daily Review — {{date}}

## Work History Today
{{work_history_json}}

## Current Setup (Full Content)
### Rules ({{rule_count}})
{{rules_content}}
### Skills ({{skill_count}})
{{skills_content}}
### Agents ({{agent_count}})
{{agents_content}}
### Hooks
{{hooks_config}}
### Memory
{{memory_content}}
### Plugins ({{plugin_count}})
{{plugins_content}}

## Best Practices Reference
{{claude_code_knowledge}}

## Instructions
Analyze the current setup against best practices. For each suggestion return:
[{
  "category": "adoption|cleanup|agent_creation|update|optimization|integration|cost|security|refinement",
  "title": "...",
  "description": "...",
  "target_type": "rule|skill|agent|hook|knowledge",
  "action": "create|update|remove|merge",
  "confidence": 0.0-1.0,
  "reasoning": "..."
}]
```

### Database Table

```sql
CREATE TABLE daily_reviews (
  id TEXT PRIMARY KEY,              -- SHA-256 from title + review_date
  review_date TEXT NOT NULL,        -- YYYY-MM-DD
  category TEXT,
  title TEXT NOT NULL,
  description TEXT,
  target_type TEXT,                 -- rule | skill | agent | hook | knowledge
  action TEXT,                      -- create | update | remove | merge
  confidence REAL,
  reasoning TEXT,
  status TEXT DEFAULT 'pending',    -- pending | accepted | dismissed
  created_at TEXT NOT NULL
);
```

### API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/daily-reviews` | List (filter: date, status, category) |
| GET | `/api/daily-reviews/stats` | Counts by status, category, date |
| GET | `/api/daily-reviews/:id` | Single detail |
| PUT | `/api/daily-reviews/:id/accept` | Mark as accepted |
| PUT | `/api/daily-reviews/:id/dismiss` | Mark as dismissed |
| POST | `/api/daily-reviews/run` | Manual trigger |

### Config

```json
{
  "daily_review_enabled": true,
  "daily_review_model": "opus",
  "daily_review_timeout_ms": 300000,
  "daily_review_max_suggestions": 25
}
```

### Exported Functions

- `collectWorkHistory(db, date)` — query day's events
- `scanAllComponents()` — read all component files
- `loadBestPractices()` — read claude-code-knowledge references
- `buildPrompt(history, components, practices)` — assemble prompt
- `parseSuggestions(output)` — parse Claude JSON output
- `runDailyReview(db)` — run full pipeline

### Launchd

Reuse existing `com.open-pulse.suggestion-agent` plist, change script target to `op-daily-review.js`.

### Report Format: `reports/YYYY-MM-DD-daily-review.md`

```markdown
# Daily Review — YYYY-MM-DD

## Summary
- Sessions: N
- Total cost: $X.XX
- Tools used: N unique
- Errors: N

## Suggestions (N total)

### 1. [category] Title
- **Action:** create | update | remove | merge
- **Target:** target_type
- **Confidence:** 0.XX
- **Reasoning:** ...

...
```

## Deletions

Remove all `insights`-related code:

| File | Action |
|---|---|
| `src/db/insights.js` | Delete |
| `public/modules/expert.js` | Delete |
| `public/modules/learning-suggestions.js` | Delete |
| `scripts/op-suggestion-agent.js` | Delete |
| `scripts/op-suggestion-prompt.md` | Delete |
| `test/op-suggestion-agent.test.js` | Delete |
| `src/op-server.js` | Remove insight routes, suggestion timer |
| `src/op-db.js` | Remove `CREATE TABLE insights`, add 2 new tables |
| `public/index.html` | Remove old nav tabs, add Auto-evolve + Daily Review |
| `public/modules/router.js` | Remove old routes, add 2 new routes |

## Frontend

### `public/modules/auto-evolves.js`

- Nav tab: "Auto-evolve"
- List of promoted/active/reverted components
- Timeline view with promoted_at timestamps
- Revert button per item
- Stats cards: total promoted, active, reverted

### `public/modules/daily-reviews.js`

- Nav tab: "Daily Review"
- Date filter (date picker)
- Suggestion list with category + action badges
- Reasoning expandable section
- Accept / Dismiss buttons per item
- Link to open report .md file
- Stats cards: total suggestions, accepted, dismissed

## Testing

### `test/op-auto-evolve.test.js` (~12 tests)

- Confidence increments +0.15 per observation, capped at 0.95
- Promotes when confidence >= 0.85 and rejection_count = 0
- Blacklist: does NOT promote agent or hook
- Writes file to correct path (rule/knowledge/skill)
- Writes log entry in correct format
- Skips when auto_evolve_enabled = false
- Revert: deletes file + updates status to 'reverted'
- Dedup: SHA-256 ID prevents duplicates

### `test/op-daily-review.test.js` (~10 tests)

- collectWorkHistory: queries correct date range
- scanAllComponents: reads all file types
- loadBestPractices: reads 8 reference docs
- buildPrompt: assembles template correctly
- parseSuggestions: parses JSON, validates required fields
- Writes suggestions to daily_reviews table
- Writes report .md to correct path and format
- Skips when daily_review_enabled = false
- Dedup: SHA-256 ID based on title + date

## File Summary

### New Files

| File | Purpose |
|---|---|
| `src/op-auto-evolve.js` | Flow 1 module (DB + promote + log) |
| `scripts/op-daily-review.js` | Flow 2 module (DB + scan + prompt + report) |
| `scripts/op-daily-review-prompt.md` | Prompt template for Opus |
| `public/modules/auto-evolves.js` | UI for Flow 1 |
| `public/modules/daily-reviews.js` | UI for Flow 2 |
| `test/op-auto-evolve.test.js` | Tests for Flow 1 |
| `test/op-daily-review.test.js` | Tests for Flow 2 |
| `reports/` | Directory for daily review reports (gitignored) |

### Modified Files

| File | Change |
|---|---|
| `src/op-server.js` | Add auto-evolve timer, register new routes, remove insight routes |
| `src/op-db.js` | Add 2 new tables, remove insights table |
| `config.json` | Add 6 new config keys |
| `public/index.html` | Update nav tabs |
| `public/modules/router.js` | Update routes |
| `scripts/op-install.sh` | Create reports/ dir, update launchd plist |
| `.gitignore` | Add reports/ |

### Deleted Files

| File | Reason |
|---|---|
| `src/db/insights.js` | Replaced by self-contained DB logic in each flow |
| `public/modules/expert.js` | Replaced by auto-evolves.js + daily-reviews.js |
| `public/modules/learning-suggestions.js` | Replaced by daily-reviews.js |
| `scripts/op-suggestion-agent.js` | Replaced by op-daily-review.js |
| `scripts/op-suggestion-prompt.md` | Replaced by op-daily-review-prompt.md |
| `test/op-suggestion-agent.test.js` | Replaced by op-daily-review.test.js |
