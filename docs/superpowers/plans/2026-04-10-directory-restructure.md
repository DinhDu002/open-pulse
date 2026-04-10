# Directory Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure open-pulse from flat `src/` with mixed prefixes into domain-based folders with shared utilities, eliminating all code duplication and dead code.

**Architecture:** Create 5 domain folders (`ingest/`, `evolve/`, `knowledge/`, `review/`, `routes/`) plus `lib/` for shared utilities and `db/` for database layer. Each domain is self-contained. Tests mirror `src/` structure in subdirectories.

**Tech Stack:** Node.js CommonJS, Fastify 5, better-sqlite3, vanilla JS ES modules (frontend)

**Spec:** `docs/superpowers/specs/2026-04-10-directory-restructure-design.md`

---

## Strategy

This restructure touches every file. To keep tests passing at each commit:

1. **Shim approach**: When moving a module, leave a 1-line re-export shim at the old path. This lets consumers keep working until they're updated.
2. **Batch per domain**: Each task moves one domain, updates its consumers, then removes shims.
3. **Final cleanup**: Delete all shims and dead code at the end.

**Import dependency order** (move leaves first, then consumers):
1. `lib/` — no internal deps (new files, extract from helpers)
2. `db/` — depends on nothing internal
3. `ingest/` — depends on db
4. `evolve/` — depends on db, lib
5. `knowledge/` — depends on db, lib
6. `review/` — depends on db, lib
7. `routes/` — depends on all above
8. `server.js` — depends on all above
9. Frontend — independent
10. Tests — mirror src
11. Cleanup — delete old files, update docs

---

### Task 1: Create `src/lib/` — Extract shared utilities

**Files:**
- Create: `src/lib/frontmatter.js`
- Create: `src/lib/slugify.js`
- Create: `src/lib/paths.js`
- Create: `src/lib/plugins.js`
- Create: `src/lib/projects.js`
- Create: `src/lib/format.js`
- Modify: `src/op-helpers.js` (keep as shim)
- Test: run existing `test/op-helpers.test.js`

- [ ] **Step 1: Create `src/lib/frontmatter.js`**

Extract `parseFrontmatter()` from `op-helpers.js:27-42` and `extractBody()` from `op-auto-evolve.js:37-40`:

```javascript
'use strict';

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function extractBody(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : '';
}

module.exports = { parseFrontmatter, extractBody };
```

- [ ] **Step 2: Create `src/lib/slugify.js`**

Extract from `op-auto-evolve.js:17-22`:

```javascript
'use strict';

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

module.exports = { slugify };
```

- [ ] **Step 3: Create `src/lib/paths.js`**

Extract `getClaudeDir()` from `op-auto-evolve.js:12-14` and `getComponentPath()` from `op-auto-evolve.js:65-74`:

```javascript
'use strict';

const path = require('path');
const os = require('os');
const { slugify } = require('./slugify');

function getClaudeDir() {
  return process.env.OPEN_PULSE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function getComponentPath(targetType, name) {
  const slug = slugify(name);
  const claudeDir = getClaudeDir();
  switch (targetType) {
    case 'rule':      return path.join(claudeDir, 'rules', `${slug}.md`);
    case 'skill':     return path.join(claudeDir, 'skills', slug, 'SKILL.md');
    case 'knowledge': return path.join(claudeDir, 'knowledge', `${slug}.md`);
    default:          return path.join(claudeDir, 'rules', `${slug}.md`);
  }
}

module.exports = { getClaudeDir, getComponentPath };
```

- [ ] **Step 4: Create `src/lib/plugins.js`**

Extract from `op-helpers.js:96-161`:

```javascript
'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');

function getInstalledPlugins() {
  const claudeDir = getClaudeDir();
  const jsonPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return Object.entries(data.plugins || {}).map(([key, installs]) => {
      const projects = [];
      for (const inst of installs) {
        if (inst.scope === 'user') {
          if (!projects.includes('global')) projects.push('global');
        } else if (inst.projectPath) {
          const name = path.basename(inst.projectPath);
          if (!projects.includes(name)) projects.push(name);
        }
      }
      return {
        plugin: key.split('@')[0],
        installPath: installs[0].installPath,
        projects: projects.length ? projects : ['global'],
      };
    });
  } catch {
    return [];
  }
}

function getPluginComponents(type) {
  const plugins = getInstalledPlugins();
  const items = [];
  for (const { plugin, installPath, projects } of plugins) {
    try {
      if (type === 'agents') {
        const dir = path.join(installPath, 'agents');
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const name = f.replace(/\.md$/, '');
          items.push({ qualifiedName: `${plugin}:${name}`, plugin, projects, filePath: path.join(dir, f) });
        }
      } else if (type === 'skills') {
        const dir = path.join(installPath, 'skills');
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const skillFile = path.join(dir, e.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            items.push({ qualifiedName: `${plugin}:${e.name}`, plugin, projects, filePath: skillFile });
          }
        }
      }
    } catch { /* plugin dir may not have agents/ or skills/ */ }
  }
  return items;
}

module.exports = { getInstalledPlugins, getPluginComponents };
```

- [ ] **Step 5: Create `src/lib/projects.js`**

Extract from `op-helpers.js:121-181`:

```javascript
'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');
const { getInstalledPlugins } = require('./plugins');

function getKnownProjectPaths() {
  const claudeDir = getClaudeDir();
  const jsonPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const paths = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const installs of Object.values(data.plugins || {})) {
      for (const inst of installs) {
        if (inst.projectPath) paths.add(inst.projectPath);
      }
    }
  } catch { /* ignore */ }
  return [...paths];
}

function getProjectAgents() {
  const projectPaths = getKnownProjectPaths();
  const items = [];
  for (const projPath of projectPaths) {
    const agentsDir = path.join(projPath, '.claude', 'agents');
    try {
      for (const f of fs.readdirSync(agentsDir)) {
        if (!f.endsWith('.md')) continue;
        const name = f.replace(/\.md$/, '');
        items.push({ name, project: path.basename(projPath), filePath: path.join(agentsDir, f) });
      }
    } catch { /* no .claude/agents/ in this project */ }
  }
  return items;
}

module.exports = { getKnownProjectPaths, getProjectAgents };
```

- [ ] **Step 6: Create `src/lib/format.js`**

Extract from `op-helpers.js` — HTTP helpers, name parsing, item meta, keywords, known skills/agents:

```javascript
'use strict';

const path = require('path');
const fs = require('fs');
const { getClaudeDir } = require('./paths');
const { parseFrontmatter } = require('./frontmatter');

function periodToDate(period) {
  if (!period || period === 'all') return null;
  const match = period.match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function parseQualifiedName(name) {
  const idx = name.indexOf(':');
  if (idx === -1) return { plugin: null, shortName: name };
  return { plugin: name.substring(0, idx), shortName: name.substring(idx + 1) };
}

function readItemMetaFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseFrontmatter(content);
    return { description: meta.description || '', origin: meta.origin || 'custom' };
  } catch {
    return { description: '', origin: 'custom' };
  }
}

function readItemMeta(type, name) {
  const claudeDir = getClaudeDir();
  let filePath;
  if (type === 'skills') {
    filePath = path.join(claudeDir, 'skills', name, 'SKILL.md');
  } else {
    filePath = path.join(claudeDir, 'agents', name + '.md');
  }
  return readItemMetaFromFile(filePath);
}

function getKnownSkills() {
  const claudeDir = getClaudeDir();
  const skillsDir = path.join(claudeDir, 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function getKnownAgents() {
  const claudeDir = getClaudeDir();
  const agentsDir = path.join(claudeDir, 'agents');
  try {
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

function isGitRepo(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isDirectory(); }
  catch { return false; }
}

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'to','of','in','for','on','with','at','by','from','as','into','through','during',
  'before','after','above','below','between','out','off','over','under','again','further',
  'then','once','here','there','when','where','why','how','all','both','each','few',
  'more','most','other','some','such','no','nor','not','only','own','same','so','than',
  'too','very','just','about','up','it','its','this','that','these','those','i','me',
  'my','we','our','you','your','he','him','his','she','her','they','them','their',
  'what','which','who','whom','and','but','or','if','while','because','until','although',
  'null','true','false','undefined','none',
]);

function extractKeywordsFromPrompts(invocations) {
  const freq = new Map();
  for (const inv of invocations) {
    let text = inv.user_prompt || '';
    if (!text && inv.detail) {
      try { const obj = JSON.parse(inv.detail); text = obj.args || obj.description || ''; }
      catch { text = String(inv.detail); }
    }
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
}

function errorReply(reply, code, message) {
  return reply.code(code).send({ error: message });
}

function parsePagination(query, defaults = {}) {
  const page = Math.max(1, parseInt(query.page) || (defaults.page || 1));
  const perPage = Math.min(50, Math.max(1, parseInt(query.per_page) || (defaults.perPage || 10)));
  return { page, perPage };
}

module.exports = {
  periodToDate, parseQualifiedName, readItemMetaFromFile, readItemMeta,
  getKnownSkills, getKnownAgents, isGitRepo,
  STOP_WORDS, extractKeywordsFromPrompts,
  errorReply, parsePagination,
};
```

- [ ] **Step 7: Replace `src/op-helpers.js` with shim**

Replace the entire file with re-exports from lib modules:

```javascript
'use strict';
// Shim: re-export from lib/ for backward compatibility during migration
const { parseFrontmatter } = require('./lib/frontmatter');
const { getClaudeDir } = require('./lib/paths');
const { getInstalledPlugins, getPluginComponents } = require('./lib/plugins');
const { getKnownProjectPaths, getProjectAgents } = require('./lib/projects');
const format = require('./lib/format');

module.exports = {
  CLAUDE_DIR: getClaudeDir(),
  parseFrontmatter,
  ...format,
  getInstalledPlugins,
  getPluginComponents,
  getKnownProjectPaths,
  getProjectAgents,
};
```

- [ ] **Step 8: Run tests**

Run: `node --test test/op-helpers.test.js`
Expected: all tests pass (shim re-exports same interface)

- [ ] **Step 9: Commit**

```bash
git add src/lib/ src/op-helpers.js
git commit -m "refactor: extract shared utilities into src/lib/"
```

---

### Task 2: Restructure `src/db/` — Split components, rename schema

**Files:**
- Create: `src/db/schema.js` (from `op-db.js`)
- Create: `src/db/prompts.js` (from `db/components.js`)
- Create: `src/db/projects.js` (from `db/components.js`)
- Create: `src/db/scan.js` (from `db/components.js`)
- Modify: `src/db/components.js` (keep only component queries)
- Rename: `src/db/knowledge.js` → `src/db/knowledge-sync.js`
- Modify: `src/op-db.js` (shim to `db/schema.js`)

- [ ] **Step 1: Read `src/db/components.js` to identify split points**

Read the file to understand which functions belong to which domain (prompts, projects, scan, components).

- [ ] **Step 2: Create `src/db/schema.js`**

Copy `createDb()` and all schema/migration logic from `op-db.js:1-308`. Remove re-exports at the bottom. Change `module.exports`:

```javascript
module.exports = { DEFAULT_DB_PATH, createDb };
```

- [ ] **Step 3: Create `src/db/prompts.js`**

Extract prompt-related functions from `db/components.js`: `insertPrompt`, `getLatestPromptForSession`, `updatePromptStats`, `updatePromptTokens`, and any prompt query functions.

- [ ] **Step 4: Create `src/db/projects.js`**

Extract project-related functions from `db/components.js`: any functions that query `cl_projects` table.

- [ ] **Step 5: Create `src/db/scan.js`**

Extract scanner-related functions from `db/components.js`: any functions that query `scan_results` table.

- [ ] **Step 6: Trim `src/db/components.js`**

Remove extracted functions, keep only component-specific queries.

- [ ] **Step 7: Rename `src/db/knowledge.js` → `src/db/knowledge-sync.js`**

```bash
git mv src/db/knowledge.js src/db/knowledge-sync.js
```

- [ ] **Step 8: Update `src/op-db.js` to shim**

Replace re-exports to point to new files:

```javascript
'use strict';
// Shim: delegates to db/schema.js during migration
const { DEFAULT_DB_PATH, createDb } = require('./db/schema');
const events = require('./db/events');
const sessions = require('./db/sessions');
const knowledge = require('./db/knowledge-sync');
const components = require('./db/components');
const prompts = require('./db/prompts');
const projects = require('./db/projects');
const scan = require('./db/scan');

module.exports = {
  DEFAULT_DB_PATH,
  createDb,
  ...events,
  ...sessions,
  ...knowledge,
  ...components,
  ...prompts,
  ...projects,
  ...scan,
};
```

- [ ] **Step 9: Run tests**

Run: `node --test test/op-db.test.js`
Expected: all pass (shim preserves same exports)

- [ ] **Step 10: Commit**

```bash
git add src/db/ src/op-db.js
git commit -m "refactor: split db/components.js into prompts, projects, scan modules"
```

---

### Task 3: Create `src/ingest/` — Move collector + split ingest + move sync

**Files:**
- Create: `src/ingest/collector.js` (from `collector/op-collector.js`)
- Create: `src/ingest/pipeline.js` (from `op-ingest.js` — ingestFile, ingestAll, processContent)
- Create: `src/ingest/prompt-linker.js` (from `op-ingest.js` — linkEventsToPrompts, distributeTokens)
- Create: `src/ingest/sync.js` (from `op-sync.js`)
- Modify: `src/op-ingest.js` (shim)
- Modify: `src/op-sync.js` (shim)
- Modify: `collector/op-collector.js` (shim)

- [ ] **Step 1: Create `src/ingest/` directory**

```bash
mkdir -p src/ingest
```

- [ ] **Step 2: Create `src/ingest/prompt-linker.js`**

Extract from `op-ingest.js:122-159`: `linkEventsToPrompts()`, `updatePromptStatsAfterInsert()`, `distributeTokensToPrompts()`. These functions require prompt DB functions — update imports to use `../db/prompts` directly.

- [ ] **Step 3: Create `src/ingest/pipeline.js`**

Extract from `op-ingest.js`: `normaliseEvent()`, `parseJsonl()`, `processContent()`, `ingestFile()`, `ingestAll()`, retry helpers. Import `prompt-linker` from same directory.

```javascript
const { linkEventsToPrompts, updatePromptStatsAfterInsert, distributeTokensToPrompts } = require('./prompt-linker');
```

Export `setKnowledgeHook` from here too (it's used by `op-server.js`).

- [ ] **Step 4: Create `src/ingest/collector.js`**

Copy `collector/op-collector.js` as-is. No internal dependencies to update.

- [ ] **Step 5: Create `src/ingest/sync.js`**

Copy `op-sync.js`. Update requires:
- `require('./op-db')` → `require('../db/schema')` for `createDb`, and direct imports from `../db/components`, `../db/projects`, etc.
- `require('./op-helpers')` → `require('../lib/format')`, `require('../lib/plugins')`, etc.

- [ ] **Step 6: Replace `src/op-ingest.js` with shim**

```javascript
'use strict';
// Shim: delegates to ingest/ during migration
module.exports = require('./ingest/pipeline');
```

- [ ] **Step 7: Replace `src/op-sync.js` with shim**

```javascript
'use strict';
// Shim: delegates to ingest/ during migration
module.exports = require('./ingest/sync');
```

- [ ] **Step 8: Replace `collector/op-collector.js` with shim**

```javascript
'use strict';
// Shim: delegates to src/ingest/ during migration
module.exports = require('../src/ingest/collector');
if (require.main === module) { require('../src/ingest/collector'); }
```

Note: The collector is invoked directly by Claude Code hooks. The shim ensures the old path still works. `register-hooks.js` will be updated in the cleanup task to point to the new path.

- [ ] **Step 9: Run tests**

Run: `node --test test/op-ingest.test.js test/op-collector.test.js`
Expected: all pass

- [ ] **Step 10: Commit**

```bash
git add src/ingest/ src/op-ingest.js src/op-sync.js collector/op-collector.js
git commit -m "refactor: create src/ingest/ — collector, pipeline, prompt-linker, sync"
```

---

### Task 4: Create `src/evolve/` — Split auto-evolve + absorb CL

**Files:**
- Create: `src/evolve/sync.js` (syncInstincts from `op-auto-evolve.js`)
- Create: `src/evolve/promote.js` (runAutoEvolve + generateComponent, merge `op-promote.js`)
- Create: `src/evolve/revert.js` (revertAutoEvolve)
- Create: `src/evolve/queries.js` (queryAutoEvolves, getAutoEvolve, getAutoEvolveStats)
- Create: `src/evolve/instinct-updater.js` (from `op-instinct-updater.js`)
- Create: `src/evolve/seed.js` (from `scripts/cl-seed-instincts.js`)
- Create: `src/evolve/export-events.js` (from `scripts/cl-export-events.js`)
- Create: `src/evolve/observer-prompt.md` (extract from `observer-loop.sh`)
- Modify: `src/op-auto-evolve.js` (shim)

- [ ] **Step 1: Create `src/evolve/` directory**

```bash
mkdir -p src/evolve
```

- [ ] **Step 2: Create `src/evolve/queries.js`**

Extract from `op-auto-evolve.js:236-268`: `queryAutoEvolves()`, `getAutoEvolve()`, `getAutoEvolveStats()`. No internal dependencies.

- [ ] **Step 3: Create `src/evolve/revert.js`**

Extract from `op-auto-evolve.js:213-230`: `revertAutoEvolve()`. No internal dependencies.

- [ ] **Step 4: Create `src/evolve/sync.js`**

Extract from `op-auto-evolve.js:107-155`: `UPSERT_SQL`, `syncInstincts()`. Update imports:
- `parseYamlFrontmatter` → `require('../lib/frontmatter').parseFrontmatter`
- `extractBody` → `require('../lib/frontmatter').extractBody`
- `makeId` stays local (only used here)

- [ ] **Step 5: Create `src/evolve/promote.js`**

Merge `op-auto-evolve.js:161-207` (runAutoEvolve) with `op-promote.js` (generateComponent). Use shared lib:
- `slugify` → `require('../lib/slugify').slugify`
- `getComponentPath` → `require('../lib/paths').getComponentPath`

Delete duplicate functions. Single `promote.js` exports both `runAutoEvolve()` and `generateComponent()`.

- [ ] **Step 6: Move `src/op-instinct-updater.js` → `src/evolve/instinct-updater.js`**

```bash
cp src/op-instinct-updater.js src/evolve/instinct-updater.js
```

Update `instinct-updater.js` to use `require('../lib/frontmatter')` instead of its local `parseFrontmatter` copy.

- [ ] **Step 7: Move `scripts/cl-seed-instincts.js` → `src/evolve/seed.js`**

```bash
cp scripts/cl-seed-instincts.js src/evolve/seed.js
```

Keep CLI logic (if `require.main === module`). No internal dependency changes needed.

- [ ] **Step 8: Move `scripts/cl-export-events.js` → `src/evolve/export-events.js`**

```bash
cp scripts/cl-export-events.js src/evolve/export-events.js
```

Keep CLI logic. No internal dependency changes needed.

- [ ] **Step 9: Extract `src/evolve/observer-prompt.md`**

Extract the Haiku prompt from `claude/skills/op-continuous-learning/agents/observer-loop.sh` lines 145-233 into a standalone markdown file. This is the prompt template for the observer.

- [ ] **Step 10: Replace `src/op-auto-evolve.js` with shim**

```javascript
'use strict';
// Shim: delegates to evolve/ during migration
const sync = require('./evolve/sync');
const promote = require('./evolve/promote');
const revert = require('./evolve/revert');
const queries = require('./evolve/queries');

module.exports = { ...sync, ...promote, ...revert, ...queries };
```

- [ ] **Step 11: Replace `src/op-instinct-updater.js` with shim**

```javascript
'use strict';
module.exports = require('./evolve/instinct-updater');
```

- [ ] **Step 12: Run tests**

Run: `node --test test/op-auto-evolve.test.js test/op-instinct-updater.test.js test/op-promote.test.js test/cl-seed-instincts.test.js test/cl-export-events.test.js`
Expected: all pass

- [ ] **Step 13: Commit**

```bash
git add src/evolve/ src/op-auto-evolve.js src/op-instinct-updater.js
git commit -m "refactor: create src/evolve/ — sync, promote, revert, queries, seed, export"
```

---

### Task 5: Create `src/knowledge/` — Split op-knowledge

**Files:**
- Create: `src/knowledge/extract.js` (extractKnowledgeFromPrompt)
- Create: `src/knowledge/vault.js` (renderVault)
- Create: `src/knowledge/scan.js` (runColdStartScan)
- Create: `src/knowledge/queries.js` (merge db/knowledge-entries + db/knowledge-sync)
- Modify: `src/op-knowledge.js` (shim)

- [ ] **Step 1: Read `src/op-knowledge.js` to identify split points**

Identify boundaries between extraction, vault, and scan logic.

- [ ] **Step 2: Create `src/knowledge/queries.js`**

Merge all functions from `db/knowledge-entries.js` and `db/knowledge-sync.js` into one file. These are tightly coupled and both operate on knowledge tables.

- [ ] **Step 3: Create `src/knowledge/extract.js`**

Extract Haiku invocation logic: `extractKnowledgeFromPrompt()` and helper functions. Update DB imports to use `./queries` instead of `../db/knowledge-entries`.

- [ ] **Step 4: Create `src/knowledge/vault.js`**

Extract vault rendering logic: `renderVault()` and related functions. Use `./queries` for DB access.

- [ ] **Step 5: Create `src/knowledge/scan.js`**

Extract cold-start scan logic: `runColdStartScan()` and file reading helpers. Use `../lib/format` for `isGitRepo()`.

- [ ] **Step 6: Replace `src/op-knowledge.js` with shim**

```javascript
'use strict';
// Shim: delegates to knowledge/ during migration
const extract = require('./knowledge/extract');
const vault = require('./knowledge/vault');
const scan = require('./knowledge/scan');

module.exports = { ...extract, ...vault, ...scan };
```

- [ ] **Step 7: Run tests**

Run: `node --test test/op-knowledge.test.js`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add src/knowledge/ src/op-knowledge.js src/db/knowledge-entries.js src/db/knowledge-sync.js
git commit -m "refactor: create src/knowledge/ — extract, vault, scan, queries"
```

---

### Task 6: Create `src/review/` — Move daily review

**Files:**
- Create: `src/review/pipeline.js` (from `scripts/op-daily-review.js`)
- Create: `src/review/context.js` (extracted from `scripts/op-daily-review.js`)
- Move: `scripts/op-daily-review-prompt.md` → `src/review/prompt.md`
- Create: `src/review/queries.js` (daily_reviews CRUD if any exist in route handlers)

- [ ] **Step 1: Read `scripts/op-daily-review.js` to identify split points**

Identify context-building logic vs orchestration logic.

- [ ] **Step 2: Create `src/review/context.js`**

Extract functions that read component files, build work history, assemble prompt context. Use `../lib/frontmatter`, `../lib/paths`, `../lib/format` instead of duplicated logic.

- [ ] **Step 3: Create `src/review/pipeline.js`**

Extract orchestration: `runDailyReview()` which calls context → Opus → save. Import `./context` for data gathering. Keep CLI entry point (`if require.main === module`).

- [ ] **Step 4: Move prompt template**

```bash
cp scripts/op-daily-review-prompt.md src/review/prompt.md
```

Update `pipeline.js` to read prompt from `./prompt.md` instead of `../scripts/op-daily-review-prompt.md`.

- [ ] **Step 5: Create `src/review/queries.js`**

Extract any daily_reviews table queries that currently live inline in route handlers into centralized query functions.

- [ ] **Step 6: Update `src/routes/daily-reviews.js`**

Change: `require('../../scripts/op-daily-review')` → `require('../review/pipeline')`

- [ ] **Step 7: Add shim at old path**

Replace `scripts/op-daily-review.js`:

```javascript
'use strict';
// Shim: delegates to src/review/ during migration
module.exports = require('../src/review/pipeline');
if (require.main === module) { require('../src/review/pipeline'); }
```

- [ ] **Step 8: Run tests**

Run: `node --test test/op-daily-review.test.js`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add src/review/ src/routes/daily-reviews.js scripts/op-daily-review.js
git commit -m "refactor: create src/review/ — pipeline, context, queries"
```

---

### Task 7: Split `src/routes/core.js`

**Files:**
- Create: `src/routes/health.js`
- Create: `src/routes/events.js`
- Create: `src/routes/prompts.js`
- Create: `src/routes/cost.js`
- Create: `src/routes/projects.js`
- Create: `src/routes/scanner.js`
- Create: `src/routes/config.js`
- Delete: `src/routes/core.js`
- Modify: `src/op-server.js` (register new routes)

- [ ] **Step 1: Read `src/routes/core.js` to map endpoints to files**

Group endpoints by domain.

- [ ] **Step 2: Create `src/routes/health.js`**

Extract: `GET /api/health`, `GET /api/overview`. Each route file is a Fastify plugin that receives `routeOpts` (db, helpers, etc).

- [ ] **Step 3: Create `src/routes/events.js`**

Extract: `GET /api/events`, `GET /api/sessions`, `GET /api/sessions/:id`.

- [ ] **Step 4: Create `src/routes/prompts.js`**

Extract: `GET /api/prompts`, `GET /api/prompts/:id`.

- [ ] **Step 5: Create `src/routes/cost.js`**

Extract: `GET /api/cost`, `GET /api/rankings/:category`.

- [ ] **Step 6: Create `src/routes/projects.js`**

Extract: `GET /api/projects`, `GET /api/projects/:id/summary`, `GET /api/projects/:id/timeline`, `DELETE /api/projects/:id`.

- [ ] **Step 7: Create `src/routes/scanner.js`**

Extract: `POST /api/scanner/run`, `GET /api/scanner/latest`, `GET /api/scanner/history`.

- [ ] **Step 8: Create `src/routes/config.js`**

Extract: `GET /api/config`, `PUT /api/config`, `GET /api/errors`, `POST /api/ingest`, legacy learning endpoints.

- [ ] **Step 9: Update `src/op-server.js`**

Replace single `require('./routes/core')` with 7 new route requires:

```javascript
app.register(require('./routes/health'), routeOpts);
app.register(require('./routes/events'), routeOpts);
app.register(require('./routes/prompts'), routeOpts);
app.register(require('./routes/cost'), routeOpts);
app.register(require('./routes/projects'), routeOpts);
app.register(require('./routes/scanner'), routeOpts);
app.register(require('./routes/config'), routeOpts);
app.register(require('./routes/inventory'), routeOpts);
app.register(require('./routes/knowledge'), routeOpts);
app.register(require('./routes/auto-evolves'), routeOpts);
app.register(require('./routes/daily-reviews'), routeOpts);
```

- [ ] **Step 10: Delete `src/routes/core.js`**

- [ ] **Step 11: Run tests**

Run: `node --test test/op-server.test.js`
Expected: all pass (same endpoints, just different files)

- [ ] **Step 12: Commit**

```bash
git add src/routes/ src/op-server.js
git commit -m "refactor: split routes/core.js into 7 domain-specific route files"
```

---

### Task 8: Rename `src/server.js` + update all direct consumers

**Files:**
- Rename: `src/op-server.js` → `src/server.js`
- Modify: `package.json` (start script)
- Modify: `test/op-server.test.js` (require path)

- [ ] **Step 1: Rename**

```bash
git mv src/op-server.js src/server.js
```

- [ ] **Step 2: Update `src/server.js` internal requires**

Update all `require('./op-*)` to new paths:
- `require('./op-db')` → `require('./db/schema')`
- `require('./op-knowledge')` → `require('./knowledge/extract')`
- `require('./op-ingest')` → `require('./ingest/pipeline')`
- `require('./op-retention')` → `require('./retention')`
- `require('./op-helpers')` → individual lib imports
- `require('./op-auto-evolve')` → `require('./evolve/sync')`, `require('./evolve/promote')`
- `require('./op-sync')` → `require('./ingest/sync')`

- [ ] **Step 3: Rename `src/op-retention.js` → `src/retention.js`**

```bash
git mv src/op-retention.js src/retention.js
```

- [ ] **Step 4: Update `package.json`**

```json
"start": "node src/server.js",
"test": "node --test 'test/**/*.test.js'",
"install-service": "bash scripts/install.sh",
"uninstall-service": "bash scripts/uninstall.sh"
```

- [ ] **Step 5: Update test require**

In `test/op-server.test.js`: `require('../src/op-server')` → `require('../src/server')`

- [ ] **Step 6: Run all tests**

Run: `node --test 'test/**/*.test.js'`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/server.js src/retention.js package.json test/
git commit -m "refactor: rename op-server.js → server.js, op-retention.js → retention.js"
```

---

### Task 9: Clean frontend

**Files:**
- Delete: `public/modules/learning-insights.js`
- Delete: `public/modules/projects.js` (shim)
- Rename: `public/modules/learning-projects.js` → `public/modules/projects.js`
- Modify: `public/modules/router.js` (import path already correct)

- [ ] **Step 1: Delete dead code**

```bash
rm public/modules/learning-insights.js
```

- [ ] **Step 2: Replace shim with actual module**

```bash
rm public/modules/projects.js
git mv public/modules/learning-projects.js public/modules/projects.js
```

- [ ] **Step 3: Verify router imports**

Read `public/modules/router.js` — it imports `./projects.js` which is now the renamed file. No changes needed.

- [ ] **Step 4: Verify browser works**

Start server: `node src/server.js`
Open: `http://127.0.0.1:3827/#projects`
Expected: projects page renders correctly.

- [ ] **Step 5: Commit**

```bash
git add public/modules/
git commit -m "refactor: remove dead frontend code, rename learning-projects → projects"
```

---

### Task 10: Restructure `test/` — Mirror `src/` directory

**Files:**
- Create directories: `test/db/`, `test/ingest/`, `test/evolve/`, `test/knowledge/`, `test/review/`, `test/routes/`
- Move all test files to new paths
- Update `require()` paths inside each test

- [ ] **Step 1: Create directories**

```bash
mkdir -p test/{db,ingest,evolve,knowledge,review,routes}
```

- [ ] **Step 2: Move test files**

```bash
git mv test/op-db.test.js test/db/schema.test.js
git mv test/op-ingest.test.js test/ingest/pipeline.test.js
git mv test/op-collector.test.js test/ingest/collector.test.js
git mv test/op-auto-evolve.test.js test/evolve/sync.test.js
git mv test/op-promote.test.js test/evolve/promote.test.js
git mv test/cl-seed-instincts.test.js test/evolve/seed.test.js
git mv test/cl-export-events.test.js test/evolve/export.test.js
git mv test/op-instinct-updater.test.js test/evolve/instinct.test.js
git mv test/op-knowledge.test.js test/knowledge/knowledge.test.js
git mv test/op-daily-review.test.js test/review/review.test.js
git mv test/op-server.test.js test/routes/routes.test.js
git mv test/op-learning-api.test.js test/routes/learning.test.js
git mv test/op-retention.test.js test/retention.test.js
git mv test/op-helpers.test.js test/helpers.test.js
git mv test/op-backfill-prompts.test.js test/backfill-prompts.test.js
```

- [ ] **Step 3: Update require paths in each test file**

Each test file needs updated `require()` calls. The pattern:
- `require('../src/op-db')` → `require('../../src/db/schema')` (for files in `test/db/`)
- `require('../src/op-auto-evolve')` → `require('../../src/evolve/sync')` (for files in `test/evolve/`)
- Similar for all other test files based on their new depth

Update each file's requires to point to the NEW module paths (not shims).

- [ ] **Step 4: Run all tests**

Run: `node --test 'test/**/*.test.js'`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "refactor: restructure test/ to mirror src/ directory layout"
```

---

### Task 11: Delete old files + shims + CL directory

**Files:**
- Delete: all shim files in `src/`
- Delete: `collector/` directory
- Delete: old `scripts/` files
- Delete: `claude/skills/op-continuous-learning/`
- Delete: `src/op-execute.js`

- [ ] **Step 1: Delete shim files**

```bash
rm src/op-helpers.js
rm src/op-db.js
rm src/op-ingest.js
rm src/op-sync.js
rm src/op-auto-evolve.js
rm src/op-instinct-updater.js
rm src/op-promote.js
```

- [ ] **Step 2: Delete dead code**

```bash
rm src/op-execute.js
```

- [ ] **Step 3: Delete old collector directory**

```bash
rm -rf collector/
```

- [ ] **Step 4: Delete moved scripts**

```bash
rm scripts/cl-seed-instincts.js
rm scripts/cl-export-events.js
rm scripts/op-daily-review.js
rm scripts/op-daily-review-prompt.md
```

- [ ] **Step 5: Rename remaining scripts**

```bash
git mv scripts/op-install.sh scripts/install.sh
git mv scripts/op-uninstall.sh scripts/uninstall.sh
git mv scripts/op-backfill-prompts.js scripts/backfill-prompts.js
```

- [ ] **Step 6: Update `scripts/register-hooks.js`**

Update the collector path reference from `collector/op-collector.js` to `src/ingest/collector.js`.

- [ ] **Step 7: Update `scripts/reset-db.js`**

Change: `require('../src/op-db')` → `require('../src/db/schema')`

- [ ] **Step 8: Update `scripts/backfill-prompts.js`**

Change: `require('../src/op-db')` → `require('../src/db/schema')`

- [ ] **Step 9: Delete CL directory**

```bash
rm -rf claude/skills/op-continuous-learning/
```

- [ ] **Step 10: Verify no references to old paths remain**

```bash
grep -r "op-helpers\|op-db\|op-ingest\|op-sync\|op-auto-evolve\|op-instinct-updater\|op-promote\|op-execute\|op-knowledge\|op-server\|op-retention\|cl-seed-instincts\|cl-export-events\|op-daily-review\|op-collector\|learning-insights\|learning-projects" src/ scripts/ test/ public/ --include="*.js" -l
```

Expected: zero results (or only `collector.js` within `src/ingest/` referencing itself).

- [ ] **Step 11: Run all tests**

Run: `node --test 'test/**/*.test.js'`
Expected: all pass

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: delete shims, dead code, and op-continuous-learning"
```

---

### Task 12: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update directory structure section**

Replace the current directory tree with the new structure reflecting all moves.

- [ ] **Step 2: Update architecture diagram**

Update the ASCII diagram to reference new file paths.

- [ ] **Step 3: Update file references throughout**

Search for any reference to old file names (`op-server.js`, `op-db.js`, etc.) and update.

- [ ] **Step 4: Update commands section**

```bash
npm start  # → node src/server.js
npm test   # → node --test 'test/**/*.test.js'
```

- [ ] **Step 5: Add observer config documentation**

Document the new observer config keys: `observer_enabled`, `observer_interval_ms`, `observer_min_events`.

- [ ] **Step 6: Remove CL references**

Remove references to `cl/` prefix convention, `op-continuous-learning`, and observer shell scripts.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for new directory structure"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full test suite**

```bash
node --test 'test/**/*.test.js'
```

Expected: all tests pass.

- [ ] **Step 2: Start server and verify**

```bash
node src/server.js &
curl http://127.0.0.1:3827/api/health
```

Expected: `{"status":"ok",...}`

- [ ] **Step 3: Verify all API endpoints**

```bash
curl http://127.0.0.1:3827/api/overview?period=30d
curl http://127.0.0.1:3827/api/auto-evolves
curl http://127.0.0.1:3827/api/knowledge/entries
curl http://127.0.0.1:3827/api/daily-reviews
```

Expected: all return valid JSON.

- [ ] **Step 4: Verify UI**

Open `http://127.0.0.1:3827/` — navigate all 8 pages, verify rendering.

- [ ] **Step 5: Re-install hooks and symlinks**

```bash
bash scripts/install.sh
```

Verify: `ls -la ~/.claude/skills/` shows 6 symlinks (no `op-continuous-learning`).
Verify: `cat ~/.claude/settings.json | grep ingest/collector` confirms new path.

- [ ] **Step 6: Grep for orphan references**

```bash
grep -r "require.*op-" src/ test/ scripts/ --include="*.js" | grep -v node_modules | grep -v ".test.js"
```

Expected: zero results.

- [ ] **Step 7: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve any remaining path references"
```
