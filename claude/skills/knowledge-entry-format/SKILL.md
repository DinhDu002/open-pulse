---
name: knowledge-entry-format
description: Defines the required format and quality standards for knowledge entries extracted by the Open Pulse knowledge system. Use this skill whenever building prompts for LLM-based knowledge extraction (post-ingest or cold-start scan), when manually creating knowledge entries, or when validating entry quality. This is the single source of truth for entry structure — the extraction pipeline reads this file at runtime and injects it into Sonnet prompts.
---

# Knowledge Entry Format

This document defines the structure, quality bar, and validation rules for knowledge entries in Open Pulse. It serves two purposes:

1. **Machine use**: The extraction pipeline (`src/knowledge/extract.js`, `src/knowledge/scan.js`) reads this file and injects the template section into prompts sent to Sonnet.
2. **Human use**: Developers can reference this when manually creating or reviewing entries.

## Why Structure Matters

Knowledge entries are loaded into Claude's context on every session via `.claude/knowledge/index.md`. Every entry costs tokens. Unstructured or descriptive entries waste context without changing behavior. The format below optimizes for **scannability** (summary-first), **actionability** (consequence-driven), and **token efficiency** (compact, no fluff).

## Entry JSON Schema

```json
{
  "category": "<one of the valid categories>",
  "title": "<short noun phrase>",
  "body": "<structured text following the 3-part template>",
  "source_file": "<most relevant file path, or null>",
  "tags": ["<from controlled vocabulary>"]
}
```

## Title Rules

- Short noun phrase, sentence case, max 80 characters
- Describe the **insight**, not the topic
- Must pass the "so what?" test — if the title could be a file name or section heading, it's too generic

**Good titles:**
- "JSONL ingestion leaves .processing files on server crash"
- "Advisory locks require PostgreSQL — not portable to MySQL"
- "Re-running backfill script creates duplicate prompt records"

**Bad titles (do NOT use these patterns):**
- "12 Core Database Tables" (just a description of what exists)
- "Technology Stack" (a topic, not an insight)
- "API Endpoints" (belongs in CLAUDE.md, not knowledge entries)
- "Best Practices for Error Handling" (generic, not project-specific)

## Body Template

Every entry body MUST follow this 3-part structure:

```
[Trigger]: One sentence — WHEN this knowledge becomes relevant.
[Detail]: 2-4 sentences — the non-obvious behavior, constraint, or decision
          that you cannot learn by reading the source code alone.
[Consequence]: "Consequence: ..." — what breaks, fails, or gets harder if ignored.
```

### Example — footgun category

```
When the server crashes during JSONL ingestion, .processing files are left behind.
The ingestion pipeline renames .jsonl to .processing before reading. After 3 failed
retries the file is marked .failed and never retried automatically. There is no
alerting or monitoring for .failed files.
Consequence: silent data loss for that batch — manual rename to .jsonl required.
```

### Example — decision category

```
When choosing a database for this project, the team evaluated SQLite vs PostgreSQL.
SQLite was chosen because the system is single-user, runs locally, and needs zero
setup. The WAL mode + 3s busy timeout handles concurrent reads from the server and
ingestion timer without conflict.
Consequence: migrating to PostgreSQL would require replacing all better-sqlite3 calls
and the synchronous transaction pattern used in migrations.
```

### Example — convention category

```
When adding a new backend module, follow the op- prefix naming convention.
All main backend files use the op- prefix (op-server, op-ingest, op-knowledge) to
avoid naming conflicts with node_modules and make project files instantly recognizable
in search results and imports.
Consequence: files without the prefix get lost in search noise and confuse new contributors.
```

### Example — error_pattern category

```
When the daily review CLI times out, the partial output is lost with no recovery.
The daily review spawns claude CLI with a 300s timeout. If Opus takes longer (common
for large component sets), the process is killed and no partial results are saved.
The review must be re-triggered manually via POST /api/daily-reviews/run.
Consequence: wasted API cost with no output — consider reducing component set size.
```

## Category-Specific Guidance

| Category | Opening pattern | Focus on |
|---|---|---|
| **decision** | "When choosing/designing X..." | WHY this option, what alternatives existed, what trade-offs were accepted |
| **footgun** | "When X happens/fails..." | The trap, how it manifests, the correct approach |
| **convention** | "When adding/creating/modifying X..." | The non-obvious rule, why it exists |
| **error_pattern** | "When X fails/times out..." | Symptom, root cause, recovery steps |
| **contract** | "When calling/using X..." | Input/output constraints not obvious from code |
| **architecture** | "When X communicates with Y..." | Integration quirks, not just topology |
| **domain** | "In this project, X means..." | Domain-specific meanings that differ from common usage |
| **schema** | "The X table/column..." | Non-obvious constraints, relationships, or migration history |
| **api** | "The X endpoint..." | Undocumented behavior, rate limits, error codes |
| **feature** | "The X feature..." | Non-obvious interactions, limitations, or prerequisites |
| **stack** | "This project uses X because..." | WHY this technology, what constraint drove the choice |

## Controlled Tag Vocabulary

Tags MUST be chosen from this list only — do NOT invent new tags:

```
backend, frontend, database, api, testing, deployment,
config, security, performance, migration, cli, hooks
```

Pick 1-3 tags per entry. Choose based on which part of the system is affected, not what the entry is about.

## What NOT to Extract

These should be rejected, not stored:

- **File/module descriptions** — "op-server.js handles HTTP routing" (read the code)
- **API endpoint lists** — already in CLAUDE.md
- **Tech stack enumerations** — already in package.json and CLAUDE.md
- **Database schema descriptions** — code is the source of truth
- **Configuration key listings** — already in config.json and CLAUDE.md
- **Generic programming best practices** — the model already knows these
- **Anything already documented in CLAUDE.md** — check before extracting

## The Actionability Test

Before accepting an entry, apply this test:

> "Would reading this entry change how a developer approaches the code?"

- YES: "Re-running backfill creates duplicates" changes behavior (developer won't re-run it)
- NO: "The system has 12 database tables" doesn't change anything (developer would discover this naturally)

If the answer is NO, reject the entry.

## Updating Existing Entries

When analyzing events, you may discover that an existing entry contains outdated or incorrect facts. In that case, you MUST re-emit the entry with the **same title** and a corrected body. The system uses title-based upsert — same title triggers an update, not a duplicate.

**When to update:**
- Events show a configuration, model, or behavior has changed (e.g., model changed from Haiku to Sonnet)
- Events show a file was refactored and an entry's description no longer matches
- Events show an API endpoint, function signature, or schema has changed

**When NOT to update:**
- The existing entry is still accurate based on the events you see
- You're unsure whether the entry is outdated — leave it for human review

**How to update:** Emit a JSON entry with the exact same title as the existing entry. The body should contain the corrected facts following the same 3-part template (Trigger, Detail, Consequence).

## Validation Rules (for code enforcement)

After LLM extraction, validate each entry programmatically:

| Rule | Check | Action if fail |
|---|---|---|
| Title length | `title.length <= 80` | Reject entry |
| Title not empty | `title.length > 0` | Reject entry |
| Body minimum length | `body.length >= 50` | Reject entry |
| Body has consequence | `body.includes('Consequence')` | Reject entry |
| Tags from vocabulary | every tag in VALID_TAGS | Remove invalid tags (keep entry) |
| Tags count | `tags.length >= 1 && tags.length <= 3` | Clamp to 1-3 |
| Category valid | category in VALID_CATEGORIES | Default to 'domain' |
