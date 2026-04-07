# Open Pulse — Project Guide

Local analytics dashboard and expert system for Claude Code. Collects usage data via hooks, stores in SQLite, serves a SPA dashboard.

## Architecture Overview

```
Hooks (Claude Code)          Server (Fastify)              Frontend (SPA)
┌──────────────┐     JSONL    ┌──────────────┐    REST     ┌──────────────┐
│ op-collector │ ──────────→  │  op-server   │  ←───────→  │  index.html  │
│   (5 hooks)  │   data/*.jsonl│  port 3827   │  /api/*    │  + 7 modules │
└──────────────┘              │              │              └──────────────┘
┌──────────────┐              │  op-ingest   │
│ suggestion-  │ ──────────→  │  (timer 10s) │──→ open-pulse.db (SQLite)
│  analyzer    │  suggestions │              │
└──────────────┘    .jsonl    │  CL sync     │──→ cl/ (instincts, projects)
  ↑ YAML-aware                │  (timer 60s) │       ↑
  │ frontmatter               │  Retention   │  Feedback loop:
  └── cl/instincts/ ──────────│  (daily)     │  approve/dismiss → confidence
                              └──────────────┘
```

## Data Flow

1. **Collection**: Claude Code hooks write JSONL to `data/` directory
   - `op-collector.js` handles: PostToolUse, UserPromptSubmit, Stop
   - Captures full `tool_input` and `tool_response` (5KB, secrets scrubbed) for CL analysis
   - `op-suggestion-analyzer.js` runs on Stop (async) — scans CL instinct YAML frontmatter, maps domain→type, stores `instinct_id` for traceability
2. **Ingestion**: Server timer (10s) atomically processes JSONL → SQLite
   - Pattern: rename `.jsonl` → `.jsonl.processing` → read → insert → delete
   - On failure: rename back to `.jsonl` for retry
3. **CL Analysis**: Observer agent reads events from SQLite via `cl-export-events.js`, runs Haiku to detect patterns + reflect on existing instincts (decay, contradictions, merge duplicates)
4. **CL Sync**: Server timer (60s) syncs `projects.json`, instinct files, and components (skills/agents/hooks/rules) into DB
5. **Feedback Loop**: Approve suggestion → source instinct +0.15 confidence. Dismiss → -0.2 confidence. 3 dismissals → instinct archived.
6. **Retention**: Daily timer compacts tool data after 7 days (NULL tool_input/response), deletes events after 90 days. Configurable via `retention_warm_days` / `retention_cold_days`.
7. **API**: Fastify serves REST endpoints on `127.0.0.1:3827`
8. **Frontend**: Vanilla JS SPA with hash-based routing, Chart.js for visualization

## Directory Structure

```
open-pulse/
├── src/                    # Backend (Node.js, CommonJS)
│   ├── op-db.js            # SQLite schema (9 tables) + query functions
│   ├── op-ingest.js        # Atomic JSONL → DB pipeline
│   ├── op-actions.js       # Component CRUD (skill/agent/hook/rule)
│   ├── op-instinct-updater.js  # YAML frontmatter parse/update for instinct feedback loop
│   ├── op-retention.js     # 3-tier storage retention (hot/warm/cold)
│   └── op-server.js        # Fastify server, all routes, CL sync, component sync, scanner, retention
├── collector/              # Hook scripts (run by Claude Code)
│   ├── op-collector.js     # Main event collector (stdin → JSONL)
│   └── op-suggestion-analyzer.js  # YAML-aware instinct scanner → suggestions with instinct_id
├── public/                 # Frontend (vanilla JS ES modules, no build)
│   ├── index.html          # SPA shell, dark theme CSS, nav
│   └── modules/
│       ├── router.js       # Hash-based routing with lazy module loading
│       ├── api.js          # Fetch wrapper (get/post/put/del)
│       ├── dashboard.js    # Overview: cards, cost chart, model mix, rankings
│       ├── sessions.js     # Session list + detail timeline
│       ├── inventory.js    # 4-tab view (skills/agents/hooks/rules) with pagination
│       ├── expert.js       # 3-tab: suggestions, scanner, actions
│       └── settings.js     # Config editor, health, manual triggers
├── scripts/                # Installation & management
│   ├── op-install.sh       # 8-step installer (npm, dirs, DB, seed, symlinks, hooks, launchd)
│   ├── op-uninstall.sh     # 4-step uninstaller (symlinks, hooks, launchd)
│   ├── register-hooks.js   # Merge hooks into ~/.claude/settings.json
│   ├── cl-export-events.js # Export project events from SQLite for CL observer
│   └── cl-seed-instincts.js # Cold start: 10 starter instincts + CLAUDE.md rule parser
├── claude/                 # Expert system (symlinked to ~/.claude/ on install)
│   ├── skills/             # 7 skills
│   │   ├── op-continuous-learning/  # Instinct-based learning system (CL v2.1)
│   │   ├── claude-code-knowledge/   # Knowledge base with 8 reference docs
│   │   ├── claude-config-advisor/   # Decision tree for component recommendations
│   │   ├── claude-setup-scanner/    # Setup inventory and gap analysis
│   │   ├── agent-creator/           # Agent scaffolding
│   │   ├── hook-creator/            # Hook scaffolding
│   │   └── rule-creator/            # Rule scaffolding
│   └── agents/
│       └── claude-code-expert.md    # Orchestrator agent using all skills
├── test/                   # Tests (node:test, 143 total)
│   ├── op-db.test.js       # 12 tests
│   ├── op-ingest.test.js   # 9 tests
│   ├── op-actions.test.js  # 7 tests
│   ├── op-collector.test.js # 13 tests
│   ├── op-server.test.js   # 21 tests
│   ├── op-instinct-updater.test.js # 13 tests
│   ├── op-retention.test.js # 4 tests
│   ├── op-suggestion-analyzer.test.js # 9 tests
│   └── cl-seed-instincts.test.js # 9 tests
├── data/                   # Runtime: JSONL files (gitignored)
├── cl/                     # Runtime: Continuous Learning data (gitignored)
├── logs/                   # Runtime: stdout/stderr logs (gitignored)
├── config.json             # Server config (port, intervals, thresholds)
├── open-pulse.db           # SQLite database (gitignored)
└── projects.json           # CL project registry (gitignored)
```

## Database Schema (9 tables)

| Table | Purpose | Key fields |
|---|---|---|
| `events` | All hook events | timestamp, session_id, event_type, name, detail, tokens, cost |
| `sessions` | Session summaries | session_id, started_at, ended_at, model, tokens, cost |
| `collector_errors` | Hook errors | occurred_at, hook_type, error_message, raw_input |
| `components` | Inventory component registry | type, name, source, plugin, project, file_path, first_seen_at |
| `cl_projects` | CL project registry | project_id, name, directory, session_count |
| `cl_instincts` | CL learned patterns | project_id, category, pattern, confidence, instinct |
| `suggestions` | Automation suggestions | id, type, confidence, description, instinct_id, status (pending/approved/dismissed) |
| `scan_results` | Setup scanner reports | scanned_at, report (JSON), issue counts by severity |

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server health + DB size + event count |
| GET | `/api/overview?period=` | Dashboard summary (sessions, cost, top items) |
| GET | `/api/events?type=&name=&from=&to=` | Event list with filters |
| GET | `/api/sessions?from=&to=` | Session list |
| GET | `/api/sessions/:id` | Session detail + events (enriched: `type`, `agent_class`, `plugin`) |
| GET | `/api/rankings/:category?period=` | Skills/agents/tools rankings |
| GET | `/api/cost?group_by=day|model|session&period=` | Cost breakdown |
| GET | `/api/inventory/:type?period=` | Skills/agents/hooks/rules list (enriched: `agent_class`, `plugin`, `project`) |
| GET | `/api/inventory/:type/:name?period=&page=&per_page=` | Component detail + paginated invocations + trigger analysis |
| GET | `/api/unused` | Unused skills, agents, rules |
| GET | `/api/errors?limit=` | Collector errors |
| GET | `/api/instincts` | All CL instincts |
| GET | `/api/instincts/projects` | CL projects with observer status |
| POST | `/api/instincts/sync` | Force CL sync |
| GET | `/api/suggestions?status=` | Automation suggestions |
| PUT | `/api/suggestions/:id/approve` | Approve suggestion |
| PUT | `/api/suggestions/:id/dismiss` | Dismiss suggestion |
| POST | `/api/scanner/run` | Run setup scan |
| GET | `/api/scanner/latest` | Latest scan result |
| GET | `/api/scanner/history?limit=` | Scan history |
| POST | `/api/actions/create-component` | Create skill/agent/hook/rule |
| DELETE | `/api/actions/delete-component` | Delete component |
| GET | `/api/actions/preview-component` | Preview component path |
| GET | `/api/config` | Read config |
| PUT | `/api/config` | Update config |
| POST | `/api/ingest` | Manual JSONL ingestion |

## Key Design Decisions

- **Hook → JSONL → DB** (not direct DB writes): hooks must be fast and never block Claude Code. JSONL append is O(1), server ingests asynchronously.
- **`__dirname` discovery**: hooks resolve repo path via `path.resolve(__dirname, '..')` — no external config files needed.
- **Atomic ingestion**: rename → read → insert → delete prevents data loss on crash.
- **CommonJS for backend**: better-sqlite3 and hook scripts need `require()`.
- **ES modules for frontend**: native browser modules, no bundler needed.
- **Symlinks for Claude integration**: `claude/skills/*` → `~/.claude/skills/*` so the repo stays self-contained.
- **Environment variables for testing**: `OPEN_PULSE_DB`, `OPEN_PULSE_DIR`, `OPEN_PULSE_CLAUDE_DIR` allow tests to use temp directories.
- **`op-` prefix**: all main files use `op-` prefix to avoid naming conflicts.
- **Feedback loop**: approve/dismiss suggestions updates source instinct confidence on disk (+0.15/-0.2). 3 dismissals archives the instinct. Upsert preserves resolved status.
- **3-tier retention**: hot (0-7d full data), warm (7-90d NULLs tool_input/response), cold (90d+ deleted). Configurable, runs daily.
- **Cold start seeding**: 10 universal starter instincts + CLAUDE.md rule parser. Idempotent — skips existing files on reinstall.

## Commands

```bash
# Development
npm start                    # Start server
npm test                     # Run all 143 tests

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

Each tool event includes: `tool_input` (full, 5KB, secrets scrubbed), `tool_response` (full, 5KB, scrubbed), `seq_num` (order within session), `success` (boolean). CL observer reads these from SQLite via `cl-export-events.js`.

## Inventory Enrichment

The inventory endpoints enrich items with metadata beyond raw event counts:

- **Agent classification** (`agent_class`): `"configured"` if agent has a `.md` file in `~/.claude/agents/` or plugin cache, `"built-in"` otherwise (Claude Code native agents like `general-purpose`, `Explore`, `Plan`).
- **Plugin identification** (`plugin`): reads `~/.claude/plugins/installed_plugins.json`, scans each plugin's `agents/` and `skills/` dirs in the cache. Components get qualified names (`plugin:name`). Only shown when item belongs to a plugin.
- **Project scoping** (`project`): derived from plugin `scope` + `projectPath`. User-scoped → `"global"`, project-scoped → `basename(projectPath)`. Also scans project-level `.claude/settings.json` for hooks and `.claude/agents/` for project agents.
- **Pagination**: detail endpoint supports `page` (default 1) and `per_page` (default 10, max 50). Response includes `total`, `page`, `per_page`. Trigger counts are always computed from ALL invocations regardless of page.
- **Trigger analysis**: for each invocation, finds the nearest preceding skill/agent event (`triggered_by`, incoming) and the nearest subsequent skill/agent event (`triggers`, outgoing). Aggregated trigger counts are returned in the `triggers` array.

Key backend helpers in `op-server.js`: `parseQualifiedName()`, `getInstalledPlugins()`, `getPluginComponents()`, `getProjectAgents()`, `getKnownProjectPaths()`, `readItemMetaFromFile()`, `parseHooksFromSettings()`.

## Cost Estimation

Token rates per million tokens (in `op-collector.js`):
- Haiku: $0.80 input / $4.00 output
- Sonnet: $3.00 input / $15.00 output
- Opus: $15.00 input / $75.00 output

## Tech Stack

- **Runtime**: Node.js >= 20
- **Server**: Fastify 5 + @fastify/static
- **Database**: better-sqlite3 (WAL mode, 3s busy timeout)
- **Frontend**: Vanilla JS ES modules, Chart.js 4 (CDN)
- **Tests**: Node.js built-in test runner (`node --test`)
- **Service**: macOS launchd (com.open-pulse)
