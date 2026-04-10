# Knowledge Extraction Dedup & Quality Fix

## Problem

216 knowledge entries with ~75% noise:
- **56 entries** are case-insensitive duplicates (28 pairs) — DB upsert uses exact match
- **~40 entries** duplicate CLAUDE.md content verbatim
- **~60 entries** are generic best practices (not project-specific)
- **Cold-start scan** doesn't pass existing titles or CLAUDE.md to LLM
- **Haiku** lacks judgment to distinguish project-specific vs generic knowledge

## Root Causes

1. **Case-sensitive upsert** — `WHERE title = @title` (SQLite BINARY collation) treats "op- prefix" ≠ "op- Prefix"
2. **Scan has no dedup context** — `buildScanPrompt()` omits existing titles and CLAUDE.md
3. **Haiku too weak** — insufficient judgment for quality filtering
4. **Prompt too permissive** — no rules against duplicating CLAUDE.md or extracting generic patterns

## Solution: Approach A + Sonnet

Fix all 4 root causes with minimal architectural change.

### 1. DB Layer — Case-Insensitive Unique Index

**File: `src/op-db.js`**

Add migration to recreate the unique index with `COLLATE NOCASE`:

```sql
DROP INDEX IF EXISTS idx_ke_project_title;
CREATE UNIQUE INDEX idx_ke_project_title
  ON knowledge_entries(project_id, title COLLATE NOCASE);
```

**File: `src/db/knowledge-entries.js`**

`upsertKnowledgeEntry()` — add COLLATE NOCASE to lookup query:

```javascript
const existing = db.prepare(
  'SELECT * FROM knowledge_entries WHERE project_id = @project_id AND title = @title COLLATE NOCASE'
).get({ project_id: entry.project_id, title: entry.title });
```

`getExistingTitles()` — no change needed (returns titles as-is for LLM context).

### 2. Model Upgrade — Haiku → Sonnet (configurable)

**File: `src/op-knowledge.js`**

`callClaude(prompt, model)` — accept model parameter:

```javascript
function callClaude(prompt, model = 'sonnet') {
  const args = ['-p', '--model', model, '--no-session-persistence'];
  // ... rest unchanged
}
```

Callers pass `config.knowledge_model` (default: `'sonnet'`).

**File: `config.json`**

Add `knowledge_model` field:

```json
{ "knowledge_model": "sonnet" }
```

**Cost impact**: ~$0.08/day (4x Haiku) at 50 prompts/day. Acceptable.

### 3. Prompt Engineering — Quality Rules

**File: `src/op-knowledge.js`**

#### 3a. `buildExtractPrompt()` — replace rules section

Current rules:
```
- Only extract knowledge that is reusable across sessions (not just what happened)
- Skip trivial actions (reading a README, listing files)
- Skip anything already in the existing titles list
- Return [] if nothing reusable is found
```

New rules:
```
Rules:
- Only extract knowledge that CANNOT be derived by reading the source code directly
- Focus on: WHY decisions were made, gotchas/footguns encountered, non-obvious conventions,
  edge cases discovered during development, integration quirks
- Do NOT extract: file/module descriptions, API endpoint lists, tech stack enumerations,
  database schema descriptions, configuration key listings, generic programming best practices
- Skip anything already in the existing titles list (compare case-insensitively)
- Each entry must be ACTIONABLE — it should change how a developer approaches the code,
  not just describe what exists
- Prefer updating an existing entry's knowledge over creating a near-duplicate
- Return [] if nothing genuinely new and reusable is found (this is the expected common case)
```

#### 3b. `buildScanPrompt()` — add existing titles + CLAUDE.md context

Current signature: `buildScanPrompt(projectName, files)`

New signature: `buildScanPrompt(projectName, files, existingTitles, claudeMdContent)`

Add two blocks to the prompt:

1. CLAUDE.md content block (truncated to 3000 chars):
```
### Already documented in CLAUDE.md (DO NOT extract knowledge that overlaps with this):
```

2. Existing titles block (same format as extractPrompt):
```
Existing knowledge titles (avoid duplicating these — compare case-insensitively):
```

Add same quality rules as extractPrompt.

### 4. Scan Flow — Pass Context

**File: `src/op-knowledge.js`**

`scanProject()` — read existing titles and CLAUDE.md before calling LLM:

```javascript
// Before building prompt (after reading files):
const existingTitles = getExistingTitles(db, projectId);

// Read CLAUDE.md if it exists
let claudeMdContent = '';
const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
try { claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8').slice(0, 3000); } catch { /* skip */ }

const llmPrompt = buildScanPrompt(projectName, files, existingTitles, claudeMdContent);
```

### 5. One-Time Cleanup Migration

Script to deduplicate existing entries:

1. Find all case-insensitive duplicate groups:
   ```sql
   SELECT LOWER(title) AS ltitle, GROUP_CONCAT(id) AS ids, COUNT(*) AS cnt
   FROM knowledge_entries
   WHERE status = 'active'
   GROUP BY project_id, LOWER(title)
   HAVING cnt > 1
   ```
2. For each group: keep the entry with latest `updated_at`, delete the rest
3. Re-render vault for affected projects

This runs as part of the DB migration (not a separate script).

### 6. Config Schema Update

Add to config.json defaults and validation:

| Key | Default | Purpose |
|---|---|---|
| `knowledge_model` | `"sonnet"` | Model for knowledge extraction (haiku/sonnet/opus) |

## Files Changed

| File | Change |
|---|---|
| `src/op-db.js` | Migration: recreate unique index COLLATE NOCASE + dedup existing entries |
| `src/db/knowledge-entries.js` | `upsertKnowledgeEntry()` COLLATE NOCASE lookup |
| `src/op-knowledge.js` | `callClaude()` accepts model param; `buildExtractPrompt()` new rules; `buildScanPrompt()` accepts existingTitles + claudeMd; `scanProject()` passes context |
| `config.json` | Add `knowledge_model: "sonnet"` |
| `test/op-db.test.js` | Test migration, COLLATE NOCASE dedup |
| `test/op-knowledge.test.js` | Test case-insensitive dedup, new prompt content, scan with context |

## Not Changed

- Overall flow (hook → ingest → extract → vault) — unchanged
- Entries auto-active (no pending/review gate)
- Vault rendering logic — unchanged
- API endpoints — unchanged
- Frontend — unchanged

## Expected Outcome

- Zero case-insensitive duplicates going forward (hard DB constraint)
- ~70-80% useful entries (up from ~25%) due to Sonnet + better prompts
- Scan no longer creates blind duplicates
- CLAUDE.md content not re-extracted into entries
- Existing 56 duplicates cleaned up by migration
