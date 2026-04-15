---
name: synthesize
description: Consolidate accumulated knowledge entries and auto-evolve pattern drafts. Deduplicates, merges, improves quality, and promotes ready patterns to Claude Code components. Requires Open Pulse server running.
---

# Synthesize

Consolidate raw extractions accumulated by Ollama (per-prompt) into high-quality, deduplicated entries. Two phases: Knowledge Consolidation, then Pattern Consolidation.

**Prerequisites:** Open Pulse server must be running at `http://localhost:3827`. Start it with `npm start` in the open-pulse directory if needed.

## Arguments

```
/synthesize [project-name] [--all]
```

- **No arguments**: auto-detect project from current working directory name
- **project-name**: consolidate only this project's entries and patterns
- **--all**: consolidate ALL projects, plus cross-project pattern detection

## Phase 1: Knowledge Consolidation

### Step 1: Fetch data

```bash
curl -s "http://localhost:3827/api/synthesize/data?project=PROJECT_NAME&type=knowledge"
```

Response contains `projects[].knowledge_entries.by_category` — entries grouped by category (domain, stack, schema, api, feature, architecture, convention, decision, footgun, contract, error_pattern).

### Step 2: Process each category

For each category with entries, analyze the batch and take action:

**Identify duplicates:** Entries covering the same topic with different wording. Signs:
- Same `source_file` and overlapping subject matter
- One entry is a subset of another
- Titles describe the same concept differently

**Merge duplicates:** Pick the higher-quality entry as target. Improve its body using the 3-part template, incorporating information from the duplicate:
```
[Trigger]: When this knowledge becomes relevant
[Detail]: The non-obvious behavior, constraint, or decision
Consequence: What breaks or goes wrong if this is ignored
```

Then:
1. Update target: `PUT /api/knowledge/entries/TARGET_ID` with `{ "body": "improved body" }`
2. Mark duplicate outdated: `PUT /api/knowledge/entries/SOURCE_ID` with `{ "status": "outdated" }`

**Improve quality:** Entries with weak or incomplete bodies — missing Trigger/Detail/Consequence structure, vague descriptions, or no actionable information. Update via PUT with improved body.

**Mark stale:** Entries contradicted by newer entries in the same category. Set `{ "status": "outdated" }` via PUT.

**Skip:** Entries that are already high-quality, unique, and current. Do not touch them.

### Step 3: Render vault

After all categories processed:

```bash
curl -s -X POST "http://localhost:3827/api/knowledge/vault/render" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "PROJECT_ID"}'
```

### Step 4: Report

```
Knowledge Consolidation — PROJECT_NAME:
  Processed: N entries across M categories
  Merged: X (Y pairs)
  Improved: Z
  Marked outdated: W
  Unchanged: V
```

## Phase 2: Pattern Consolidation

### Step 1: Fetch data

```bash
curl -s "http://localhost:3827/api/synthesize/data?project=PROJECT_NAME&type=patterns"
```

Response contains `projects[].auto_evolves.by_type` — patterns grouped by target_type (rule, skill, agent, workflow).

### Step 2: Process each target_type

For each type with patterns, analyze the batch:

**Identify duplicates:** Patterns describing the same behavior. Signs:
- Same or very similar titles
- Descriptions overlap significantly
- Same target_type and scope

**Merge duplicates:** Keep the better-described pattern. Update it:
```bash
curl -s -X PUT "http://localhost:3827/api/auto-evolves/KEEP_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "improved consolidated description",
    "observation_count": COMBINED_COUNT,
    "confidence": HIGHER_CONFIDENCE,
    "projects": ["project-a", "project-b"]
  }'
```

Delete the duplicate:
```bash
curl -s -X DELETE "http://localhost:3827/api/auto-evolves/REMOVE_ID"
```

**Validate patterns:** Reject false positives:
- Generic practices any developer follows (e.g., "commit code regularly")
- Single-occurrence events (not a pattern)
- Known Claude Code default behavior
- Vague descriptions without actionable specifics

Delete invalid patterns via DELETE.

**Assess promotion readiness:** A pattern is ready when:
- `observation_count >= 3` OR description is clearly actionable with strong evidence
- Description is specific enough to generate a useful component
- Not duplicating an existing Claude Code component

For ready patterns, first set status to active:
```bash
curl -s -X PUT "http://localhost:3827/api/auto-evolves/ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "active", "confidence": 0.85}'
```

Then promote:
```bash
curl -s -X POST "http://localhost:3827/api/auto-evolves/ID/promote"
```

This generates the component file (rule → `~/.claude/rules/`, skill → `~/.claude/skills/`, agent → `~/.claude/agents/`).

**Keep as draft:** Patterns with some signal but not enough evidence yet. Leave them for future consolidation.

### Step 3: Report

```
Pattern Consolidation — PROJECT_NAME:
  Processed: N patterns (R rules, S skills, A agents, W workflows)
  Merged: X (Y pairs)
  Validated and activated: Z
  Promoted: P (details: "rule-name" → ~/.claude/rules/rule-name.md)
  Deleted (false positive): D
  Kept as draft: K
```

## Cross-Project Mode (--all)

When `--all` is specified:

### Step 1: Fetch all data

```bash
curl -s "http://localhost:3827/api/synthesize/data?type=all"
```

### Step 2: Per-project consolidation

Run Phase 1 and Phase 2 for each project individually.

### Step 3: Cross-project pattern detection

After per-project consolidation, analyze patterns across all projects:

1. Collect all active/draft patterns from all projects
2. Find patterns with same/similar title appearing in 3+ different projects
3. For cross-project patterns:
   - Merge into a single entry with combined `projects` array
   - Set confidence to 0.90+ (strong cross-project signal)
   - Update description to be project-agnostic
   - Promote as global component (written to `~/.claude/`)
4. Delete the project-specific duplicates

### Step 4: Cross-project report

```
Cross-Project Analysis:
  Projects analyzed: N
  Cross-project patterns found: X
  Promoted to global: Y (details)
```

## Quality Criteria

### Knowledge entries — what makes a good entry

- **Actionable**: changes how a developer approaches the code
- **Non-obvious**: cannot be derived by reading the source code directly
- **Specific**: names exact files, functions, or behaviors
- **Structured**: follows Trigger/Detail/Consequence template
- **Current**: reflects the actual state of the codebase

### Patterns — what makes a good pattern

- **Repeated**: observed multiple times across sessions
- **Specific**: describes a concrete behavior, not a vague practice
- **Actionable**: can be converted to a useful rule/skill/agent/workflow
- **Evidenced**: description includes what was observed and how many times

### Target type guidance

- **Rule**: behavioral constraint the user consistently follows → `~/.claude/rules/`
- **Skill**: reusable multi-step procedure with clear inputs/outputs → `~/.claude/skills/`
- **Agent**: delegatable role requiring specific tools and judgment → `~/.claude/agents/`
- **Workflow**: temporal sequence where step X always follows step Y → `~/.claude/rules/`

## Error Handling

- **Server not running**: If any API call fails with connection error, report: "Open Pulse server not running. Start with `npm start` in the open-pulse directory."
- **Empty data**: If a phase has 0 entries/patterns, report "Nothing to consolidate" and skip to next phase.
- **Individual API call fails**: Log warning, continue with next item. Do not abort the entire phase.
- **Large dataset (>200 entries in a category)**: Process in sub-batches, report progress per batch.
