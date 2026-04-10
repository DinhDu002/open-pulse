# Inventory Per-Project Counting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `project_name` column to events, deduplicate inventory list, add project filter and per-project breakdown in inventory detail.

**Architecture:** Add column + backfill in migration, populate at ingest time via cl_projects lookup, update inventory API to dedup + filter + breakdown, update frontend with dropdown and Usage by Project card.

**Tech Stack:** Node.js, better-sqlite3, Fastify, vanilla JS ES modules

**Spec:** `docs/superpowers/specs/2026-04-10-inventory-per-project-counting-design.md`

---

### Task 1: Schema migration — add `project_name` column

**Files:**
- Modify: `src/op-db.js:275-278` (add migration block before `return db`)
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing test for migration**

In `test/op-db.test.js`, add test inside the existing `describe('op-db', ...)`:

```js
it('migration adds project_name column to events', () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all().map(c => c.name);
  assert.ok(cols.includes('project_name'), 'events table should have project_name column');

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_project'").get();
  assert.ok(idx, 'idx_events_project index should exist');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-db.test.js --test-name-pattern="migration adds project_name"`
Expected: FAIL — `project_name` column doesn't exist yet

- [ ] **Step 3: Add migration in initDb()**

In `src/op-db.js`, before the line `return db;` (line 278), add:

```js
  // Migrate: add project_name column to events
  const hasProjectName = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pragma_table_info('events') WHERE name = 'project_name'"
  ).get();
  if (hasProjectName.cnt === 0) {
    db.exec('ALTER TABLE events ADD COLUMN project_name TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_name)');
  }
```

Also update the CREATE TABLE statement (line 13-31) to include `project_name TEXT` after `seq_num INTEGER`:

```sql
  seq_num             INTEGER,
  project_name        TEXT
```

And add the index in the initial index block (after line 36):

```sql
CREATE INDEX IF NOT EXISTS idx_events_project   ON events (project_name);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-db.test.js --test-name-pattern="migration adds project_name"`
Expected: PASS

- [ ] **Step 5: Write failing test for backfill**

```js
it('migration backfills project_name from cl_projects', () => {
  // Insert a cl_project
  db.prepare(`
    INSERT OR IGNORE INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
    VALUES ('bp-test', 'my-project', '/tmp/my-project', '2026-01-01', '2026-01-01', 1)
  `).run();

  // Insert an event with matching working_directory but no project_name
  db.prepare(`
    INSERT INTO events (timestamp, session_id, event_type, name, working_directory)
    VALUES ('2026-04-10T01:00:00Z', 'bp-sess', 'tool_call', 'Read', '/tmp/my-project')
  `).run();

  // Re-run migration (backfill)
  const { createDb } = require('../src/op-db');
  createDb(process.env.OPEN_PULSE_DB || db.name);

  const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'bp-sess'").get();
  assert.equal(row.project_name, 'my-project');
});

it('migration backfills project_name with basename fallback', () => {
  db.prepare(`
    INSERT INTO events (timestamp, session_id, event_type, name, working_directory)
    VALUES ('2026-04-10T01:01:00Z', 'bp-sess-2', 'tool_call', 'Read', '/tmp/unknown-project')
  `).run();

  const { createDb } = require('../src/op-db');
  createDb(process.env.OPEN_PULSE_DB || db.name);

  const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'bp-sess-2'").get();
  assert.equal(row.project_name, 'unknown-project');
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `node --test test/op-db.test.js --test-name-pattern="backfill"`
Expected: FAIL — backfill not implemented

- [ ] **Step 7: Add backfill logic in migration**

In the same migration block (after creating the column), add:

```js
    // Backfill: exact match with cl_projects
    db.exec(`
      UPDATE events SET project_name = (
        SELECT name FROM cl_projects WHERE directory = events.working_directory
      ) WHERE working_directory IS NOT NULL AND project_name IS NULL
    `);

    // Backfill: basename fallback for unmatched
    const unmatched = db.prepare(
      "SELECT DISTINCT working_directory FROM events WHERE project_name IS NULL AND working_directory IS NOT NULL"
    ).all();
    const updateStmt = db.prepare(
      "UPDATE events SET project_name = @name WHERE working_directory = @dir AND project_name IS NULL"
    );
    for (const row of unmatched) {
      updateStmt.run({ name: path.basename(row.working_directory), dir: row.working_directory });
    }
```

Add `const path = require('path');` at the top of `op-db.js` if not already present.

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test test/op-db.test.js --test-name-pattern="backfill|migration adds project_name"`
Expected: PASS

- [ ] **Step 9: Run full test suite**

Run: `npm test`
Expected: All existing tests pass

- [ ] **Step 10: Commit**

```bash
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add project_name column to events with backfill migration"
```

---

### Task 2: Populate project_name at ingest time

**Files:**
- Modify: `src/op-ingest.js:14-33` (normaliseEvent) and `src/op-ingest.js:119-167` (processContent)
- Modify: `src/db/events.js` (add project_name to INSERT + defaults)
- Test: `test/op-ingest.test.js`

- [ ] **Step 1: Write failing test**

In `test/op-ingest.test.js`, add:

```js
it('ingestFile populates project_name from cl_projects', () => {
  // Seed a cl_project
  db.prepare(`
    INSERT OR IGNORE INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count)
    VALUES ('ing-proj', 'test-project', '/tmp/test-project', '2026-01-01', '2026-01-01', 1)
  `).run();

  const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
  const event = {
    timestamp: '2026-04-10T10:00:00Z', session_id: 'proj-test-1',
    event_type: 'skill_invoke', name: 'brainstorming', detail: null,
    duration_ms: 50, success: 1,
    working_directory: '/tmp/test-project', model: 'opus',
  };
  fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
  ingest.ingestFile(db, filePath, 'events');

  const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'proj-test-1'").get();
  assert.equal(row.project_name, 'test-project');
});

it('ingestFile uses basename fallback when no cl_project match', () => {
  const filePath = path.join(TEST_DIR, 'data', 'events.jsonl');
  const event = {
    timestamp: '2026-04-10T10:01:00Z', session_id: 'proj-test-2',
    event_type: 'agent_spawn', name: 'Explore', detail: null,
    duration_ms: 50, success: 1,
    working_directory: '/tmp/no-match-dir', model: 'opus',
  };
  fs.writeFileSync(filePath, JSON.stringify(event) + '\n');
  ingest.ingestFile(db, filePath, 'events');

  const row = db.prepare("SELECT project_name FROM events WHERE session_id = 'proj-test-2'").get();
  assert.equal(row.project_name, 'no-match-dir');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-ingest.test.js --test-name-pattern="project_name"`
Expected: FAIL — project_name is NULL

- [ ] **Step 3: Add project_name to db/events.js**

In `src/db/events.js`, update `withEventDefaults`:

```js
function withEventDefaults(evt) {
  return {
    detail: null, duration_ms: null, success: null,
    input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    working_directory: null, model: null, user_prompt: null,
    tool_input: null, tool_response: null, seq_num: null, prompt_id: null,
    project_name: null,
    ...evt,
  };
}
```

Update both `insertEvent` and `insertEventBatch` SQL — add `project_name` to column list and VALUES:

```sql
INSERT INTO events
  (timestamp, session_id, event_type, name, detail, duration_ms, success,
   input_tokens, output_tokens, estimated_cost_usd, working_directory, model, user_prompt,
   tool_input, tool_response, seq_num, prompt_id, project_name)
VALUES
  (@timestamp, @session_id, @event_type, @name, @detail, @duration_ms, @success,
   @input_tokens, @output_tokens, @estimated_cost_usd, @working_directory, @model, @user_prompt,
   @tool_input, @tool_response, @seq_num, @prompt_id, @project_name)
```

- [ ] **Step 4: Add resolveProjectName helper and wire into processContent**

In `src/op-ingest.js`, add helper after imports:

```js
function resolveProjectName(db, workDir) {
  if (!workDir) return null;
  const row = db.prepare(
    'SELECT name FROM cl_projects WHERE directory = ?'
  ).get(workDir);
  return row ? row.name : path.basename(workDir);
}
```

In `normaliseEvent`, add to the returned object:

```js
    project_name:       raw.project_name       ?? null,
```

In `processContent`, after `const events = rows.map(normaliseEvent);` (line 125), add:

```js
      // Derive project_name from working_directory
      for (const evt of events) {
        if (!evt.project_name && evt.working_directory) {
          evt.project_name = resolveProjectName(db, evt.working_directory);
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/op-ingest.test.js --test-name-pattern="project_name"`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/db/events.js src/op-ingest.js test/op-ingest.test.js
git commit -m "feat: populate project_name at ingest time"
```

---

### Task 3: Inventory list API — deduplicate + project filter

**Files:**
- Modify: `src/routes/inventory.js:12-85` (list endpoint)
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing test for deduplication**

In `test/op-server.test.js`, add:

```js
it('GET /api/inventory/agents deduplicates same-name components', async () => {
  const dbMod = require('../src/op-db');
  const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

  // Insert duplicate components directly (simulating sync of same agent in 2 projects)
  dbMod.upsertComponent(testDb, {
    type: 'agent', name: 'shared-agent', source: 'project', plugin: null,
    project: 'proj1', file_path: '/tmp/proj1/shared-agent.md',
    description: 'test', agent_class: 'configured',
    first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
  });
  dbMod.upsertComponent(testDb, {
    type: 'agent', name: 'shared-agent', source: 'project', plugin: null,
    project: 'proj2', file_path: '/tmp/proj2/shared-agent.md',
    description: 'test', agent_class: 'configured',
    first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
  });

  // Insert an event for this agent
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T03:00:00Z', session_id: 'dedup-test',
    event_type: 'agent_spawn', name: 'shared-agent',
    working_directory: '/tmp/proj1', project_name: 'proj1',
  });
  testDb.close();

  const { syncComponents } = require('../src/op-server');
  syncComponents();

  const res = await app.inject({ method: 'GET', url: '/api/inventory/agents?period=all' });
  const items = JSON.parse(res.body);
  const matches = items.filter(i => i.name === 'shared-agent');

  assert.equal(matches.length, 1, 'should have exactly one entry for shared-agent');
  assert.ok(Array.isArray(matches[0].projects), 'should have projects array');
  assert.ok(matches[0].projects.includes('proj1'), 'should include proj1');
  assert.ok(matches[0].projects.includes('proj2'), 'should include proj2');
  assert.equal(matches[0].count, 1);
});
```

- [ ] **Step 2: Write failing test for project filter**

```js
it('GET /api/inventory/skills?project= filters by project_name', async () => {
  const dbMod = require('../src/op-db');
  const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

  dbMod.upsertComponent(testDb, {
    type: 'skill', name: 'test-skill-pf', source: 'global', plugin: null,
    project: null, file_path: '/tmp/test', description: 'test', agent_class: null,
    first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
  });
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T04:00:00Z', session_id: 'pf-test-1',
    event_type: 'skill_invoke', name: 'test-skill-pf',
    working_directory: '/tmp/alpha', project_name: 'alpha',
  });
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T04:01:00Z', session_id: 'pf-test-2',
    event_type: 'skill_invoke', name: 'test-skill-pf',
    working_directory: '/tmp/beta', project_name: 'beta',
  });
  testDb.close();

  const all = await app.inject({ method: 'GET', url: '/api/inventory/skills?period=all' });
  const allItems = JSON.parse(all.body);
  const allMatch = allItems.find(i => i.name === 'test-skill-pf');
  assert.ok(allMatch.count >= 2, 'unfiltered should count all');

  const filtered = await app.inject({ method: 'GET', url: '/api/inventory/skills?period=all&project=alpha' });
  const filteredItems = JSON.parse(filtered.body);
  const filteredMatch = filteredItems.find(i => i.name === 'test-skill-pf');
  assert.equal(filteredMatch.count, 1, 'filtered should count only alpha');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/op-server.test.js --test-name-pattern="deduplicates|project= filters"`
Expected: FAIL

- [ ] **Step 4: Implement dedup + project filter in inventory list**

Replace the list endpoint handler in `src/routes/inventory.js`:

```js
  app.get('/api/inventory/:type', async (request, reply) => {
    const { type } = request.params;
    const { period, project } = request.query;
    const since = periodToDate(period);

    const requestETag = `${componentETagFn()}:${period || 'all'}:${project || ''}`;
    if (request.headers['if-none-match'] === `"${requestETag}"`) {
      reply.code(304);
      return;
    }

    if (!VALID_TYPES.has(type)) {
      return errorReply(reply, 400, 'Invalid type. Must be: skills, agents');
    }
    const singularType = type.replace(/s$/, '');
    const components = getComponentsByType(db, singularType);

    // Deduplicate components by name — merge projects into array
    const byName = new Map();
    for (const c of components) {
      const proj = c.project || 'global';
      if (!byName.has(c.name)) {
        byName.set(c.name, { ...c, projects: [proj] });
      } else {
        const existing = byName.get(c.name);
        if (!existing.projects.includes(proj)) existing.projects.push(proj);
        if (!existing.plugin && c.plugin) existing.plugin = c.plugin;
        if (c.agent_class === 'configured') existing.agent_class = 'configured';
      }
    }

    // Usage counts from events
    const eventTypeMap = { skill: 'skill_invoke', agent: 'agent_spawn' };
    const eventType = eventTypeMap[singularType];

    const conditions = ['event_type = @eventType'];
    if (since) conditions.push('timestamp >= @since');
    if (project) conditions.push('project_name = @project');
    const where = 'WHERE ' + conditions.join(' AND ');

    const usageRows = db.prepare(
      `SELECT name, COUNT(*) as count, MAX(timestamp) as last_used
       FROM events ${where} GROUP BY name`
    ).all({ eventType, since: since || undefined, project: project || undefined });

    const usageMap = new Map(usageRows.map(r => [r.name, r]));

    const items = [...byName.values()].map(c => {
      const usage = usageMap.get(c.name) || { count: 0, last_used: null };
      const item = {
        name: c.name,
        count: usage.count,
        last_used: usage.last_used,
        status: usage.count > 0 ? 'active' : 'unused',
        origin: 'custom',
        projects: c.projects,
        plugin: c.plugin || null,
      };
      if (singularType === 'agent') {
        item.agent_class = c.agent_class || 'built-in';
      }
      return item;
    });

    // Built-in agents from events not on disk
    if (singularType === 'agent') {
      const knownNames = new Set(byName.keys());
      for (const [name, usage] of usageMap) {
        if (!knownNames.has(name)) {
          items.push({
            name,
            count: usage.count,
            last_used: usage.last_used,
            status: 'active',
            origin: 'custom',
            projects: ['global'],
            plugin: parseQualifiedName(name).plugin,
            agent_class: 'built-in',
          });
        }
      }
    }

    items.sort((a, b) => b.count - a.count);
    reply.header('etag', `"${requestETag}"`);
    return items;
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/op-server.test.js --test-name-pattern="deduplicates|project= filters"`
Expected: PASS

- [ ] **Step 6: Fix existing tests that expect `project` (string) instead of `projects` (array)**

Search existing tests for `.project` assertions on inventory responses and update to `.projects`. Check tests at lines 129, 222, 296, 302, 314.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/routes/inventory.js test/op-server.test.js
git commit -m "feat: deduplicate inventory list and add project filter"
```

---

### Task 4: Inventory detail API — by_project breakdown + project filter

**Files:**
- Modify: `src/routes/inventory.js:87-179` (detail endpoint)
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing test for by_project**

```js
it('GET /api/inventory/skills/:name includes by_project breakdown', async () => {
  const dbMod = require('../src/op-db');
  const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

  dbMod.upsertComponent(testDb, {
    type: 'skill', name: 'bp-detail-skill', source: 'global', plugin: null,
    project: null, file_path: '/tmp', description: '', agent_class: null,
    first_seen_at: '2026-04-10', last_seen_at: '2026-04-10',
  });
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T05:00:00Z', session_id: 'bp-d-1',
    event_type: 'skill_invoke', name: 'bp-detail-skill',
    working_directory: '/tmp/proj-a', project_name: 'proj-a',
  });
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T05:01:00Z', session_id: 'bp-d-2',
    event_type: 'skill_invoke', name: 'bp-detail-skill',
    working_directory: '/tmp/proj-a', project_name: 'proj-a',
  });
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T05:02:00Z', session_id: 'bp-d-3',
    event_type: 'skill_invoke', name: 'bp-detail-skill',
    working_directory: '/tmp/proj-b', project_name: 'proj-b',
  });
  testDb.close();

  const res = await app.inject({ method: 'GET', url: '/api/inventory/skills/bp-detail-skill?period=all' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.ok(Array.isArray(body.by_project), 'should have by_project array');
  assert.equal(body.by_project.length, 2);

  const projA = body.by_project.find(p => p.project === 'proj-a');
  assert.equal(projA.count, 2);
  const projB = body.by_project.find(p => p.project === 'proj-b');
  assert.equal(projB.count, 1);
});
```

- [ ] **Step 2: Write failing test for detail project filter**

```js
it('GET /api/inventory/skills/:name?project= filters invocations', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/inventory/skills/bp-detail-skill?period=all&project=proj-a',
  });
  const body = JSON.parse(res.body);

  assert.equal(body.total, 2, 'filtered total should be 2');
  assert.equal(body.by_project.length, 2, 'by_project always returns all');
  for (const inv of body.invocations) {
    assert.equal(inv.project_name, 'proj-a', 'all invocations should be from proj-a');
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/op-server.test.js --test-name-pattern="by_project|filters invocations"`
Expected: FAIL

- [ ] **Step 4: Implement by_project and project filter in detail endpoint**

Replace the detail endpoint handler in `src/routes/inventory.js`:

```js
  app.get('/api/inventory/:type/:name', async (request, reply) => {
    const { type, name } = request.params;
    const { period, project } = request.query;
    const since = periodToDate(period);
    const { page, perPage } = parsePagination(request.query, { perPage: 10 });

    const eventTypeMap = { skills: 'skill_invoke', agents: 'agent_spawn' };
    const eventType = eventTypeMap[type];
    if (!eventType) return errorReply(reply, 400, 'Invalid type. Must be: skills, agents');

    const singularType = type.replace(/s$/, '');
    const comp = db.prepare(
      'SELECT * FROM components WHERE type = ? AND name = ?'
    ).get(singularType, name);
    const meta = comp
      ? { description: comp.description || '', origin: 'custom' }
      : readItemMeta(type, name);

    // by_project breakdown — always unfiltered by project
    const bpConditions = ['event_type = @eventType', 'name = @name'];
    if (since) bpConditions.push('timestamp >= @since');
    const bpWhere = 'WHERE ' + bpConditions.join(' AND ');
    const byProject = db.prepare(
      `SELECT project_name AS project, COUNT(*) AS count, MAX(timestamp) AS last_used
       FROM events ${bpWhere} GROUP BY project_name ORDER BY count DESC`
    ).all({ eventType, name, since: since || undefined });

    // Filtered invocations
    const conditions = ['event_type = @eventType', 'name = @name'];
    if (since) conditions.push('timestamp >= @since');
    if (project) conditions.push('project_name = @project');
    const where = 'WHERE ' + conditions.join(' AND ');

    const allInvocations = db.prepare(
      `SELECT timestamp, detail, session_id, duration_ms, user_prompt, project_name
       FROM events ${where} ORDER BY timestamp DESC`
    ).all({ eventType, name, since: since || undefined, project: project || undefined });

    // Batch query: triggered_by
    const triggeredBySinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggeredByProjectFrag = project ? 'AND e1.project_name = @project' : '';
    const triggeredByRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp < e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggeredBySinceFrag} ${triggeredByProjectFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MAX(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined, project: project || undefined });

    const triggeredByMap = new Map(
      triggeredByRows.map(r => [r.inv_ts, { name: r.name, type: r.event_type }])
    );

    // Batch query: triggers (outgoing)
    const triggersSinceFrag = since ? 'AND e1.timestamp >= @since' : '';
    const triggersProjectFrag = project ? 'AND e1.project_name = @project' : '';
    const triggersRows = db.prepare(`
      SELECT e1.timestamp AS inv_ts, e2.name, e2.event_type
      FROM events e1
      JOIN events e2 ON e2.session_id = e1.session_id
        AND e2.event_type IN ('skill_invoke', 'agent_spawn')
        AND e2.timestamp > e1.timestamp
        AND e2.name != @currentName
      WHERE e1.name = @currentName AND e1.event_type = @eventType
        ${triggersSinceFrag} ${triggersProjectFrag}
      GROUP BY e1.session_id, e1.timestamp
      HAVING e2.timestamp = MIN(e2.timestamp)
    `).all({ currentName: name, eventType, since: since || undefined, project: project || undefined });

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

    const total = allInvocations.length;
    const invocations = allInvocations.slice((page - 1) * perPage, page * perPage);

    return {
      name,
      description: meta.description,
      origin: meta.origin,
      keywords: extractKeywordsFromPrompts(allInvocations),
      by_project: byProject,
      invocations,
      triggers: [...triggerCounts.values()],
      total,
      page,
      per_page: perPage,
    };
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/op-server.test.js --test-name-pattern="by_project|filters invocations"`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/routes/inventory.js test/op-server.test.js
git commit -m "feat: add by_project breakdown and project filter to inventory detail"
```

---

### Task 5: Augment projects endpoint

**Files:**
- Modify: `src/routes/core.js:378-380` (existing `/api/projects` endpoint)
- Test: `test/op-server.test.js`

- [ ] **Step 1: Write failing test**

```js
it('GET /api/projects includes event-only projects', async () => {
  const dbMod = require('../src/op-db');
  const testDb = require('better-sqlite3')(process.env.OPEN_PULSE_DB);

  // Insert event with project_name not in cl_projects
  dbMod.insertEvent(testDb, {
    timestamp: '2026-04-10T06:00:00Z', session_id: 'evonly-1',
    event_type: 'tool_call', name: 'Read',
    working_directory: '/tmp/event-only-proj', project_name: 'event-only-proj',
  });
  testDb.close();

  const res = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(res.statusCode, 200);
  const projects = JSON.parse(res.body);

  const eventOnly = projects.find(p => p.name === 'event-only-proj');
  assert.ok(eventOnly, 'should include project known only from events');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-server.test.js --test-name-pattern="event-only projects"`
Expected: FAIL

- [ ] **Step 3: Update projects endpoint**

In `src/routes/core.js`, replace the `/api/projects` handler (line 378-380):

```js
  app.get('/api/projects', async () => {
    // Projects from cl_projects registry
    const registered = db.prepare(
      'SELECT name, directory FROM cl_projects ORDER BY last_seen_at DESC'
    ).all();

    // Projects known only from events (not in cl_projects)
    const registeredNames = new Set(registered.map(r => r.name));
    const eventOnly = db.prepare(
      "SELECT DISTINCT project_name AS name FROM events WHERE project_name IS NOT NULL"
    ).all().filter(r => !registeredNames.has(r.name));

    return [
      ...registered.map(r => ({ name: r.name, directory: r.directory })),
      ...eventOnly.map(r => ({ name: r.name, directory: null })),
    ];
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-server.test.js --test-name-pattern="event-only projects"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/routes/core.js test/op-server.test.js
git commit -m "feat: augment projects endpoint to include event-only projects"
```

---

### Task 6: Frontend — project dropdown + multi-badge + Usage by Project card

**Files:**
- Modify: `public/modules/inventory.js`

- [ ] **Step 1: Update projectBadge to render array**

In `public/modules/inventory.js`, replace `projectBadge` function (line 111-117):

```js
function projectBadges(item) {
  const container = document.createElement('span');
  const projects = item.projects || [item.project || 'global'];
  for (const proj of projects) {
    const badge = document.createElement('span');
    badge.className = proj === 'global' ? 'badge badge-project-global' : 'badge badge-project';
    badge.textContent = proj;
    badge.style.marginRight = '4px';
    container.appendChild(badge);
  }
  return container;
}
```

Update `renderSkillsTab` (line 123) and `renderAgentsTab` (line 144): change `render: projectBadge` to `render: projectBadges`.

- [ ] **Step 2: Add project dropdown to mount()**

In the `mount` function (line 319), replace the section that creates `tabsEl` and appends it. After creating `tabsEl` and `content`, but before `el.appendChild(tabsEl)`:

```js
  let currentProject = '';

  const filterWrap = document.createElement('div');
  filterWrap.style.cssText = 'display:flex; align-items:center; gap:8px; justify-content:space-between;';

  const projectSelect = document.createElement('select');
  projectSelect.className = 'project-filter';
  projectSelect.innerHTML = '<option value="">All Projects</option>';

  get('/projects').then(projects => {
    for (const proj of projects) {
      const opt = document.createElement('option');
      opt.value = proj.name;
      opt.textContent = proj.name;
      projectSelect.appendChild(opt);
    }
  });

  projectSelect.addEventListener('change', () => {
    currentProject = projectSelect.value;
    loadTab(activeTab);
  });

  filterWrap.appendChild(tabsEl);
  filterWrap.appendChild(projectSelect);
  el.appendChild(filterWrap);
```

Remove the line `el.appendChild(tabsEl);` (line 341).

Update `loadTab` to include project param in API path:

```js
    const projectParam = currentProject ? '&project=' + encodeURIComponent(currentProject) : '';
    let apiPath;
    if (tab === 'skills') apiPath = '/inventory/skills?period=' + p + projectParam;
    else if (tab === 'agents') apiPath = '/inventory/agents?period=' + p + projectParam;
```

- [ ] **Step 3: Add Usage by Project card to renderItemDetail**

In `renderItemDetail` (line 230), after the Triggers section (after the `if (triggers.length > 0)` block ending around line 285), add:

```js
  // Usage by Project breakdown
  const byProject = item.by_project || [];
  if (byProject.length > 0) {
    const bpCard = document.createElement('div');
    bpCard.className = 'card';
    const bpTitle = document.createElement('div');
    bpTitle.className = 'card-title';
    bpTitle.textContent = 'Usage by Project';
    bpCard.appendChild(bpTitle);

    const totalCount = byProject.reduce((s, p) => s + p.count, 0);

    byProject.forEach(p => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 0; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--border);';

      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'min-width:160px;';
      nameEl.textContent = p.project || 'unknown';

      const countEl = document.createElement('span');
      countEl.style.cssText = 'min-width:40px; text-align:right;';
      countEl.textContent = p.count;

      const pct = totalCount > 0 ? Math.round((p.count / totalCount) * 100) : 0;
      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'flex:1; height:8px; background:var(--border); border-radius:4px; overflow:hidden;';
      const bar = document.createElement('div');
      bar.style.cssText = 'height:100%; background:var(--accent); border-radius:4px; width:' + pct + '%;';
      barWrap.appendChild(bar);

      const pctEl = document.createElement('span');
      pctEl.className = 'text-muted';
      pctEl.style.cssText = 'min-width:40px; text-align:right;';
      pctEl.textContent = pct + '%';

      row.append(nameEl, countEl, barWrap, pctEl);
      bpCard.appendChild(row);
    });
    el.appendChild(bpCard);
  }
```

- [ ] **Step 4: Verify visually**

Restart server, open `http://127.0.0.1:3827/#inventory`

Check:
- Project dropdown appears next to tabs
- No duplicate agent entries
- Clicking an item shows "Usage by Project" card with percentage bars
- Selecting a project from dropdown filters the list

- [ ] **Step 5: Commit**

```bash
git add public/modules/inventory.js
git commit -m "feat: add project dropdown and Usage by Project card to inventory UI"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, no regressions

- [ ] **Step 2: Verify API — no duplicates**

```bash
curl -s http://127.0.0.1:3827/api/inventory/agents?period=all | python3 -c "
import json,sys; data=json.load(sys.stdin)
names=[d['name'] for d in data]
dupes=[n for n in names if names.count(n)>1]
print(f'Total: {len(data)}, Unique: {len(set(names))}, Dupes: {dupes}')
for d in data[:5]: print(f\"  {d['name']}: count={d['count']}, projects={d.get('projects')}\")"
```

Expected: `Dupes: []`, all items have `projects` array

- [ ] **Step 3: Verify project filter**

```bash
curl -s "http://127.0.0.1:3827/api/inventory/agents?period=all&project=open-pulse" | python3 -m json.tool | head -20
```

Expected: counts reflect only open-pulse usage

- [ ] **Step 4: Verify by_project in detail**

```bash
curl -s "http://127.0.0.1:3827/api/inventory/agents/general-purpose?period=all" | python3 -c "
import json,sys; d=json.load(sys.stdin); print('by_project:', d.get('by_project'))"
```

Expected: array with per-project breakdown

- [ ] **Step 5: Update CLAUDE.md**

Update `CLAUDE.md` API table: note that inventory list returns `projects` (array) instead of `project` (string), and detail returns `by_project`.
