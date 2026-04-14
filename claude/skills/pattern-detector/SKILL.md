---
name: pattern-detector
description: Detect reusable behavioral patterns from Claude Code session events. Outputs auto-evolve pattern drafts (title, description, target_type, scope, evidence). Used by Ollama for per-prompt extraction and by Opus for /synthesize cross-project consolidation and promotion to components.
---

# Pattern Detector

Detect reusable behavioral patterns from Claude Code session events — repeated workflows, error-recovery sequences, user corrections, and tool preferences. Each pattern maps to a target component type (rule, skill, agent, workflow) that can be promoted to a Claude Code component.

This skill serves two consumers:
1. **Local model (Ollama)**: reads `## Compact Instructions` + `## JSON Schema` for per-prompt pattern detection
2. **Frontier model (Opus)**: reads the full body for `/synthesize` consolidation, dedup, merge, and cross-project promotion

## JSON Schema

```json
[
  {
    "title": "<pattern name, imperative or descriptive, max 80 chars>",
    "description": "<what the pattern is and when it applies, 2-5 sentences>",
    "target_type": "<one of: rule|skill|agent|workflow>",
    "scope": "<project|global>",
    "evidence": "<specific observations: what was seen, how many times, which sessions>",
    "projects": ["<project name if scope=project, omit or empty array if global>"]
  }
]
```

## Compact Instructions

You are detecting reusable behavioral patterns from Claude Code session events. Follow these rules strictly:

Target types:
- `rule` — a behavioral constraint the user consistently follows or corrects toward
- `skill` — a reusable multi-step procedure the user repeats across sessions
- `agent` — a delegatable role that appears as a recurring task pattern
- `workflow` — a temporal sequence where X always follows Y

Detection rules:
- Only flag patterns with 2+ occurrences in the events — never invent patterns from a single event
- Focus on: user corrections (words like "no", "wrong", "fix", "instead"), error-recovery sequences (success=false followed by corrective actions), retry patterns (same tool/skill invoked 2+ times), temporal sequences (same seq_num ordering repeats)
- Be specific about trigger conditions — "when editing auth modules" not "when editing files"
- Set scope=global for coding style, error handling, tool preferences; scope=project for project-specific APIs, file patterns, domain conventions
- Return `[]` if no clear patterns detected

**Example:**

```json
[
  {
    "title": "Always run tests after editing authentication modules",
    "description": "User consistently runs test suite immediately after modifying files in src/auth/. This happens regardless of change size. When tests are skipped, the user backtracks to run them before continuing.",
    "target_type": "rule",
    "scope": "project",
    "evidence": "Observed 4 times across 2 sessions. After editing src/auth/handler.js and src/auth/middleware.js, user_prompt contains 'run tests' or Bash tool runs npm test within the next 3 events.",
    "projects": ["crm-backend"]
  }
]
```

Return a JSON array only. No explanation.

## Pattern Types

### Rule — Behavioral Constraint

A rule captures a constraint the user consistently follows or corrects toward. Rules are the most common pattern type.

**Detection signals:**
- User corrects the same mistake 2+ times ("no, always use X instead of Y")
- A specific check or validation is always performed after certain operations
- A naming convention, code style, or approach is consistently enforced

**Promotion criteria:**
- Clear, specific trigger condition
- Actionable in one sentence
- Not already documented in CLAUDE.md or project rules

**Examples:**
- "Always validate environment variables on startup before accessing them"
- "Use immutable updates — never mutate objects in-place"
- "Register static Fastify routes before dynamic routes"

### Skill — Reusable Procedure

A skill captures a multi-step procedure that the user repeats across sessions.

**Detection signals:**
- Same sequence of 3+ tool calls appears in multiple sessions
- User describes the same complex task multiple times
- A domain-specific procedure has non-obvious steps

**Promotion criteria:**
- 3+ distinct steps that benefit from documentation
- Non-obvious ordering or parameters
- Saves significant time when automated

**Examples:**
- "Database migration workflow: write migration, run migrate, verify schema, update types"
- "Deploy procedure: run tests, build, tag release, push, verify health endpoint"

### Agent — Delegatable Role

An agent captures a recurring task that benefits from delegation to a specialized subagent.

**Detection signals:**
- Same complex task is delegated to Agent tool repeatedly
- A multi-step analysis or review process recurs
- User spawns the same type of agent across different projects

**Promotion criteria:**
- Task requires multiple tool calls and context gathering
- Benefits from isolation (own context window)
- Has clear inputs and expected outputs

**Examples:**
- "Security review agent for auth-related changes"
- "Migration safety checker for database schema changes"

### Workflow — Temporal Sequence

A workflow captures a temporal sequence where specific actions always follow others in a fixed order.

**Detection signals:**
- seq_num analysis shows X always precedes Y within N events
- A pipeline of tool calls repeats with the same ordering
- User always follows a specific sequence when starting/ending tasks

**Promotion criteria:**
- Fixed ordering (X before Y, not random)
- 3+ steps in the sequence
- Breaking the sequence causes problems (evidenced by errors or corrections)

**Examples:**
- "Feature branch workflow: create branch → implement → test → review → PR"
- "Bug fix workflow: reproduce → write failing test → fix → verify → commit"

## Detection Signals

Look for these patterns in the session events:

### Post-Invocation Correction Density
After a `skill_invoke` or `agent_spawn`, count `tool_call` events before the next different `user_prompt`. If 5+ tool calls follow in the same session, the component likely did not complete its job. This signals a potential component-quality issue.

### Error-Recovery Chains
After any tool call, if 2+ of the next 5 events have `success=false`, followed by corrective actions with `success=true`, this is an error-recovery pattern. The recovery steps are the pattern to capture.

### Retry Patterns
Same skill/agent name appears 2+ times in the same session with different `seq_num` values. The user had to re-invoke it — signals either the component is unreliable or the task needs better tooling.

### User Correction Language
After a tool result, if the next `user_prompt` contains correction words ("no", "wrong", "redo", "fix", "instead", "actually", "not that"), the previous action produced incorrect results. The correction itself reveals the desired behavior.

### Temporal Sequences
Using `seq_num` ordering: if tool/skill A consistently appears within N events before tool/skill B across multiple sessions, this is a workflow pattern. Look for sequences where breaking the order causes errors.

## Scope Rules

**Project scope** — pattern references:
- Specific file paths or directories
- Project-specific APIs, endpoints, or services
- Domain-specific conventions unique to the project
- Project-specific configuration or infrastructure

**Global scope** — pattern is about:
- General coding style (immutability, naming conventions)
- Universal error handling approaches
- Tool preferences (Grep over grep, Read over cat)
- Development methodology (TDD, code review before commit)
- Component quality issues (a skill/agent that consistently fails)

When unsure, default to `project` scope — it's safer to keep patterns local and let `/synthesize` detect cross-project overlap for global promotion.

## What NOT to Detect

Reject these — they are not actionable patterns:

- **Single-occurrence events** — one-time actions are not patterns
- **Generic programming practices** — the model already knows "write tests" or "handle errors"
- **Known Claude Code behaviors** — built-in tool usage patterns (Read before Edit, etc.)
- **Trivial sequences** — "user types prompt, model responds" is not a workflow
- **Project setup actions** — one-time configuration or installation steps
- **Patterns already captured as rules** in CLAUDE.md or `.claude/rules/`

## Quality Bar

For Opus `/synthesize` consolidation:

### Merging Duplicates
- Same pattern described differently → merge into one, keep the most specific description
- Combine evidence sections, sum observation counts
- Keep the higher confidence value

### Promoting Drafts
- Draft patterns (from Ollama per-prompt) with observation_count >= 3 → candidate for active status
- Active patterns with confidence >= 0.85 and rejection_count = 0 → candidate for promotion
- Before promoting, verify the pattern is not already covered by an existing component

### Cross-Project Detection
- Same pattern title (or semantically equivalent) appears in 3+ projects → candidate for global promotion
- Global patterns are promoted to `~/.claude/rules/` or `~/.claude/skills/`
- Project-specific details are stripped during global promotion — keep only the universal part

### Conflict Resolution
- Two patterns contradict each other → keep the one with more evidence, mark the other dismissed
- A pattern contradicts an existing CLAUDE.md rule → dismiss the pattern (documented rules take precedence)

## Confidence Rules

### Initial Assignment
- Per-prompt Ollama detection: initial confidence = 0.3 (draft)
- Re-observation of existing pattern: bump confidence by 0.15, cap at 0.95
- Frequency scaling: 3-5 observations → 0.5, 6-10 → 0.7, 11+ → 0.85

### Decay
- Each `/synthesize` pass checks all active patterns against recent events
- No supporting evidence in recent window → reduce confidence by 0.05
- Events contradict the pattern → reduce confidence by 0.15
- High-confidence (0.7+): slow decay (reduce by 0.025 instead)
- Confidence below 0.1 → auto-delete

### Thresholds
- `< 0.3`: weak signal, may be auto-deleted on next decay cycle
- `0.3-0.5`: emerging pattern, needs more observations
- `0.5-0.85`: established pattern, visible in UI for review
- `>= 0.85`: promotion candidate (if rejection_count = 0)
