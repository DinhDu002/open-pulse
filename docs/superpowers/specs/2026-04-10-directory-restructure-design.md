# Directory Restructure Design

## Goal

Restructure open-pulse from a flat `src/` directory with mixed prefixes into domain-based folders with shared utilities. Remove dead code, eliminate duplicate functions, integrate Continuous Learning into auto-evolve, and mirror `src/` structure in `test/`.

## Constraints

- Breaking changes OK — all imports updated, tests must pass
- Restructure everything: `src/`, `scripts/`, `public/`, `collector/`, `claude/`, `test/`
- No new features — pure cleanup
- No framework changes (keep CommonJS backend, ES modules frontend)

## Principles

- Folder structure replaces prefixes (`op-`, `cl-`) for context
- Each file < 250 lines, single responsibility
- Shared utilities in `src/lib/` — zero duplication
- Domain folders are self-contained: business logic + queries together
- Tests mirror `src/` directory structure

---

## Current Problems

### 1. Duplicate functions (5 instances)

| Function | Locations |
|----------|-----------|
| `slugify()` | `op-auto-evolve.js`, `op-promote.js` |
| `parseFrontmatter()` | `op-helpers.js`, `op-instinct-updater.js` |
| `getClaudeDir()` | `op-auto-evolve.js`, `op-promote.js`, `op-daily-review.js` |
| `getComponentPath()` | `op-auto-evolve.js`, `op-promote.js` |
| `extractBody()` | `op-auto-evolve.js` (single, but needed by instinct-updater) |

### 2. Flat `src/` with 16 files, mixed prefixes

All backend files sit in `src/` root with `op-` or no prefix. No grouping by domain.

### 3. `op-helpers.js` (263 lines) — monolithic utility bag

Contains plugin detection, project discovery, frontmatter parsing, name formatting — unrelated concerns in one file.

### 4. `core.js` route file (460 lines) — 15+ endpoints

Health, overview, events, sessions, prompts, rankings, cost, projects, scanner, config, errors, ingest — all in one file.

### 5. `op-knowledge.js` (642 lines) — 3 responsibilities

Haiku extraction, vault rendering, and cold-start scanning in one file.

### 6. Dead code

- `src/op-execute.js` (180 lines) — not imported anywhere
- `public/modules/learning-insights.js` (672 lines) — not routed
- `public/modules/projects.js` (15 lines) — shim delegating to `learning-projects.js`

### 7. Scattered CL subsystem

Continuous Learning logic split across 3 locations: `src/` (Node.js), `scripts/` (Node.js), `claude/skills/op-continuous-learning/` (shell/Python). Shell scripts duplicate functionality available in Node.js.

### 8. `scripts/` contains business logic

`op-daily-review.js` (413 lines) and `cl-seed-instincts.js` (342 lines) are business logic, not CLI utilities.

### 9. `components.js` DB module (196 lines) — 4 domains

Components, projects, prompts, and scan queries all in one file.

---

## Target Structure

```
open-pulse/
├── src/
│   ├── server.js
│   ├── retention.js
│   ├── lib/
│   │   ├── frontmatter.js
│   │   ├── slugify.js
│   │   ├── paths.js
│   │   ├── plugins.js
│   │   ├── projects.js
│   │   └── format.js
│   ├── db/
│   │   ├── schema.js
│   │   ├── events.js
│   │   ├── sessions.js
│   │   ├── prompts.js
│   │   ├── components.js
│   │   ├── projects.js
│   │   ├── scan.js
│   │   ├── knowledge-entries.js
│   │   └── knowledge-sync.js
│   ├── ingest/
│   │   ├── collector.js
│   │   ├── pipeline.js
│   │   ├── prompt-linker.js
│   │   └── sync.js
│   ├── evolve/
│   │   ├── sync.js
│   │   ├── promote.js
│   │   ├── revert.js
│   │   ├── queries.js
│   │   ├── observer.js
│   │   ├── observer-prompt.md
│   │   ├── instinct-updater.js
│   │   ├── seed.js
│   │   └── export-events.js
│   ├── knowledge/
│   │   ├── extract.js
│   │   ├── vault.js
│   │   ├── scan.js
│   │   └── queries.js
│   ├── review/
│   │   ├── pipeline.js
│   │   ├── context.js
│   │   ├── prompt.md
│   │   └── queries.js
│   └── routes/
│       ├── health.js
│       ├── events.js
│       ├── prompts.js
│       ├── cost.js
│       ├── projects.js
│       ├── scanner.js
│       ├── config.js
│       ├── inventory.js
│       ├── knowledge.js
│       ├── auto-evolves.js
│       └── daily-reviews.js
├── scripts/
│   ├── install.sh
│   ├── uninstall.sh
│   ├── register-hooks.js
│   ├── reset-db.js
│   └── backfill-prompts.js
├── public/
│   ├── index.html
│   └── modules/
│       ├── router.js
│       ├── api.js
│       ├── utils.js
│       ├── dashboard.js
│       ├── prompts.js
│       ├── inventory.js
│       ├── knowledge.js
│       ├── projects.js
│       ├── auto-evolves.js
│       ├── daily-reviews.js
│       └── settings.js
├── test/
│   ├── db/
│   │   └── schema.test.js
│   ├── ingest/
│   │   ├── pipeline.test.js
│   │   └── collector.test.js
│   ├── evolve/
│   │   ├── sync.test.js
│   │   ├── promote.test.js
│   │   ├── seed.test.js
│   │   ├── export.test.js
│   │   └── instinct.test.js
│   ├── knowledge/
│   │   └── knowledge.test.js
│   ├── review/
│   │   └── review.test.js
│   ├── routes/
│   │   ├── routes.test.js
│   │   └── learning.test.js
│   ├── retention.test.js
│   ├── helpers.test.js
│   └── backfill-prompts.test.js
├── claude/
│   ├── agents/
│   │   └── claude-code-expert.md
│   └── skills/
│       ├── claude-code-knowledge/
│       ├── claude-config-advisor/
│       ├── claude-setup-scanner/
│       ├── agent-creator/
│       ├── rule-creator/
│       └── hook-creator/
├── config.json
└── CLAUDE.md
```

---

## Detailed Changes

### `src/lib/` — Shared utilities (NEW)

Extract from `op-helpers.js` (263 lines, deleted after) and deduplicate from other modules:

| File | Functions | Source |
|------|-----------|--------|
| `frontmatter.js` | `parseFrontmatter()`, `extractBody()` | op-helpers.js, op-auto-evolve.js |
| `slugify.js` | `slugify()` | op-auto-evolve.js, op-promote.js |
| `paths.js` | `getClaudeDir()`, `getComponentPath()`, `getRepoDir()` | op-auto-evolve.js, op-promote.js, op-daily-review.js |
| `plugins.js` | `getInstalledPlugins()`, `getPluginComponents()` | op-helpers.js |
| `projects.js` | `getKnownProjectPaths()`, `getProjectAgents()` | op-helpers.js |
| `format.js` | `parseQualifiedName()`, `readItemMetaFromFile()`, `errorReply()`, `parsePagination()` | op-helpers.js |

Each file 30-60 lines.

### `src/db/` — Database layer (RESTRUCTURE)

| File | Source | Change |
|------|--------|--------|
| `schema.js` | `op-db.js` | Keep only `createDb()` + migrations. Remove all re-exports. |
| `events.js` | `db/events.js` | No change |
| `sessions.js` | `db/sessions.js` | No change |
| `prompts.js` | `db/components.js` | Extract: `insertPrompt`, `getLatestPromptForSession`, `updatePromptStats`, `updatePromptTokens` |
| `components.js` | `db/components.js` | Keep only component queries |
| `projects.js` | `db/components.js` | Extract: project CRUD queries |
| `scan.js` | `db/components.js` | Extract: scan result queries |
| `knowledge-entries.js` | `db/knowledge-entries.js` | No change |
| `knowledge-sync.js` | `db/knowledge.js` | Rename for clarity (vault hash + sync state) |

### `src/ingest/` — Collection + ingestion (NEW folder)

| File | Source | Change |
|------|--------|--------|
| `collector.js` | `collector/op-collector.js` | Move. Delete `collector/` folder. Update hook paths in `register-hooks.js`. |
| `pipeline.js` | `op-ingest.js` | Extract: `ingestFile()`, `ingestAll()`, `processContent()`, `parseJsonl()`, retry logic |
| `prompt-linker.js` | `op-ingest.js` | Extract: `linkEventsToPrompts()`, `updatePromptStatsAfterInsert()`, `distributeTokensToPrompts()` |
| `sync.js` | `op-sync.js` | Move |

### `src/evolve/` — Auto-evolve + observer (NEW folder, absorbs CL)

| File | Source | Change |
|------|--------|--------|
| `sync.js` | `op-auto-evolve.js` | Extract: `syncInstincts()`, `UPSERT_SQL` |
| `promote.js` | `op-auto-evolve.js` + `op-promote.js` | Merge: `runAutoEvolve()`, `generateComponent()`. Use `lib/slugify`, `lib/paths`. Delete `op-promote.js`. |
| `revert.js` | `op-auto-evolve.js` | Extract: `revertAutoEvolve()` |
| `queries.js` | `op-auto-evolve.js` | Extract: `queryAutoEvolves()`, `getAutoEvolve()`, `getAutoEvolveStats()` |
| `observer.js` | `claude/skills/op-continuous-learning/agents/observer-loop.sh` | Rewrite in Node.js. Runs as server timer. Flow: export-events → Haiku → instinct files. |
| `observer-prompt.md` | `observer-loop.sh` heredoc (lines 145-233) | Extract Haiku prompt template to standalone file |
| `instinct-updater.js` | `op-instinct-updater.js` | Move. Use `lib/frontmatter` instead of local duplicate. |
| `seed.js` | `scripts/cl-seed-instincts.js` | Move from `scripts/` |
| `export-events.js` | `scripts/cl-export-events.js` | Move from `scripts/` |

Delete entirely: `claude/skills/op-continuous-learning/` (7 shell/Python files, config.json, SKILL.md).

Observer config keys added to root `config.json`:

| Key | Default | Purpose |
|-----|---------|---------|
| `observer_enabled` | `false` | Enable observer timer |
| `observer_interval_ms` | `300000` | Observer cycle interval (5 min) |
| `observer_min_events` | `20` | Minimum events before analysis |

### `src/knowledge/` — Knowledge extraction + vault (NEW folder)

| File | Source | Change |
|------|--------|--------|
| `extract.js` | `op-knowledge.js` | Extract: `extractKnowledgeFromPrompt()`, Haiku invocation, response parsing (~200 lines) |
| `vault.js` | `op-knowledge.js` | Extract: `renderVault()`, markdown file generation (~150 lines) |
| `scan.js` | `op-knowledge.js` | Extract: `runColdStartScan()`, file reading + bootstrap (~150 lines) |
| `queries.js` | `db/knowledge-entries.js` + `db/knowledge.js` | Merge: all knowledge DB queries (~250 lines) |

Delete `op-knowledge.js` (642 lines).

### `src/review/` — Daily review (NEW folder)

| File | Source | Change |
|------|--------|--------|
| `pipeline.js` | `scripts/op-daily-review.js` | Extract: orchestration (collect → Opus → save) (~150 lines) |
| `context.js` | `scripts/op-daily-review.js` | Extract: read component files + work history (~150 lines). Use `lib/frontmatter`, `lib/paths`. |
| `prompt.md` | `scripts/op-daily-review-prompt.md` | Move |
| `queries.js` | scattered in route handlers | Centralize daily_reviews CRUD |

Delete `scripts/op-daily-review.js` (413 lines) and `scripts/op-daily-review-prompt.md`.

### `src/routes/` — API endpoints (SPLIT)

Split `core.js` (460 lines) into:

| File | Endpoints | ~Lines |
|------|-----------|--------|
| `health.js` | `GET /api/health`, `GET /api/overview` | ~50 |
| `events.js` | `GET /api/events`, `GET /api/sessions`, `GET /api/sessions/:id` | ~60 |
| `prompts.js` | `GET /api/prompts`, `GET /api/prompts/:id` | ~70 |
| `cost.js` | `GET /api/cost`, `GET /api/rankings` | ~50 |
| `projects.js` | `GET /api/projects`, `DELETE /api/projects/:id`, `GET /api/projects/:id/*` | ~60 |
| `scanner.js` | `POST /api/scanner/run`, `GET /api/scanner/latest`, `GET /api/scanner/history` | ~40 |
| `config.js` | `GET/PUT /api/config`, `GET /api/errors`, `POST /api/ingest` | ~60 |

Keep unchanged: `inventory.js`, `knowledge.js`, `auto-evolves.js`, `daily-reviews.js`.

`server.js` registers 11 route plugins instead of 5.

### `src/server.js` — App factory (RENAME + SLIM)

Rename from `op-server.js`. Same role: Fastify app factory + timer coordinator + route registration. Update all `require()` paths to new locations.

### `src/retention.js` — Keep at root (RENAME)

Rename from `op-retention.js`. Only 45 lines — no need for its own folder.

### `scripts/` — CLI utilities only (SLIM)

| File | Source | Change |
|------|--------|--------|
| `install.sh` | `op-install.sh` | Rename, update paths |
| `uninstall.sh` | `op-uninstall.sh` | Rename, update paths |
| `register-hooks.js` | same | Update collector path to `src/ingest/collector.js` |
| `reset-db.js` | same | Update `require()` path to `db/schema` |
| `backfill-prompts.js` | `op-backfill-prompts.js` | Rename |

Removed from `scripts/`: `op-daily-review.js`, `op-daily-review-prompt.md`, `cl-seed-instincts.js`, `cl-export-events.js` (moved to `src/`).

### `public/modules/` — Frontend (CLEAN)

| Change | Detail |
|--------|--------|
| Delete `learning-insights.js` | Dead code (672 lines) — not routed |
| Delete `projects.js` (shim) | 15-line shim, replaced by rename |
| Rename `learning-projects.js` → `projects.js` | Remove `learning-` prefix |
| Update `router.js` | Update import path for `projects.js` |

### `test/` — Mirror `src/` (RESTRUCTURE)

| New path | Old path |
|----------|----------|
| `test/db/schema.test.js` | `test/op-db.test.js` |
| `test/ingest/pipeline.test.js` | `test/op-ingest.test.js` |
| `test/ingest/collector.test.js` | `test/op-collector.test.js` |
| `test/evolve/sync.test.js` | `test/op-auto-evolve.test.js` |
| `test/evolve/promote.test.js` | `test/op-promote.test.js` |
| `test/evolve/seed.test.js` | `test/cl-seed-instincts.test.js` |
| `test/evolve/export.test.js` | `test/cl-export-events.test.js` |
| `test/evolve/instinct.test.js` | `test/op-instinct-updater.test.js` |
| `test/knowledge/knowledge.test.js` | `test/op-knowledge.test.js` |
| `test/review/review.test.js` | `test/op-daily-review.test.js` |
| `test/routes/routes.test.js` | `test/op-server.test.js` |
| `test/routes/learning.test.js` | `test/op-learning-api.test.js` |
| `test/retention.test.js` | `test/op-retention.test.js` |
| `test/helpers.test.js` | `test/op-helpers.test.js` |
| `test/backfill-prompts.test.js` | `test/op-backfill-prompts.test.js` |

Update `npm test` in `package.json` to: `node --test 'test/**/*.test.js'` (recursive glob).

### `claude/` — Expert system (DELETE CL)

Delete `claude/skills/op-continuous-learning/` entirely. Keep all other skills and agents unchanged.

### `CLAUDE.md` — Update after restructure

Update directory structure section, file references, and architecture diagram to reflect new layout.

---

## Deletions Summary

| Path | Lines | Reason |
|------|-------|--------|
| `src/op-execute.js` | 180 | Dead code — not imported |
| `src/op-helpers.js` | 263 | Split into `src/lib/*` |
| `src/op-promote.js` | 173 | Merged into `src/evolve/promote.js` |
| `src/op-db.js` | 326 | Split: schema → `db/schema.js`, queries re-exported directly |
| `src/op-ingest.js` | 328 | Split into `ingest/pipeline.js` + `ingest/prompt-linker.js` |
| `src/op-auto-evolve.js` | 287 | Split into `evolve/sync.js`, `promote.js`, `revert.js`, `queries.js` |
| `src/op-knowledge.js` | 642 | Split into `knowledge/extract.js`, `vault.js`, `scan.js` |
| `src/op-sync.js` | 226 | Moved to `ingest/sync.js` |
| `src/op-instinct-updater.js` | 193 | Moved to `evolve/instinct-updater.js` |
| `src/op-server.js` | 171 | Renamed to `server.js` |
| `src/op-retention.js` | 45 | Renamed to `retention.js` |
| `src/routes/core.js` | 460 | Split into 7 route files |
| `src/db/knowledge.js` | 52 | Renamed to `knowledge-sync.js` |
| `collector/op-collector.js` | 425 | Moved to `ingest/collector.js` |
| `scripts/op-daily-review.js` | 413 | Moved to `review/pipeline.js` + `context.js` |
| `scripts/op-daily-review-prompt.md` | — | Moved to `review/prompt.md` |
| `scripts/cl-seed-instincts.js` | 342 | Moved to `evolve/seed.js` |
| `scripts/cl-export-events.js` | 122 | Moved to `evolve/export-events.js` |
| `public/modules/learning-insights.js` | 672 | Dead code |
| `public/modules/projects.js` | 15 | Shim replaced by rename |
| `claude/skills/op-continuous-learning/` | ~800 | Absorbed into `src/evolve/` |

---

## Migration Notes

### Hook path update

`register-hooks.js` must update the collector path from `collector/op-collector.js` to `src/ingest/collector.js`. Run `register-hooks.js` after restructure to update `~/.claude/settings.json`.

### `npm test` command

Update `package.json` test script from `node --test test/` to `node --test 'test/**/*.test.js'` for recursive subdirectory discovery.

### Observer rewrite

The Node.js observer (`src/evolve/observer.js`) replaces the shell-based CL observer. It runs as a server timer (same pattern as auto-evolve timer). Config keys move from `claude/skills/op-continuous-learning/config.json` to root `config.json`.

### Symlink re-registration

After restructure, run `scripts/install.sh` to re-create symlinks for `claude/skills/` and `claude/agents/` (minus `op-continuous-learning`).

---

## Verification

1. `npm test` — all tests pass with new paths
2. `npm start` — server starts, all timers functional
3. `curl http://127.0.0.1:3827/api/health` — responds OK
4. UI at `http://127.0.0.1:3827/` — all pages render
5. `scripts/install.sh` — symlinks created correctly (6 skills, 1 agent)
6. Grep for old paths (`op-server`, `op-db`, `op-helpers`, etc.) — zero references remain
