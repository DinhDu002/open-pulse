# Inventory Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically sync disk-state changes of skills/agents/hooks/rules into a `components` DB table, serve inventory from DB instead of per-request filesystem scans, and poll with ETag on the frontend for silent updates.

**Architecture:** A `syncComponents()` function runs inside the existing CL sync timer (60s) and on startup. It scans disk → diffs against the `components` table → inserts new, deletes removed, touches existing. API endpoints query `components` JOIN `events` instead of scanning the filesystem. Frontend polls every 60s with `If-None-Match`; re-renders only on 200.

**Tech Stack:** better-sqlite3 (existing), Fastify (existing), Vanilla JS ES modules (existing)

**Spec:** `docs/superpowers/specs/2026-04-07-inventory-sync-design.md`

---

### Task 1: Add `components` table to `op-db.js`

**Files:**
- Modify: `src/op-db.js`
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing tests for component DB helpers**

In `test/op-db.test.js`, add these tests inside the existing `describe('op-db', ...)` block, after the last `it(...)`:

```js
it('creates components table', () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('components'));
});

it('upsertComponent inserts and updates', () => {
  const now = '2026-04-07T10:00:00Z';
  mod.upsertComponent(db, {
    type: 'skill', name: 'test-skill', source: 'global',
    plugin: null, project: null, file_path: '/tmp/skills/test-skill',
    description: 'A test skill', agent_class: null,
    hook_event: null, hook_matcher: null, hook_command: null,
    first_seen_at: now, last_seen_at: now,
  });
  const row = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
  assert.ok(row);
  assert.equal(row.type, 'skill');
  assert.equal(row.description, 'A test skill');

  // Update: change last_seen_at
  const later = '2026-04-07T11:00:00Z';
  mod.upsertComponent(db, {
    type: 'skill', name: 'test-skill', source: 'global',
    plugin: null, project: null, file_path: '/tmp/skills/test-skill',
    description: 'A test skill', agent_class: null,
    hook_event: null, hook_matcher: null, hook_command: null,
    first_seen_at: now, last_seen_at: later,
  });
  const updated = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
  assert.equal(updated.last_seen_at, later);
  assert.equal(updated.first_seen_at, now); // preserved
});

it('deleteComponentsNotSeenSince removes stale rows', () => {
  const old = '2026-04-07T09:00:00Z';
  mod.upsertComponent(db, {
    type: 'skill', name: 'stale-skill', source: 'global',
    plugin: null, project: null, file_path: '/tmp/skills/stale',
    description: '', agent_class: null,
    hook_event: null, hook_matcher: null, hook_command: null,
    first_seen_at: old, last_seen_at: old,
  });
  // Delete components with last_seen_at before the cutoff
  const cutoff = '2026-04-07T09:30:00Z';
  mod.deleteComponentsNotSeenSince(db, cutoff);
  const row = db.prepare("SELECT * FROM components WHERE name = 'stale-skill'").get();
  assert.equal(row, undefined);
  // test-skill from previous test should still exist (last_seen_at = 11:00)
  const kept = db.prepare("SELECT * FROM components WHERE name = 'test-skill'").get();
  assert.ok(kept);
});

it('getComponentsByType returns filtered rows', () => {
  mod.upsertComponent(db, {
    type: 'agent', name: 'test-agent', source: 'global',
    plugin: null, project: null, file_path: '/tmp/agents/test-agent.md',
    description: 'An agent', agent_class: 'configured',
    hook_event: null, hook_matcher: null, hook_command: null,
    first_seen_at: '2026-04-07T10:00:00Z', last_seen_at: '2026-04-07T11:00:00Z',
  });
  const skills = mod.getComponentsByType(db, 'skill');
  assert.ok(skills.every(r => r.type === 'skill'));
  const agents = mod.getComponentsByType(db, 'agent');
  assert.ok(agents.some(r => r.name === 'test-agent'));
});

it('getAllComponents returns all rows', () => {
  const all = mod.getAllComponents(db);
  assert.ok(all.length >= 2); // test-skill + test-agent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-db.test.js`
Expected: FAIL — `mod.upsertComponent is not a function`

- [ ] **Step 3: Add components table to SCHEMA + helper functions**

In `src/op-db.js`, add the `components` table DDL at the end of the `SCHEMA` string (before the closing backtick on line 112):

```sql
CREATE TABLE IF NOT EXISTS components (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  plugin        TEXT,
  project       TEXT,
  file_path     TEXT,
  description   TEXT,
  agent_class   TEXT,
  hook_event    TEXT,
  hook_matcher  TEXT,
  hook_command  TEXT,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  UNIQUE(type, name, source, COALESCE(plugin, ''), COALESCE(project, ''))
);

CREATE INDEX IF NOT EXISTS idx_components_type   ON components (type);
CREATE INDEX IF NOT EXISTS idx_components_source ON components (source);
```

Then add the helper functions after the `getScanHistory` function (around line 389) and before the Learning API section:

```js
// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function upsertComponent(db, comp) {
  db.prepare(`
    INSERT INTO components
      (type, name, source, plugin, project, file_path, description, agent_class,
       hook_event, hook_matcher, hook_command, first_seen_at, last_seen_at)
    VALUES
      (@type, @name, @source, @plugin, @project, @file_path, @description, @agent_class,
       @hook_event, @hook_matcher, @hook_command, @first_seen_at, @last_seen_at)
    ON CONFLICT(type, name, source, COALESCE(plugin, ''), COALESCE(project, '')) DO UPDATE SET
      file_path    = excluded.file_path,
      description  = excluded.description,
      agent_class  = excluded.agent_class,
      hook_event   = excluded.hook_event,
      hook_matcher = excluded.hook_matcher,
      hook_command = excluded.hook_command,
      last_seen_at = excluded.last_seen_at
  `).run(comp);
}

function deleteComponentsNotSeenSince(db, cutoff) {
  db.prepare('DELETE FROM components WHERE last_seen_at < ?').run(cutoff);
}

function getComponentsByType(db, type) {
  return db.prepare('SELECT * FROM components WHERE type = ? ORDER BY name').all(type);
}

function getAllComponents(db) {
  return db.prepare('SELECT * FROM components ORDER BY type, name').all();
}
```

Finally, add the four functions to `module.exports`:

```js
upsertComponent,
deleteComponentsNotSeenSince,
getComponentsByType,
getAllComponents,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-db.test.js`
Expected: All tests PASS including the 5 new ones

- [ ] **Step 5: Commit**

```bash
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add components table and CRUD helpers to op-db"
```

---

### Task 2: Add `syncComponents()` to server

**Files:**
- Modify: `src/op-server.js`
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing tests for syncComponents**

In `test/op-server.test.js`, add these tests inside the existing `describe('op-server', ...)` block. These tests create files on disk in the test's `.claude/` directory and verify the sync picks them up.

```js
it('syncComponents populates components table from disk', async () => {
  // Create a skill dir and an agent file on disk
  const skillDir = path.join(TEST_DIR, '.claude', 'skills', 'my-sync-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: A synced skill\n---\nContent');

  fs.writeFileSync(
    path.join(TEST_DIR, '.claude', 'agents', 'my-sync-agent.md'),
    '---\ndescription: A synced agent\n---\nContent'
  );

  // Trigger sync via the exported helper
  const { syncComponents } = require('../src/op-server');
  syncComponents();

  // Verify via API
  const skillRes = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
  const skills = JSON.parse(skillRes.body);
  assert.ok(skills.some(s => s.name === 'my-sync-skill'), 'synced skill should appear');

  const agentRes = await app.inject({ method: 'GET', url: '/api/inventory/agents' });
  const agents = JSON.parse(agentRes.body);
  assert.ok(agents.some(a => a.name === 'my-sync-agent'), 'synced agent should appear');
});

it('syncComponents removes deleted components', async () => {
  // Delete the skill dir created in previous test
  fs.rmSync(path.join(TEST_DIR, '.claude', 'skills', 'my-sync-skill'), { recursive: true });

  const { syncComponents } = require('../src/op-server');
  syncComponents();

  const res = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
  const skills = JSON.parse(res.body);
  assert.ok(!skills.some(s => s.name === 'my-sync-skill'), 'deleted skill should be removed');
});

it('inventory endpoint returns ETag header', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['etag'], 'should have ETag header');
});

it('inventory endpoint returns 304 when ETag matches', async () => {
  const res1 = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
  const etag = res1.headers['etag'];

  const res2 = await app.inject({
    method: 'GET',
    url: '/api/inventory/skills',
    headers: { 'if-none-match': etag },
  });
  assert.equal(res2.statusCode, 304);
});

it('inventory endpoint returns 200 with new ETag after sync changes', async () => {
  const res1 = await app.inject({ method: 'GET', url: '/api/inventory/skills' });
  const etag1 = res1.headers['etag'];

  // Add a new skill
  const newSkillDir = path.join(TEST_DIR, '.claude', 'skills', 'another-skill');
  fs.mkdirSync(newSkillDir, { recursive: true });
  fs.writeFileSync(path.join(newSkillDir, 'SKILL.md'), '---\ndescription: Another\n---\n');

  const { syncComponents } = require('../src/op-server');
  syncComponents();

  const res2 = await app.inject({
    method: 'GET',
    url: '/api/inventory/skills',
    headers: { 'if-none-match': etag1 },
  });
  assert.equal(res2.statusCode, 200);
  assert.notEqual(res2.headers['etag'], etag1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-server.test.js`
Expected: FAIL — `syncComponents` not exported or ETag header missing

- [ ] **Step 3: Implement `syncComponents()` and ETag logic**

In `src/op-server.js`, first add the new imports at the top (line 11, inside the destructured require):

```js
upsertComponent,
deleteComponentsNotSeenSince,
getComponentsByType,
getAllComponents,
```

Then add a module-level variable for the ETag after the `CONFIG_PATH` declaration (around line 42):

```js
let componentETag = '';
```

Add the `syncComponents` function after the `syncAll` function (around line 404). It needs access to `db`, so it will be defined inside `buildApp` but exported via a module-level reference:

Actually, better approach — define it at module level with a `db` parameter but also store a reference for the exported version. Add this after `syncAll()`:

```js
// ---------------------------------------------------------------------------
// Component sync: filesystem → components table
// ---------------------------------------------------------------------------

let _syncDb = null; // set by buildApp for the exported syncComponents()

function syncComponentsWithDb(db) {
  const now = new Date().toISOString();

  // 1. SCAN disk
  const diskItems = [];

  // Global skills
  for (const name of getKnownSkills()) {
    const filePath = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'skill', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global agents
  for (const name of getKnownAgents()) {
    const filePath = path.join(CLAUDE_DIR, 'agents', name + '.md');
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'agent', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Global rules
  for (const name of getKnownRules()) {
    const subPath = name.includes('/') ? name + '.md' : name + '.md';
    const filePath = path.join(CLAUDE_DIR, 'rules', subPath);
    const meta = readItemMetaFromFile(filePath);
    diskItems.push({
      type: 'rule', name, source: 'global', plugin: null, project: null,
      file_path: filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Hooks (global + project)
  for (const hook of getKnownHooks()) {
    const isProject = hook.project && hook.project !== 'global';
    diskItems.push({
      type: 'hook', name: hook.name, source: isProject ? 'project' : 'global',
      plugin: null, project: hook.project || null,
      file_path: null, description: null, agent_class: null,
      hook_event: hook.event, hook_matcher: hook.matcher, hook_command: hook.command,
    });
  }

  // Plugin components (skills + agents)
  for (const pItem of getPluginComponents('skills')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'skill', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: null,
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }
  for (const pItem of getPluginComponents('agents')) {
    const meta = readItemMetaFromFile(pItem.filePath);
    diskItems.push({
      type: 'agent', name: pItem.qualifiedName, source: 'plugin',
      plugin: pItem.plugin, project: pItem.projects.join(', '),
      file_path: pItem.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // Project agents
  for (const projAgent of getProjectAgents()) {
    const meta = readItemMetaFromFile(projAgent.filePath);
    diskItems.push({
      type: 'agent', name: projAgent.name, source: 'project',
      plugin: null, project: projAgent.project,
      file_path: projAgent.filePath, description: meta.description, agent_class: 'configured',
      hook_event: null, hook_matcher: null, hook_command: null,
    });
  }

  // 2. UPSERT all disk items
  for (const item of diskItems) {
    upsertComponent(db, { ...item, first_seen_at: now, last_seen_at: now });
  }

  // 3. DELETE items no longer on disk (last_seen_at < now)
  deleteComponentsNotSeenSince(db, now);

  // 4. COMPUTE ETag
  const stats = db.prepare(
    "SELECT COUNT(*) AS cnt, MAX(last_seen_at) AS latest FROM components"
  ).get();
  componentETag = crypto
    .createHash('md5')
    .update(`${stats.cnt}:${stats.latest || ''}`)
    .digest('hex');
}

function syncComponents() {
  if (_syncDb) syncComponentsWithDb(_syncDb);
}
```

Now integrate into `buildApp()`. In the `buildApp` function, after `syncAll(db)` (line 477), add:

```js
// Initial component sync
_syncDb = db;
try { syncComponentsWithDb(db); } catch { /* non-critical */ }
```

In the CL sync timer (line 495), change:

```js
timers.push(setInterval(() => syncAll(db), config.cl_sync_interval_ms || 60000));
```

to:

```js
timers.push(setInterval(() => {
  syncAll(db);
  try { syncComponentsWithDb(db); } catch { /* non-critical */ }
}, config.cl_sync_interval_ms || 60000));
```

Add `syncComponents` to the module.exports at the bottom of the file:

```js
module.exports = { buildApp, syncComponents };
```

- [ ] **Step 4: Refactor `/api/inventory/:type` to use components table + ETag**

Replace the entire `app.get('/api/inventory/:type', ...)` handler (lines 692-786) with:

```js
app.get('/api/inventory/:type', async (request, reply) => {
  const { type } = request.params;
  const { period } = request.query;
  const since = periodToDate(period);

  // ETag check
  if (request.headers['if-none-match'] === `"${componentETag}"`) {
    reply.code(304);
    return;
  }

  const singularType = type.replace(/s$/, ''); // skills→skill, agents→agent, hooks→hook, rules→rule
  const validTypes = ['skill', 'agent', 'hook', 'rule'];
  if (!validTypes.includes(singularType)) {
    return { error: 'Invalid type. Use skills, agents, hooks, or rules.' };
  }

  const components = getComponentsByType(db, singularType);

  if (singularType === 'hook') {
    reply.header('etag', `"${componentETag}"`);
    return components.map(c => ({
      name: c.name,
      event: c.hook_event,
      matcher: c.hook_matcher,
      command: c.hook_command,
      project: c.project || 'global',
    }));
  }

  if (singularType === 'rule') {
    reply.header('etag', `"${componentETag}"`);
    return components.map(c => ({
      name: c.name,
      type: 'rule',
      project: c.project || 'global',
    }));
  }

  // Skills and agents: join with events for usage counts
  const eventTypeMap = { skill: 'skill_invoke', agent: 'agent_spawn' };
  const eventType = eventTypeMap[singularType];

  const conditions = ['event_type = @eventType'];
  if (since) conditions.push('timestamp >= @since');
  const where = 'WHERE ' + conditions.join(' AND ');

  const usageRows = db.prepare(
    `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
     FROM events ${where} GROUP BY name`
  ).all({ eventType, since: since || undefined });

  const usageMap = new Map(usageRows.map(r => [r.name, r]));

  const items = components.map(c => {
    const usage = usageMap.get(c.name) || { count: 0, last_used: null };
    const item = {
      name: c.name,
      count: usage.count,
      last_used: usage.last_used,
      status: usage.count > 0 ? 'active' : 'unused',
      origin: c.description ? 'custom' : 'custom',
      plugin: c.plugin || null,
      project: c.project || 'global',
    };
    if (singularType === 'agent') {
      item.agent_class = c.agent_class || 'built-in';
    }
    return item;
  });

  // Also include "built-in" agents from events that aren't on disk
  if (singularType === 'agent') {
    const knownNames = new Set(components.map(c => c.name));
    for (const [name, usage] of usageMap) {
      if (!knownNames.has(name)) {
        items.push({
          name,
          count: usage.count,
          last_used: usage.last_used,
          status: 'active',
          origin: 'custom',
          plugin: parseQualifiedName(name).plugin,
          project: 'global',
          agent_class: 'built-in',
        });
      }
    }
  }

  items.sort((a, b) => b.count - a.count);
  reply.header('etag', `"${componentETag}"`);
  return items;
});
```

- [ ] **Step 5: Refactor `/api/inventory/:type/:name` to use components table**

Replace the metadata lookup at the beginning of the handler (around line 799). Change:

```js
const meta = readItemMeta(type, name);
```

to:

```js
const singularType = type.replace(/s$/, '');
const comp = db.prepare(
  'SELECT * FROM components WHERE type = ? AND name = ?'
).get(singularType, name);
const meta = comp
  ? { description: comp.description || '', origin: 'custom' }
  : readItemMeta(type, name);
```

- [ ] **Step 6: Refactor `/api/unused` to use components table**

Replace the entire `app.get('/api/unused', ...)` handler (lines 881-894) with:

```js
app.get('/api/unused', async () => {
  const unused_skills = db.prepare(`
    SELECT c.name FROM components c
    LEFT JOIN events e ON e.name = c.name AND e.event_type = 'skill_invoke'
    WHERE c.type = 'skill'
    GROUP BY c.id
    HAVING COUNT(e.id) = 0
  `).all().map(r => r.name);

  const unused_agents = db.prepare(`
    SELECT c.name FROM components c
    LEFT JOIN events e ON e.name = c.name AND e.event_type = 'agent_spawn'
    WHERE c.type = 'agent'
    GROUP BY c.id
    HAVING COUNT(e.id) = 0
  `).all().map(r => r.name);

  const unused_rules = db.prepare(
    "SELECT name FROM components WHERE type = 'rule'"
  ).all().map(r => r.name);

  return { unused_skills, unused_agents, unused_rules };
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/op-server.test.js`
Expected: All tests PASS including the 5 new ones

- [ ] **Step 8: Commit**

```bash
git add src/op-server.js test/op-server.test.js
git commit -m "feat: add syncComponents with ETag, refactor inventory endpoints to use components table"
```

---

### Task 3: Frontend ETag polling

**Files:**
- Modify: `public/modules/api.js`
- Modify: `public/modules/inventory.js`

- [ ] **Step 1: Add `getWithETag()` to `api.js`**

In `public/modules/api.js`, add after the existing `request` function (line 24) and before the exports:

```js
async function getWithETag(path, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(BASE + path, { method: 'GET', headers });
  if (res.status === 304) return { data: null, etag, notModified: true };
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const newEtag = res.headers.get('etag') || null;
  return { data, etag: newEtag, notModified: false };
}
```

Update the exports line to include it:

```js
export const get = (path) => request('GET', path);
export { getWithETag };
export const post = (path, body) => request('POST', path, body);
export const put = (path, body) => request('PUT', path, body);
export const del = (path, body) => request('DELETE', path, body);
```

- [ ] **Step 2: Add ETag polling to `inventory.js`**

In `public/modules/inventory.js`, update the import at line 1:

```js
import { get, getWithETag } from './api.js';
```

Add state variables after the `TABS` declaration (after line 12):

```js
let pollInterval = null;
let currentETag = null;
let inDetailView = false;
```

Replace the `mount` function's `loadTab` inner function. The new version stores ETag and supports silent refresh:

Find the `loadTab` function definition inside `mount` (line 398). Replace the `get(apiPath).then(data => {` block (lines 413-453) with:

```js
    const fetchFn = isRefresh
      ? () => getWithETag(apiPath, currentETag)
      : () => get(apiPath).then(data => ({ data, etag: null, notModified: false }));

    fetchFn().then(result => {
      if (result.notModified) return; // ETag matched, nothing changed

      const data = result.data;
      if (result.etag) currentETag = result.etag;

      content.textContent = '';
      const items = Array.isArray(data) ? data : (data.items || data[tab] || []);
```

And update the function signature from `function loadTab(tab)` to `function loadTab(tab, isRefresh = false)`.

Add polling setup at the end of `mount`, after `loadTab(activeTab)` (line 456):

```js
  // Start polling every 60s with ETag
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (inDetailView) return; // skip refresh while viewing detail
    loadTab(activeTab, true);
  }, 60000);
```

Update each detail view callback to set `inDetailView = true`, and each back button to set `inDetailView = false`. In the skills detail callback (inside the `if (tab === 'skills')` block):

After the line `function loadDetail(pg) {`, add:
```js
            inDetailView = true;
```

In the `renderItemDetail` call's `onBack` callback, change `() => loadTab('skills')` to:
```js
              () => { inDetailView = false; loadTab('skills'); }
```

Do the same for agents:
```js
            inDetailView = true;
```
and change `() => loadTab('agents')` to:
```js
              () => { inDetailView = false; loadTab('agents'); }
```

Update `unmount` to clear the interval:

```js
export function unmount() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  inDetailView = false;
  currentETag = null;
}
```

- [ ] **Step 3: Verify manually**

Run: `npm start`

1. Open `http://127.0.0.1:3827` → Inventory tab
2. Verify skills/agents/hooks/rules load correctly
3. Check browser DevTools Network tab: requests should include `If-None-Match` header after first load
4. Wait 60s → verify poll request returns 304 (no changes)
5. Add a new skill directory in `~/.claude/skills/test-poll-skill/` with a `SKILL.md` file
6. Wait 60s → verify poll returns 200 and new skill appears in the list
7. Delete `~/.claude/skills/test-poll-skill/`
8. Wait 60s → verify skill disappears from the list

- [ ] **Step 4: Commit**

```bash
git add public/modules/api.js public/modules/inventory.js
git commit -m "feat: add ETag polling to inventory frontend for auto-sync"
```

---

### Task 4: Update existing tests for refactored endpoints

**Files:**
- Modify: `test/op-server.test.js`

- [ ] **Step 1: Update existing inventory test if present**

Check if there are existing inventory tests in `test/op-server.test.js` that might break due to the refactor. The existing tests use `app.inject()` with `disableTimers: true`, so `syncComponents` won't run automatically.

Add an initial sync call in the `before()` block, after `await app.ready()`:

```js
// Run initial component sync for tests
const { syncComponents } = require('../src/op-server');
syncComponents();
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All 87+ tests PASS

- [ ] **Step 3: Commit if any test fixes were needed**

```bash
git add test/op-server.test.js
git commit -m "test: update server tests for component sync integration"
```

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the database schema table**

In `CLAUDE.md`, find the "Database Schema (8 tables)" section and update it to "Database Schema (9 tables)". Add the new table:

```
| `components` | Inventory component registry | type, name, source, plugin, project, file_path, first_seen_at |
```

- [ ] **Step 2: Update the architecture description**

In the Architecture Overview section, add a note about component sync in the server box description. Update the line about CL sync timer to:

```
│  CL sync     │──→ cl/ (instincts, projects)
│  (timer 60s) │──→ components table (inventory sync)
```

- [ ] **Step 3: Update test count**

Update the test count from `87` to the new total (should be ~97 after adding ~10 new tests).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with components table and inventory sync"
```
