# Inventory Sync — Scan-and-Diff Design

## Problem

The inventory feature (skills, agents, hooks, rules) has no sync mechanism. It scans the filesystem on every API request and never persists component state. When a component is added, modified, or deleted on disk, the dashboard only reflects changes after a manual page refresh. There is no way to know when a component was first seen or last confirmed to exist.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sync strategy | Periodic (Scan-and-Diff) | Consistent with existing timer patterns (ingestion 10s, CL sync 60s). Simple, deterministic, reliable. |
| Sync interval | 60s (shared with CL sync timer) | Inventory changes are infrequent. Avoids adding a separate timer. |
| Scope | Global + plugins + project-level | Matches current API coverage. |
| Deleted components | Remove from DB, don't display | Event history preserved in `events` table but component hidden from inventory. |
| Frontend update | Poll with ETag (60s) | Only re-render when data actually changes. No WebSocket infrastructure needed. |
| Storage | New `components` DB table | Persists across restarts. Enables fast queries. Replaces per-request disk scanning. |

## Database Schema

### New table: `components`

```sql
CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  plugin TEXT,
  project TEXT,
  file_path TEXT,
  description TEXT,
  agent_class TEXT,
  hook_event TEXT,
  hook_matcher TEXT,
  hook_command TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(type, name, source, COALESCE(plugin, ''), COALESCE(project, ''))
);

CREATE INDEX IF NOT EXISTS idx_components_type ON components (type);
CREATE INDEX IF NOT EXISTS idx_components_source ON components (source);
```

### Field definitions

| Field | Type | Description |
|---|---|---|
| `type` | TEXT | `'skill'`, `'agent'`, `'hook'`, `'rule'` |
| `name` | TEXT | Component name (or qualified `plugin:name`) |
| `source` | TEXT | `'global'`, `'plugin'`, `'project'` |
| `plugin` | TEXT | Plugin name when `source = 'plugin'`, NULL otherwise |
| `project` | TEXT | Project name when `source = 'project'` or plugin scope |
| `file_path` | TEXT | Absolute path to the component file on disk |
| `description` | TEXT | Extracted from YAML frontmatter (skills, agents, rules) |
| `agent_class` | TEXT | `'configured'` or `'built-in'` (agents only) |
| `hook_event` | TEXT | `PreToolUse`, `PostToolUse`, `Stop` (hooks only) |
| `hook_matcher` | TEXT | Matcher pattern (hooks only) |
| `hook_command` | TEXT | Command string (hooks only) |
| `first_seen_at` | TEXT | ISO timestamp when first discovered |
| `last_seen_at` | TEXT | ISO timestamp when last confirmed on disk |

## Sync Logic: `syncComponents()`

Runs inside the existing CL sync timer (every 60s). Also runs once immediately on server start.

### Algorithm

```
1. SCAN disk using existing functions:
   - getKnownSkills()        → global skills
   - getKnownAgents()        → global agents
   - getKnownRules()         → global rules (+ common/)
   - getKnownHooks()         → hooks from settings.json (global + project)
   - getPluginComponents()   → plugin skills + agents
   - getProjectAgents()      → project-level agents

   Each item normalized to: { type, name, source, plugin, project, file_path, description, ... }

2. LOAD current DB state:
   SELECT * FROM components → Map keyed by (type, name, source, plugin, project)

3. DIFF:
   - added   = items on disk but not in DB
              → INSERT with first_seen_at = now, last_seen_at = now
              → Read metadata (frontmatter) for description
   - removed = items in DB but not on disk
              → DELETE from components
   - exists  = items on both disk and DB
              → UPDATE last_seen_at = now

4. COMPUTE ETag:
   - Hash from: component count + latest last_seen_at timestamp
   - Store in-memory variable for API responses
   - Note: ETag only reflects component list changes (add/delete),
     not usage count changes. This is intentional — the feature
     scope is syncing disk state, not real-time usage tracking.
```

### Composite key for comparison

`(type, name, source, COALESCE(plugin, ''), COALESCE(project, ''))`

This distinguishes same-named components from different sources (e.g., a global agent `foo` vs a plugin agent `plugin:foo`).

### Metadata reading

- Only read file frontmatter for newly added components (not on every sync cycle)
- Existing components keep their stored description
- To detect content changes in the future: add a `content_hash` column (out of scope for v1)

## API Changes

### `GET /api/inventory/:type` — Refactored

**Before**: Synchronous filesystem scan on every request, merge with event counts.

**After**:
```sql
SELECT c.*, COUNT(e.id) as count, MAX(e.timestamp) as last_used
FROM components c
LEFT JOIN events e ON e.name = c.name
  AND e.event_type = :eventType
  AND (:from IS NULL OR e.timestamp >= :from)
WHERE c.type = :type
GROUP BY c.id
ORDER BY count DESC
```

Response headers:
- `ETag: "<computed_hash>"`

Request handling:
- If `If-None-Match` header matches current ETag → return `304 Not Modified`
- Otherwise → return full response with new ETag

### `GET /api/inventory/:type/:name` — Refactored

**Before**: `readItemMetaFromFile()` on every request.

**After**: Metadata from `components` table. Invocations and triggers logic unchanged (still queries `events`).

### `GET /api/unused` — Refactored

**Before**: Separate disk scan + event query.

**After**:
```sql
SELECT c.* FROM components c
LEFT JOIN events e ON e.name = c.name
  AND e.event_type IN ('skill_invoke', 'agent_spawn')
WHERE c.type = :type
GROUP BY c.id
HAVING COUNT(e.id) = 0
```

### No new endpoints needed

All existing endpoints retain their contracts. Changes are implementation-only.

## Frontend Changes

### `inventory.js` — Polling with ETag

```
mount(period):
  1. Fetch initial data for active tab
  2. Store ETag from response header
  3. Start polling interval (60s)

poll():
  1. GET /api/inventory/:activeTab
     Header: If-None-Match: <stored_etag>
  2. If 304 → do nothing
  3. If 200 → update data, store new ETag, re-render active tab

unmount():
  1. clearInterval(pollInterval)
```

### Re-render rules

- Only re-render the currently active tab
- If user is in detail view (viewing a specific skill/agent) → skip re-render to preserve scroll position and context
- When user navigates back to list view → fetch fresh data

### No UX additions

No loading indicators, no "data updated" notifications. The tab silently shows the latest data.

## Files Modified

| File | Change |
|---|---|
| `src/op-db.js` | Add `components` table to `initDb()`. Add helper functions: `upsertComponent()`, `deleteComponent()`, `getComponentsByType()`. |
| `src/op-server.js` | Add `syncComponents()` function. Integrate into CL sync timer. Refactor `/api/inventory/:type`, `/api/inventory/:type/:name`, `/api/unused` to query `components`. Add ETag response logic. |
| `public/modules/inventory.js` | Add 60s polling with ETag. Store ETag per tab. Cleanup on unmount. |

## Files NOT modified

- `collector/op-collector.js` — no changes to event collection
- `collector/op-suggestion-analyzer.js` — no changes
- `src/op-ingest.js` — no changes to ingestion pipeline
- `public/modules/router.js` — no routing changes
- Other frontend modules — no changes

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sync timer fails | Components table becomes stale | Log error, next cycle retries. If table is empty, API can fall back to direct disk scan. |
| Slow filesystem scan | Blocks server event loop | Scan is lightweight (readdir + stat, no file content reads except for new items). Monitor with timing logs. |
| Race between sync and API | Stale data returned briefly | Acceptable — 60s window. Data is eventually consistent. |
| DB migration on existing installs | Table doesn't exist on first run | `CREATE TABLE IF NOT EXISTS` — idempotent. First sync populates all data. |

## Out of Scope

- Content change detection (file modified but name unchanged) — add `content_hash` column later if needed
- Real-time push (WebSocket/SSE) — can layer on top of this foundation later
- Rule usage tracking — rules still have no event type, shown as unused
- Component version history — only current state tracked
