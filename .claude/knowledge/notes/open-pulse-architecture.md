---
type: note
title: Open Pulse Architecture
tags: [architecture, data-flow]
created_at: 2026-04-08T04:04:21.939Z
updated_at: 2026-04-08T04:04:21.939Z
---

# Open Pulse — Architecture

Local analytics dashboard and expert system for Claude Code.

## Data Flow

```
Hooks (Claude Code) → JSONL (data/) → Ingest (10s) → SQLite → API (Fastify :3827) → SPA
```

1. Claude Code hooks write JSONL to `data/` (PostToolUse, UserPromptSubmit, Stop)
2. Server ingests atomically: rename .jsonl → .processing → read → insert → delete
3. CL observer reads events, runs Haiku to detect patterns
4. Server syncs projects/instincts/components (60s timer)
5. Suggestion agent (Opus 4.6) runs daily at 3 AM — 8-category analysis
6. Retention: hot (7d full) → warm (90d NULLs tool_input) → cold (90d+ deleted)

## Database (SQLite, 9 tables)

- `events` — all hook events (tool_input/response, tokens, cost)
- `sessions` — session summaries
- `collector_errors` — hook failures
- `components` — inventory (skills/agents/hooks/rules)
- `cl_projects` — project registry
- `cl_instincts` — learned patterns with confidence
- `suggestions` — AI-generated suggestions
- `scan_results` — setup scanner reports
- `kb_notes` — user-created knowledge notes

## Key Design Decisions

- Hook → JSONL → DB (not direct writes): hooks must be fast, O(1) append
- CommonJS backend (better-sqlite3 needs require)
- ES modules frontend (no build step)
- Symlinks to ~/.claude/ for integration
- `op-` prefix for all files
- 3-tier retention (hot/warm/cold)
- SHA-256 dedup for vault generation
