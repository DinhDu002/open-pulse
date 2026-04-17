# Open Pulse — Project Guide

@.claude/knowledge/index.md

Local analytics dashboard and expert system for Claude Code. Tracks usage via hooks, extracts project knowledge via LLM post-ingest, and surfaces learning through auto-evolve patterns.

## Architecture Overview

```
Hooks (Claude Code)          Server (Fastify)              Frontend (SPA)
┌──────────────┐     JSONL    ┌──────────────┐    REST     ┌──────────────┐
│  collector   │ ──────────→  │   server.js  │  ←───────→  │  index.html  │
│   (3 hooks)  │   data/*.jsonl│  port 3827   │  /api/*    │  + 8 routes  │
└──────────────┘              │  12 route mods│              └──────────────┘
                              │              │
                              │  Ingest      │──→ open-pulse.db (SQLite, 14 tables)
                              │  (timer 10s) │    events + prompt linking
                              │              │
                              │  Filesystem  │──→ projects.json, components
                              │  sync (60s)  │    disk → DB
                              │              │
                              │  Auto-evolve │──→ auto_evolves table
                              │  (60s timer) │    confidence >= 0.85 → component files
                              │              │
                              │  Knowledge   │──→ knowledge_entries table
                              │  (post-ingest│    Opus extracts project understanding
                              │   + scan)    │
                              │              │
                              │  Knowledge   │──→ <project>/.claude/knowledge/*.md
                              │  vault       │    one file per category
                              │              │
                              │  Ollama      │──→ knowledge_entries + auto_evolves
                              │  (per-prompt │    local model extraction
                              │   extract)   │
                              │              │
                              │  Quality     │──→ prompt_scores table
                              │  scoring     │    per-prompt Ollama evaluation
                              │  (post-ingest│    4 dimensions: efficiency, accuracy,
                              │   per-prompt)│    cost, approach (0-100)
                              │              │
                              │  Session     │──→ session_reviews table
                              │  retro       │    Ollama narrative review on session_end
                              │  (on end)    │    strengths, improvements, suggestions
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
   - On failure: file stays at `.processing`; retry counter tracked in sidecar `.retries` file; after 3 failed retries → rename to `.failed`
   - Links events to `prompts` table — groups contiguous events per user turn with cost/token aggregation
3. **Filesystem Sync**: Server timer (60s) syncs `projects.json` and components (skills/agents) from disk into DB via `src/ingest/sync.js`
4. **Auto-Evolve**: Ollama patterns (`detect.js`) → `auto_evolves` table → auto-promote when confidence >= 0.85 (no rejections, blacklists agent/hook) → component files written to `~/.claude/`
5. **Knowledge Extraction**: After each prompt is ingested, `src/knowledge/extract.js` invokes Opus to extract project-specific understanding from recent events. Entries stored in `knowledge_entries` table. Cold-start scan bootstraps from key project files (`README.md`, `package.json`, `CLAUDE.md`)
6. **Pattern Detection**: After each prompt is ingested, `src/evolve/detect.js` invokes local Ollama model to detect reusable behavioral patterns from recent events. This is the primary source of auto-evolve patterns. Entries stored in `auto_evolves` table with status `draft`.
7. **Synthesize**: Two paths. (a) `/synthesize` skill invokes Opus for LLM-driven manual consolidation of knowledge entries and auto-evolve patterns. (b) `src/knowledge/synthesize.js` runs deterministic Jaccard-based dedup on a schedule (opt-in via `synthesize_enabled`) — marks near-duplicate `knowledge_entries` as `outdated` with an `auto_merged` history snapshot pointing at the kept entry
8. **Knowledge Vault**: `src/knowledge/vault.js` renders `knowledge_entries` as markdown files in `<project>/.claude/knowledge/` — one file per category. Uses content hashing (`kg_vault_hashes` table) to skip unchanged content
9. **Quality Scoring**: After each prompt is ingested (alongside knowledge + pattern extraction), `src/quality/score.js` invokes Ollama to score the interaction on 4 dimensions (efficiency, accuracy, cost, approach) 0-100. Scores stored in `prompt_scores` table. Skips prompts with < 3 events.
10. **Session Retrospective**: When a `session_end` event is processed, `src/quality/review.js` aggregates prompt scores + notable events and invokes Ollama to generate a narrative review (summary, strengths, improvements, suggestions). Stored in `session_reviews` table.
11. **Session Knowledge Extraction** (opt-in): 120s after `session_end` (post-review), `extractKnowledgeFromSession` in `src/knowledge/extract.js` runs a second extraction pass over the full session arc, enriched with the retrospective summary + top scored prompts as context. Title-based upsert merges with per-prompt entries. Gated by `knowledge_session_extract_enabled` (default `false`).
12. **Retention**: Daily timer compacts tool data after 7 days (NULL tool_input/response), deletes events after 90 days. Configurable via `retention_warm_days` / `retention_cold_days`
13. **API + Frontend**: Fastify serves REST endpoints on `127.0.0.1:3827`. Vanilla JS SPA with hash-based routing, Chart.js + Cytoscape.js for visualization

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
│   │   ├── format.js           # parseQualifiedName(), errorReply(), parsePagination()
│   │   ├── skill-loader.js     # loadSkillBody(), loadCompactPrompt()
│   │   ├── ollama.js           # callOllama() HTTP client
│   │   └── format-events.js    # formatEventsForLLM() shared formatter
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
│   ├── evolve/                 # Auto-evolve pipeline
│   │   ├── sync.js             # makeId() deterministic hash for pattern IDs
│   │   ├── promote.js          # Auto-promote + component file generation
│   │   ├── revert.js           # Revert promoted components
│   │   ├── queries.js          # auto_evolves table queries
│   │   └── detect.js           # Pattern detection pipeline (Ollama)
│   ├── knowledge/              # Knowledge extraction + vault
│   │   ├── extract.js          # Opus post-ingest extraction
│   │   ├── vault.js            # Entries → markdown files in .claude/knowledge/
│   │   ├── scan.js             # Cold-start scan from project files
│   │   └── queries.js          # knowledge_entries + vault hash queries
│   ├── quality/                # Quality evaluation pipelines
│   │   ├── score.js            # Per-prompt quality scoring (Ollama)
│   │   ├── review.js           # Session retrospective generation (Ollama)
│   │   └── queries.js          # prompt_scores + session_reviews queries
│   └── routes/                 # Fastify route plugins (13 files)
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
│       ├── synthesize.js       # /api/synthesize/data
│       └── quality.js          # /api/quality/*
├── scripts/                    # CLI utilities + installation
│   ├── install.sh              # 8-step installer (npm, dirs, DB, backfill, symlinks, agents, hooks, launchd)
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
│       ├── learning-projects.js # Projects list + detail (session breakdown)
│       ├── knowledge.js        # 2-tab: Notes editor (tab 1) + Projects & Sync (tab 2)
│       ├── auto-evolves.js     # Auto-evolve patterns list + promote/revert UI
│       └── settings.js         # Config editor, health, manual triggers
├── test/                       # Tests mirror src/ structure
│   ├── db/                     # schema.test.js
│   ├── ingest/                 # pipeline.test.js, collector.test.js
│   ├── evolve/                 # sync.test.js, promote.test.js, seed.test.js, etc.
│   ├── knowledge/              # knowledge.test.js
│   ├── routes/                 # routes.test.js, learning.test.js
│   └── *.test.js               # retention, helpers, backfill-prompts
├── claude/                     # Expert system (symlinked to ~/.claude/ on install)
│   ├── agents/
│   │   └── claude-code-expert.md    # Orchestrator agent using all skills
│   └── skills/                 # 9 skills (knowledge, patterns, config, scanner, creators, synthesize)
│       ├── claude-code-knowledge/   # Knowledge base with 8 reference docs
│       ├── claude-config-advisor/   # Decision tree for component recommendations
│       ├── claude-setup-scanner/    # Setup inventory and gap analysis
│       ├── knowledge-extractor/     # Knowledge entry extraction rules (Ollama + Opus)
│       ├── pattern-detector/        # Pattern detection rules (Ollama + Opus)
│       ├── synthesize/              # Opus-driven knowledge + pattern consolidation
│       ├── agent-creator/           # Agent scaffolding
│       ├── hook-creator/            # Hook configuration generator
│       ├── rule-creator/            # Rule creation with conflict detection
│       └── quality-evaluator/       # Quality scoring rubric + retrospective instructions
├── data/                       # Runtime: JSONL files (gitignored)
├── logs/                       # Runtime: stdout/stderr logs (gitignored)
├── config.json                 # Server config (port, intervals, thresholds)
├── open-pulse.db               # SQLite database (gitignored)
└── projects.json               # Project registry (gitignored)
```

## Database Schema

14 tables:

| Table | Purpose | Key fields |
|---|---|---|
| `events` | All hook events | timestamp, session_id, event_type, name, detail, tokens, cost, prompt_id, project_name |
| `sessions` | Session summaries | session_id, started_at, ended_at, model, tokens, cost |
| `prompts` | User turns linked to event ranges | session_id, prompt_text, seq_start, seq_end, event_count, total_cost_usd, total_tokens, duration_ms |
| `collector_errors` | Hook errors | occurred_at, hook_type, error_message, raw_input |
| `components` | Skill/agent inventory from filesystem | type, name, source, plugin, project, file_path, agent_class |
| `cl_projects` | Registered projects | project_id, name, directory, session_count, last_seen_at |
| `scan_results` | Setup scanner reports | scanned_at, report (JSON), issue counts by severity |
| `auto_evolves` | Ollama-detected patterns | id, title, target_type, confidence, observation_count, status, promoted_to |
| `knowledge_entries` | LLM-extracted project knowledge | project_id, category, title, body, source_file, status |
| `kg_vault_hashes` | Content hashes for vault files | project_id, file_path, content_hash, generated_at |
| `kg_sync_state` | KV state for graph sync | key, value |
| `pipeline_runs` | Internal Claude CLI invocation log | pipeline, project_id, model, status, error, input_tokens, output_tokens, duration_ms |
| `prompt_scores` | Per-prompt quality scores (Ollama) | prompt_id, session_id, project_id, efficiency, accuracy, cost_score, approach, overall, reasoning |
| `session_reviews` | Session retrospective reviews (Ollama) | session_id, project_id, overall_score, summary, strengths, improvements, suggestions, prompt_count, duration_mins |

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
| POST | `/api/knowledge/vault/render` | Trigger vault re-render for project |
| GET | `/api/knowledge/projects` | Projects with knowledge entry counts |
| GET | `/api/knowledge/autocomplete?project=&q=` | Entry title suggestions |

### Auto-Evolve

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auto-evolves/stats` | Counts by status, target_type |
| GET | `/api/auto-evolves?status=&target_type=` | List auto-evolves |
| GET | `/api/auto-evolves/:id` | Single auto-evolve detail |
| PUT | `/api/auto-evolves/:id` | Update auto-evolve fields |
| DELETE | `/api/auto-evolves/:id` | Delete auto-evolve |
| PUT | `/api/auto-evolves/:id/revert` | Revert promoted component |

### Synthesize

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/synthesize/data?project=&type=` | Bulk data for Opus consolidation |

### Scanner

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/scanner/run` | Run setup scan |
| GET | `/api/scanner/latest` | Latest scan result |
| GET | `/api/scanner/history?limit=` | Scan history |

### Pipeline Runs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/pipeline-runs/stats?project_id=&days=` | Aggregated run stats |
| GET | `/api/projects/:id/pipeline-runs?pipeline=&status=&limit=&page=` | Project pipeline run history |

### Quality

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/quality/prompts/:promptId` | Single prompt quality score |
| GET | `/api/quality/sessions/:sessionId` | Session retrospective review |
| GET | `/api/quality/stats?project=&period=` | Aggregated quality stats (avg scores, trends) |
| GET | `/api/quality/trends?project=&days=` | Daily quality score averages for charts |

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
| `knowledge_max_events_per_prompt` | 100 | Max events fed to LLM per extraction run |
| `knowledge_model` | `"local"` | Legacy alias for `knowledge_extract_model` — read as fallback |
| `knowledge_extract_model` | `"local"` | Extraction model: `"local"` (Ollama) \| `"haiku"` \| `"sonnet"` \| `"opus"` |
| `knowledge_session_extract_enabled` | false | Opt-in: run end-of-session extraction 120s after session_end, using full session arc + retrospective context. Complements per-prompt extract via title-match upsert |
| `knowledge_session_max_events` | 150 | Max events fed to session-level extract |
| `knowledge_scan_files` | ["README.md","package.json","CLAUDE.md"] | Files read during cold-start scan |
| `knowledge_scan_patterns` | [] | Additional glob patterns for cold-start scan |
| `synthesize_enabled` | false | Opt-in: enable the scheduled auto-synthesize timer. 5-min warmup run on boot, then every `synthesize_interval_hours`. Runs deterministic dedup (title + body Jaccard) across `knowledge_entries`, marking duplicates as `outdated` |
| `synthesize_interval_hours` | 24 | Interval for auto-synthesize runs |
| `auto_evolve_enabled` | true | Enable auto-evolve promotion timer |
| `auto_evolve_blacklist` | ["agent","hook"] | Target types blocked from auto-promotion |
| `auto_evolve_min_confidence` | 0.85 | Confidence threshold for auto-promotion |
| `ollama_url` | `"http://localhost:11434"` | Ollama API base URL |
| `ollama_model` | `"qwen3.5:9b"` | Local model for per-prompt extraction |
| `ollama_timeout_ms` | 120000 | Ollama HTTP request timeout |
| `pattern_detect_enabled` | true | Enable per-prompt pattern detection via Ollama |
| `quality_scoring_enabled` | true | Enable per-prompt quality scoring via Ollama |
| `quality_review_enabled` | true | Enable session retrospective generation via Ollama |
| `quality_min_events` | 3 | Minimum events per prompt to trigger quality scoring |

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
- **Auto-evolve pipeline**: Per-prompt Ollama extraction (`detect.js`) creates draft patterns in `auto_evolves` table. 60s timer runs `runAutoEvolve` to auto-promote patterns when confidence >= 0.85 (rejection_count = 0). Agents and hooks are blacklisted from auto-promote and require manual approval via `POST /api/auto-evolves/:id/promote`. `/synthesize` skill invokes Opus to consolidate and promote patterns manually.
- **Knowledge entries architecture**: Replaces KG (`kg_nodes`/`kg_edges`). LLM (Opus) extracts project understanding after each prompt. Entries stored in `knowledge_entries` table, rendered as markdown vault files per category in `<project>/.claude/knowledge/`. Cold-start scan bootstraps knowledge from key project files. No confidence scoring — entries are factual, not behavioral patterns.
- **`cl_` DB prefix**: The `cl_` prefix on DB tables (e.g., `cl_projects`) is a historical artifact from the earlier instinct-based observer subsystem. The auto-evolve code lives in `src/evolve/`.
- **3-tier retention**: hot (0-7d full data), warm (7-90d NULLs tool_input/response), cold (90d+ deleted). Configurable, runs daily. Sessions never deleted.

## Commands

```bash
# Development
npm start                    # → node src/server.js
npm test                     # → node --test test/*.test.js test/**/*.test.js

# Installation
npm run install-service      # Full 8-step install (npm, dirs, DB, backfill, symlinks, agents, hooks, launchd)
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

Each tool event includes: `tool_input` (full, 5KB, secrets scrubbed), `tool_response` (full, 5KB, scrubbed), `seq_num` (order within session), `success` (boolean). `detect.js` reads recent events from SQLite for pattern extraction.

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
- **Service**: macOS launchd (com.open-pulse server)
