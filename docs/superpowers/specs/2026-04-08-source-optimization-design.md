# Open Pulse — Source Optimization Design

**Date:** 2026-04-08
**Goal:** Improve maintainability, performance, and reliability across the entire codebase
**Approach:** Hybrid — 5 phases ordered by risk/impact, each independently shippable
**Breaking changes:** Allowed (no backward-compatibility requirement)

## Constraints

- Frontend stays vanilla JS (no framework)
- Each phase produces a working, testable state
- Existing 231 tests must stay green throughout

---

## Phase 1: Extract Shared Frontend Utils

**Problem:** 6 utility functions duplicated across 4+ frontend modules (~90 lines wasted).

**Solution:** Create `public/modules/utils.js` exporting shared functions. Each consuming module imports from utils, removes local definition.

### Functions to extract

| Function | Source files | Notes |
|----------|-------------|-------|
| `escHtml(str)` | learning-instincts, learning-suggestions, learning-projects, knowledge | 4 identical copies |
| `confColor(c)` | learning-instincts, learning-suggestions | Identical |
| `confidenceBarHtml(conf)` | learning-instincts, learning-suggestions | Identical, depends on confColor |
| `fmtDate(ts)` | learning-instincts, learning-suggestions, learning-projects | Identical, uses dayjs |
| `fmtDateShort(ts)` | learning-projects | Single source, move for reuse |
| `truncate(str, len)` | learning-projects, prompts | Identical |
| `debounce(fn, delay)` | knowledge | Single source, move for reuse |
| `confLabel(c)` | learning-instincts | Single source, move for reuse |

### Affected files

- `public/modules/learning-instincts.js` — remove escHtml, confColor, confidenceBarHtml, fmtDate, confLabel
- `public/modules/learning-suggestions.js` — remove escHtml, confColor, confidenceBarHtml, fmtDate
- `public/modules/learning-projects.js` — remove escHtml, fmtDate, fmtDateShort, truncate
- `public/modules/knowledge.js` — remove escHtml, debounce
- `public/modules/prompts.js` — remove truncate

---

## Phase 2: Split `op-server.js` (1,753 → ~6 files)

**Problem:** God object with 52 routes, 22 helpers, 5 sync functions, 5 timers in one file.

**Solution:** Extract into Fastify plugin route files, helper module, and sync module.

### Target structure

```
src/
├── op-server.js          (~250 lines) — buildApp(), config, timers, plugin registration
├── routes/
│   ├── core.js           (~200 lines) — health, overview, events, sessions, prompts, rankings, cost, errors, rules, unused
│   ├── inventory.js      (~200 lines) — /api/inventory/:type, /api/inventory/:type/:name
│   ├── instincts.js      (~250 lines) — /api/instincts/* (CRUD, validate, reject, translate)
│   ├── suggestions.js    (~120 lines) — /api/suggestions/* (query, analyze, approve, dismiss, translate)
│   └── knowledge.js      (~250 lines) — /api/knowledge/* (graph, vault, enrich, notes, autocomplete, discover)
├── op-helpers.js         (~200 lines) — shared helpers (see below)
├── op-sync.js            (~120 lines) — sync functions + runScan
```

### Route file pattern

```js
// routes/instincts.js
module.exports = async function instinctRoutes(app, { db, helpers }) {
  app.get('/api/instincts', async (req, reply) => { ... });
  app.put('/api/instincts/:id/validate', async (req, reply) => { ... });
  // ...
};
```

### Registration in op-server.js

```js
const helpers = require('./op-helpers');
app.register(require('./routes/core'), { db, helpers });
app.register(require('./routes/inventory'), { db, helpers });
app.register(require('./routes/instincts'), { db, helpers });
app.register(require('./routes/suggestions'), { db, helpers });
app.register(require('./routes/knowledge'), { db, helpers });
```

### Helper functions → `op-helpers.js`

`periodToDate`, `parseFrontmatter`, `extractKeywordsFromPrompts`, `parseQualifiedName`, `getInstalledPlugins`, `getKnownProjectPaths`, `getPluginComponents`, `getProjectAgents`, `readItemMetaFromFile`, `readItemMeta`, `getKnownSkills`, `getKnownAgents`, `getKnownRules`, `parseHooksFromSettings`, `getKnownHooks`, `isGitRepo`, `errorReply` (new, Phase 5)

### Sync functions → `op-sync.js`

`syncProjectsToDb`, `syncInstinctsToDb`, `syncAll`, `syncComponentsWithDb`, `runScan`

### What stays in `op-server.js`

- `loadConfig()` (used only in buildApp)
- `buildApp(opts)` factory
- Timer setup (5 setIntervals)
- `onClose` cleanup
- Fastify static plugin registration

---

## Phase 3: Split `op-db.js` (1,083 → ~6 files)

**Problem:** All database operations in one file. Schema changes require navigating 1000+ lines.

**Solution:** Split by domain, keep `op-db.js` as re-export facade.

### Target structure

```
src/
├── op-db.js              (~180 lines) — createDb(), schema, migrations, re-exports all
├── db/
│   ├── events.js         (~120 lines) — event insert/batch, withEventDefaults
│   ├── sessions.js       (~80 lines)  — session upsert/batch, updateSessionEnd
│   ├── instincts.js      (~200 lines) — instinct CRUD, filtered query, stats, sort presets
│   ├── suggestions.js    (~100 lines) — suggestion CRUD, status, withSuggestionDefaults
│   ├── knowledge.js      (~250 lines) — KG nodes/edges/queries/vault/state + KB notes
│   └── components.js     (~100 lines) — components, scanner, projects, learning, errors
```

### Re-export facade

```js
// op-db.js
const events = require('./db/events');
const sessions = require('./db/sessions');
const instincts = require('./db/instincts');
const suggestions = require('./db/suggestions');
const knowledge = require('./db/knowledge');
const components = require('./db/components');

module.exports = {
  createDb,
  ...events, ...sessions, ...instincts,
  ...suggestions, ...knowledge, ...components,
};
```

### Consolidate raw queries

Move inline `db.prepare()` calls from route handlers into proper db functions:

| New function | Replaces raw queries in |
|-------------|------------------------|
| `getOverviewStats(db, since)` | `GET /api/overview` (5 raw queries) |
| `getEventsFiltered(db, filters)` | `GET /api/events` |
| `getSessionsFiltered(db, filters)` | `GET /api/sessions`, `GET /api/sessions/:id` |
| `getPromptsFiltered(db, filters)` | `GET /api/prompts`, `GET /api/prompts/:id` |
| `getRankings(db, category, since)` | `GET /api/rankings/:category` |
| `getCostBreakdown(db, groupBy, since)` | `GET /api/cost` |
| `getProjectsWithStats(db)` | `GET /api/instincts/projects` |

---

## Phase 4: Performance Fixes

### 4a. Fix N+1 in inventory detail

**Current:** `GET /api/inventory/:type/:name` loops each invocation with 2× `.get()` calls.
For 1000 invocations → 2000+ queries.

**Fix:** Single batch query using window functions or CTEs to find nearest preceding/following skill_invoke or agent_spawn events per invocation.

```sql
WITH inv AS (
  SELECT rowid, session_id, timestamp, seq_num
  FROM events WHERE name = ? AND event_type = ? AND timestamp >= ?
)
SELECT i.rowid AS inv_rowid,
       e.name, e.event_type, e.timestamp,
       CASE WHEN e.seq_num < i.seq_num THEN 'triggered_by' ELSE 'triggers' END AS role
FROM inv i
JOIN events e ON e.session_id = i.session_id
  AND e.event_type IN ('skill_invoke', 'agent_spawn')
  AND e.rowid != i.rowid
  AND abs(e.seq_num - i.seq_num) = (
    SELECT min(abs(e2.seq_num - i.seq_num))
    FROM events e2
    WHERE e2.session_id = i.session_id
      AND e2.event_type IN ('skill_invoke', 'agent_spawn')
      AND e2.rowid != i.rowid
      AND CASE WHEN e.seq_num < i.seq_num
               THEN e2.seq_num < i.seq_num
               ELSE e2.seq_num > i.seq_num END
  )
```

Exact SQL will be refined during implementation based on SQLite query plan analysis.

### 4b. Add pagination to unbounded endpoints

| Endpoint | Current | After |
|----------|---------|-------|
| `GET /api/rules` | Returns all | `{ data, total, page, per_page }` (default per_page=50) |
| `GET /api/unused` | Returns all | `{ data, total, page, per_page }` (default per_page=50) |
| `GET /api/knowledge/autocomplete` | Hardcoded `.slice(0, 20)` | `?limit=` param (default 20, max 50) |

Response shape changes from array to object — breaking change accepted.

### 4c. Smart sync with change detection

| Timer | Current | Optimization |
|-------|---------|-------------|
| CL sync (60s) | Full scan every minute | Check `mtime` of `projects.json` + instinct dirs before scanning |
| Knowledge graph (5m) | Full sync | Compare `getKgSyncState('last_event_id')` vs max event id — skip if no new events |
| Vault generation (15m) | Generate all | Check content hash via existing `upsertKgVaultHash` — skip unchanged projects |
| Ingest (10s) | Scan data dir | Keep as-is (hot path) |
| Retention (24h) | Daily cleanup | Keep as-is (runs once/day) |

---

## Phase 5: Error Handling + Test Coverage

### 5a. Consistent error handling

Add `errorReply(reply, code, message)` helper to `op-helpers.js`. Register Fastify global error handler in `buildApp()`:

```js
app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  reply.code(500).send({ error: 'Internal server error' });
});
```

Replace 22+ bare `reply.code(500).send(...)` patterns across route files.

### 5b. Input validation at system boundary

- Clamp `page`/`per_page` with `Math.max`/`Math.min` on all paginated endpoints
- Validate `period` format: regex `^\d+[dwmy]$`
- Validate inventory `type` enum: `skills|agents|hooks|rules`
- No deep validation of internal code — trust framework and internal functions

### 5c. New tests (~43 tests)

| Area | Count | Method |
|------|-------|--------|
| Route integration (health, overview, inventory, instincts, suggestions) | ~15 | `app.inject()` |
| Error paths (invalid params, missing records, malformed input) | ~8 | `app.inject()` with bad input |
| Pagination clamping (boundary values) | ~5 | Unit test on clamp logic |
| op-helpers.js (periodToDate, parseQualifiedName, parseFrontmatter, etc.) | ~10 | Unit tests |
| op-sync.js (syncProjectsToDb, syncComponentsWithDb) | ~5 | Unit tests with temp dirs |

Target: 231 → ~274 tests. No frontend tests this round.

---

## Execution Order

```
Phase 1 (low risk)  →  Phase 2 (medium risk)  →  Phase 3 (medium risk)  →  Phase 4 (low risk)  →  Phase 5 (low risk)
   frontend utils         split server              split db                 performance            error + tests
```

Each phase: implement → run full test suite → commit. If any phase breaks tests, fix before proceeding.

## Out of Scope

- Frontend framework migration
- Authentication/authorization
- Frontend test coverage
- Database migration tooling
- CI/CD pipeline changes
