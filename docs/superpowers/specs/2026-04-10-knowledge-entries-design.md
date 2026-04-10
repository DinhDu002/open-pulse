# Knowledge Entries — Design Spec

> Replaces the existing Knowledge Graph (kg_nodes/kg_edges) with a project-understanding system that extracts factual knowledge about each project via LLM after every prompt.

## Problem

The current Knowledge system stores **tool usage stats** (Read: 500 invocations, success rate 99%) and **tool co-occurrence patterns** (Read triggers Edit). This does not help Claude understand what a project actually does — its domain, schema meanings, API purposes, or business logic.

## Goal

Build a system where Claude gains deep project understanding automatically — domain, tech stack, database schema meanings, API endpoint purposes, feature logic, architecture decisions, known issues, and more. Knowledge updates incrementally after each prompt and can be bootstrapped via cold-start scan.

## Non-Goals

- Does NOT replace auto-evolves (behavioral patterns → rules/skills)
- Does NOT replace daily-reviews (comprehensive suggestions)
- Does NOT replace KB Notes (manual wiki notes — kept as-is)
- No confidence scoring — entries are factual, not behavioral patterns
- No auto-promotion to `~/.claude/` — output stays in `<project>/.claude/knowledge/`

## Knowledge Categories

| Category | Description | Example |
|---|---|---|
| `domain` | Industry/business context | "CRM system for managing customer relationships" |
| `stack` | Languages, frameworks, libraries | "Fastify 5 + better-sqlite3 + vanilla JS frontend" |
| `schema` | Database table/column meanings | "events.prompt_id links each event to its user turn" |
| `api` | Endpoint purposes and contracts | "GET /api/overview returns dashboard summary with cost breakdown" |
| `feature` | Business logic and rules | "Retention compacts tool data after 7 days, deletes after 90" |
| `architecture` | Module structure, data flow, patterns | "Hook → JSONL → atomic ingest → SQLite, never direct DB writes" |
| `convention` | Naming, file org, coding style | "op- prefix for backend files, cl- prefix for CL scripts" |
| `decision` | Why choices were made, tradeoffs | "CommonJS for backend because better-sqlite3 needs require()" |
| `footgun` | Known issues, hacks, workarounds | "kg_edges FK constraint requires both nodes to exist before inserting edge" |
| `contract` | External system integrations | "Calls Claude Haiku API at api.anthropic.com for enrichment" |
| `error_pattern` | Common errors and fixes | "SQLITE_BUSY when WAL mode not enabled — set busy_timeout to 3000ms" |

## Data Model

### New table: `knowledge_entries`

```sql
CREATE TABLE knowledge_entries (
  id              TEXT PRIMARY KEY,           -- 'ke-<sha256_16>'
  project_id      TEXT NOT NULL,              -- FK to cl_projects
  category        TEXT NOT NULL,              -- one of 11 categories above
  title           TEXT NOT NULL,              -- concise unique identifier
  body            TEXT NOT NULL DEFAULT '',   -- detailed description (markdown)
  source_file     TEXT,                       -- file path if applicable
  source_prompt_id TEXT,                      -- prompt_id that generated this entry
  tags            TEXT DEFAULT '[]',          -- JSON array
  status          TEXT DEFAULT 'active',      -- active | outdated | merged
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_ke_project ON knowledge_entries(project_id);
CREATE INDEX idx_ke_category ON knowledge_entries(category);
CREATE INDEX idx_ke_status ON knowledge_entries(status);
CREATE UNIQUE INDEX idx_ke_project_title ON knowledge_entries(project_id, title);
```

### Entry lifecycle

- `active` — entry is current and valid
- `outdated` — marked stale when LLM detects contradicting information
- `merged` — duplicate entry merged into a newer one

### Tables removed

- `kg_nodes` — replaced by `knowledge_entries`
- `kg_edges` — no longer needed (entries are flat, not a graph)

### Tables kept

- `kg_vault_hashes` — reused for new vault content-hash dedup
- `kg_sync_state` — reused for tracking scan/extract timestamps
- `kb_notes` — manual notes, unchanged

## Architecture

### Two extraction flows

```
Flow 1: Post-Ingest (incremental, after each prompt)
─────────────────────────────────────────────────────
op-ingest.js (processFile)
  → prompt record created/updated
  → setImmediate(() => extractKnowledgeFromPrompt(db, promptId))
  → op-knowledge.js reads prompt's events
  → builds LLM prompt with events + existing titles (dedup)
  → calls Haiku API
  → parses JSON response → upsert knowledge_entries
  → renders vault files (content-hash dedup)

Flow 2: Cold Start Scan (manual, per project)
──────────────────────────────────────────────
POST /api/knowledge/scan { project_id }
  → op-knowledge.js reads key project files
    (README, package.json, schema files, routes, config)
  → builds comprehensive LLM prompt
  → calls Haiku API
  → bulk upsert knowledge_entries
  → renders vault files
```

### Module: `src/op-knowledge.js`

Core functions:

| Function | Purpose |
|---|---|
| `extractKnowledgeFromPrompt(db, promptId, opts)` | Read prompt events → LLM → upsert entries |
| `scanProject(db, projectId, opts)` | Cold start: read key files → LLM → bulk upsert |
| `renderKnowledgeVault(db, projectId)` | Entries → grouped markdown files → content-hash dedup |
| `mergeOrUpdate(db, projectId, newEntries)` | Dedup: update existing / mark outdated / insert new |
| `getExistingTitles(db, projectId)` | Get active entry titles for LLM dedup context |
| `buildExtractPrompt(events, existingTitles)` | Build post-ingest LLM prompt |
| `buildScanPrompt(files)` | Build cold-start LLM prompt |
| `callHaiku(apiKey, prompt, maxTokens)` | Call Claude Haiku API |

### LLM Prompt: Post-Ingest

```
You are a project knowledge extractor. Given tool events from a coding
session, extract factual knowledge about the project.

Project: {project_name}
Existing knowledge titles (skip these): {existing_titles}

Events:
{formatted_events — tool_name, file paths, key content snippets}

Extract knowledge entries as JSON array. Each entry:
{
  "category": "domain|stack|schema|api|feature|architecture|convention|decision|footgun|contract|error_pattern",
  "title": "concise unique identifier",
  "body": "2-5 sentences explaining in detail",
  "source_file": "file path or null",
  "tags": ["tag1", "tag2"]
}

Rules:
- Only extract NEW knowledge not already in existing titles
- Focus on project understanding, not tool usage statistics
- Be specific to this project, not generic programming knowledge
- Return empty array [] if no new knowledge found
```

### LLM Prompt: Cold Start Scan

```
Analyze these project files and extract comprehensive knowledge about the project.

Files:
{file_name: content, ...}

Extract ALL knowledge entries covering every applicable category:
domain, stack, schema, api, feature, architecture, convention, decision,
footgun, contract, error_pattern.

Return JSON array with same schema as above.
Be thorough — this is the initial knowledge bootstrap for the project.
```

### Integration with `op-ingest.js`

After prompt record is created/updated in the ingest transaction:

```js
if (config.knowledge_enabled !== false) {
  setImmediate(() => {
    extractKnowledgeFromPrompt(db, promptId, {
      maxTokens: config.knowledge_max_tokens ?? 1000,
    }).catch(err => { /* log error, never crash */ });
  });
}
```

`setImmediate` ensures extraction does not block the ingest pipeline. Failures are logged to `collector_errors`, never crash the server.

## API Endpoints

### Knowledge Entries (new)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/knowledge/entries?project=&category=&status=&page=&per_page=` | Paginated list with filters |
| GET | `/api/knowledge/entries/stats` | Counts by category, status, project |
| GET | `/api/knowledge/entries/:id` | Entry detail |
| PUT | `/api/knowledge/entries/:id` | Manual edit (title, body, tags, category) |
| PUT | `/api/knowledge/entries/:id/outdated` | Mark as outdated |
| DELETE | `/api/knowledge/entries/:id` | Delete entry |
| POST | `/api/knowledge/scan` | Cold start scan (body: `{project_id}`) |

### KB Notes (unchanged)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/knowledge/notes?...` | List notes |
| POST | `/api/knowledge/notes` | Create note |
| GET | `/api/knowledge/notes/:id` | Note detail + backlinks |
| PUT | `/api/knowledge/notes/:id` | Update note |
| DELETE | `/api/knowledge/notes/:id` | Delete note |

### Autocomplete & Discovery (rebuilt)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/knowledge/autocomplete?project=&q=` | Search entry titles + note slugs |
| GET | `/api/knowledge/discover?project=&context=` | Find relevant entries by keyword matching |

### Removed endpoints

- `/api/knowledge/status` → replaced by `/entries/stats`
- `/api/knowledge/projects` → merged into `/entries/stats`
- `/api/knowledge/graph` → removed (no more KG)
- `/api/knowledge/node/:id` → replaced by `/entries/:id`
- `/api/knowledge/sync` → replaced by auto post-ingest
- `/api/knowledge/generate` → vault auto-renders after extract
- `/api/knowledge/enrich` → merged into extract pipeline
- `/api/knowledge/config` → merged into `/api/config`
- `/api/knowledge/discover` → rebuilt for entries

## Vault Generation

Output directory: `<project>/.claude/knowledge/`

```
.claude/knowledge/
├── index.md              -- Table of contents
├── domain.md             -- Domain/Industry entries
├── stack.md              -- Tech stack entries
├── schema.md             -- Database schema meanings
├── api.md                -- API endpoint purposes
├── features.md           -- Feature logic & business rules
├── architecture.md       -- Architecture & patterns
├── conventions.md        -- Coding conventions
├── decisions.md          -- Decision rationale
├── footguns.md           -- Known issues & workarounds
├── contracts.md          -- External system contracts
├── error-patterns.md     -- Common error patterns
└── notes/                -- KB Notes (unchanged)
    └── *.md
```

Each category file groups all active entries:

```markdown
<!-- Auto-generated by Open Pulse. Do not edit. -->
# Database Schema

## events table stores hook events
Bảng events lưu trữ tất cả hook events từ Claude Code. Mỗi event
có timestamp, session_id, event_type, và tool_input/tool_response.
Cột prompt_id liên kết event với user turn trong bảng prompts.
Source: `src/op-db.js`

## sessions table tracks session summaries
Bảng sessions tổng hợp thông tin mỗi phiên làm việc gồm model,
total tokens, cost, và working directory.
Source: `src/op-db.js`
```

Content-hash dedup uses `kg_vault_hashes` table (reused, same schema).

## Frontend UI

Page `#knowledge` with 3 tabs:

### Tab 1: Entries (default, new)

- **Filter bar**: project dropdown + category dropdown + status filter (all/active/outdated)
- **Entry list**: cards with title, category badge (colored), source_file, body excerpt, timeAgo
- **Click card** → inline detail: full body (markdown rendered), edit button, outdated button, delete button
- **Stats row**: total entries count, breakdown by category

### Tab 2: Notes (unchanged)

Same as current — note list, editor, wikilink autocomplete, backlinks.

### Tab 3: Scan (replaces Projects & Sync)

- **Project list**: table with project name, entry count, last scan time
- **Scan button** per project: triggers `POST /api/knowledge/scan`
- **Progress indicator**: "Scanning..." with spinner during scan

## Configuration

### New keys in `config.json`

| Key | Default | Purpose |
|---|---|---|
| `knowledge_enabled` | `true` | Enable/disable post-ingest extraction |
| `knowledge_max_events_per_prompt` | `50` | Max events sent to Haiku per prompt |
| `knowledge_max_tokens` | `1000` | Max response tokens from Haiku |
| `knowledge_scan_files` | `["README.md","package.json","CLAUDE.md"]` | Files read during cold start |
| `knowledge_scan_patterns` | `["**/schema*","**/routes/*","**/migration*"]` | Glob patterns for cold start |

### Removed config keys

- `knowledge_graph_interval_ms`
- `knowledge_vault_interval_ms`
- `knowledge_enrich_enabled`
- `knowledge_pattern_min_occurrences`
- `knowledge_session_lookback_days`
- `knowledge_instinct_min_confidence`
- `knowledge_vault_max_index_items`

## File Changes

### New files

| File | Purpose |
|---|---|
| `src/op-knowledge.js` | Core module: extract, scan, vault, merge |
| `src/db/knowledge-entries.js` | DB queries for knowledge_entries |
| `test/op-knowledge.test.js` | Tests for extraction, scan, vault, merge |

### Deleted files

| File | Reason |
|---|---|
| `src/op-knowledge-graph.js` | Replaced by `op-knowledge.js` |
| `src/op-knowledge-enricher.js` | Merged into extract pipeline |
| `src/op-vault-generator.js` | Vault logic moved to `op-knowledge.js` |
| `test/op-knowledge-graph.test.js` | Replaced by `op-knowledge.test.js` |
| `test/op-vault-generator.test.js` | Replaced |
| `test/op-knowledge-enricher.test.js` | Replaced |

### Modified files

| File | Changes |
|---|---|
| `src/op-db.js` | Add `knowledge_entries` table, migration to drop `kg_nodes`/`kg_edges` |
| `src/db/knowledge.js` | Remove KG node/edge queries, add knowledge entry queries |
| `src/routes/knowledge.js` | Rewrite: entries CRUD + scan + rebuild autocomplete/discover |
| `src/op-ingest.js` | Add post-ingest hook to call `extractKnowledgeFromPrompt` |
| `src/op-server.js` | Remove KG sync timer, vault timer. Keep notes endpoints |
| `src/op-notes.js` | Remove `syncNoteToGraph`/`removeNoteFromGraph` (KG gone) |
| `public/modules/knowledge.js` | Rewrite UI: 3 tabs (Entries, Notes, Scan) |
| `CLAUDE.md` | Update architecture docs, remove KG references |

### Unchanged

- `src/op-notes.js` — slug helpers, backlink extraction, disk sync (kept)
- `kb_notes` table and all notes endpoints
- `kg_vault_hashes` table (reused)
- `kg_sync_state` table (reused)

## Separation from Other Systems

| System | Scope | Trigger | Output |
|---|---|---|---|
| **Knowledge Entries** (new) | Project understanding | Post-ingest + manual scan | `.claude/knowledge/*.md` |
| **Auto-Evolves** (unchanged) | Behavioral patterns | CL observer | `~/.claude/rules/`, `~/.claude/skills/` |
| **Daily Reviews** (unchanged) | Comprehensive suggestions | 3AM daily | `daily_reviews` table + `reports/*.md` |
| **KB Notes** (unchanged) | Manual wiki notes | User action | `.claude/knowledge/notes/*.md` |

Zero shared code between these four systems.
