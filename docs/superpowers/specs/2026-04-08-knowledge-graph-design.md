# Knowledge Graph & Obsidian Vault — Design Spec

**Date**: 2026-04-08
**Phase**: 1 of 3 (Graph + Vault → Auto-Wiki → NLQ)
**Approach**: Two-Pass (deterministic + LLM enrichment)

## Problem

Claude Code lacks persistent, structured knowledge about how it's used in each project. Every session starts from scratch — reading CLAUDE.md and exploring the codebase. Open Pulse already collects rich usage data (tool calls, sessions, instincts, components, trigger chains) but this knowledge is locked in a dashboard, not accessible to Claude during sessions.

## Goal

Build an auto-updating knowledge graph in Open Pulse that materializes as Obsidian-compatible vault files in each project's `.claude/knowledge/` directory. Claude Code reads these files to understand project-specific usage patterns, component relationships, validated conventions, and performance insights — making each session more informed than the last.

## Architecture

```
Open Pulse SQLite                    Per-Project Output
┌──────────────────┐                 ┌──────────────────────────┐
│ events           │                 │ project/.claude/knowledge/ │
│ sessions         │   Pass 1        │   index.md  ← @ref in     │
│ components       │──(5 min)──→     │   tools/Read.md            │
│ cl_instincts     │   SQL extract   │   components/code-rev.md   │
│ suggestions      │   + graph       │   patterns/file-mod.md     │
│ cl_projects      │   upsert        │   instincts/pagination.md  │
│                  │                 │   insights/cost-report.md  │
│ ┌──────────────┐ │   Vault Gen     │                            │
│ │ kg_nodes     │─┼──(15 min)──→   │   (SHA-256 skip unchanged) │
│ │ kg_edges     │ │   templates     │                            │
│ │ kg_vault_hash│ │                 └──────────────────────────┘
│ └──────────────┘ │
│                  │   Pass 2
│                  │──(on-demand)──→ kg_nodes.properties.summary
│                  │   Haiku enrich  (overlay, never replaces)
└──────────────────┘
```

## Database Schema

### kg_nodes

```sql
CREATE TABLE kg_nodes (
  id TEXT PRIMARY KEY,             -- 'tool:Read', 'component:code-reviewer', 'instinct:api-pagination'
  type TEXT NOT NULL,              -- tool, component, instinct, pattern, session, project
  name TEXT NOT NULL,              -- display name
  properties TEXT DEFAULT '{}',   -- JSON: stats, description, summary (enriched), enriched_at
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kg_nodes_type ON kg_nodes(type);
```

### kg_edges

```sql
CREATE TABLE kg_edges (
  source_id TEXT NOT NULL REFERENCES kg_nodes(id),
  target_id TEXT NOT NULL REFERENCES kg_nodes(id),
  relationship TEXT NOT NULL,     -- triggers, belongs_to, learned_from, co_occurs, suggests, used_in
  weight REAL DEFAULT 1.0,        -- occurrence count or strength
  properties TEXT DEFAULT '{}',   -- JSON: context, first_seen, etc.
  valid_from TEXT,                -- temporal: when relationship started
  valid_to TEXT,                  -- temporal: when superseded (NULL = current)
  PRIMARY KEY (source_id, target_id, relationship)
);
CREATE INDEX idx_kg_edges_source ON kg_edges(source_id);
CREATE INDEX idx_kg_edges_target ON kg_edges(target_id);
CREATE INDEX idx_kg_edges_rel ON kg_edges(relationship);
```

### kg_vault_hashes

```sql
CREATE TABLE kg_vault_hashes (
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,         -- relative: 'tools/Read.md'
  content_hash TEXT NOT NULL,      -- SHA-256 of generated content
  generated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);
```

### kg_sync_state

```sql
CREATE TABLE kg_sync_state (
  key TEXT PRIMARY KEY,            -- 'last_event_id', 'last_sync_at', 'last_vault_gen_at'
  value TEXT NOT NULL
);
```

## Node Types

| Type | ID Format | Source | Example |
|------|-----------|--------|---------|
| tool | `tool:{name}` | events (DISTINCT name) | `tool:Read` |
| component | `component:{type}:{name}` | components table | `component:agent:code-reviewer` |
| instinct | `instinct:{instinct_id}` | cl_instincts table | `instinct:api-pagination-clamping` |
| pattern | `pattern:{hash}` | derived from trigger analysis | `pattern:read-edit-write` |
| session | `session:{session_id}` | sessions table (last 30d) | `session:abc123` |
| project | `project:{project_id}` | cl_projects table | `project:open-pulse` |

## Edge Types

| Relationship | Meaning | Source | Weight |
|---|---|---|---|
| `triggers` | tool A commonly followed by tool B | LEAD(name) OVER session window | occurrence count |
| `co_occurs` | tools used together in sessions | tool pair per session GROUP BY | session count |
| `belongs_to` | component/instinct belongs to project | FK: project_id | 1.0 |
| `learned_from` | instinct derived from project sessions | cl_instincts.project_id | 1.0 |
| `suggests` | instinct led to suggestion | suggestions.instinct_id | 1.0 |
| `used_in` | tool/component used in session | events.session_id | invocation count |

## Pass 1: Deterministic Pipeline

**Timer**: Every 5 minutes (configurable via `config.json`)
**Module**: `src/op-knowledge-graph.js`

### Step 1: Extract Nodes

```
- tools: SELECT DISTINCT name, event_type FROM events WHERE rowid > cursor
- components: SELECT * FROM components
- instincts: SELECT * FROM cl_instincts WHERE confidence > 0.3
- sessions: SELECT * FROM sessions WHERE started_at > (now - 30d)
- projects: SELECT * FROM cl_projects
- patterns: derived from trigger pairs with count > threshold (default 5)
```

### Step 2: Extract Edges

```
- triggers: LEAD(name) OVER (PARTITION BY session_id ORDER BY seq_num)
            WHERE both are tool/skill/agent, GROUP BY pair, COUNT(*)
- co_occurs: tool pairs within same session, COUNT(DISTINCT session_id)
- belongs_to: component.project / instinct.project_id → project node
- learned_from: instinct.project_id → project node
- suggests: suggestion.instinct_id → instinct node
- used_in: events grouped by (name, session_id) → session node
```

### Step 3: Upsert Graph

All operations within a single transaction:
1. UPSERT nodes (INSERT OR REPLACE)
2. UPSERT edges (INSERT ... ON CONFLICT UPDATE weight)
3. Update `kg_sync_state.last_event_id` cursor
4. Update `kg_sync_state.last_sync_at`

## Vault Generator

**Timer**: Every 15 minutes (configurable), runs after Pass 1
**Module**: `src/op-vault-generator.js`

### Per-Project Generation

For each project in `cl_projects`:

1. Query graph: all nodes + edges where node belongs to project OR is a global tool/pattern used in project sessions
2. Generate files from templates (one per node type):
   - `index.md` — TOC with top tools, active components, key patterns, validated instincts, insights
   - `tools/{name}.md` — stats, relationships (backlinks), usage insights
   - `components/{name}.md` — description, spawn count, trigger chains
   - `patterns/{name}.md` — sequence description, occurrence count, related tools
   - `instincts/{id}.md` — pattern, confidence, evidence, related suggestions
   - `insights/cost-report.md` — aggregated cost data
   - `insights/error-patterns.md` — recurring failures
   - `insights/performance-trends.md` — degradation detection
3. SHA-256 skip: hash generated content, compare with `kg_vault_hashes`, write only if changed
4. Target directory: `{project_dir}/.claude/knowledge/`

### CLAUDE.md Integration

One-time per project (first vault generation):
1. Check if `@.claude/knowledge/index.md` already in project's CLAUDE.md
2. If not: show banner in Projects & Sync tab ("CLAUDE.md not linked — click to add @reference")
3. User clicks → API call appends `@.claude/knowledge/index.md` to end of CLAUDE.md
4. Add `.claude/knowledge/` to project's `.gitignore` if not present
5. Never modify existing CLAUDE.md content beyond appending the `@` reference
6. If project has no CLAUDE.md: skip (do not create one automatically)

### Vault File Format

All files use Obsidian-compatible markdown with `[[backlinks]]`:

```markdown
---
type: tool
total_invocations: 1247
sessions_used: 89
avg_per_session: 14.0
last_used: 2026-04-08
generated_at: 2026-04-08T10:30:00Z
---
# Read

Built-in Claude Code tool for reading files.

## Relationships
- Commonly triggers: [[tools/Edit]], [[tools/Write]]
- Triggered by: [[components/code-reviewer]]
- Co-occurs with: [[tools/Grep]], [[tools/Glob]]
- Part of: [[patterns/file-modification]]

## Usage Insights
- Peak usage in debug sessions (22/session vs 14 avg)
- 98.5% success rate
- Avg 0 cost (native tool)

## Related Instincts
- [[instincts/prefer-read-over-cat]]
```

### Backlink Convention

- `[[tools/Read]]` → resolves to `tools/Read.md` (relative path within vault)
- Compatible with Obsidian (user can open `.claude/knowledge/` as vault)
- Claude interprets `[[path]]` as "Read `.claude/knowledge/{path}.md`"

## Pass 2: LLM Enrichment

**Trigger**: On-demand (UI button) or daily timer (configurable, default off)
**Module**: `src/op-knowledge-enricher.js`
**Model**: Haiku 4.5 (cost-efficient)

### When It Runs

- Manual trigger from Open Pulse UI (per-project "Enrich" button)
- Daily timer if enabled in config
- Auto-trigger: after 50+ new events since last enrichment (configurable)

### What It Adds

Haiku receives graph context (node + neighbors + recent events) and generates:

1. **Pattern summaries**: "Read→Edit→Write is a file modification workflow, typically used when refactoring existing code"
2. **Session insights**: "Recent sessions focus heavily on API endpoint development"
3. **Recommendations**: "Consider creating a dedicated agent for the frequent debug→test cycle"
4. **Component descriptions**: Fill missing descriptions by inferring from usage context

### Storage

Enrichments stored in `kg_nodes.properties` JSON:
```json
{
  "summary": "Human-readable summary from Haiku",
  "enriched_at": "2026-04-08T10:30:00Z"
}
```

Vault generator checks: if `enriched_at` exists, use LLM summary. Otherwise, use template text. Enrichment is an overlay — never replaces deterministic data (stats, relationships).

### Cost Control

- Haiku 4.5: $0.80/M input, $4.00/M output
- Typical enrichment: ~500 tokens input, ~200 output per node
- 200 nodes ≈ 140K tokens ≈ $0.11 input + $0.80 output ≈ **~$1 per full enrichment**
- Config: `knowledge_enrich_enabled` (default false), `knowledge_enrich_interval_ms`

## Open Pulse UI

### New Module: `public/modules/knowledge.js`

**Tab 1: Graph Explorer**
- Cytoscape.js interactive graph visualization
- Filters: project, node type, search
- Click node → side panel with stats, connections, vault file link
- Color coding: green=tool, blue=component, purple=pattern, cyan=instinct
- Layouts: force-directed (default), hierarchical, concentric

**Tab 2: Projects & Sync**
- Overview cards: total projects, nodes, edges, last sync time
- Per-project rows: node/edge counts, vault file count, sync status, last sync time
- Actions per project: Sync (force Pass 1 + vault gen), Enrich (force Pass 2)

### Navigation

Add "Knowledge" entry to SPA nav bar (between "Learning" and "Settings").

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/knowledge/status` | Overall KG stats (nodes, edges, projects, last sync) |
| GET | `/api/knowledge/projects` | Per-project KG status + vault file counts |
| GET | `/api/knowledge/graph?project=&type=` | Graph data for Cytoscape.js (nodes + edges, filtered) |
| GET | `/api/knowledge/node/:id` | Single node detail + all connections |
| POST | `/api/knowledge/sync` | Force Pass 1 graph extraction |
| POST | `/api/knowledge/generate?project=` | Force vault generation (all or specific project) |
| POST | `/api/knowledge/enrich?project=` | Trigger Pass 2 Haiku enrichment |
| GET | `/api/knowledge/config` | KG-specific config values |

## New Config Keys

```json
{
  "knowledge_graph_interval_ms": 300000,
  "knowledge_vault_interval_ms": 900000,
  "knowledge_enrich_enabled": false,
  "knowledge_enrich_interval_ms": 86400000,
  "knowledge_enrich_auto_threshold": 50,
  "knowledge_pattern_min_occurrences": 5,
  "knowledge_session_lookback_days": 30,
  "knowledge_instinct_min_confidence": 0.3,
  "knowledge_vault_max_index_items": 10
}
```

## New Files

| File | Purpose |
|---|---|
| `src/op-knowledge-graph.js` | Pass 1: entity extraction + graph upsert |
| `src/op-vault-generator.js` | Vault generation: graph → .md files per project |
| `src/op-knowledge-enricher.js` | Pass 2: Haiku LLM enrichment |
| `public/modules/knowledge.js` | Frontend: Graph Explorer + Projects & Sync |
| `test/op-knowledge-graph.test.js` | Tests for graph extraction |
| `test/op-vault-generator.test.js` | Tests for vault generation |
| `test/op-knowledge-enricher.test.js` | Tests for LLM enrichment |

## Dependencies

| Package | Purpose | New? |
|---|---|---|
| `cytoscape` | Graph visualization (CDN) | Yes (frontend CDN only) |
| `cytoscape-cola` | Force-directed layout (CDN) | Yes (frontend CDN only) |
| No new npm dependencies for backend | Uses existing better-sqlite3, crypto (built-in) | — |

## Future Phases

**Phase 2: Auto-Generated Wiki** — Synthesize vault files into high-level project documentation with Mermaid diagrams. Wiki pages cover architecture overview, conventions, decision history.

**Phase 3: Natural Language Q&A** — Add FTS5 virtual table indexing vault content. Later upgrade with sqlite-vec for semantic search. Hybrid retrieval with Reciprocal Rank Fusion (RRF).

## References

- [Graphify](https://github.com/safishamsi/graphify) — Two-pass pipeline (AST + LLM), SHA-256 caching, Obsidian export
- [Graphiti](https://github.com/getzep/graphiti) — Temporal knowledge graph from event streams, bi-temporal tracking
- [simple-graph](https://github.com/dpapathanasiou/simple-graph) — SQLite graph database (2 tables, recursive CTE traversal)
- [GitNexus](https://github.com/abhigyanpatwari/GitNexus) — Hybrid search (BM25 + semantic + RRF)
- [CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) — Auto-wiki from code with Mermaid diagrams
