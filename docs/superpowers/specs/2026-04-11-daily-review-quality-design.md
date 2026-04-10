# Daily Review Quality Improvements — Design Spec

## Problem

The daily review pipeline currently has limited data scope:
1. **Single-day history**: Only reads events from the review date — misses multi-day patterns
2. **Global-only configs**: Only scans `~/.claude/` — ignores project-level `.claude/` configs across 11+ projects
3. **No cross-project analysis**: Cannot detect duplicates, conflicts, or gaps between projects

## Decisions

| Question | Decision |
|---|---|
| Project scope | All registered projects from DB + `projects.json` |
| Work history range | Configurable via `daily_review_history_days`, default 1 |
| Data format to LLM | Raw content, Opus 1M context, max effort |
| Output format | Suggestions (existing) + cross-project insights (new) |
| Insights storage | Separate `daily_review_insights` table |
| Project discovery | From `cl_projects` DB table + `projects.json` registry only |

## Data Collection

### Current

```
collectWorkHistory(db, date)     → 1 day events + sessions
scanAllComponents(claudeDir)     → ~/.claude/ only
loadBestPractices(repoDir)       → references/ docs
```

### New

```
collectWorkHistory(db, date, historyDays)
  → N days events + sessions (configurable, default 1)
  → WHERE DATE(timestamp) BETWEEN dateStart AND date

scanAllComponents(claudeDir)
  → unchanged, reads ~/.claude/ (global scope)

discoverProjectPaths(db, registryPath)              ← NEW
  → reads cl_projects.directory from DB
  → merges with projects.json entries
  → filters: only keeps projects where directory exists on disk
  → returns [{ name, directory }]

scanOneProject(projectDir)                           ← NEW
  → claudeMd: reads CLAUDE.md at project root (if exists)
  → rules: readDirFiles(.claude/rules/)
  → skills: readDirFiles(.claude/skills/)
  → agents: readDirFiles(.claude/agents/)
  → knowledge: readDirFiles(.claude/knowledge/)
  → hooks: parses .claude/settings.json hooks (if exists)
  → returns { claudeMd, rules, skills, agents, knowledge, hooks }

scanProjectConfigs(db, registryPath)                 ← NEW
  → paths = discoverProjectPaths(db, registryPath)
  → for each: scanOneProject()
  → returns { [projectName]: { directory, ...components } }

loadBestPractices(repoDir)
  → unchanged
```

### Data flow

```
discoverProjectPaths(db, registryPath)
  → paths[]
      ↓
scanProjectConfigs(paths)
  → { projectName: { directory, claudeMd, rules, skills, agents, knowledge, hooks } }
      ↓
buildPrompt(history, globalComponents, projectConfigs, practices, opts)
```

## Database Changes

### New table: `daily_review_insights`

```sql
CREATE TABLE IF NOT EXISTS daily_review_insights (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  projects TEXT,
  target_type TEXT,
  severity TEXT DEFAULT 'info',
  reasoning TEXT,
  summary_vi TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);
```

Column details:
- `insight_type`: `duplicate` | `conflict` | `gap` | `unused` | `cross_dependency`
- `projects`: JSON array of project names involved (e.g., `["open-pulse","carthings"]`)
- `target_type`: `rule` | `skill` | `agent` | `hook` | `knowledge`
- `severity`: `info` | `warning` | `critical`
- `status`: `pending` | `resolved` | `dismissed`

### Insight types

| Type | Description |
|---|---|
| `duplicate` | Same rule/skill exists in multiple projects or duplicates global |
| `conflict` | Configurations contradict between project-level or global vs project |
| `gap` | Project missing component that other similar projects have |
| `unused` | Component defined but never invoked in work history |
| `cross_dependency` | Project uses skill/agent defined in another project |

### New config key

```json
{
  "daily_review_history_days": 1
}
```

## API Changes

### New routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/daily-reviews/insights` | List insights (filter: review_date, insight_type, status, severity) |
| GET | `/api/daily-reviews/insights/stats` | Counts by type, severity |
| GET | `/api/daily-reviews/insights/:id` | Insight detail |
| PUT | `/api/daily-reviews/insights/:id/resolve` | Mark resolved |
| PUT | `/api/daily-reviews/insights/:id/dismiss` | Dismiss insight |

### Modified route

`POST /api/daily-reviews/run` — accepts optional `date` in request body (already added).

## Prompt Template

Redesigned from 5 sections to 8 sections:

```markdown
# Daily Review — {{date}}

You are a Claude Code setup advisor. Analyze the user's complete configuration
across all scopes and work history, then provide suggestions and cross-project insights.

## Work History ({{history_days}} days: {{date_range}})
{{work_history_json}}

## Global Configuration (~/.claude/)

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

## Project Configurations ({{project_count}} projects)

{{project_configs_content}}

## Best Practices Reference
{{claude_code_knowledge}}

## Instructions

### Part 1: Suggestions
Analyze configurations against best practices. Consider:
1. Redundant or conflicting rules/skills/agents
2. Patterns in work history suggesting new rules or skills
3. Components to merge, update, or remove
4. Missing components suggested by best practices
5. Cost optimization based on model usage

### Part 2: Cross-Project Insights
Analyze configurations across all {{project_count}} projects. Identify:
1. Duplicate rules/skills/agents across projects or global
2. Conflicting configurations between scopes
3. Gaps — project missing components other similar projects have
4. Unused components — defined but never invoked in work history
5. Cross-dependencies — project using components defined elsewhere

Return TWO labeled JSON code blocks:

```json suggestions
[
  {
    "category": "adoption|cleanup|agent_creation|update|optimization|integration|cost|security|refinement",
    "title": "Short descriptive title",
    "description": "Detailed description",
    "target_type": "rule|skill|agent|hook|knowledge",
    "action": "create|update|remove|merge",
    "confidence": 0.5,
    "reasoning": "Evidence-based reasoning",
    "summary_vi": "Tóm tắt bằng tiếng Việt"
  }
]
```

```json insights
[
  {
    "insight_type": "duplicate|conflict|gap|unused|cross_dependency",
    "title": "Short descriptive title",
    "description": "Detailed description",
    "projects": ["project-a", "project-b"],
    "target_type": "rule|skill|agent|hook|knowledge",
    "severity": "info|warning|critical",
    "reasoning": "Evidence-based reasoning",
    "summary_vi": "Tóm tắt bằng tiếng Việt"
  }
]
```

Rules:
- Maximum {{max_suggestions}} suggestions
- Confidence range: 0.1 (speculative) to 0.9 (strong evidence)
- Every suggestion must reference specific evidence
- Do not suggest changes already handled by existing components
```

## Pipeline Changes (`scripts/op-daily-review.js`)

### New functions

- `discoverProjectPaths(db, registryPath)` — merge DB + registry, filter existing paths
- `scanOneProject(projectDir)` — read one project's `.claude/` directory
- `scanProjectConfigs(db, registryPath)` — orchestrate project scanning
- `parseReviewOutput(output)` — find labeled JSON blocks by matching ` ```json suggestions ` and ` ```json insights ` fences. Falls back: if only one unlabeled JSON block found, treat as suggestions with empty insights. Replaces `parseSuggestions`.
- `saveInsights(db, insights, reviewDate)` — insert into `daily_review_insights`

### Modified functions

- `collectWorkHistory(db, date, historyDays)` — date range query
- `buildPrompt(history, globalComponents, projectConfigs, practices, opts)` — new project section
- `runDailyReview(db, opts)` — new `historyDays` option, call project scanning, save insights
- `writeReport(suggestions, insights, history, reportDir, date)` — include insights in report

### execFileSync adjustments

```javascript
execFileSync('claude', [
  '--model', model,
  '--max-turns', '1',
  '--print',
  '-p', prompt,
], {
  timeout,
  encoding: 'utf8',
  env: { ...process.env, OP_SKIP_COLLECT: '1', OP_HOOK_PROFILE: 'minimal' },
  maxBuffer: 50 * 1024 * 1024,  // 50MB (up from 10MB)
})
```

## Frontend Changes (`public/modules/daily-reviews.js`)

### Tab layout for list view

```
[Suggestions]  [Cross-Project Insights]
```

### Tab: Suggestions
Unchanged — existing table + detail page.

### Tab: Cross-Project Insights
- Table columns: Date, Type, Severity, Title, Projects, Target
- Badge colors:
  - insight_type: duplicate (purple), conflict (red), gap (orange), unused (gray), cross_dependency (blue)
  - severity: info (light blue), warning (yellow), critical (red)
- `projects` column: multi-badge display
- Click title → detail page at `#daily-reviews/insight/ID`
- Detail page: back link, header card, description, reasoning, tóm tắt, resolve/dismiss buttons

### Stats card expanded

```
Suggestions: 18    Insights: 7
```

## Files Changed

| File | Change |
|---|---|
| `src/db/schema.js` | `CREATE TABLE daily_review_insights`, `summary_vi` migration |
| `src/db/daily-reviews.js` | **NEW** — query helpers for both tables (extracted from scripts/) |
| `src/routes/daily-reviews.js` | 5 new insight routes, `date` param support |
| `scripts/op-daily-review.js` | New functions + modified pipeline |
| `scripts/op-daily-review-prompt.md` | Redesigned 8 sections, 2 JSON output blocks |
| `public/modules/daily-reviews.js` | Tab layout, insights table + detail, expanded stats |
| `config.json` | Add `daily_review_history_days: 1` |
| `test/op-daily-review.test.js` | Tests for new functions + insights |
| `test/op-server.test.js` | Tests for 5 new routes |
| `CLAUDE.md` | Update schema docs, API docs, config docs |

## Verification

1. `npm test` — all existing + new tests pass
2. Manual: insert test insight row, verify API returns it
3. Manual: run daily review, verify both suggestions + insights generated
4. Playwright screenshot: verify tabs, insight table, detail page
5. Check prompt size stays within 1M token limit with all projects loaded
