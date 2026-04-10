# Knowledge Dedup & Quality Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix duplicate knowledge entries at the root cause — case-insensitive DB dedup, better LLM model, improved prompts, and scan context awareness.

**Architecture:** Four targeted fixes to the existing extraction pipeline. No new modules or architectural changes. DB migration deduplicates existing data and adds COLLATE NOCASE. Model upgrade from Haiku to Sonnet (configurable). Prompt engineering reduces noise. Scan flow gets existing titles + CLAUDE.md context.

**Tech Stack:** Node.js, better-sqlite3, Claude CLI

---

### Task 1: DB Migration — COLLATE NOCASE Index + Dedup Existing Entries

**Files:**
- Modify: `src/op-db.js:133-149` (schema section)
- Test: `test/op-db.test.js`

- [ ] **Step 1: Write failing test — COLLATE NOCASE unique index**

Add to `test/op-db.test.js` inside the `op-db` describe block:

```javascript
it('knowledge_entries unique index is case-insensitive', () => {
  // Insert an entry
  mod.insertKnowledgeEntry(db, {
    project_id: 'proj-nocase',
    category: 'domain',
    title: 'Case Test Entry',
    body: 'body',
  });

  // Inserting same title with different case should throw UNIQUE constraint
  assert.throws(() => {
    mod.insertKnowledgeEntry(db, {
      project_id: 'proj-nocase',
      category: 'domain',
      title: 'case test entry',
      body: 'body2',
    });
  }, /UNIQUE constraint/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-db.test.js --test-name-pattern "case-insensitive"`

Expected: FAIL — SQLite default BINARY collation allows both "Case Test Entry" and "case test entry"

- [ ] **Step 3: Add migration to recreate index with COLLATE NOCASE**

In `src/op-db.js`, add after the existing schema is applied (inside `createDb` or as a migration block). Find the section where migrations run and add:

```javascript
// Migration: case-insensitive unique index on knowledge_entries
const hasNocaseIndex = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_ke_project_title'"
).get();

if (hasNocaseIndex && !hasNocaseIndex.sql.includes('COLLATE NOCASE')) {
  // Dedup existing entries before rebuilding index
  const dupes = db.prepare(`
    SELECT LOWER(title) AS ltitle, project_id, GROUP_CONCAT(id) AS ids
    FROM knowledge_entries
    WHERE status = 'active'
    GROUP BY project_id, LOWER(title)
    HAVING COUNT(*) > 1
  `).all();

  for (const group of dupes) {
    const ids = group.ids.split(',');
    // Keep the one with latest updated_at
    const rows = db.prepare(
      `SELECT id FROM knowledge_entries WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC`
    ).all(...ids);
    // Delete all except the first (newest)
    const toDelete = rows.slice(1).map(r => r.id);
    if (toDelete.length > 0) {
      db.prepare(
        `DELETE FROM knowledge_entries WHERE id IN (${toDelete.map(() => '?').join(',')})`
      ).run(...toDelete);
    }
  }

  db.exec('DROP INDEX IF EXISTS idx_ke_project_title');
  db.exec('CREATE UNIQUE INDEX idx_ke_project_title ON knowledge_entries(project_id, title COLLATE NOCASE)');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-db.test.js --test-name-pattern "case-insensitive"`

Expected: PASS

- [ ] **Step 5: Write test — migration deduplicates existing entries**

Add to `test/op-db.test.js`:

```javascript
it('migration deduplicates case-insensitive title duplicates', () => {
  // Clean slate for this test
  db.prepare("DELETE FROM knowledge_entries WHERE project_id = 'proj-dedup-mig'").run();

  mod.insertKnowledgeEntry(db, {
    project_id: 'proj-dedup-mig',
    category: 'domain',
    title: 'Migration Dedup Test',
    body: 'first',
  });

  // Same title, different case — should fail due to COLLATE NOCASE
  assert.throws(() => {
    mod.insertKnowledgeEntry(db, {
      project_id: 'proj-dedup-mig',
      category: 'domain',
      title: 'migration dedup test',
      body: 'second',
    });
  }, /UNIQUE constraint/);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/op-db.test.js --test-name-pattern "deduplicates"`

Expected: PASS

- [ ] **Step 7: Run full test suite to check no regressions**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/op-db.js test/op-db.test.js
git commit -m "feat: add COLLATE NOCASE migration for knowledge_entries dedup"
```

---

### Task 2: Case-Insensitive Upsert in knowledge-entries.js

**Files:**
- Modify: `src/db/knowledge-entries.js:60-63`
- Test: `test/op-knowledge.test.js`

- [ ] **Step 1: Write failing test — upsert matches case-insensitively**

Add to `test/op-knowledge.test.js` inside the `upsertKnowledgeEntry` section:

```javascript
it('upsertKnowledgeEntry matches existing entry case-insensitively', () => {
  // Insert with Title Case
  const first = dbMod.upsertKnowledgeEntry(db, {
    project_id: 'proj-ke-test',
    category: 'convention',
    title: 'Case Insensitive Upsert Test',
    body: 'Original body.',
  });

  // Wait 1ms to ensure updated_at differs
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  // Upsert with lowercase — should UPDATE, not INSERT
  const second = dbMod.upsertKnowledgeEntry(db, {
    project_id: 'proj-ke-test',
    category: 'convention',
    title: 'case insensitive upsert test',
    body: 'Updated body via case-variant title.',
  });

  // Should reuse the same id
  assert.equal(second.id, first.id, 'should match the same entry regardless of case');

  // DB should reflect the update
  const fetched = dbMod.getKnowledgeEntry(db, first.id);
  assert.equal(fetched.body, 'Updated body via case-variant title.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "case-insensitively"`

Expected: FAIL — current upsert creates a new entry instead of updating

- [ ] **Step 3: Add COLLATE NOCASE to upsert lookup**

In `src/db/knowledge-entries.js`, change line 61-63:

```javascript
// Before:
const existing = db.prepare(
  'SELECT * FROM knowledge_entries WHERE project_id = @project_id AND title = @title'
).get({ project_id: entry.project_id, title: entry.title });

// After:
const existing = db.prepare(
  'SELECT * FROM knowledge_entries WHERE project_id = @project_id AND title = @title COLLATE NOCASE'
).get({ project_id: entry.project_id, title: entry.title });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "case-insensitively"`

Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/db/knowledge-entries.js test/op-knowledge.test.js
git commit -m "feat: case-insensitive upsert for knowledge entries"
```

---

### Task 3: Configurable Model for callClaude

**Files:**
- Modify: `src/op-knowledge.js:195-224` (callClaude function)
- Modify: `src/op-knowledge.js:505-546` (extractKnowledgeFromPrompt)
- Modify: `src/op-knowledge.js:562-623` (scanProject)
- Modify: `src/op-server.js:63-68` (setKnowledgeHook call)
- Modify: `src/routes/knowledge.js:74-82` (scan route)
- Modify: `config.json`

- [ ] **Step 1: Add `knowledge_model` to config.json**

In `config.json`, add after the `knowledge_max_tokens` line:

```json
"knowledge_model": "sonnet",
```

- [ ] **Step 2: Update callClaude to accept model parameter**

In `src/op-knowledge.js`, change `callClaude` signature (line 195):

```javascript
// Before:
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', 'haiku', '--no-session-persistence'];

// After:
function callClaude(prompt, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--no-session-persistence'];
```

- [ ] **Step 3: Pass model from opts in extractKnowledgeFromPrompt**

In `src/op-knowledge.js`, in `extractKnowledgeFromPrompt` (line 506-507):

```javascript
// Before:
const maxEvents = opts.maxEvents ?? 50;

// After:
const maxEvents = opts.maxEvents ?? 50;
const model = opts.model || 'sonnet';
```

And line 534:

```javascript
// Before:
const rawResponse = await callClaude(llmPrompt);

// After:
const rawResponse = await callClaude(llmPrompt, model);
```

- [ ] **Step 4: Pass model from opts in scanProject**

In `src/op-knowledge.js`, in `scanProject` after line 562:

```javascript
// Add after existing opts destructuring:
const model = opts.model || 'sonnet';
```

And line 613:

```javascript
// Before:
const rawResponse = await callClaude(llmPrompt);

// After:
const rawResponse = await callClaude(llmPrompt, model);
```

- [ ] **Step 5: Pass knowledge_model from config in op-server.js**

In `src/op-server.js`, update the `setKnowledgeHook` call (line 64):

```javascript
// Before:
setKnowledgeHook(extractKnowledgeFromPrompt, {
  maxTokens: config.knowledge_max_tokens ?? 1000,
  maxEvents: config.knowledge_max_events_per_prompt ?? 50,
});

// After:
setKnowledgeHook(extractKnowledgeFromPrompt, {
  maxTokens: config.knowledge_max_tokens ?? 1000,
  maxEvents: config.knowledge_max_events_per_prompt ?? 50,
  model: config.knowledge_model || 'sonnet',
});
```

- [ ] **Step 6: Pass model in scan route**

In `src/routes/knowledge.js`, update the `scanProject` call (line 77):

```javascript
// Before:
const result = await scanProject(db, project_id, {
  scanFiles: scan_files || config.knowledge_scan_files || ['README.md', 'package.json', 'CLAUDE.md'],
  patterns:  patterns  || config.knowledge_scan_patterns || [],
});

// After:
const result = await scanProject(db, project_id, {
  scanFiles: scan_files || config.knowledge_scan_files || ['README.md', 'package.json', 'CLAUDE.md'],
  patterns:  patterns  || config.knowledge_scan_patterns || [],
  model: config.knowledge_model || 'sonnet',
});
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`

Expected: All tests pass (callClaude is only called in real extraction, not in unit tests)

- [ ] **Step 8: Commit**

```bash
git add src/op-knowledge.js src/op-server.js src/routes/knowledge.js config.json
git commit -m "feat: configurable model for knowledge extraction (default sonnet)"
```

---

### Task 4: Improve Extract Prompt Quality Rules

**Files:**
- Modify: `src/op-knowledge.js:120-143` (buildExtractPrompt rules section)
- Test: `test/op-knowledge.test.js`

- [ ] **Step 1: Write failing test — extract prompt includes quality rules**

Add to `test/op-knowledge.test.js` inside the `buildExtractPrompt` describe:

```javascript
it('includes quality rules that reject generic and descriptive entries', () => {
  const prompt = buildExtractPrompt('Proj', [], []);
  assert.ok(prompt.includes('CANNOT be derived by reading the source code'), 'should require non-obvious knowledge');
  assert.ok(prompt.includes('Do NOT extract'), 'should have exclusion rules');
  assert.ok(prompt.includes('ACTIONABLE'), 'should require actionable entries');
});

it('instructs case-insensitive dedup in rules', () => {
  const prompt = buildExtractPrompt('Proj', [], ['Existing Title']);
  assert.ok(prompt.includes('case-insensitive'), 'should mention case-insensitive comparison');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "quality rules|case-insensitive dedup in rules"`

Expected: FAIL

- [ ] **Step 3: Replace rules section in buildExtractPrompt**

In `src/op-knowledge.js`, replace lines 136-141 (the Rules block in the `return` array of `buildExtractPrompt`):

```javascript
// Before:
    'Rules:',
    '- Only extract knowledge that is reusable across sessions (not just what happened)',
    '- Skip trivial actions (reading a README, listing files)',
    '- Skip anything already in the existing titles list',
    '- Return [] if nothing reusable is found',

// After:
    'Rules:',
    '- Only extract knowledge that CANNOT be derived by reading the source code directly',
    '- Focus on: WHY decisions were made, gotchas/footguns encountered, non-obvious conventions,',
    '  edge cases discovered during development, integration quirks',
    '- Do NOT extract: file/module descriptions, API endpoint lists, tech stack enumerations,',
    '  database schema descriptions, configuration key listings, generic programming best practices',
    '- Skip anything already in the existing titles list (compare case-insensitively)',
    '- Each entry must be ACTIONABLE — it should change how a developer approaches the code,',
    '  not just describe what exists',
    '- Prefer updating an existing entry over creating a near-duplicate',
    '- Return [] if nothing genuinely new and reusable is found (this is the expected common case)',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "quality rules|case-insensitive dedup in rules"`

Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/op-knowledge.js test/op-knowledge.test.js
git commit -m "feat: improve extract prompt with quality rules to reduce noise"
```

---

### Task 5: Fix Scan Prompt — Add Existing Titles + CLAUDE.md Context

**Files:**
- Modify: `src/op-knowledge.js:157-182` (buildScanPrompt)
- Modify: `src/op-knowledge.js:562-623` (scanProject)
- Test: `test/op-knowledge.test.js`

- [ ] **Step 1: Write failing tests — scan prompt includes existing titles and CLAUDE.md**

Add to `test/op-knowledge.test.js` inside the `buildScanPrompt` describe:

```javascript
it('includes existing titles when provided', () => {
  const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' }, ['Existing Entry A', 'Existing Entry B']);
  assert.ok(prompt.includes('Existing Entry A'), 'should include existing title A');
  assert.ok(prompt.includes('Existing Entry B'), 'should include existing title B');
  assert.ok(prompt.includes('avoid duplicating'), 'should instruct to avoid duplicates');
});

it('includes CLAUDE.md content when provided', () => {
  const claudeMd = '# Project Guide\n\n## Architecture\nHook -> JSONL -> DB';
  const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' }, [], claudeMd);
  assert.ok(prompt.includes('Hook -> JSONL -> DB'), 'should include CLAUDE.md content');
  assert.ok(prompt.includes('Already documented'), 'should label as already documented');
});

it('includes quality rules matching extract prompt', () => {
  const prompt = buildScanPrompt('Proj', { 'README.md': '# Hello' });
  assert.ok(prompt.includes('CANNOT be derived by reading the source code'), 'should include quality rules');
  assert.ok(prompt.includes('ACTIONABLE'), 'should require actionable entries');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "existing titles when provided|CLAUDE.md content|quality rules matching"`

Expected: FAIL

- [ ] **Step 3: Replace buildScanPrompt function**

In `src/op-knowledge.js`, replace the entire `buildScanPrompt` function (lines 157-182):

```javascript
function buildScanPrompt(projectName, files, existingTitles = [], claudeMdContent = '') {
  const fileBlocks = Object.entries(files).map(([name, content]) => {
    return `### ${name}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');

  const claudeBlock = claudeMdContent
    ? [
        '',
        '### Already documented in CLAUDE.md (DO NOT extract knowledge that overlaps with this):',
        '```',
        claudeMdContent.slice(0, 3000),
        '```',
        '',
      ].join('\n')
    : '';

  const existingBlock = existingTitles.length
    ? `\nExisting knowledge titles (avoid duplicating these — compare case-insensitively):\n${existingTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

  return [
    `Project: ${projectName}`,
    '',
    'Perform a comprehensive knowledge extraction from the following project files.',
    'Extract everything that helps understand the project: domain, stack, schema,',
    'API contracts, architectural decisions, conventions, footguns, and error patterns.',
    claudeBlock,
    existingBlock,
    fileBlocks,
    '',
    'Extract knowledge entries as a JSON array. Each entry:',
    '  { "category": "<category>", "title": "<short title>", "body": "<detailed explanation>",',
    '    "source_file": "<file path if relevant, else null>", "tags": ["<tag>", ...] }',
    '',
    'Valid categories: domain, stack, schema, api, feature, architecture, convention,',
    '                  decision, footgun, contract, error_pattern',
    '',
    'Rules:',
    '- Only extract knowledge that CANNOT be derived by reading the source code directly',
    '- Focus on: WHY decisions were made, gotchas/footguns encountered, non-obvious conventions,',
    '  edge cases discovered during development, integration quirks',
    '- Do NOT extract: file/module descriptions, API endpoint lists, tech stack enumerations,',
    '  database schema descriptions, configuration key listings, generic programming best practices',
    '- Skip anything already in the existing titles list (compare case-insensitively)',
    '- Each entry must be ACTIONABLE — it should change how a developer approaches the code,',
    '  not just describe what exists',
    '- Prefer updating an existing entry over creating a near-duplicate',
    '- Return [] if nothing genuinely new and reusable is found',
    '',
    'Respond with a JSON array only. No explanation.',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "existing titles when provided|CLAUDE.md content|quality rules matching"`

Expected: PASS

- [ ] **Step 5: Verify existing buildScanPrompt tests still pass**

Run: `node --test test/op-knowledge.test.js --test-name-pattern "buildScanPrompt"`

Expected: All buildScanPrompt tests PASS (default params are backward compatible)

- [ ] **Step 6: Update scanProject to pass context to LLM**

In `src/op-knowledge.js`, in `scanProject`, replace lines 611-612:

```javascript
// Before:
  const projectName = project.name || projectId;
  const llmPrompt = buildScanPrompt(projectName, files);

// After:
  const projectName = project.name || projectId;
  const existingTitles = getExistingTitles(db, projectId);

  let claudeMdContent = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  try { claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8').slice(0, 3000); } catch { /* skip */ }

  const llmPrompt = buildScanPrompt(projectName, files, existingTitles, claudeMdContent);
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/op-knowledge.js test/op-knowledge.test.js
git commit -m "feat: scan prompt includes existing titles, CLAUDE.md, and quality rules"
```

---

### Task 6: Full Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: All 274+ tests pass

- [ ] **Step 2: Restart server and verify health**

Stop any running server, then start:

Run: `npm start` (background)
Then: `curl -s http://127.0.0.1:3827/api/health`

Expected: Server starts, health endpoint returns OK with event count

- [ ] **Step 3: Verify dedup migration ran on real DB**

Run: `sqlite3 open-pulse.db "SELECT COUNT(*) as dupes FROM (SELECT LOWER(title), project_id FROM knowledge_entries WHERE status='active' GROUP BY project_id, LOWER(title) HAVING COUNT(*)>1)"`

Expected: `0` — no case-insensitive duplicates remain

- [ ] **Step 4: Verify COLLATE NOCASE index exists**

Run: `sqlite3 open-pulse.db "SELECT sql FROM sqlite_master WHERE name='idx_ke_project_title'"`

Expected: Output includes `COLLATE NOCASE`

- [ ] **Step 5: Verify config has knowledge_model**

Run: `node -p "require('./config.json').knowledge_model"`

Expected: `sonnet`
