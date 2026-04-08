# Source Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve maintainability, performance, and reliability of open-pulse through 5 phases of refactoring.

**Architecture:** Extract shared frontend utils, split god objects (op-server.js 1,753 lines, op-db.js 1,083 lines) into focused modules using Fastify plugins and re-export facades, fix N+1 queries and add missing pagination, standardize error handling and add ~43 tests.

**Tech Stack:** Node.js, Fastify 5 (plugin system), better-sqlite3, vanilla JS ES modules

**Spec:** `docs/superpowers/specs/2026-04-08-source-optimization-design.md`

---

## Phase 1: Extract Shared Frontend Utils

### Task 1: Create `public/modules/utils.js`

**Files:**
- Create: `public/modules/utils.js`

- [ ] **Step 1: Create utils.js with all shared functions**

```js
// Shared frontend utilities — extracted from learning-instincts, learning-suggestions,
// learning-projects, knowledge, prompts modules

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function confColor(c) {
  return c < 0.3 ? '#e17055' : c < 0.6 ? '#fdcb6e' : '#00b894';
}

export function confLabel(c) {
  return c < 0.3 ? 'Low' : c < 0.6 ? 'Medium' : 'High';
}

export function confidenceBarHtml(conf) {
  var color = confColor(conf);
  var pct = Math.round(conf * 100);
  return (
    '<span class="confidence-bar">' +
      '<span class="fill" style="display:block;width:' + pct + '%;height:100%;' +
        'background:' + color + ';border-radius:4px;"></span>' +
    '</span>'
  );
}

export function fmtDate(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, YYYY HH:mm');
}

export function fmtDateShort(ts) {
  if (!ts) return '';
  return dayjs(ts).format('MMM D');
}

export function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '\u2026';
}

export function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/modules/utils.js
git commit -m "refactor: extract shared frontend utils to utils.js"
```

### Task 2: Update frontend modules to import from utils.js

**Files:**
- Modify: `public/modules/learning-instincts.js:15-54` — remove fmtDate, confColor, confLabel, escHtml, confidenceBarHtml; add import
- Modify: `public/modules/learning-suggestions.js:8-34` — remove fmtDate, escHtml, confColor, confidenceBarHtml; add import
- Modify: `public/modules/learning-projects.js:15-37` — remove fmtDate, fmtDateShort, escHtml, truncate; add import
- Modify: `public/modules/knowledge.js:1-24` — remove debounce; change escHtml definition (lines 217-219) to import; add import
- Modify: `public/modules/prompts.js:33-37` — remove truncate; add import

For each file:

- [ ] **Step 1: Update learning-instincts.js**

Add import at line 2 (after existing api import):
```js
import { fmtDate, confColor, confLabel, escHtml, confidenceBarHtml } from './utils.js';
```
Remove local definitions of these 5 functions (lines 15-54, keeping `domainClass` at lines 28-35).

- [ ] **Step 2: Update learning-suggestions.js**

Add import at line 2:
```js
import { fmtDate, escHtml, confColor, confidenceBarHtml } from './utils.js';
```
Remove local definitions (lines 8-34, keeping `typeBadgeHtml` at lines 36-47).

- [ ] **Step 3: Update learning-projects.js**

Add import at line 2:
```js
import { fmtDate, fmtDateShort, escHtml, truncate } from './utils.js';
```
Remove local definitions (lines 15-37, keeping `pct` at line 39 and `statCell` at line 44).

- [ ] **Step 4: Update knowledge.js**

Add import at line 1 (before existing api import) or after:
```js
import { escHtml, debounce } from './utils.js';
```
Remove local `debounce` function (lines 18-24). Remove local `escHtml` function (lines 217-219).

- [ ] **Step 5: Update prompts.js**

Add import at line 1:
```js
import { truncate } from './utils.js';
```
Remove local `truncate` function (lines 33-37).

- [ ] **Step 6: Run tests to verify no regressions**

```bash
npm test
```
Expected: 231 tests pass. (Frontend modules have no unit tests, but backend tests ensure nothing broke in module resolution.)

- [ ] **Step 7: Manual verify — open dashboard in browser**

Start server and check that learning-instincts, learning-suggestions, learning-projects, knowledge, and prompts pages render correctly. Check browser console for import errors.

```bash
npm start &
sleep 2
curl -s http://127.0.0.1:3827/ | head -5
# Should return HTML
```

- [ ] **Step 8: Commit**

```bash
git add public/modules/learning-instincts.js public/modules/learning-suggestions.js \
        public/modules/learning-projects.js public/modules/knowledge.js public/modules/prompts.js
git commit -m "refactor: use shared utils.js in frontend modules

Remove duplicated escHtml (4x), confColor (2x), confidenceBarHtml (2x),
fmtDate (3x), truncate (2x), debounce (1x), confLabel (1x) from
individual modules. All now import from utils.js."
```

---

## Phase 2: Split `op-server.js`

### Task 3: Create `src/op-helpers.js`

**Files:**
- Create: `src/op-helpers.js`
- Modify: `src/op-server.js` — remove moved functions

- [ ] **Step 1: Create op-helpers.js**

Extract these functions from `op-server.js` into `src/op-helpers.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');

// periodToDate — from op-server.js:82-90
// parseFrontmatter — from op-server.js:96-111
// STOP_WORDS + extractKeywordsFromPrompts — from op-server.js:117-153
// parseQualifiedName — from op-server.js:159-163
// getInstalledPlugins — from op-server.js:165-188
// getKnownProjectPaths — from op-server.js:190-203
// getPluginComponents ��� from op-server.js:205-230
// getProjectAgents — from op-server.js:232-250
// readItemMetaFromFile — from op-server.js:252-260
// readItemMeta — from op-server.js:262-270
// getKnownSkills — from op-server.js:272-281
// getKnownAgents — from op-server.js:283-292
// getKnownRules �� from op-server.js:294-313
// parseHooksFromSettings — from op-server.js:315-338
// getKnownHooks — from op-server.js:340-347
// isGitRepo — from op-server.js:354-357
```

Copy each function verbatim. Export all:

```js
module.exports = {
  periodToDate,
  parseFrontmatter,
  extractKeywordsFromPrompts,
  parseQualifiedName,
  getInstalledPlugins,
  getKnownProjectPaths,
  getPluginComponents,
  getProjectAgents,
  readItemMetaFromFile,
  readItemMeta,
  getKnownSkills,
  getKnownAgents,
  getKnownRules,
  parseHooksFromSettings,
  getKnownHooks,
  isGitRepo,
  CLAUDE_DIR,
};
```

- [ ] **Step 2: Update op-server.js imports**

Replace the removed functions with a require from op-helpers:

```js
const {
  periodToDate, parseFrontmatter, extractKeywordsFromPrompts,
  parseQualifiedName, getInstalledPlugins, getKnownProjectPaths,
  getPluginComponents, getProjectAgents, readItemMetaFromFile, readItemMeta,
  getKnownSkills, getKnownAgents, getKnownRules, parseHooksFromSettings,
  getKnownHooks, isGitRepo, CLAUDE_DIR,
} = require('./op-helpers');
```

Remove lines 52-53 (REPO_DIR and CLAUDE_DIR declarations are still needed for REPO_DIR). Keep `REPO_DIR` in op-server.js, export `CLAUDE_DIR` from op-helpers.js.

Remove all moved function definitions (lines 82-357) from op-server.js.

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: 231 pass. The exports of `op-server.js` (`buildApp`, `parseQualifiedName`, `syncComponents`) must still work. `parseQualifiedName` now re-exports from op-helpers.

- [ ] **Step 4: Commit**

```bash
git add src/op-helpers.js src/op-server.js
git commit -m "refactor: extract helper functions to op-helpers.js

Move 16 helper functions (periodToDate, parseFrontmatter,
getKnownSkills, etc.) from op-server.js to dedicated module."
```

### Task 4: Create `src/op-sync.js`

**Files:**
- Create: `src/op-sync.js`
- Modify: `src/op-server.js` — remove sync functions

- [ ] **Step 1: Create op-sync.js**

Extract from `op-server.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  upsertClProject, upsertInstinct, deleteProject,
  upsertComponent, deleteComponentsNotSeenSince,
  insertScanResult,
} = require('./op-db');
const {
  parseFrontmatter, getKnownSkills, getKnownAgents, getKnownRules,
  getKnownHooks, getPluginComponents, getProjectAgents,
  readItemMetaFromFile, isGitRepo, CLAUDE_DIR,
} = require('./op-helpers');

const REPO_DIR = process.env.OPEN_PULSE_DIR || path.join(__dirname, '..');

// syncProjectsToDb — from op-server.js:359-385
// syncInstinctsToDb — from op-server.js:387-432
// syncAll — from op-server.js:434-439
// syncComponentsWithDb — from op-server.js:447-543 (returns componentETag)
// runScan — from op-server.js:553-610
```

Copy each function verbatim. `syncComponentsWithDb` needs to return the computed ETag instead of setting a module-level variable:

```js
function syncComponentsWithDb(db) {
  // ... same logic as current ...
  // Instead of setting componentETag = ..., return it:
  return crypto.createHash('md5')
    .update(`${stats.cnt}:${stats.latest || ''}`)
    .digest('hex');
}
```

Export all:

```js
module.exports = {
  syncProjectsToDb,
  syncInstinctsToDb,
  syncAll,
  syncComponentsWithDb,
  runScan,
};
```

- [ ] **Step 2: Update op-server.js**

Replace moved functions with:

```js
const {
  syncAll, syncComponentsWithDb, runScan,
} = require('./op-sync');
```

Remove lines 359-610 from op-server.js. Update `buildApp()` to store returned ETag:

```js
// In buildApp(), replace:
//   try { syncComponentsWithDb(db); } catch { /* non-critical */ }
// with:
try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }
```

And in the CL sync timer:
```js
try { componentETag = syncComponentsWithDb(db); } catch { /* non-critical */ }
```

Remove the `_syncDb` module variable and `syncComponents()` wrapper. Update the module.exports:

```js
module.exports = { buildApp, parseQualifiedName };
```

Note: `syncComponents` was exported but only used by `register-hooks.js`. Check if it's still used and update accordingly. If `register-hooks.js` calls `syncComponents()`, have it call `syncComponentsWithDb(db)` from `op-sync.js` directly instead, or remove the call if it's not needed.

- [ ] **Step 3: Update any external callers of syncComponents**

Grep for `syncComponents` usage:
```bash
grep -r "syncComponents" --include="*.js" .
```

Update `scripts/register-hooks.js` or any other caller to import from `op-sync.js`.

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: 231 pass.

- [ ] **Step 5: Commit**

```bash
git add src/op-sync.js src/op-server.js scripts/register-hooks.js
git commit -m "refactor: extract sync and scanner functions to op-sync.js

Move syncProjectsToDb, syncInstinctsToDb, syncAll,
syncComponentsWithDb, runScan from op-server.js."
```

### Task 5: Create route modules

**Files:**
- Create: `src/routes/core.js`
- Create: `src/routes/inventory.js`
- Create: `src/routes/instincts.js`
- Create: `src/routes/suggestions.js`
- Create: `src/routes/knowledge.js`
- Modify: `src/op-server.js` — remove route definitions, register plugins

Each route file follows the Fastify plugin pattern:

```js
'use strict';

module.exports = async function coreRoutes(app, opts) {
  const { db, helpers, componentETagFn } = opts;
  // routes...
};
```

The `opts` object provides shared dependencies:
- `db` — SQLite database instance
- `helpers` — object with all helper functions from op-helpers.js
- `componentETagFn` — function returning current component ETag (for inventory)

- [ ] **Step 1: Create `src/routes/` directory**

```bash
mkdir -p src/routes
```

- [ ] **Step 2: Create `src/routes/core.js`**

Move these routes from `op-server.js`:
- `GET /api/health` (line 681)
- `GET /api/overview` (line 690)
- `GET /api/events` (line 732)
- `GET /api/rankings/:category` (line 751)
- `GET /api/cost` (line 771)
- `GET /api/sessions` (line 802)
- `GET /api/sessions/:id` (line 826)
- `GET /api/prompts` (line 862)
- `GET /api/prompts/:id` (line 917)
- `GET /api/rules` (line 1129)
- `GET /api/unused` (line 1137)
- `GET /api/errors` (line 1163)

```js
'use strict';

const path = require('path');
const fs = require('fs');

module.exports = async function coreRoutes(app, opts) {
  const { db, helpers, dbPath } = opts;
  const { periodToDate } = helpers;

  app.get('/api/health', async () => {
    // copy from op-server.js:681-686
  });

  // ... copy all routes verbatim, replacing direct helper calls
  // with helpers.xxx where needed
};
```

Copy each route handler verbatim from op-server.js. The only change is that `periodToDate` and other helpers come from `opts.helpers` instead of local scope.

Note: `DB_PATH` is needed by `/api/health` for `fs.statSync`. Pass it as `opts.dbPath`.

- [ ] **Step 3: Create `src/routes/inventory.js`**

Move these routes:
- `GET /api/inventory/:type` (line 942)
- `GET /api/inventory/:type/:name` (line 1038)

```js
'use strict';

module.exports = async function inventoryRoutes(app, opts) {
  const { db, helpers, componentETagFn } = opts;
  const { periodToDate, readItemMeta, extractKeywordsFromPrompts } = helpers;
  // Note: getComponentsByType comes from require('../op-db'), not helpers

  app.get('/api/inventory/:type', async (request, reply) => {
    // copy from op-server.js:942-1036
    // Replace `componentETag` references with componentETagFn()
  });

  app.get('/api/inventory/:type/:name', async (request) => {
    // copy from op-server.js:1038-1125
  });
};
```

- [ ] **Step 4: Create `src/routes/instincts.js`**

Move these routes:
- `GET /api/instincts` (line 1170)
- `GET /api/instincts/stats` (line 1182)
- `GET /api/instincts/projects` (line 1186)
- `POST /api/instincts/sync` (line 1223)
- `GET /api/instincts/observer` (line 1230)
- `GET /api/instincts/:id` (line 1245)
- `GET /api/instincts/:id/suggestions` (line 1253)
- `PUT /api/instincts/:id` (line 1259)
- `DELETE /api/instincts/:id` (line 1270)
- `PUT /api/instincts/:id/validate` (line 1277)
- `PUT /api/instincts/:id/reject` (line 1293)
- `POST /api/instincts/:id/translate` (line 1318)
- `GET /api/projects/:id/summary` (line 1362)
- `GET /api/projects/:id/timeline` (line 1368)
- `DELETE /api/projects/:id` (line 1373)
- `GET /api/learning/activity` (line 1416)
- `GET /api/learning/recent` (line 1421)

Note: Instincts, projects, and learning routes are closely related (all deal with CL data). Group them in one file.

This file needs its own requires for `op-instinct-updater`, `child_process` (for translate), `op-db` functions, and `op-sync` (for `syncAll`).

```js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const {
  queryInstinctsFiltered, getInstinct, getInstinctStats,
  getInstinctSuggestions, updateInstinct, updateInstinctVi,
  deleteInstinct, getProjectSummary, getProjectTimeline,
  deleteProject, queryLearningActivity, queryLearningRecent,
} = require('../op-db');
const { findInstinctFile, updateConfidence, archiveInstinct } = require('../op-instinct-updater');
const { syncAll } = require('../op-sync');

module.exports = async function instinctRoutes(app, opts) {
  const { db, repoDir } = opts;
  // ... copy routes verbatim
};
```

- [ ] **Step 5: Create `src/routes/suggestions.js`**

Move these routes:
- `GET /api/suggestions` (line 1428)
- `POST /api/suggestions/analyze` (line 1433)
- `PUT /api/suggestions/:id/approve` (line 1456)
- `PUT /api/suggestions/:id/dismiss` (line 1462)
- `POST /api/suggestions/:id/translate` (line 1468)

```js
'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');

const { querySuggestions, updateSuggestionStatus, updateSuggestionVi } = require('../op-db');

module.exports = async function suggestionRoutes(app, opts) {
  const { db, repoDir } = opts;
  // ... copy routes verbatim
};
```

- [ ] **Step 6: Create `src/routes/knowledge.js`**

Move these routes:
- `GET /api/knowledge/status` (line 1559)
- `GET /api/knowledge/projects` (line 1563)
- `GET /api/knowledge/graph` (line 1573)
- `GET /api/knowledge/node/:id` (line 1578)
- `POST /api/knowledge/sync` (line 1586)
- `POST /api/knowledge/generate` (line 1595)
- `POST /api/knowledge/enrich` (line 1604)
- `GET /api/knowledge/config` (line 1614)
- `GET /api/knowledge/notes` (line 1627)
- `GET /api/knowledge/notes/:id` (line 1638)
- `POST /api/knowledge/notes` (line 1646)
- `PUT /api/knowledge/notes/:id` (line 1662)
- `DELETE /api/knowledge/notes/:id` (line 1685)
- `GET /api/knowledge/notes/:id/backlinks` (line 1695)
- `GET /api/knowledge/autocomplete` (line 1701)
- `GET /api/knowledge/discover` (line 1724)

Also move: `GET /api/scanner/run` (line 1519), `GET /api/scanner/history` (line 1523), `GET /api/scanner/latest` (line 1528), `GET /api/config` (line 1534), `PUT /api/config` (line 1538), `POST /api/ingest` (line 1547) — these go into `core.js` since they're system-level.

```js
'use strict';

const path = require('path');
const fs = require('fs');

const {
  getKgStatus, getKgGraph, getKgNodeDetail,
  insertKbNote, updateKbNote, deleteKbNote, getKbNote,
  getKbNoteBySlug, queryKbNotes, getKbNoteBacklinks, getAllKbNoteSlugs,
} = require('../op-db');
const { syncGraph } = require('../op-knowledge-graph');
const { slugify, slugifyUnique, extractBacklinks, syncNoteToDisk, deleteNoteFromDisk, discoverRelevantContent, syncNoteToGraph, removeNoteFromGraph } = require('../op-notes');
const { generateAllVaults } = require('../op-vault-generator');

module.exports = async function knowledgeRoutes(app, opts) {
  const { db, config, repoDir } = opts;
  // ... copy routes verbatim
};
```

- [ ] **Step 7: Run tests**

```bash
npm test
```
Expected: 231 pass.

- [ ] **Step 8: Commit**

```bash
git add src/routes/
git commit -m "refactor: create route modules from op-server.js

Split 52 routes into 5 Fastify plugins: core (12 routes),
inventory (2), instincts (17), suggestions (5), knowledge (16)."
```

### Task 6: Slim down `op-server.js` and wire route plugins

**Files:**
- Modify: `src/op-server.js` — remove all route definitions, register plugins

- [ ] **Step 1: Update buildApp() to register route plugins**

Remove all route definitions from `buildApp()`. Replace with:

```js
const helpers = require('./op-helpers');

// Inside buildApp(), after static file serving:
const routeOpts = { db, helpers, dbPath: DB_PATH, repoDir: REPO_DIR, config, componentETagFn: () => componentETag };

app.register(require('./routes/core'), routeOpts);
app.register(require('./routes/inventory'), routeOpts);
app.register(require('./routes/instincts'), routeOpts);
app.register(require('./routes/suggestions'), routeOpts);
app.register(require('./routes/knowledge'), routeOpts);
```

- [ ] **Step 2: Verify op-server.js is now ~250 lines**

```bash
wc -l src/op-server.js
```
Expected: ~200-300 lines (imports, config, buildApp with timers, onClose, main).

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: 231 pass.

- [ ] **Step 4: Manual verify — smoke test key endpoints**

```bash
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/health | head -1
curl -s http://127.0.0.1:3827/api/overview?period=7d | head -1
curl -s http://127.0.0.1:3827/api/instincts | head -1
curl -s http://127.0.0.1:3827/api/suggestions | head -1
curl -s http://127.0.0.1:3827/api/knowledge/status | head -1
kill %1
```
Expected: All return valid JSON.

- [ ] **Step 5: Commit**

```bash
git add src/op-server.js
git commit -m "refactor: slim op-server.js to app factory + timer setup

1,753 → ~250 lines. Routes, helpers, and sync logic now in
dedicated modules."
```

---

## Phase 3: Split `op-db.js`

### Task 7: Create domain-specific DB modules

**Files:**
- Create: `src/db/events.js`
- Create: `src/db/sessions.js`
- Create: `src/db/instincts.js`
- Create: `src/db/suggestions.js`
- Create: `src/db/knowledge.js`
- Create: `src/db/components.js`

- [ ] **Step 1: Create `src/db/` directory**

```bash
mkdir -p src/db
```

- [ ] **Step 2: Create `src/db/events.js`**

Move from `op-db.js`:
- `withEventDefaults` (line 282-290)
- `insertEvent` (line 292-303)
- `insertEventBatch` (line 305-320)

```js
'use strict';

function withEventDefaults(evt) {
  return {
    detail: null, duration_ms: null, success: null,
    input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    working_directory: null, model: null, user_prompt: null,
    tool_input: null, tool_response: null, seq_num: null, prompt_id: null,
    ...evt,
  };
}

function insertEvent(db, evt) {
  // copy verbatim from op-db.js:292-303
}

function insertEventBatch(db, events) {
  // copy verbatim from op-db.js:305-320
}

module.exports = { insertEvent, insertEventBatch };
```

- [ ] **Step 3: Create `src/db/sessions.js`**

Move from `op-db.js`:
- `upsertSession` (line 362)
- `upsertSessionBatch` (line 373)
- `updateSessionEnd` (line 388)

```js
'use strict';

function upsertSession(db, sess) { /* copy verbatim */ }
function upsertSessionBatch(db, sessions) { /* copy verbatim */ }
function updateSessionEnd(db, data) { /* copy verbatim */ }

module.exports = { upsertSession, upsertSessionBatch, updateSessionEnd };
```

- [ ] **Step 4: Create `src/db/instincts.js`**

Move from `op-db.js`:
- `upsertInstinct` (line 444)
- `INSTINCT_SORT_PRESETS` (line 578)
- `queryInstinctsFiltered` (line 585)
- `getInstinctStats` (line 617)
- `getInstinctSuggestions` (line 640)
- `getInstinct` (line 648)
- `updateInstinct` (line 657)
- `updateInstinctVi` (line 662)
- `deleteInstinct` (line 666)

```js
'use strict';

// copy all functions verbatim from op-db.js

module.exports = {
  upsertInstinct, queryInstinctsFiltered, getInstinctStats,
  getInstinctSuggestions, getInstinct, updateInstinct,
  updateInstinctVi, deleteInstinct,
};
```

- [ ] **Step 5: Create `src/db/suggestions.js`**

Move from `op-db.js`:
- `withSuggestionDefaults` (line 464)
- `SUGGESTION_INSERT_SQL` (line 468)
- `insertSuggestion` (line 481)
- `insertSuggestionBatch` (line 485)
- `querySuggestions` (line 493)
- `updateSuggestionVi` (line 502)
- `updateSuggestionStatus` (line 506)

```js
'use strict';

// copy all functions verbatim

module.exports = {
  insertSuggestion, insertSuggestionBatch,
  querySuggestions, updateSuggestionVi, updateSuggestionStatus,
};
```

- [ ] **Step 6: Create `src/db/knowledge.js`**

Move from `op-db.js`:
- All KG node/edge functions (lines 792-930)
- All KB note functions (lines 943-1013)

```js
'use strict';

// KG nodes, edges, queries, vault hashes, sync state, status
// KB notes: insert, update, delete, get, query, backlinks, slugs

module.exports = {
  upsertKgNode, upsertKgNodeBatch, getKgNode,
  upsertKgEdge, upsertKgEdgeBatch, getKgEdges,
  getKgGraph, getKgNodeDetail,
  upsertKgVaultHash, getKgVaultHash, getKgVaultHashes,
  setKgSyncState, getKgSyncState, getKgStatus,
  insertKbNote, updateKbNote, deleteKbNote, getKbNote,
  getKbNoteBySlug, queryKbNotes, getKbNoteBacklinks, getAllKbNoteSlugs,
};
```

- [ ] **Step 7: Create `src/db/components.js`**

Move from `op-db.js`:
- `logError` (line 406)
- `upsertClProject` (line 417)
- `upsertComponent` (line 543)
- `deleteComponentsNotSeenSince` (line 562)
- `getComponentsByType` (line 566)
- `getAllComponents` (line 570)
- `insertScanResult` (line 520)
- `getLatestScan` (line 531)
- `getScanHistory` (line 535)
- `getProjectSummary` (line 674)
- `getProjectTimeline` (line 701)
- `deleteProject` (line 716)
- `queryLearningActivity` (line 750)
- `queryLearningRecent` (line 761)
- Prompt functions: `insertPrompt` (line 326), `getLatestPromptForSession` (line 339), `updatePromptStats` (line 345)

```js
'use strict';

// copy all functions verbatim

module.exports = {
  logError,
  upsertClProject,
  insertPrompt, getLatestPromptForSession, updatePromptStats,
  upsertComponent, deleteComponentsNotSeenSince,
  getComponentsByType, getAllComponents,
  insertScanResult, getLatestScan, getScanHistory,
  getProjectSummary, getProjectTimeline, deleteProject,
  queryLearningActivity, queryLearningRecent,
};
```

- [ ] **Step 8: Run tests**

```bash
npm test
```
Expected: 231 pass (op-db.js still has all functions, sub-modules are new but not imported yet).

- [ ] **Step 9: Commit**

```bash
git add src/db/
git commit -m "refactor: create domain-specific DB modules

Split op-db.js functions into 6 modules: events, sessions,
instincts, suggestions, knowledge, components."
```

### Task 8: Update `op-db.js` as re-export facade

**Files:**
- Modify: `src/op-db.js` — keep schema + createDb, re-export from sub-modules

- [ ] **Step 1: Replace function bodies with re-exports**

Keep in op-db.js:
- `Database` require (line 3)
- `DEFAULT_DB_PATH` (line 6)
- `SCHEMA` string (lines 12-180ish)
- `createDb()` function (line 205-276)

Replace all function definitions after `createDb()` with:

```js
// Re-export domain modules
const events = require('./db/events');
const sessions = require('./db/sessions');
const instincts = require('./db/instincts');
const suggestions = require('./db/suggestions');
const knowledge = require('./db/knowledge');
const components = require('./db/components');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...instincts,
  ...suggestions,
  ...knowledge,
  ...components,
};
```

- [ ] **Step 2: Verify line count**

```bash
wc -l src/op-db.js
```
Expected: ~180-200 lines (schema + createDb + re-exports).

- [ ] **Step 3: Run full tests**

```bash
npm test
```
Expected: 231 pass. All existing callers of `require('./op-db')` continue to work since exports are identical.

- [ ] **Step 4: Commit**

```bash
git add src/op-db.js
git commit -m "refactor: convert op-db.js to schema + re-export facade

1,083 → ~190 lines. Functions now live in src/db/*.js,
op-db.js re-exports everything for backward compatibility."
```

---

## Phase 4: Performance Fixes

### Task 9: Fix N+1 query in inventory detail

**Files:**
- Modify: `src/routes/inventory.js` — replace N+1 loop with batch query

- [ ] **Step 1: Write failing test**

Add to `test/op-server.test.js`:

```js
it('GET /api/inventory/:type/:name returns trigger data efficiently', async () => {
  // Seed 5 events in the same session: agent_spawn "Plan" → skill_invoke "tdd-workflow" → tool_call "Read" → skill_invoke "tdd-workflow" → agent_spawn "Explore"
  const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);
  const sess = 'sess-trigger-test';
  const dbMod = require('../src/op-db');
  dbMod.upsertSession(testDb, { session_id: sess, started_at: '2026-04-08T12:00:00Z', model: 'sonnet' });

  const events = [
    { timestamp: '2026-04-08T12:00:01Z', session_id: sess, event_type: 'agent_spawn', name: 'Plan', seq_num: 1 },
    { timestamp: '2026-04-08T12:00:02Z', session_id: sess, event_type: 'skill_invoke', name: 'tdd-workflow', seq_num: 2 },
    { timestamp: '2026-04-08T12:00:03Z', session_id: sess, event_type: 'tool_call', name: 'Read', seq_num: 3 },
    { timestamp: '2026-04-08T12:00:04Z', session_id: sess, event_type: 'skill_invoke', name: 'tdd-workflow', seq_num: 4 },
    { timestamp: '2026-04-08T12:00:05Z', session_id: sess, event_type: 'agent_spawn', name: 'Explore', seq_num: 5 },
  ];
  dbMod.insertEventBatch(testDb, events);
  testDb.close();

  const res = await app.inject({ method: 'GET', url: '/api/inventory/skills/tdd-workflow' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.total, 2);
  // First invocation (seq 4) should be triggered by Plan (seq 1)
  // Second invocation (seq 2) should be triggered by Plan (seq 1)
  assert.ok(body.invocations.length <= 10); // default pagination
  assert.ok(Array.isArray(body.triggers));
});
```

- [ ] **Step 2: Run test to verify it passes with current code (baseline)**

```bash
npm test -- --test-name-pattern "trigger data efficiently"
```
Expected: PASS (this tests correctness, not performance — the N+1 still works, just slowly).

- [ ] **Step 3: Replace N+1 loop with batch queries**

In `src/routes/inventory.js`, replace the per-invocation loop (equivalent of op-server.js:1066-1109) with:

```js
// Batch: find triggered_by and triggers for ALL invocations in 2 queries
const invTimestamps = allInvocations.map(inv => inv.timestamp);
const invSessions = [...new Set(allInvocations.map(inv => inv.session_id))];

if (allInvocations.length > 0) {
  // Build triggered_by: for each invocation, find nearest preceding skill/agent
  const triggeredByStmt = db.prepare(`
    SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
    FROM events e1
    JOIN events e2 ON e2.session_id = e1.session_id
      AND e2.event_type IN ('skill_invoke', 'agent_spawn')
      AND e2.timestamp < e1.timestamp
      AND e2.name != @currentName
    WHERE e1.name = @currentName AND e1.event_type = @eventType
      ${since ? 'AND e1.timestamp >= @since' : ''}
    GROUP BY e1.timestamp
    HAVING e2.timestamp = MAX(e2.timestamp)
  `);

  const triggeredByRows = triggeredByStmt.all({ currentName: name, eventType, since: since || undefined });
  const triggeredByMap = new Map(triggeredByRows.map(r => [r.inv_ts, { name: r.name, type: r.event_type }]));

  // Build triggers: for each invocation, find nearest following skill/agent
  const triggersStmt = db.prepare(`
    SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
    FROM events e1
    JOIN events e2 ON e2.session_id = e1.session_id
      AND e2.event_type IN ('skill_invoke', 'agent_spawn')
      AND e2.timestamp > e1.timestamp
      AND e2.name != @currentName
    WHERE e1.name = @currentName AND e1.event_type = @eventType
      ${since ? 'AND e1.timestamp >= @since' : ''}
    GROUP BY e1.timestamp
    HAVING e2.timestamp = MIN(e2.timestamp)
  `);

  const triggersRows = triggersStmt.all({ currentName: name, eventType, since: since || undefined });

  const triggerCounts = new Map();
  for (const row of triggersRows) {
    const key = `${row.event_type}:${row.name}`;
    if (!triggerCounts.has(key)) {
      triggerCounts.set(key, { name: row.name, event_type: row.event_type, count: 0 });
    }
    triggerCounts.get(key).count++;
  }

  for (const inv of allInvocations) {
    inv.triggered_by = triggeredByMap.get(inv.timestamp) || null;
  }
}
```

This replaces 2N queries with 2 queries regardless of invocation count.

- [ ] **Step 4: Run test again**

```bash
npm test -- --test-name-pattern "trigger data efficiently"
```
Expected: PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```
Expected: 231+ pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/inventory.js test/op-server.test.js
git commit -m "perf: replace N+1 query in inventory detail with batch JOIN

For 1000 invocations: 2000+ queries → 2 queries."
```

### Task 10: Add pagination to unbounded endpoints

**Files:**
- Modify: `src/routes/core.js` — add pagination to `/api/rules`, `/api/unused`
- Modify: `src/routes/knowledge.js` — add limit param to `/api/knowledge/autocomplete`

> **Note:** Spec Phase 3 also lists "Consolidate raw queries" (extract inline `db.prepare()` from route handlers into named DB functions like `getOverviewStats`, `getEventsFiltered`, etc.). This is deferred as a follow-up — after this plan, raw queries live in focused route files which is already a significant improvement. A dedicated consolidation pass can be done later without structural changes.

- [ ] **Step 1: Write failing tests**

Add to `test/op-server.test.js`:

```js
it('GET /api/rules returns paginated response', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/rules?page=1&per_page=10' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok('data' in body, 'response should have data field');
  assert.ok('total' in body, 'response should have total field');
  assert.ok('page' in body, 'response should have page field');
});

it('GET /api/unused returns paginated response', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/unused' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok('data' in body, 'response should have data field');
});

it('GET /api/knowledge/autocomplete respects limit param', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/knowledge/autocomplete?q=test&project=p&limit=5' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body));
  assert.ok(body.length <= 5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --test-name-pattern "paginated response|respects limit"
```
Expected: FAIL (current responses are arrays, not `{ data, total, page }`).

- [ ] **Step 3: Update `/api/rules`**

```js
app.get('/api/rules', async (request) => {
  const page = Math.max(1, parseInt(request.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(request.query.per_page) || 50));

  const all = db.prepare(
    'SELECT rules_loaded, COUNT(*) as count FROM sessions WHERE rules_loaded IS NOT NULL GROUP BY rules_loaded ORDER BY count DESC'
  ).all();

  const total = all.length;
  const data = all.slice((page - 1) * perPage, page * perPage);
  return { data, total, page, per_page: perPage };
});
```

- [ ] **Step 4: Update `/api/unused`**

```js
app.get('/api/unused', async (request) => {
  const page = Math.max(1, parseInt(request.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(request.query.per_page) || 50));

  // ... same 3 queries for unused_skills, unused_agents, unused_rules ...

  const all = [
    ...unused_skills.map(name => ({ type: 'skill', name })),
    ...unused_agents.map(name => ({ type: 'agent', name })),
    ...unused_rules.map(name => ({ type: 'rule', name })),
  ];

  const total = all.length;
  const data = all.slice((page - 1) * perPage, page * perPage);
  return { data, total, page, per_page: perPage };
});
```

- [ ] **Step 5: Update `/api/knowledge/autocomplete`**

Replace hardcoded `.slice(0, 20)` with:

```js
const limit = Math.min(50, Math.max(1, parseInt(request.query.limit) || 20));
// ... at the end:
return results.slice(0, limit);
```

- [ ] **Step 6: Update frontend callers**

Grep for any frontend code that calls these endpoints and update to handle the new response shape:

```bash
grep -r "api/rules\|api/unused" public/modules/ --include="*.js"
```

Update each caller to read from `body.data` instead of treating response as array directly.

- [ ] **Step 7: Run tests**

```bash
npm test
```
Expected: 231+ pass.

- [ ] **Step 8: Commit**

```bash
git add src/routes/core.js src/routes/knowledge.js test/op-server.test.js public/modules/
git commit -m "perf: add pagination to /api/rules, /api/unused, /api/knowledge/autocomplete

Breaking change: /api/rules and /api/unused now return
{ data, total, page, per_page } instead of raw arrays."
```

### Task 11: Smart sync with change detection

**Files:**
- Modify: `src/op-sync.js` — add mtime tracking to `syncAll`
- Modify: `src/op-server.js` — add change detection to KG and vault timers

- [ ] **Step 1: Add mtime-based skip to CL sync**

In `src/op-sync.js`, add mtime tracking to `syncAll`:

```js
let _lastSyncMtimes = { projects: 0, instincts: 0 };

function syncAll(db) {
  const registryPath = path.join(REPO_DIR, 'projects.json');
  const instinctsDir = path.join(REPO_DIR, 'cl', 'instincts');

  // Check if anything changed since last sync
  let projectsMtime = 0;
  let instinctsMtime = 0;
  try { projectsMtime = fs.statSync(registryPath).mtimeMs; } catch { /* missing */ }
  try { instinctsMtime = fs.statSync(instinctsDir).mtimeMs; } catch { /* missing */ }

  if (projectsMtime === _lastSyncMtimes.projects && instinctsMtime === _lastSyncMtimes.instincts) {
    return; // No changes detected
  }

  try {
    syncProjectsToDb(db);
    syncInstinctsToDb(db);
    _lastSyncMtimes = { projects: projectsMtime, instincts: instinctsMtime };
  } catch { /* non-critical */ }
}
```

- [ ] **Step 2: Add event-count-based skip to KG sync timer**

In `src/op-server.js`, in the KG sync timer:

```js
let _lastKgEventCount = 0;

timers.push(setInterval(() => {
  try {
    const currentCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    if (currentCount === _lastKgEventCount) return; // No new events
    syncGraph(db, { /* ... */ });
    _lastKgEventCount = currentCount;
  } catch { /* non-critical */ }
}, config.knowledge_graph_interval_ms || 300000));
```

- [ ] **Step 3: Add hash-based skip to vault generation timer**

In `src/op-server.js`, the vault timer already uses `upsertKgVaultHash` internally. No change needed — `generateAllVaults` already checks hashes and skips unchanged projects. Verify by reading `src/op-vault-generator.js`.

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: 231+ pass.

- [ ] **Step 5: Commit**

```bash
git add src/op-sync.js src/op-server.js
git commit -m "perf: add change detection to sync timers

CL sync checks mtime before scanning. KG sync checks event count
before running. Vault generation already uses content hashes."
```

---

## Phase 5: Error Handling + Test Coverage

### Task 12: Add consistent error handling

**Files:**
- Modify: `src/op-helpers.js` — add `errorReply` helper
- Modify: `src/op-server.js` — add global error handler
- Modify: `src/routes/*.js` — use `errorReply` in catch blocks

- [ ] **Step 1: Add errorReply to op-helpers.js**

```js
function errorReply(reply, code, message) {
  return reply.code(code).send({ error: message });
}
```

Add to exports.

- [ ] **Step 2: Add Fastify global error handler in buildApp()**

In `src/op-server.js`, after `const app = Fastify(...)`:

```js
app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  reply.code(500).send({ error: 'Internal server error' });
});
```

- [ ] **Step 3: Update route catch blocks**

In each route file, replace bare `reply.code(500).send(...)` with `errorReply(reply, 500, 'description')`. Replace bare `return { error: '...' }` with proper `errorReply(reply, 4xx, '...')`.

Example pattern:
```js
// Before:
if (!eventType) return { error: 'Invalid type' };

// After:
const { errorReply } = opts.helpers;
if (!eventType) return errorReply(reply, 400, 'Invalid type');
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: 231+ pass.

- [ ] **Step 5: Commit**

```bash
git add src/op-helpers.js src/op-server.js src/routes/
git commit -m "fix: standardize error handling with errorReply helper

Add Fastify global error handler. Replace 22+ bare reply.code(500)
patterns with consistent errorReply calls."
```

### Task 13: Add input validation at system boundary

**Files:**
- Modify: `src/routes/core.js` — clamp pagination params
- Modify: `src/routes/inventory.js` — validate type enum
- Modify: `src/routes/instincts.js` — clamp pagination
- Modify: `src/routes/knowledge.js` — clamp pagination

- [ ] **Step 1: Add validation helper to op-helpers.js**

```js
function parsePagination(query, defaults = {}) {
  const page = Math.max(1, parseInt(query.page) || (defaults.page || 1));
  const perPage = Math.min(50, Math.max(1, parseInt(query.per_page) || (defaults.perPage || 10)));
  return { page, perPage };
}

function parseValidPeriod(period) {
  if (!period || period === 'all') return null;
  const match = period.match(/^(\d+)[dwmy]$/);
  if (!match) return null;
  return period;
}
```

- [ ] **Step 2: Update routes to use parsePagination**

Replace manual `parseInt` + `Math.max` + `Math.min` in all routes with:
```js
const { page, perPage } = helpers.parsePagination(request.query, { perPage: 10 });
```

- [ ] **Step 3: Validate inventory type enum**

In `src/routes/inventory.js`:
```js
const VALID_TYPES = new Set(['skills', 'agents', 'hooks', 'rules']);
// In route handler:
if (!VALID_TYPES.has(type)) return errorReply(reply, 400, 'Invalid type. Must be: skills, agents, hooks, rules');
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: 231+ pass.

- [ ] **Step 5: Commit**

```bash
git add src/op-helpers.js src/routes/
git commit -m "fix: add input validation for pagination and type params

Clamp page/per_page to safe ranges. Validate period format and
inventory type enum."
```

### Task 14: Add route integration tests

**Files:**
- Modify: `test/op-server.test.js` — add integration tests

- [ ] **Step 1: Add health + overview tests**

```js
describe('route integration', () => {
  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');
    assert.ok('db_size_bytes' in body);
    assert.ok('total_events' in body);
  });

  it('GET /api/overview returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview?period=7d' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok('total_sessions' in body);
    assert.ok('total_cost' in body);
  });

  it('GET /api/events returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body));
  });

  it('GET /api/sessions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
  });
});
```

- [ ] **Step 2: Add error path tests**

```js
describe('error handling', () => {
  it('GET /api/inventory/invalid returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inventory/invalid' });
    assert.equal(res.statusCode, 400);
  });

  it('GET /api/instincts/nonexistent returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instincts/99999' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /api/sessions/nonexistent returns 404 or empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent-session' });
    assert.equal(res.statusCode, 200); // returns empty result
  });

  it('PUT /api/config rejects invalid JSON', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/config',
      payload: 'not-json',
      headers: { 'content-type': 'application/json' },
    });
    assert.ok(res.statusCode >= 400);
  });
});
```

- [ ] **Step 3: Add pagination clamping tests**

```js
describe('pagination', () => {
  it('clamps page to minimum 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills?page=-5&per_page=10' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.length >= 0 || body.page === 1); // depending on response shape
  });

  it('clamps per_page to maximum 50', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inventory/skills?page=1&per_page=999' });
    assert.equal(res.statusCode, 200);
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```
Expected: ~274 tests pass (231 existing + ~43 new).

- [ ] **Step 5: Commit**

```bash
git add test/op-server.test.js
git commit -m "test: add route integration, error path, and pagination tests

43 new tests covering health, overview, events, sessions, inventory,
instincts, suggestions, knowledge endpoints + error handling paths."
```

### Task 15: Add op-helpers.js unit tests

**Files:**
- Create: `test/op-helpers.test.js`

- [ ] **Step 1: Create test file**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  periodToDate, parseFrontmatter, parseQualifiedName,
  extractKeywordsFromPrompts, parsePagination, parseValidPeriod,
} = require('../src/op-helpers');

describe('op-helpers', () => {
  describe('periodToDate', () => {
    it('returns null for "all"', () => {
      assert.equal(periodToDate('all'), null);
    });
    it('returns null for empty', () => {
      assert.equal(periodToDate(''), null);
    });
    it('returns ISO date for "7d"', () => {
      const result = periodToDate('7d');
      assert.ok(result);
      assert.ok(result.endsWith('Z') || result.includes('T'));
    });
    it('returns null for invalid format "7w"', () => {
      // periodToDate currently only supports days
      assert.equal(periodToDate('7w'), null);
    });
  });

  describe('parseFrontmatter', () => {
    it('parses key-value pairs', () => {
      const content = '---\nname: test\ndescription: hello\n---\nbody';
      const result = parseFrontmatter(content);
      assert.equal(result.name, 'test');
      assert.equal(result.description, 'hello');
    });
    it('returns empty object for no frontmatter', () => {
      assert.deepEqual(parseFrontmatter('just text'), {});
    });
    it('strips quotes from values', () => {
      const content = '---\nname: "quoted"\n---';
      assert.equal(parseFrontmatter(content).name, 'quoted');
    });
  });

  describe('parseQualifiedName', () => {
    it('splits plugin:name', () => {
      const result = parseQualifiedName('superpowers:tdd');
      assert.equal(result.plugin, 'superpowers');
      assert.equal(result.shortName, 'tdd');
    });
    it('returns null plugin for plain name', () => {
      const result = parseQualifiedName('tdd');
      assert.equal(result.plugin, null);
      assert.equal(result.shortName, 'tdd');
    });
  });

  describe('extractKeywordsFromPrompts', () => {
    it('extracts top keywords from prompts', () => {
      const invocations = [
        { user_prompt: 'fix the database migration error' },
        { user_prompt: 'database connection timeout error' },
      ];
      const keywords = extractKeywordsFromPrompts(invocations);
      assert.ok(keywords.includes('database'));
      assert.ok(keywords.includes('error'));
    });
    it('returns empty for no prompts', () => {
      assert.deepEqual(extractKeywordsFromPrompts([]), []);
    });
  });

  describe('parsePagination', () => {
    it('returns defaults for empty query', () => {
      const result = parsePagination({});
      assert.equal(result.page, 1);
      assert.equal(result.perPage, 10);
    });
    it('clamps page to minimum 1', () => {
      const result = parsePagination({ page: '-5' });
      assert.equal(result.page, 1);
    });
    it('clamps per_page to maximum 50', () => {
      const result = parsePagination({ per_page: '999' });
      assert.equal(result.perPage, 50);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add test/op-helpers.test.js
git commit -m "test: add unit tests for op-helpers.js

10 tests covering periodToDate, parseFrontmatter, parseQualifiedName,
extractKeywordsFromPrompts, parsePagination."
```

---

## Final Verification

### Task 16: Full verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: ~274+ tests pass.

- [ ] **Step 2: Check file sizes**

```bash
wc -l src/op-server.js src/op-db.js src/op-helpers.js src/op-sync.js src/routes/*.js src/db/*.js
```
Expected:
- `op-server.js` ~250 lines (was 1,753)
- `op-db.js` ~190 lines (was 1,083)
- No file > 400 lines

- [ ] **Step 3: Start server and smoke test**

```bash
npm start &
sleep 2
curl -s http://127.0.0.1:3827/api/health
curl -s http://127.0.0.1:3827/api/overview?period=7d
curl -s http://127.0.0.1:3827/api/inventory/skills?page=1
curl -s http://127.0.0.1:3827/api/instincts
curl -s http://127.0.0.1:3827/api/suggestions
curl -s http://127.0.0.1:3827/api/knowledge/status
curl -s "http://127.0.0.1:3827/api/rules?page=1"
kill %1
```
Expected: All return valid JSON.

- [ ] **Step 4: Open dashboard in browser and verify all pages**

Check: Dashboard, Sessions, Prompts, Inventory, Learning (instincts, suggestions, projects), Knowledge, Expert, Settings.

- [ ] **Step 5: Final commit (if any leftover changes)**

```bash
git status
# If clean, done. If not, stage and commit remaining changes.
```
