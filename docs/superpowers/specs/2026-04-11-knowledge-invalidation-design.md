# Knowledge Entry Invalidation — Design Spec

## Context

Knowledge entries extracted by the LLM become stale when the underlying code changes. The extraction prompt tells the LLM to "avoid duplicating" existing titles, which prevents updates to entries with outdated facts. There is no mechanism to detect or flag entries whose content contradicts current source code.

Example: `extract.js` was changed from `model = 'haiku'` to `model = 'sonnet'`, but 9 knowledge entries and CLAUDE.md still reference "Haiku" because the extraction prompt never told the LLM to update them.

## Root Causes

1. **Extraction prompt blocks updates** — `existingTitles` tells LLM "avoid duplicating these" without providing entry content, so LLM cannot detect contradictions
2. **SKILL.md has no UPDATE semantics** — only describes how to create new entries, never when to update existing ones
3. **Daily review ignores knowledge entries** — reviews rules/skills/agents but never checks if knowledge entries match current code

## Solution: Two Complementary Mechanisms

### A. Fix Extraction Prompt (Prevention)

**Goal:** When extraction runs after a code change, the LLM sees relevant existing entries and updates them if facts have changed.

#### A1. Change `buildExtractPrompt()` in `src/knowledge/extract.js`

Currently sends:
```
Existing knowledge titles (avoid duplicating these):
- Knowledge Extraction Pipeline
- Node.js built-in test runner used
```

New behavior — send context-aware entries:

1. Extract affected file paths from events (`tool_input.file_path`)
2. Query entries where `source_file` matches any affected file → send **full body**
3. Query remaining active entries → send **title + first 100 chars of body**
4. Change wording from "avoid duplicating" to "update if facts have changed"

New prompt block:
```
Related entries (UPDATE these if the events above contradict their content — emit
the same title with corrected body to trigger an update):
- "Knowledge Extraction Pipeline" [source: src/knowledge/extract.js]
  Body: After each prompt ingestion, Haiku extracts project-specific understanding...

Other entries (update if clearly contradicted, otherwise skip):
- "Frontend SPA and API..." — When adding new frontend API calls or routes, the @f...
```

New helper function: `buildExistingEntriesBlock(db, projectId, affectedFiles)`
- Queries entries with `source_file IN (affectedFiles)` → full body
- Queries remaining active entries → title + body.slice(0, 100)
- Returns formatted prompt block

#### A2. Update `claude/skills/knowledge-entry-format/SKILL.md`

Add a section on update semantics:
```
## Updating Existing Entries

If an event contradicts facts in an existing entry, you MUST re-emit that entry
with the SAME title and a corrected body. The system uses title-based upsert —
same title = update, not duplicate.

Do NOT skip an entry just because its title already exists. Skip only when the
existing content is still accurate.
```

### B. Daily Review Integration (Safety Net)

**Goal:** Daily review at 3AM detects entries whose content contradicts their source files, creates suggestions for human review.

#### B1. Add knowledge context to `src/review/context.js`

New function: `getKnowledgeReviewContext(db)`

1. Query all active entries that have a `source_file`
2. For each entry, read the actual source file from disk (skip if file missing/deleted)
3. Return array of `{ entry_id, title, body_excerpt, source_file, source_content_excerpt }` (cap source content at 500 chars)
4. Cap total entries at 30 to limit token usage

This context is appended to the existing review context passed to Opus.

#### B2. Update `src/review/prompt.md`

Add section:
```
## Knowledge Entry Validation

Compare each knowledge entry's body against its source_file content.
Flag entries where:
- The entry states facts that contradict the current source code
- The source_file has been deleted or renamed
- The entry references APIs, functions, or patterns that no longer exist

For each stale entry, create a suggestion with:
- category: "knowledge"
- target_type: "knowledge"
- action: description of what's wrong and what the correct fact is
- confidence: 0.0-1.0 based on how clearly the entry contradicts the code
```

#### B3. Output

Daily review creates `daily_reviews` rows with `category = 'knowledge'`. These appear in the existing Daily Review UI — user can accept or dismiss.

No auto-modification of entries. Human decides.

## Files to Modify

| File | Change |
|---|---|
| `src/knowledge/extract.js` | Replace `existingTitles` block with context-aware entries block in `buildExtractPrompt()`. Add `buildExistingEntriesBlock()` helper |
| `claude/skills/knowledge-entry-format/SKILL.md` | Add "Updating Existing Entries" section |
| `src/review/context.js` | Add `getKnowledgeReviewContext()` function |
| `src/review/prompt.md` | Add "Knowledge Entry Validation" section |
| `test/knowledge/knowledge.test.js` | Tests for `buildExistingEntriesBlock()` |

## Verification

### Part A — Extraction fix
1. Run extraction on a prompt where events touch `src/knowledge/extract.js`
2. Verify the extraction prompt includes full body of related entries
3. Verify LLM updates the entry with corrected facts (Sonnet instead of Haiku)
4. Check `knowledge_entry_history` records the change

### Part B — Daily review
1. Create a deliberately stale entry (body says "Haiku", source says "sonnet")
2. Trigger daily review via `POST /api/daily-reviews/run`
3. Verify a suggestion with `category: 'knowledge'` is created
4. Verify the suggestion describes the contradiction
5. Check Daily Review UI shows the suggestion

## Out of Scope

- Automatic entry modification (human decides)
- TTL / expiration-based invalidation
- Validation cycle timer (daily review is sufficient)
- Updating CLAUDE.md content (separate concern)
