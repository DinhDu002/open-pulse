# Harness Improvement Design Spec

## Overview

Improve Open Pulse as an agent harness by closing the observe→learn→act loop and simplifying the data pipeline. Two focus areas:

- **Actuation**: Unify instincts + suggestions into a single "insight" entity with auto-classification, auto-promotion, and execute mechanisms
- **Simplification**: Consolidate JSONL streams, remove mutable state files, clean break DB

## Approach

Bottom-up (Approach 2): simplify foundation first, then build unified insights on clean base.

- Phase 1: Collector simplification
- Phase 2: Unified insights entity
- Phase 3: Auto-promote pipeline
- Phase 4: Execute mechanism

---

## Phase 1: Collector Simplification

### 1.1 Merge JSONL Streams

Current state: collector writes both `events.jsonl` and `sessions.jsonl`. The `session_end` event in events.jsonl already contains all data that sessions.jsonl duplicates.

After:
- Only `events.jsonl` remains — contains all event types
- Ingest module upserts `sessions` table when encountering `event_type: "session_end"` (instead of reading from separate sessions.jsonl)
- Remove sessions.jsonl write logic from collector
- Remove sessions.jsonl read logic from ingest

### 1.2 Remove `.seq-*` Files

Current state: each session creates a `.seq-{sessionId}` file in `data/` directory, read/written on every tool call for seq_num tracking.

After:
- Use JSONL file line count as seq_num: `seq_num = existing_lines + 1`
- Count newlines without parsing JSON (fast)
- No more `.seq-*` file litter in `data/`

### 1.3 Clean Break DB

- Script `reset-db.js`: drop all tables → recreate schema → empty DB
- Run once when deploying phase 1
- Historical data is lost (accepted trade-off)

---

## Phase 2: Unified Insights Entity

### 2.1 Schema

Replace `cl_instincts` + `suggestions` with single `insights` table:

```sql
CREATE TABLE insights (
  id                TEXT PRIMARY KEY,       -- SHA-256 deterministic
  source            TEXT NOT NULL,          -- 'observer' | 'daily_analysis' | 'manual'
  category          TEXT NOT NULL,          -- 'anti_pattern' | 'workflow' | 'optimization' | 'cleanup' | 'security' | ...
  target_type       TEXT,                   -- 'rule' | 'hook' | 'skill' | 'agent' | 'knowledge' | NULL
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  confidence        REAL DEFAULT 0.3,
  observation_count INTEGER DEFAULT 1,      -- sessions where pattern appeared
  validation_count  INTEGER DEFAULT 0,
  rejection_count   INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',  -- 'active' | 'promoted' | 'executed' | 'archived' | 'reverted'
  action_data       TEXT,                   -- JSON: claude_prompt, implementation_steps, what_changes
  promoted_to       TEXT,                   -- file path of created component
  project_id        TEXT,                   -- project scope (NULL = global)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

### 2.2 Auto-Classify Logic

When insight is created (from observer or daily analysis), system classifies `target_type`:

| Signal in description/pattern | target_type |
|---|---|
| "always", "never", "must", behavioral pattern | `rule` |
| "automatically", "every time", "after X do Y", deterministic trigger | `hook` |
| Multi-step procedure, domain-specific knowledge | `skill` |
| Task delegation, needs isolation/specialization | `agent` |
| Factual, relationship, reference information | `knowledge` |

Classification pipeline:
1. Keyword matching first
2. If ambiguous → Haiku LLM classify
3. `target_type` can be NULL initially, user can override in UI

### 2.3 Unified Feedback Loop

- **Validate**: `confidence += 0.15`, `validation_count += 1`
- **Reject**: `confidence -= 0.2`, `rejection_count += 1`
- 3 rejections → `status = 'archived'`
- Observer increments `observation_count` each time same pattern detected in new session

### 2.4 Drop Old Tables

- Drop `cl_instincts` and `suggestions` tables
- Clean break — no data migration needed
- Update all API routes: `/api/instincts/*` and `/api/suggestions/*` → `/api/insights/*`
- Update frontend: merge instinct + suggestion tabs → single "Insights" tab

---

## Phase 3: Auto-Promote Pipeline

### 3.1 Promotion Threshold

Insight auto-promotes when ALL conditions met:
- `confidence >= 0.85`
- `observation_count >= 10`
- `rejection_count == 0`
- `target_type IS NOT NULL`
- `status == 'active'`

### 3.2 Promote Engine

Runs in server timer (same interval as CL sync, 60s). Each cycle:

1. Query insights meeting threshold
2. Generate component based on `target_type`:

| target_type | Action |
|---|---|
| `rule` | Create `.md` file in project's `.claude/rules/` or append to CLAUDE.md |
| `hook` | Create hook script + add entry to `settings.json` |
| `skill` | Create directory + `SKILL.md` in `.claude/skills/` |
| `agent` | Create `.md` file in `.claude/agents/` |
| `knowledge` | Create `.md` file in `.claude/knowledge/` |

3. Generation uses **Haiku** (cheap, sufficient for template-based generation)
4. Update insight: `status = 'promoted'`, `promoted_to = <file_path>`
5. Log event for tracking

### 3.3 Revert (R1)

UI displays "Revert" button for insights with `status = 'promoted'`:
- Delete component file at `promoted_to`
- If hook → remove entry from `settings.json`
- `status = 'reverted'`, `confidence -= 0.3`
- Insight cannot auto-promote again (needs user validation to rebuild confidence)

### 3.4 Notification

- Status changes in `insights` table are sufficient for UI to display
- `GET /api/insights?status=promoted&since=<timestamp>` for UI to poll new promotions

---

## Phase 4: Execute Mechanism

### 4.1 Two Execute Modes

Each insight has `action_data` containing `claude_prompt` + `implementation_steps`. When user clicks execute:

**Mode A — Auto execute (spawn Claude session)**
- Server runs `claude --model sonnet --max-turns 3 --print -p "<prompt>"`
- Output stored in `action_data.execution_result`
- `status = 'executed'`
- UI displays result for user review

**Mode B — Copy-ready**
- UI displays full prompt + implementation steps
- "Copy to clipboard" button
- User pastes into their own Claude Code session
- User clicks "Mark as executed" → `status = 'executed'`

### 4.2 Generate Prompt

When insight lacks `action_data` (e.g., from observer, only has pattern description):
- "Generate prompt" button in UI
- Server uses Haiku to generate `claude_prompt` + `implementation_steps` from insight description + target_type
- Saved to `action_data`

### 4.3 UI Flow

```
Insight card
├── [Validate] [Reject]          -- feedback loop
├── [Execute ▾]                   -- dropdown
│   ├── Auto execute (Mode A)
│   └── Copy prompt (Mode B)
├── [Generate prompt]             -- if no action_data yet
└── [Revert]                      -- only shown when status = promoted
```

### 4.4 Execute vs Promote Relationship

Execute and promote are **independent**:
- Execute: perform action now (one-time) — e.g., "create file X", "fix config Y"
- Promote: turn insight into permanent component — e.g., pattern "always lint after edit" → hook
- An insight can be execute-only (one-time action), promote-only (recurring pattern), or both

---

## Architecture After Improvement

### Data Flow

```
Collector (3 hooks)
    │
    ▼
events.jsonl (single stream, no .seq-* files)
    │
    ▼ (ingest 10s)
SQLite
├── events
├── sessions (upsert from session_end event)
├── prompts
├── components
├── insights (unified: observer + daily_analysis + manual)
├── scan_results
├── kg_nodes / kg_edges / kg_vault_hashes / kg_sync_state
└── kb_notes
    │
    ▼ (CL sync 60s)
Observer (Haiku) ──→ insights (source: observer)
    │
    ▼ (daily 3AM)
Suggestion agent (Opus) ──→ insights (source: daily_analysis)
    │
    ▼ (promote check 60s)
Auto-promote engine
├── confidence >= 0.85 + observations >= 10 + 0 reject
├── → generate component (rule/hook/skill/agent/knowledge)
└── → status = 'promoted', promoted_to = <path>
    │
    ▼ (user action)
Execute mechanism
├── Mode A: spawn claude session
└── Mode B: copy-ready prompt
```

### API Changes

| Remove | Replace with |
|---|---|
| `GET /api/instincts` | `GET /api/insights?source=observer` |
| `GET /api/instincts/projects` | `GET /api/insights/projects` |
| `POST /api/instincts/sync` | `POST /api/insights/sync` |
| `PUT /api/instincts/:id/validate` | `PUT /api/insights/:id/validate` |
| `PUT /api/instincts/:id/reject` | `PUT /api/insights/:id/reject` |
| `GET /api/suggestions` | `GET /api/insights?source=daily_analysis` |
| `POST /api/suggestions/analyze` | `POST /api/insights/analyze` |
| `PUT /api/suggestions/:id/approve` | _(removed — use validate)_ |
| `PUT /api/suggestions/:id/dismiss` | _(removed — use reject)_ |
| — | `POST /api/insights/:id/execute` **(new)** |
| — | `POST /api/insights/:id/generate-prompt` **(new)** |
| — | `PUT /api/insights/:id/revert` **(new)** |

### Frontend Changes

- Remove `learning-suggestions.js`
- Merge instinct + suggestion UI → single module `learning.js` with "Insights" tab
- Filter bar: source (all/observer/daily_analysis), status (active/promoted/executed/archived/reverted), target_type
- Insight card: validate/reject, execute dropdown, generate prompt, revert

### Out of Scope

- Knowledge graph pipeline (unchanged)
- Scan results (unchanged)
- Dashboard, sessions, inventory, prompts, settings (unchanged)
- Observer agent logic (only changes output: writes insight instead of instinct)
- Suggestion agent logic (only changes output: writes insight instead of suggestion)
- Intelligence improvements (group B — deferred)
