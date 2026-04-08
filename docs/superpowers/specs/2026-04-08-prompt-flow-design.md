# Prompt Flow Manager — Design Spec

Feature to browse user prompts and visualize Claude's workflow per prompt.

## Summary

- **New page** `#prompts`: searchable, filterable list of all user prompts with card layout
- **New page** `#prompts/{id}`: prompt detail with expandable flow timeline
- **Session detail** `#sessions/{id}`: events grouped under prompt headers instead of flat timeline
- **New table** `prompts`: first-class entity with pre-aggregated stats
- **Backfill script**: migrates existing events to the new schema

## Data Model

### New table: `prompts`

```sql
CREATE TABLE prompts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  prompt_text     TEXT    NOT NULL,
  seq_start       INTEGER NOT NULL,
  seq_end         INTEGER,
  timestamp       TEXT    NOT NULL,
  event_count     INTEGER DEFAULT 0,
  total_cost_usd  REAL    DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX idx_prompts_session ON prompts(session_id);
CREATE INDEX idx_prompts_timestamp ON prompts(timestamp);
```

### Alter table: `events`

```sql
ALTER TABLE events ADD COLUMN prompt_id INTEGER REFERENCES prompts(id);
CREATE INDEX idx_events_prompt ON events(prompt_id);
```

The existing `user_prompt` column on `events` is kept for backward compatibility.

### Field descriptions

| Field | Purpose |
|---|---|
| `seq_start` / `seq_end` | Event range within session — disambiguates when same prompt text appears twice |
| `event_count` | Pre-aggregated count, incremented on each event insert |
| `total_cost_usd` | Pre-aggregated cost sum |
| `duration_ms` | Last event timestamp minus prompt timestamp |
| `prompt_id` (on events) | FK back-link for `SELECT * FROM events WHERE prompt_id = ?` |

## Ingestion Changes

Modified flow in `op-ingest.js` when inserting an event with `user_prompt`:

1. Find current prompt: `SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT 1`
2. If no prompt record exists OR `prompt_text !== event.user_prompt`:
   - `INSERT INTO prompts` with session_id, prompt_text, seq_start, timestamp
   - Use new `prompt_id`
3. If `prompt_text` matches current prompt:
   - Reuse existing `prompt_id`
4. Insert event with `prompt_id`
5. Update prompt: `SET seq_end, event_count = event_count + 1, total_cost_usd += cost, duration_ms = now - timestamp`

### Edge cases

| Case | Behavior |
|---|---|
| Event with NULL `user_prompt` | `prompt_id = NULL`, no prompt record created |
| `session_end` event | `prompt_id = NULL` (session-level, not prompt-scoped) |
| Same prompt text consecutively | Grouped into same prompt record |
| Same prompt text non-consecutively | New prompt record (different `seq_start`) |

## API Endpoints

### GET `/api/prompts`

List prompts with filtering, search, and pagination.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `period` | string | `7d` | Time filter: `24h`, `7d`, `30d`, `90d` |
| `q` | string | — | Text search on `prompt_text` (LIKE %q%) |
| `session_id` | string | — | Filter by session |
| `project` | string | — | Filter by project (matched against `sessions.working_directory`) |
| `page` | integer | 1 | Page number |
| `per_page` | integer | 20 | Items per page (max 50) |

**Response:**

```json
{
  "prompts": [
    {
      "id": 1,
      "session_id": "uuid",
      "prompt_text": "hãy thêm tính năng auth...",
      "timestamp": "2026-04-08T10:32:00Z",
      "event_count": 12,
      "total_cost_usd": 0.45,
      "duration_ms": 150000,
      "project": "open-pulse",
      "event_breakdown": {
        "tool_call": 8,
        "skill_invoke": 2,
        "agent_spawn": 2
      }
    }
  ],
  "total": 156,
  "page": 1,
  "per_page": 20
}
```

The `project` field is derived from `basename(sessions.working_directory)`. The `event_breakdown` is computed via a joined GROUP BY query per page.

### GET `/api/prompts/:id`

Prompt detail with full event list.

**Response:**

```json
{
  "prompt": {
    "id": 1,
    "session_id": "uuid",
    "prompt_text": "hãy thêm tính năng auth...",
    "timestamp": "2026-04-08T10:32:00Z",
    "event_count": 12,
    "total_cost_usd": 0.45,
    "duration_ms": 150000,
    "project": "open-pulse"
  },
  "events": [
    {
      "id": 101,
      "event_type": "tool_call",
      "name": "Read",
      "detail": "src/server.js",
      "timestamp": "2026-04-08T10:32:05Z",
      "duration_ms": 120,
      "success": 1,
      "estimated_cost_usd": 0.01,
      "tool_input": "{...}",
      "tool_response": "{...}"
    }
  ]
}
```

Events are ordered by `seq_num ASC`. The `tool_input` and `tool_response` fields are included for the expandable detail view (may be NULL for warm/cold retention events).

## Frontend

### New module: `public/modules/prompts.js`

Two views controlled by route params:

#### List view (`#prompts`)

- **Filter bar**: search input + project dropdown + session dropdown
- **Summary cards**: total prompts, total events, total cost (for current filter)
- **Prompt cards**: each card shows prompt_text, metadata (project, time, duration, cost), event type badges (colored pills with counts)
- **Pagination**: prev/next + page numbers
- **Click card** → navigate to `#prompts/{id}`

#### Detail view (`#prompts/{id}`)

- **Header**: back link, prompt text, metadata (project, session link, time, duration, cost, event count)
- **Flow timeline**: numbered list of events
  - Each row: sequence number, colored dot (by event type), tool name, detail, duration, success indicator
  - Click row to expand/collapse: shows `tool_input` and `tool_response` in formatted panels
  - Color scheme: green (Read/Glob), blue (Edit/Write), purple (Agent), yellow (Bash), cyan (Grep/Search), pink (Skill)

### Modified module: `public/modules/sessions.js`

Session detail changes from flat timeline to grouped view:

- Events grouped under prompt headers (prompt text + stats badge)
- Each prompt group is collapsible (default expanded)
- Click prompt header → navigate to `#prompts/{id}`
- Events with NULL `prompt_id` shown at bottom under "Other events" group
- Session stats cards remain unchanged at top

### Router changes (`public/modules/router.js`)

Add routes:
- `#prompts` → `prompts.js` (list view)
- `#prompts/{id}` → `prompts.js` (detail view, `params = { id }`)

### Navigation (`public/index.html`)

Add "Prompts" link in nav bar (between Dashboard and Sessions).

## Backfill Script

`scripts/op-backfill-prompts.js` — one-time migration for existing data.

### Algorithm

1. Query events ordered by `session_id, seq_num` (batch by session)
2. Walk events sequentially; when `user_prompt` changes → create new prompt record
3. Update `event.prompt_id` for each event in the group
4. Update prompt stats (event_count, total_cost_usd, duration_ms, seq_end)
5. Run in transaction per session for atomicity
6. Log progress: `Backfilled session X (N prompts, M events)`

### Properties

- **Idempotent**: skips events that already have `prompt_id`
- **Auto-run**: `op-install.sh` runs backfill if `prompts` table is empty
- **Safe to re-run**: no duplicate prompt records created

## Event Type Color Scheme

| Event Type | Tools | Color |
|---|---|---|
| Read | Read, Glob | Green (#56d364) |
| Search | Grep | Cyan (#58a6ff) |
| Edit | Edit, Write | Blue (#6e9eff) |
| Execute | Bash | Yellow (#d29922) |
| Agent | Agent | Purple (#d2a8ff) |
| Skill | Skill | Pink (#f778ba) |
