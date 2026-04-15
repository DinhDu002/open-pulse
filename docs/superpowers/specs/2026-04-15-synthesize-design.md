# `/synthesize` Slash Command Design — Sub-project B

## Context

Sub-project A wired Ollama (Qwen 2.5 7B) into the ingest pipeline. After each prompt, two extractions run automatically:
- **Knowledge entries** (`knowledge_entries` table, status=`active`)
- **Auto-evolve patterns** (`auto_evolves` table, status=`draft`, confidence=0.30)

Ollama produces raw, per-prompt extractions. Quality varies — duplicates accumulate, descriptions are terse, patterns lack cross-prompt context. This is by design: cheap model, fast, good enough for raw signal.

**Sub-project B** adds a `/synthesize` slash command that invokes Opus to consolidate accumulated raw extractions into high-quality, deduplicated, promotion-ready entries.

## Architecture

```
User: /synthesize [project-name] [--all]
         │
         ▼
    Opus reads claude/skills/synthesize/SKILL.md
         │
         ├── GET /api/synthesize/data?project=X     ← bulk data endpoint
         │
         ├── Phase 1: Knowledge Consolidation
         │   ├── Analyze entries by category (batched)
         │   ├── PUT /api/knowledge/entries/:id      ← update/merge
         │   ├── PUT /api/knowledge/entries/:id/outdated  ← mark duplicates
         │   └── POST /api/knowledge/vault/render    ← re-render vault
         │
         └── Phase 2: Pattern Consolidation
             ├── Analyze drafts by target_type (batched)
             ├── PUT /api/auto-evolves/:id           ← update/merge
             ├── DELETE /api/auto-evolves/:id         ← remove duplicates
             └── POST /api/auto-evolves/:id/promote  ← promote ready patterns
```

### Why this architecture

- **Skill-based, not server-side**: Opus runs in Claude Code conversation. User sees reasoning and results inline. No background process management needed.
- **API-mediated**: Opus reads/writes via HTTP endpoints, decoupled from DB schema. Same endpoints available for UI dashboard later.
- **Batched by category/type**: Prevents context overflow. A project with 200 entries gets processed as 11 category batches (~20 entries each), not one dump.
- **Bulk data endpoint**: Single `GET /api/synthesize/data` returns all entries + drafts without pagination loops. Capped to prevent abuse.

## New Files

### 1. `claude/skills/synthesize/SKILL.md`

The core deliverable. A Claude Code skill invoked via `/synthesize` in conversation.

**Frontmatter:**
```yaml
---
name: synthesize
description: Consolidate accumulated knowledge entries and auto-evolve patterns using Opus
---
```

**Sections:**

#### Overview
- What synthesize does: consolidate raw Ollama extractions into high-quality entries
- Two phases: Knowledge Consolidation, then Pattern Consolidation
- Requires Open Pulse server running at `http://localhost:3827`

#### Phase 1: Knowledge Consolidation

**Input:** `GET /api/synthesize/data?project=X&type=knowledge`

Response shape:
```json
{
  "project": { "project_id": "...", "name": "...", "directory": "..." },
  "knowledge_entries": [
    { "id": "ke-xxx", "category": "convention", "title": "...", "body": "...", "source_file": "...", "tags": [...], "status": "active", "created_at": "...", "updated_at": "..." }
  ],
  "stats": { "total": 45, "by_category": { "convention": 12, "api": 8, ... } }
}
```

**Processing (per category batch):**

1. Group entries by `category`
2. For each category with >0 entries:
   a. **Identify duplicates**: entries with overlapping titles or covering the same topic
   b. **Merge duplicates**: pick the best entry as target, improve its body using 3-part template (`[Trigger]`/`[Detail]`/`Consequence`), then `PUT /api/knowledge/entries/:targetId` with improved body. Mark other entries as outdated via `PUT /api/knowledge/entries/:sourceId` with `{ "status": "outdated" }`.
   c. **Improve quality**: entries with weak bodies get improved (add missing Trigger/Detail/Consequence structure)
   d. **Mark stale**: entries contradicted by newer entries get marked outdated
   e. **Skip** entries that are already high-quality and unique

**Output:** After all categories processed, trigger vault re-render:
`POST /api/knowledge/vault/render` with body `{ "project_id": "..." }`

**Report to user:**
```
Knowledge Consolidation — project-name:
  Processed: 45 entries across 8 categories
  Merged: 6 (3 pairs)
  Improved: 12
  Marked outdated: 4
  Unchanged: 23
```

#### Phase 2: Pattern Consolidation

**Input:** `GET /api/synthesize/data?project=X&type=patterns`

Response shape:
```json
{
  "project": { "project_id": "...", "name": "...", "directory": "..." },
  "auto_evolves": [
    { "id": "ae-xxx", "title": "...", "description": "...", "target_type": "rule", "confidence": 0.3, "observation_count": 1, "status": "draft", "projects": "[\"project-name\"]", "created_at": "...", "updated_at": "..." }
  ],
  "stats": { "total": 20, "by_type": { "rule": 10, "skill": 5, "agent": 3, "workflow": 2 }, "by_status": { "draft": 15, "active": 5 } }
}
```

**Processing (per target_type batch):**

1. Group patterns by `target_type`
2. For each type:
   a. **Identify duplicates**: patterns describing the same behavior
   b. **Merge duplicates**: keep best, update with combined evidence and higher observation_count. `PUT /api/auto-evolves/:keepId` with improved description, bumped confidence, merged projects. `DELETE /api/auto-evolves/:removeId` for duplicates.
   c. **Validate patterns**: reject false positives (generic practices, single-occurrence flukes). Delete invalid patterns.
   d. **Assess promotion readiness**: patterns with strong evidence, observed 3+ times, clear actionable description → set `status='active'` and `confidence >= 0.85`
   e. **Promote ready patterns**: `POST /api/auto-evolves/:id/promote` for patterns meeting threshold

**Promotion criteria** (Opus evaluates):
- `observation_count >= 3` OR description is clearly actionable
- Description is specific enough to generate a useful component
- Not duplicating an existing component (check component name in description)

**Report to user:**
```
Pattern Consolidation — project-name:
  Processed: 20 patterns (10 rules, 5 skills, 3 agents, 2 workflows)
  Merged: 4 (2 pairs)
  Validated → active: 8
  Promoted: 3 (2 rules, 1 skill)
  Deleted (false positive): 2
  Kept as draft: 3
```

#### Cross-Project Mode (`--all`)

When user invokes `/synthesize --all`:

1. `GET /api/synthesize/data?type=knowledge` (no project filter → all projects)
2. `GET /api/synthesize/data?type=patterns` (no project filter → all projects)
3. Additional step: **cross-project pattern detection**
   - Find patterns with same/similar title across 3+ projects
   - Update their `projects` array to include all relevant projects
   - Set `scope` field to `global` (requires schema: auto_evolves already has `projects` JSON array)
   - Promote global patterns → component files written to `~/.claude/` (existing `getComponentPath` behavior)

#### Error Handling

- Server not running: report error, suggest `npm start`
- Empty data (0 entries/patterns): report "Nothing to consolidate" per phase
- Individual API call fails: log warning, continue with next item
- Large dataset (>500 entries): process in category/type batches, report progress per batch

## Modified Files

### 2. `src/routes/auto-evolves.js`

**Add `PUT /api/auto-evolves/:id`** — update auto-evolve fields:
```js
app.put('/api/auto-evolves/:id', (req, reply) => {
  const row = getAutoEvolve(db, req.params.id);
  if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
  const { description, confidence, status, projects } = req.body || {};
  const fields = {};
  if (description !== undefined) fields.description = description;
  if (confidence !== undefined)  fields.confidence = Math.max(0, Math.min(1, confidence));
  if (status !== undefined)      fields.status = status;
  if (projects !== undefined)    fields.projects = JSON.stringify(projects);
  updateAutoEvolve(db, req.params.id, fields);
  reply.send(getAutoEvolve(db, req.params.id));
});
```

**Add `DELETE /api/auto-evolves/:id`** — delete auto-evolve:
```js
app.delete('/api/auto-evolves/:id', (req, reply) => {
  const row = getAutoEvolve(db, req.params.id);
  if (!row) return errorReply(reply, 404, 'Auto-evolve not found');
  if (row.status === 'promoted') return errorReply(reply, 400, 'Revert before deleting');
  deleteAutoEvolve(db, req.params.id);
  reply.send({ deleted: true });
});
```

**Modify `GET /api/auto-evolves`** — add `project` query param:
```js
// Add to existing handler:
const { status, target_type, project } = req.query;
if (project) {
  reply.send(queryAutoEvolvesByProject(db, project, { status, target_type, page, per_page: perPage }));
} else {
  reply.send(queryAutoEvolves(db, { status, target_type, page, per_page: perPage }));
}
```

**Modify `POST /api/auto-evolves/:id/promote`** — allow promoting drafts:
```js
// Change status check from:
if (row.status !== 'active') ...
// To:
if (row.status !== 'active' && row.status !== 'draft') ...
```

### 3. `src/routes/knowledge.js`

**Fix `PUT /api/knowledge/entries/:id`** — add `status` to accepted fields:
```js
const { title, body, tags, category, status } = req.body || {};
// ...
if (status !== undefined) fields.status = status;
```

**Add `POST /api/knowledge/vault/render`**:
```js
app.post('/api/knowledge/vault/render', async (req, reply) => {
  const { project_id } = req.body || {};
  if (!project_id) return errorReply(reply, 400, 'project_id required');
  const project = db.prepare('SELECT * FROM cl_projects WHERE project_id = ?').get(project_id);
  if (!project) return errorReply(reply, 404, 'Project not found');
  const { renderKnowledgeVault } = require('../knowledge/vault');
  renderKnowledgeVault(db, project_id);
  return { rendered: true, project_id };
});
```

### 4. `src/routes/synthesize.js` (NEW)

Dedicated route plugin for synthesize bulk data endpoint:

```js
module.exports = async function synthesizeRoutes(app, opts) {
  const { db, helpers } = opts;
  const { errorReply } = helpers;

  // GET /api/synthesize/data — bulk data for Opus consolidation
  app.get('/api/synthesize/data', (req, reply) => {
    const { project, type } = req.query;
    // ... returns all entries/patterns without pagination
  });
};
```

**`GET /api/synthesize/data`** parameters:
- `project` (optional): filter by project name. If omitted, returns all projects.
- `type` (optional): `knowledge`, `patterns`, or `all` (default: `all`)

Response caps: max 500 knowledge entries, max 200 auto-evolves per project. If exceeded, returns most recent by `updated_at`.

### 5. `src/evolve/queries.js`

**Add `updateAutoEvolve(db, id, fields)`**:
```js
function updateAutoEvolve(db, id, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE auto_evolves SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
```

**Add `deleteAutoEvolve(db, id)`**:
```js
function deleteAutoEvolve(db, id) {
  db.prepare('DELETE FROM auto_evolves WHERE id = ?').run(id);
}
```

### 6. `src/server.js`

Register new route plugin:
```js
app.register(require('./routes/synthesize'), routeOpts);
```

## Config Changes

No new config keys needed. The skill runs in user's Claude Code conversation — no server-side config.

## Database Changes

No schema changes. All needed columns already exist:
- `auto_evolves.projects` — JSON array, already used
- `auto_evolves.status` — TEXT, supports 'draft'/'active'/'promoted'/'reverted'
- `knowledge_entries.status` — TEXT, supports 'active'/'outdated'

## Batching Strategy

To prevent Opus context overflow:

1. **Knowledge**: bulk endpoint returns entries grouped by category. Skill instructs Opus to process one category at a time. With 11 categories and ~20-50 entries each, each batch fits comfortably in context.

2. **Patterns**: bulk endpoint returns patterns grouped by target_type. 4 types (rule, skill, agent, workflow). Each batch typically 5-30 patterns.

3. **Cross-project**: In `--all` mode, bulk endpoint returns data grouped by project. Opus processes one project at a time for phases 1-2, then does cross-project analysis on the pattern titles/descriptions only (not full entries).

The bulk data endpoint structures its response to support this batching:

```json
{
  "projects": [
    {
      "project": { "project_id": "...", "name": "..." },
      "knowledge_entries": { "by_category": { "convention": [...], "api": [...] } },
      "auto_evolves": { "by_type": { "rule": [...], "skill": [...] } }
    }
  ],
  "totals": { "knowledge_entries": 150, "auto_evolves": 45 }
}
```

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| Server not running | Opus reports error, suggests `npm start` |
| No entries/patterns | Opus reports "Nothing to consolidate", skips phase |
| Single API call fails | Opus logs warning, continues with next item |
| Too many entries (>500) | Bulk endpoint caps at 500 most recent per project |
| Promoted pattern already exists as file | Promote endpoint detects conflict, Opus reports |

## Verification Plan

1. **Unit tests** (`test/evolve/queries.test.js` additions):
   - `updateAutoEvolve` updates fields correctly
   - `deleteAutoEvolve` removes row
   - `queryAutoEvolvesByProject` filters correctly

2. **Route tests** (`test/routes/synthesize-api.test.js`):
   - `GET /api/synthesize/data` returns grouped data
   - `GET /api/synthesize/data?project=X` filters by project
   - `PUT /api/auto-evolves/:id` updates fields
   - `DELETE /api/auto-evolves/:id` removes entry
   - `POST /api/knowledge/vault/render` triggers render
   - `PUT /api/knowledge/entries/:id` accepts status field
   - `POST /api/auto-evolves/:id/promote` accepts draft status

3. **Skill file validation**:
   - Markdown renders correctly
   - API endpoint URLs match actual routes
   - Sample curl commands in skill work against running server

4. **Manual integration test**:
   - Seed some knowledge entries + auto-evolve drafts
   - Invoke `/synthesize` in Claude Code
   - Verify Opus follows skill instructions
   - Check DB state after consolidation
