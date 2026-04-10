# Inventory Per-Project Counting

**Date**: 2026-04-10
**Status**: Draft

## Problem

The inventory page has two issues:

1. **Duplicate entries**: Agents defined in multiple projects (e.g., `security-reviewer` in global + carthings + travelize) appear as separate rows, each showing the same total count. This is misleading.

2. **No per-project breakdown**: Events already record `working_directory`, but the inventory API ignores it. Users cannot see which project a skill/agent was used in.

## Approach

Add a `project_name` column to the `events` table. Populate it at ingest time by resolving `working_directory` → `cl_projects.name`. Backfill existing data. Deduplicate the inventory list by component name. Add project filtering and per-project breakdown.

## Design

### 1. Schema Migration

In `initDb()` (op-db.js), following existing migration pattern:

```sql
ALTER TABLE events ADD COLUMN project_name TEXT;
CREATE INDEX idx_events_project ON events(project_name);
```

Backfill logic (JS, in migration block):
- For each event with `working_directory IS NOT NULL AND project_name IS NULL`:
  - Exact match: `SELECT name FROM cl_projects WHERE directory = working_directory`
  - Fallback: `path.basename(working_directory)`

### 2. Ingest Pipeline

**op-ingest.js** — `processContent()`:
- After `normaliseEvent()`, before `insertEventBatch()`, derive `project_name` for each event
- Helper: `resolveProjectName(db, workDir)` → exact match cl_projects → fallback `path.basename(workDir)`

**db/events.js** — `insertEvent()`, `insertEventBatch()`, `withEventDefaults()`:
- Add `project_name` to INSERT statements and defaults

**op-ingest.js** — `normaliseEvent()`:
- Add `project_name: null` to normalized fields

### 3. API — Projects Endpoint

New endpoint: `GET /api/projects`

Returns deduplicated list of project names from `cl_projects` UNION DISTINCT `project_name` from events.

```json
[
  { "name": "open-pulse", "directory": "/Users/du/Workspace/open-pulse" },
  { "name": "carthings-workspace", "directory": "/Users/du/Workspace/carthings-workspace" }
]
```

### 4. API — Inventory List

**`GET /api/inventory/:type`**

Changes:
- Accept `?project=` query param
- When `project` is set: filter events by `project_name = @project`
- Deduplicate components by name: merge entries with same name, `project` field (string) → `projects` field (array of where component is defined)
- Built-in agents (from events, not in components table) continue to be added as before

Response shape change:
```json
{
  "name": "security-reviewer",
  "count": 5,
  "last_used": "2026-04-10T05:00:00Z",
  "status": "active",
  "origin": "custom",
  "projects": ["global", "carthings-workspace", "travelize-workspace"],
  "plugin": null,
  "agent_class": "configured"
}
```

Field rename: `project` (string) → `projects` (string array).

### 5. API — Inventory Detail

**`GET /api/inventory/:type/:name`**

Changes:
- Accept `?project=` query param — when set, filter `invocations` and `triggers` by project
- Add `by_project` array — always returns full breakdown regardless of filter

Response shape addition:
```json
{
  "name": "brainstorming",
  "total": 12,
  "by_project": [
    { "project": "open-pulse", "count": 7, "last_used": "..." },
    { "project": "carthings-workspace", "count": 5, "last_used": "..." }
  ],
  "invocations": [...],
  "triggers": [...]
}
```

### 6. Frontend — Inventory List

**Project dropdown filter**:
- Position: right side of tab bar, inline with Skills/Agents tabs
- Data source: `GET /api/projects`
- Default: "All Projects" (no filter)
- On change: reload current tab with `?project=xxx`

**List table changes**:
- `Project` column: render multi-badge from `projects` array (was single badge from `project` string)
- No more duplicate rows for same-name components

### 7. Frontend — Inventory Detail

**"Usage by Project" card**:
- Position: between Triggers card and Invocations card
- Layout: simple list — project name, count, percentage bar
- Data source: `by_project` field from detail API

## Files to Modify

| File | Change |
|------|--------|
| `src/op-db.js` | Migration: add `project_name` column + index + backfill |
| `src/op-ingest.js` | Derive `project_name` at ingest time |
| `src/db/events.js` | Add `project_name` to INSERT + defaults |
| `src/routes/inventory.js` | Dedup components, `?project=` filter, `by_project` breakdown |
| `src/routes/core.js` | Add `GET /api/projects` endpoint |
| `public/modules/inventory.js` | Project dropdown, multi-badge projects, Usage by Project card |

## Test Plan

- [ ] Migration adds column and backfills existing events correctly
- [ ] New events get `project_name` populated at ingest
- [ ] Events with unknown `working_directory` use basename fallback
- [ ] `GET /api/projects` returns correct list
- [ ] `GET /api/inventory/agents` no longer has duplicate entries
- [ ] `GET /api/inventory/agents?project=open-pulse` filters by project
- [ ] `GET /api/inventory/agents/:name` includes `by_project` breakdown
- [ ] Detail `?project=` filter scopes invocations and triggers
- [ ] Frontend dropdown loads projects and filters correctly
- [ ] Frontend detail shows "Usage by Project" card
- [ ] Existing tests still pass after migration
