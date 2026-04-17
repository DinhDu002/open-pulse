---
name: knowledge-extractor
description: Extract project-specific knowledge from Claude Code session events. Outputs structured knowledge entries (category, title, body, source_file, tags). Used by Ollama for per-prompt extraction and by Opus for /synthesize consolidation. The extraction pipeline reads this file at runtime.
---

# Knowledge Extractor

Extract non-obvious, actionable project knowledge from Claude Code session events. Every entry must change how a developer approaches the code — reject anything discoverable by reading the source directly.

This skill serves two consumers:
1. **Local model (Ollama)**: reads `## Compact Instructions` + `## JSON Schema` for per-prompt extraction
2. **Frontier model (Opus)**: reads the full body for `/synthesize` consolidation, dedup, and quality enforcement

## JSON Schema

```json
[
  {
    "category": "<one of: domain|stack|schema|api|feature|architecture|convention|decision|footgun|contract|error_pattern>",
    "title": "<short noun phrase, sentence case, max 80 chars>",
    "body": "<3-part: [Trigger]: ... [Detail]: ... Consequence: ...>",
    "source_file": "<most relevant file path, or null>",
    "tags": ["<1-3 from: backend|frontend|database|api|testing|deployment|config|security|performance|migration|cli|hooks>"]
  }
]
```

## Compact Instructions

You are extracting project knowledge from Claude Code session events. Follow these rules strictly:

- Extract ONLY non-obvious facts that cannot be learned by reading the source code
- Each body MUST have three parts: `[Trigger]:` (when relevant), `[Detail]:` (the insight), `Consequence:` (what breaks if ignored)
- Titles must be specific insights, not topic labels — pass the "so what?" test
- If an existing entry title matches, emit the SAME title with corrected body to trigger an update
- Never extract file descriptions, API lists, tech stack enumerations, or anything already in CLAUDE.md
- Return `[]` if nothing worth extracting

**Example:**

```json
[
  {
    "category": "footgun",
    "title": "JSONL ingestion leaves .processing files on server crash",
    "body": "[Trigger]: When the server crashes during JSONL ingestion. [Detail]: The pipeline renames .jsonl to .processing before reading. After 3 failed retries the file is marked .failed and never retried automatically. There is no alerting for .failed files. Consequence: silent data loss for that batch — manual rename to .jsonl required.",
    "source_file": "src/ingest/pipeline.js",
    "tags": ["backend", "config"]
  }
]
```

Return a JSON array only. No explanation.

**Programmatic validation**: bodies missing `[Trigger]:`, `[Detail]:`, or `Consequence:`, or shorter than 50 characters, will be rejected before insertion. Tags outside the vocabulary are dropped (entry kept if ≥1 valid tag remains, else a category-default tag is assigned). Do not skip the three labels.

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
Consequence: what breaks, fails, or gets harder if ignored.
```

### Example — footgun category

```
[Trigger]: When the server crashes during JSONL ingestion.
[Detail]: The ingestion pipeline renames .jsonl to .processing before reading.
After 3 failed retries the file is marked .failed and never retried automatically.
There is no alerting or monitoring for .failed files.
Consequence: silent data loss for that batch — manual rename to .jsonl required.
```

### Example — decision category

```
[Trigger]: When choosing a database for this project.
[Detail]: The team evaluated SQLite vs PostgreSQL. SQLite was chosen because the system
is single-user, runs locally, and needs zero setup. The WAL mode + 3s busy timeout
handles concurrent reads from the server and ingestion timer without conflict.
Consequence: migrating to PostgreSQL would require replacing all better-sqlite3 calls
and the synchronous transaction pattern used in migrations.
```

### Example — convention category

```
[Trigger]: When adding a new backend module.
[Detail]: All route files are organized as Fastify plugins under src/routes/. Each
receives routeOpts (db, dbPath, repoDir, config, componentETagFn). Route registration
order matters — static routes before dynamic to prevent param collision.
Consequence: wrong registration order causes 404s on static endpoints that match dynamic params.
```

### Example — error_pattern category

```
[Trigger]: When the daily review CLI times out.
[Detail]: The daily review spawns claude CLI with a 300s timeout. If Opus takes longer
(common for large component sets), the process is killed and no partial results are saved.
The review must be re-triggered manually via POST /api/daily-reviews/run.
Consequence: wasted API cost with no output — consider reducing component set size.
```

## Category Guidance

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

## Tag Vocabulary

Tags MUST be chosen from this list only — do NOT invent new tags:

```
backend, frontend, database, api, testing, deployment,
config, security, performance, migration, cli, hooks
```

Pick 1-3 tags per entry. Choose based on which part of the system is affected, not what the entry is about.

## What NOT to Extract

These should be rejected, not stored:

- **File/module descriptions** — "server.js handles HTTP routing" (read the code)
- **API endpoint lists** — already in CLAUDE.md
- **Tech stack enumerations** — already in package.json and CLAUDE.md
- **Database schema descriptions** — code is the source of truth
- **Configuration key listings** — already in config.json and CLAUDE.md
- **Generic programming best practices** — the model already knows these
- **Anything already documented in CLAUDE.md** — check before extracting

## Actionability Test

Before accepting an entry, apply this test:

> "Would reading this entry change how a developer approaches the code?"

- YES: "Re-running backfill creates duplicates" changes behavior (developer won't re-run it)
- NO: "The system has 14 database tables" doesn't change anything (developer would discover this naturally)

If the answer is NO, reject the entry.

## Updating Existing Entries

When analyzing events, you may discover that an existing entry contains outdated or incorrect facts. In that case, re-emit the entry with the **same title** and a corrected body. The system uses title-based upsert — same title triggers an update, not a duplicate.

**When to update:**
- Events show a configuration, model, or behavior has changed
- Events show a file was refactored and an entry's description no longer matches
- Events show an API endpoint, function signature, or schema has changed

**When NOT to update:**
- The existing entry is still accurate based on the events you see
- You're unsure whether the entry is outdated — leave it for human review

## Validation Rules

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
