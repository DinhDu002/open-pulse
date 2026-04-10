# Open Pulse — Project Guide

@.claude/knowledge/index.md

Local analytics dashboard and expert system for Claude Code. Tracks usage via hooks, extracts project knowledge via LLM post-ingest, and surfaces learning through auto-evolve patterns and daily reviews.

## Architecture Overview

```
Hooks (Claude Code)          Server (Fastify)              Frontend (SPA)
┌──────────────┐     JSONL    ┌──────────────┐    REST     ┌──────────────┐
│  collector   │ ──────────→  │   server.js  │  ←───────→  │  index.html  │
│   (3 hooks)  │   data/*.jsonl│  port 3827   │  /api/*    │  + 8 routes  │
└──────────────┘              │  11 route mods│              └──────────────┘
                              │              │
                              │  Ingest      │──→ open-pulse.db (SQLite, 12 tables)
                              │  (timer 10s) │    events + prompt linking
                              │              │
                              │  Filesystem  │──→ projects.json, instincts, components
                              │  sync (60s)  │    disk → DB
                              │              │
                              │  Auto-evolve │──→ auto_evolves table
                              │  (60s timer) │    confidence >= 0.85 → component files
                              │              │
                              │  Knowledge   │──→ knowledge_entries table
                              │  (post-ingest│    Haiku extracts project understanding
                              │   + scan)    │
                              │              │
                              │  Knowledge   │──→ <project>/.claude/knowledge/*.md
                              │  vault       │    one file per category
                              │              │
                              │  Daily review│──→ daily_reviews table + reports/*.md
                              │  (3AM launchd│    Opus 4.6 analysis
                              │  + API POST) │
                              │              │
                              │  Retention   │──→ compacts/deletes old events (daily)
                              └──────────────┘
```

## Data Flow

1. **Collection**: Claude Code hooks write JSONL to `data/` directory
   - `src/ingest/collector.js` handles: PostToolUse, UserPromptSubmit, Stop
   - Captures full `tool_input` and `tool_response` (5KB, secrets scrubbed) for analysis
2. **Ingestion**: Server timer (10s) atomically processes JSONL → SQLite
   - Pattern: rename `.jsonl` → `.jsonl.processing` → read → insert → delete
   - On failure: rename back to `.jsonl` for retry (max 3 retries → `.failed`)
   - Links events to `prompts` table — groups contiguous events per user turn with cost/token aggregation
3. **Observer (optional timer)**: Background observer in `src/evolve/observer.js` reads events from SQLite via `src/evolve/export-events.js`, invokes Haiku to detect patterns, updates instinct YAML files in `cl/instincts/`
4. **Filesystem Sync**: Server timer (60s) syncs `projects.json`, instinct files, and components (skills/agents) from disk into DB via `src/ingest/sync.js`
5. **Auto-Evolve**: Observer patterns → instinct files → `auto_evolves` table → auto-promote when confidence >= 0.85 (no rejections, blacklists agent/hook) → component files written to `~/.claude/`
6. **Knowledge Extraction**: After each prompt is ingested, `src/knowledge/extract.js` invokes Haiku to extract project-specific understanding from recent events. Entries stored in `knowledge_entries` table. Cold-start scan bootstraps from key project files (`README.md`, `package.json`, `CLAUDE.md`)
7. **Knowledge Vault**: `src/knowledge/vault.js` renders `knowledge_entries` as markdown files in `<project>/.claude/knowledge/` — one file per category. Uses content hashing (`kg_vault_hashes` table) to skip unchanged content
8. **Daily Review**: 3 AM daily → `src/review/pipeline.js` reads all component files + work history + best practices → Opus analysis → `daily_reviews` table + report `.md` in `reports/`. Triggerable via API
9. **Retention**: Daily timer compacts tool data after 7 days (NULL tool_input/response), deletes events after 90 days. Configurable via `retention_warm_days` / `retention_cold_days`
10. **API + Frontend**: Fastify serves REST endpoints on `127.0.0.1:3827`. Vanilla JS SPA with hash-based routing, Chart.js + Cytoscape.js for visualization

## Directory Structure

```
open-pulse/
├── src/                        # Backend (Node.js, CommonJS)
│   ├── server.js               # Fastify app factory, timers, route registration
│   ├── retention.js            # 3-tier storage retention (hot/warm/cold)
│   ├── lib/                    # Shared utilities (zero duplication)
│   │   ├── frontmatter.js      # parseFrontmatter(), extractBody()
│   │   ├── slugify.js          # slugify()
│   │   ├── paths.js            # getClaudeDir(), getComponentPath()
│   │   ├── plugins.js          # getInstalledPlugins(), getPluginComponents()
│   │   ├── projects.js         # getKnownProjectPaths(), getProjectAgents()
│   │   └── format.js           # parseQualifiedName(), errorReply(), parsePagination()
│   ├── db/                     # Database layer
│   │   ├── schema.js           # SQLite schema, migrations, createDb()
│   │   ├── events.js           # Event insert/batch
│   │   ├── sessions.js         # Session upsert/update
│   │   ├── prompts.js          # Prompt linking queries
│   │   ├── components.js       # Component queries
│   │   ├── projects.js         # cl_projects queries
│   │   ├── scan.js             # Scanner result queries
│   │   ├── knowledge-entries.js # knowledge_entries CRUD
│   │   └── knowledge-sync.js   # Vault hash + sync state
│   ├── ingest/                 # Data collection + ingestion
│   │   ├── collector.js        # Hook script (PostToolUse, Stop, UserPromptSubmit)
│   │   ├── pipeline.js         # Atomic JSONL → DB pipeline
│   │   ├── prompt-linker.js    # Group events into prompt records
│   │   └── sync.js             # Filesystem → DB sync (projects, components)
│   ├── evolve/                 # Auto-evolve + instinct ecosystem
│   │   ├── sync.js             # Instinct YAML files → auto_evolves table
│   │   ├── promote.js          # Auto-promote + component file generation
│   │   ├── revert.js           # Revert promoted components
│   │   ├── queries.js          # auto_evolves table queries
│   │   ├── observer.js         # Background observer (Haiku pattern detection)
│   │   ├── observer-prompt.md  # Haiku prompt template
│   │   ├── instinct-updater.js # YAML frontmatter feedback loop
│   │   ├── seed.js             # Cold-start: 10 starter instincts + CLAUDE.md parser
│   │   └── export-events.js    # SQLite → JSONL for observer
│   ├── knowledge/              # Knowledge extraction + vault
│   │   ├── extract.js          # Haiku post-ingest extraction
│   │   ├── vault.js            # Entries → markdown files in .claude/knowledge/
│   │   ├── scan.js             # Cold-start scan from project files
│   │   └── queries.js          # knowledge_entries + vault hash queries
│   ├── review/                 # Daily review pipeline
│   │   ├── pipeline.js         # Orchestrate: context → Opus → save
│   │   ├── context.js          # Read components + work history
│   │   ├── prompt.md           # Opus prompt template
│   │   └── queries.js          # daily_reviews CRUD
│   └── routes/                 # Fastify route plugins (11 files)
│       ├── health.js           # /api/health, /api/overview
│       ├── events.js           # /api/events, /api/sessions
│       ├── prompts.js          # /api/prompts
│       ├── cost.js             # /api/cost, /api/rankings
│       ├── projects.js         # /api/projects
│       ├── scanner.js          # /api/scanner
│       ├── config.js           # /api/config, /api/errors, /api/ingest
│       ├── inventory.js        # /api/inventory/:type
│       ├── knowledge.js        # /api/knowledge/*
│       ├── auto-evolves.js     # /api/auto-evolves/*
│       └── daily-reviews.js    # /api/daily-reviews/*
├── scripts/                    # CLI utilities + installation
│   ├── install.sh              # 8-step installer (npm, dirs, DB, seed, symlinks, hooks, launchd)
│   ├── uninstall.sh            # 4-step uninstaller (symlinks, hooks, launchd)
│   ├── register-hooks.js       # Merge hooks into ~/.claude/settings.json
│   ├── reset-db.js             # Drop and recreate DB (clean break)
│   └── backfill-prompts.js     # One-time migration: link existing events to prompt records
├── public/                     # Frontend (vanilla JS ES modules, no build)
│   ├── index.html              # SPA shell, dark theme CSS, nav (8 items)
│   └── modules/                # 11 ES modules
│       ├── router.js           # Hash-based SPA router (8 routes)
│       ├── api.js              # Fetch wrapper (get/post/put/del + ETag support)
│       ├── utils.js            # Shared utilities (escHtml, debounce, confColor, etc.)
│       ├── dashboard.js        # Overview: stat cards, cost chart, model mix, rankings
│       ├── prompts.js          # Prompt history list + per-prompt event flow timeline
│       ├── inventory.js        # Skills/Agents 2-tab view, project filter, pagination
│       ├── projects.js         # Router shim — delegates to learning-projects.js
│       ├── learning-projects.js # Projects list + detail (timeline, session breakdown)
│       ├── knowledge.js        # 2-tab: Notes editor (tab 1) + Projects & Sync (tab 2)
│       ├── auto-evolves.js     # Auto-evolve patterns list + promote/revert UI
│       ├── daily-reviews.js    # Daily review suggestions list + accept/dismiss UI
│       └── settings.js         # Config editor, health, manual triggers
├── test/                       # Tests mirror src/ structure
│   ├── db/                     # schema.test.js
│   ├── ingest/                 # pipeline.test.js, collector.test.js
│   ├── evolve/                 # sync.test.js, promote.test.js, seed.test.js, etc.
│   ├── knowledge/              # knowledge.test.js
│   ├── review/                 # review.test.js
│   ├── routes/                 # routes.test.js, learning.test.js
│   └── *.test.js               # retention, helpers, backfill-prompts
├── claude/                     # Expert system (symlinked to ~/.claude/ on install)
│   ├── agents/
│   │   └── claude-code-expert.md    # Orchestrator agent using all skills
│   └── skills/                 # 6 skills (knowledge, config, scanner, creators)
│       ├── claude-code-knowledge/   # Knowledge base with 8 reference docs
│       ├── claude-config-advisor/   # Decision tree for component recommendations
│       ├── claude-setup-scanner/    # Setup inventory and gap analysis
│       └── agent-creator/           # Agent scaffolding
├── data/                       # Runtime: JSONL files (gitignored)
├── cl/                         # Runtime: instinct YAML files (gitignored)
├── logs/                       # Runtime: stdout/stderr logs (gitignored)
├── reports/                    # Daily review reports (gitignored)
├── config.json                 # Server config (port, intervals, thresholds)
├── open-pulse.db               # SQLite database (gitignored)
└── projects.json               # Project registry (gitignored)
```

## Database Schema

13 tables:

| Table | Purpose | Key fields |
|---|---|---|
| `events` | All hook events | timestamp, session_id, event_type, name, detail, tokens, cost, prompt_id, project_name |
| `sessions` | Session summaries | session_id, started_at, ended_at, model, tokens, cost |
| `prompts` | User turns linked to event ranges | session_id, prompt_text, seq_start, seq_end, event_count, total_cost_usd, total_tokens, duration_ms |
| `collector_errors` | Hook errors | occurred_at, hook_type, error_message, raw_input |
| `components` | Skill/agent inventory from filesystem | type, name, source, plugin, project, file_path, agent_class |
| `cl_projects` | Registered projects | project_id, name, directory, session_count, last_seen_at |
| `scan_results` | Setup scanner reports | scanned_at, report (JSON), issue counts by severity |
| `auto_evolves` | Observer-detected patterns | id, title, target_type, confidence, observation_count, status, promoted_to |
| `daily_reviews` | Opus analysis suggestions | id, review_date, category, title, target_type, action, confidence, status |
| `daily_review_insights` | Cross-project insights from daily review | id, review_date, insight_type, title, projects (JSON), target_type, severity, status |
| `knowledge_entries` | LLM-extracted project knowledge | project_id, category, title, body, source_file, status |
| `kg_vault_hashes` | Content hashes for vault files | project_id, file_path, content_hash, generated_at |
| `kg_sync_state` | KV state for graph sync | key, value |

## API Endpoints

### Core

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server health + DB size + event count |
| GET | `/api/overview?period=` | Dashboard summary (sessions, cost, top items) |
| GET | `/api/events?type=&name=&from=&to=` | Event list with filters |
| GET | `/api/sessions?period=` | Session list |
| GET | `/api/sessions/:id` | Session detail + events |
| GET | `/api/rankings/:category?period=` | Skills/agents/tools rankings |
| GET | `/api/cost?group_by=day\|model\|session&period=` | Cost breakdown |
| GET | `/api/unused` | Unused skills, agents |
| GET | `/api/errors?limit=` | Collector errors |
| GET | `/api/config` | Read config |
| PUT | `/api/config` | Update config |
| POST | `/api/ingest` | Manual JSONL ingestion |

### Prompts

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/prompts?period=&page=&per_page=&q=&project=` | Paginated prompt history |
| GET | `/api/prompts/:id` | Prompt detail + ordered event flow timeline |

### Inventory

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/inventory/:type?period=&project=` | Skills/agents list (enriched: `agent_class`, `plugin`, `project`) |
| GET | `/api/inventory/:type/:name?period=&page=&per_page=&project=` | Component detail + paginated invocations + trigger analysis |

### Projects

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | All projects (registered + event-only) |
| GET | `/api/projects/:id/summary` | Project summary (sessions, cost, top tools) |
| GET | `/api/projects/:id/timeline?weeks=` | Weekly activity timeline |
| DELETE | `/api/projects/:id` | Remove project from DB + filesystem + registry |

### Knowledge Entries

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/knowledge/entries?project=&category=&status=&page=&per_page=` | Paginated entries |
| GET | `/api/knowledge/entries/stats?project=` | Counts by category/status |
| GET | `/api/knowledge/entries/:id` | Entry detail |
| PUT | `/api/knowledge/entries/:id` | Edit entry |
| PUT | `/api/knowledge/entries/:id/outdated` | Mark outdated |
| DELETE | `/api/knowledge/entries/:id` | Delete entry |
| POST | `/api/knowledge/scan` | Cold start scan |
| GET | `/api/knowledge/projects` | Projects with knowledge entry counts |
| GET | `/api/knowledge/autocomplete?project=&q=` | Entry title suggestions |

### Auto-Evolve

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auto-evolves/stats` | Counts by status, target_type |
| GET | `/api/auto-evolves?status=&target_type=` | List auto-evolves |
| GET | `/api/auto-evolves/:id` | Single auto-evolve detail |
| PUT | `/api/auto-evolves/:id/revert` | Revert promoted component |

### Daily Review

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/daily-reviews/stats` | Counts by status, category, date |
| GET | `/api/daily-reviews?review_date=&status=&category=` | List daily reviews |
| GET | `/api/daily-reviews/:id` | Single daily review detail |
| PUT | `/api/daily-reviews/:id/accept` | Accept suggestion |
| PUT | `/api/daily-reviews/:id/dismiss` | Dismiss suggestion |
| POST | `/api/daily-reviews/run` | Manual trigger daily review |
| GET | `/api/daily-reviews/insights/stats` | Insight counts by type, severity |
| GET | `/api/daily-reviews/insights?review_date=&insight_type=&status=&severity=` | List insights |
| GET | `/api/daily-reviews/insights/:id` | Insight detail |
| PUT | `/api/daily-reviews/insights/:id/resolve` | Mark insight resolved |
| PUT | `/api/daily-reviews/insights/:id/dismiss` | Dismiss insight |

### Scanner

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/scanner/run` | Run setup scan |
| GET | `/api/scanner/latest` | Latest scan result |
| GET | `/api/scanner/history?limit=` | Scan history |

### Learning (legacy, returns empty)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/learning/activity?days=` | Daily activity counts (stub) |
| GET | `/api/learning/recent?limit=` | Recent events (stub) |

## Configuration (`config.json`)

| Key | Default | Purpose |
|---|---|---|
| `port` | 3827 | Server port |
| `ingest_interval_ms` | 10000 | JSONL ingestion timer interval |
| `cl_sync_interval_ms` | 60000 | Filesystem sync + auto-evolve timer interval |
| `max_detail_length` | 500 | Max chars for event `detail` field |
| `max_prompt_length` | 1000 | Max chars for captured `user_prompt` |
| `retention_warm_days` | 7 | Days before NULLing tool_input/tool_response |
| `retention_cold_days` | 90 | Days before deleting events |
| `knowledge_enabled` | true | Enable knowledge extraction post-ingest |
| `knowledge_max_events_per_prompt` | 50 | Max events fed to Haiku per extraction run |
| `knowledge_max_tokens` | 1000 | Max output tokens for Haiku extraction response |
| `knowledge_scan_files` | ["README.md","package.json","CLAUDE.md"] | Files read during cold-start scan |
| `knowledge_scan_patterns` | [] | Additional glob patterns for cold-start scan |
| `auto_evolve_enabled` | true | Enable auto-evolve promotion timer |
| `auto_evolve_blacklist` | ["agent","hook"] | Target types blocked from auto-promotion |
| `auto_evolve_min_confidence` | 0.85 | Confidence threshold for auto-promotion |
| `observer_enabled` | false | Enable background observer timer |
| `observer_interval_ms` | 300000 | Observer cycle interval (5 min) |
| `observer_min_events` | 20 | Minimum events before analysis |
| `daily_review_enabled` | true | Enable daily review |
| `daily_review_model` | "opus" | Model for daily review (opus/sonnet) |
| `daily_review_timeout_ms` | 300000 | Timeout for daily review Claude invocation |
| `daily_review_max_suggestions` | 25 | Max suggestions per daily review run |
| `daily_review_history_days` | 1 | Number of days of work history to include in daily review |

## Key Design Decisions

- **Hook → JSONL → DB** (not direct DB writes): hooks must be fast and never block Claude Code. JSONL append is O(1), server ingests asynchronously.
- **`__dirname` discovery**: hooks resolve repo path via `path.resolve(__dirname, '..')` — no external config files needed.
- **Atomic ingestion**: rename → read → insert → delete prevents data loss on crash. Max 3 retries before marking `.failed`.
- **CommonJS for backend**: better-sqlite3 and hook scripts need `require()`.
- **ES modules for frontend**: native browser modules, no bundler needed.
- **Symlinks for Claude integration**: `claude/skills/*` → `~/.claude/skills/*` so the repo stays self-contained.
- **Environment variables for testing**: `OPEN_PULSE_DB`, `OPEN_PULSE_DIR`, `OPEN_PULSE_CLAUDE_DIR` allow tests to use temp directories.
- **Route plugins**: All API routes are organized into 11 Fastify plugins under `src/routes/`. Each receives `routeOpts` (db, dbPath, repoDir, config, componentETagFn). `src/server.js` is app factory + timer coordinator only.
- **Prompt linking**: During ingestion, contiguous events sharing the same `user_prompt` are grouped into a `prompts` record. Each event gets a `prompt_id` FK. Enables per-turn cost, token count, duration, and event breakdown without query-time aggregation.
- **Split feedback loops**: Two independent flows replace the old unified insights system. Flow 1 (auto-evolve): Observer-detected patterns auto-promote to rule/knowledge/skill when confidence >= 0.85 (blacklists agent/hook). Flow 2 (daily review): Comprehensive 3AM analysis reads all component files + work history, invokes Opus for suggestions. Each flow has its own table, routes, and UI — zero shared code.
- **Daily review pipeline**: `src/review/pipeline.js` reads full content of all component files (rules, skills, agents, hooks, memory, plugins) + best practices from `claude-code-knowledge` + day's work history. Invokes Opus for comprehensive analysis. Outputs: suggestions in `daily_reviews` table + markdown report in `reports/`.
- **Knowledge entries architecture**: Replaces KG (`kg_nodes`/`kg_edges`). LLM (Haiku) extracts project understanding after each prompt. Entries stored in `knowledge_entries` table, rendered as markdown vault files per category in `<project>/.claude/knowledge/`. Cold-start scan bootstraps knowledge from key project files. No confidence scoring — entries are factual, not behavioral patterns.
- **`cl_` DB prefix**: The `cl_` prefix on DB tables (e.g., `cl_projects`) and the `cl/` runtime directory stand for the instinct-based observer subsystem. The code itself lives in `src/evolve/`.
- **3-tier retention**: hot (0-7d full data), warm (7-90d NULLs tool_input/response), cold (90d+ deleted). Configurable, runs daily. Sessions never deleted.
- **Cold start seeding**: 10 universal starter instincts + CLAUDE.md rule parser. Idempotent — skips existing files on reinstall.
- **Cross-project daily review**: Pipeline scans all registered project configs (CLAUDE.md, .claude/rules|skills|agents|knowledge) from `cl_projects` + `projects.json`. Cross-project insights stored in separate `daily_review_insights` table with types: duplicate, conflict, gap, unused, cross_dependency. Uses Opus 1M context with raw content for maximum analysis quality.

## Commands

```bash
# Development
npm start                    # → node src/server.js
npm test                     # → node --test test/*.test.js test/**/*.test.js

# Installation
npm run install-service      # Full 8-step install (npm, dirs, DB, seed, symlinks, hooks, launchd)
npm run uninstall-service    # Full uninstall

# Service management (macOS launchd)
launchctl print gui/$(id -u)/com.open-pulse       # Status
launchctl bootout gui/$(id -u)/com.open-pulse      # Stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.open-pulse.plist  # Start
```

## Event Types

The collector classifies events into four types based on tool name:
- `skill_invoke` — when `tool_name === 'Skill'`
- `agent_spawn` — when `tool_name === 'Agent'`
- `tool_call` — all other tools (Read, Write, Edit, Bash, Grep, Glob, etc.)
- `session_end` — from Stop hook (includes token counts and cost)

Each tool event includes: `tool_input` (full, 5KB, secrets scrubbed), `tool_response` (full, 5KB, scrubbed), `seq_num` (order within session), `success` (boolean). The observer reads these from SQLite via `src/evolve/export-events.js`.

## Inventory Enrichment

The inventory endpoints enrich items with metadata beyond raw event counts:

- **Agent classification** (`agent_class`): `"configured"` if agent has a `.md` file in `~/.claude/agents/` or plugin cache, `"built-in"` otherwise (Claude Code native agents like `general-purpose`, `Explore`, `Plan`).
- **Plugin identification** (`plugin`): reads `~/.claude/plugins/installed_plugins.json`, scans each plugin's `agents/` and `skills/` dirs in the cache. Components get qualified names (`plugin:name`). Only shown when item belongs to a plugin.
- **Project scoping** (`project`): derived from plugin `scope` + `projectPath`. User-scoped → `"global"`, project-scoped → `basename(projectPath)`. Also scans project-level `.claude/agents/` for project agents.
- **Pagination**: detail endpoint supports `page` (default 1) and `per_page` (default 10, max 50). Response includes `total`, `page`, `per_page`. Trigger counts are always computed from ALL invocations regardless of page.
- **Trigger analysis**: for each invocation, finds the nearest preceding skill/agent event (`triggered_by`, incoming) and the nearest subsequent skill/agent event (`triggers`, outgoing). Aggregated trigger counts are returned in the `triggers` array.

Key backend helpers in `src/lib/`: `parseQualifiedName()` and `parsePagination()` in `format.js`; `getInstalledPlugins()` and `getPluginComponents()` in `plugins.js`; `getProjectAgents()` and `getKnownProjectPaths()` in `projects.js`; `getClaudeDir()` and `getComponentPath()` in `paths.js`.

## Cost Estimation

Token rates per million tokens (in `src/ingest/collector.js`):
- Haiku: $0.80 input / $4.00 output
- Sonnet: $3.00 input / $15.00 output
- Opus: $15.00 input / $75.00 output

## Tech Stack

- **Runtime**: Node.js >= 20
- **Server**: Fastify 5 + @fastify/static
- **Database**: better-sqlite3 (WAL mode, 3s busy timeout)
- **Frontend**: Vanilla JS ES modules, Chart.js 4 (CDN), Cytoscape.js 3 (CDN)
- **Tests**: Node.js built-in test runner (`node --test`)
- **Service**: macOS launchd (com.open-pulse server + com.open-pulse.daily-review daily 3 AM)
