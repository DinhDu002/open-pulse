---
name: claude-config-advisor
description: Analyze needs and recommend which Claude Code component to create (skill, agent, hook, rule, memory, MCP). Collects requirements, scans existing setup, and chains to the appropriate creator. Use when user wants to add automation but isn't sure what to create.
---

# Claude Config Advisor

Analyze a need and recommend the right Claude Code component to create, then chain to the appropriate creator skill.

## Process

### Step 1: Listen
User describes their need in free text. Example: "I want to auto-format code after every edit"

### Step 2: Scan Existing Setup
Before asking questions, check what already exists:
```
Scan: ~/.claude/skills/ → list skill names
Scan: ~/.claude/agents/ → list agent names  
Scan: ~/.claude/settings.json → list hooks
Scan: ~/.claude/rules/ → list rules
Scan: ~/.claude/CLAUDE.md → check for relevant rules
```

If something similar already exists → tell user and ask if they want to modify existing or create new.

### Step 3: Collect Required Information (7 fields)

You MUST collect ALL 7 fields before making a recommendation. Ask ONE question at a time. Do NOT skip any field. Do NOT proceed until all are answered.

| # | Field | Question to Ask |
|---|---|---|
| 1 | **Intent** | "What do you want to achieve? Describe the desired outcome." |
| 2 | **Trigger** | "When should this happen? Options: (a) automatically when an event occurs, (b) on-demand when you ask, (c) every session always, (d) on a schedule" |
| 3 | **Reliability** | "Must this happen 100% of the time without exception, or is it a guideline/suggestion?" |
| 4 | **Scope** | "Should this apply to all projects (global) or just specific projects?" |
| 5 | **Complexity** | "Is this simple logic (a few lines/rules) or complex reasoning (analysis, multi-step)?" |
| 6 | **Context** | "Does this need its own isolated context window, or can it work within the main session?" |
| 7 | **Input/Output** | "What information does it receive as input? What should it produce as output?" |

### Step 4: Apply Decision Tree

```
Trigger = "event" AND Reliability = "100%"
  → HOOK
  Determine event: PreToolUse, PostToolUse, Stop, SessionStart, etc.

Trigger = "on-demand" AND Complexity = "simple"  
  → RULE (in CLAUDE.md or rules/)

Trigger = "on-demand" AND Complexity = "complex" AND Context = "main session"
  → SKILL

Trigger = "on-demand" AND Complexity = "complex" AND Context = "isolated"
  → AGENT

Trigger = "every session" AND Complexity = "simple"
  → RULE

Trigger = "every session" AND Complexity = "complex"
  → SKILL (auto-invoked)

Intent involves "external service/API"
  → MCP SERVER

Intent involves "remember across sessions"
  → MEMORY
```

### Step 5: Present Recommendation

Present your recommendation with:
1. **Recommended component type** and why
2. **Why NOT the alternatives** (brief)
3. **Existing components** that overlap or can be reused
4. **Template preview** — read the relevant template from `references/templates/`

### Step 6: Chain to Creator

After user approves the recommendation:

| Component | Action |
|---|---|
| Skill | Invoke `/skill-creator` via Skill tool |
| Agent | Invoke `/agent-creator` via Skill tool |
| Hook | Invoke `/hook-creator` via Skill tool |
| Rule | Invoke `/rule-creator` via Skill tool |
| MCP Server | Reference `/mcp-server-patterns` skill for patterns |
| Memory | Save directly using auto memory system |

## Templates

Read templates from `references/templates/` when presenting recommendations:
- `skill-template.md` — Skill SKILL.md structure
- `agent-template.md` — Agent .md structure  
- `hook-template.md` — Hook config + script structure
- `rule-template.md` — Rule .md structure
- `mcp-server-template.md` — MCP server config structure

## Examples

Read real examples from `references/examples/` for context:
- `real-skills.md` — Examples from current setup
- `real-agents.md` — Examples from current setup
- `real-hooks.md` — Examples from current setup

## Edge Cases

### Multiple components needed
Sometimes the answer is a combination:
- Hook (enforcement) + Rule (documentation) — for critical conventions
- Agent (execution) + Skill (knowledge) — for expert tasks
- Present the combination and create each in sequence

### Uncertain classification
If the 7 fields don't clearly point to one type:
- Present the top 2 options with trade-offs
- Let user choose
- Default to the simpler option (rule > skill > agent)

### Already exists
If scanning reveals an existing component:
- Show what exists
- Ask: modify existing, create alongside, or cancel?
