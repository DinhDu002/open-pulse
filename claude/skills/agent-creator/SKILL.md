---
name: agent-creator
description: Create well-structured Claude Code agent definitions. Use when user wants to create a new subagent with proper frontmatter, persona, tools, and process instructions.
---

# Agent Creator

Create a new Claude Code agent by collecting required information, scanning for conflicts, and generating a well-structured agent definition file.

## Required Information (collect ALL before generating)

You MUST collect all 7 fields. Ask one question at a time. Do NOT proceed until all fields are filled.

### 1. Name & Description
- **Name**: kebab-case, concise (e.g., `api-tester`, `log-analyzer`)
- **Description**: One line explaining WHEN to use this agent (Claude uses this to auto-delegate)

### 2. Expertise / Persona
- What domain expert is this agent? (e.g., "Senior security engineer", "DevOps specialist")
- What specific knowledge should it have?

### 3. Tools Needed
Choose from available tools:
- **Read-only**: Read, Grep, Glob (safe, no side effects)
- **Modification**: Edit, Write (can change files)
- **Execution**: Bash (can run commands)
- **Web**: WebSearch, WebFetch (internet access)
- **Interaction**: AskUserQuestion (ask user)
- Principle: minimum tools needed for the task

### 4. Model
- **opus** — Complex reasoning, architecture, deep analysis
- **sonnet** — Balanced capability and cost (default for most agents)
- **haiku** — Lightweight, fast, cost-efficient (good for simple tasks)

### 5. Scope
- **Global**: `~/.claude/agents/<name>.md` (available in all projects)
- **Project**: `.claude/agents/<name>.md` (only this project)

### 6. Skills to Preload
- Which existing skills should the agent have loaded? (optional)
- Check available skills with: `ls ~/.claude/skills/`

### 7. Isolation
- **None** (default) — agent shares filesystem with main session
- **Worktree** — agent gets isolated git worktree (for file-modifying agents)

## Pre-Generation Checks

Before generating, scan existing agents for:

1. **Name conflict**: `ls ~/.claude/agents/ .claude/agents/ 2>/dev/null` — does an agent with this name exist?
2. **Role overlap**: Read existing agent descriptions — does another agent already cover this domain?
3. If conflict found → present to user and ask: merge, rename, or proceed anyway?

## Generation Template

```markdown
---
name: {name}
description: {description}
tools: {tools as comma-separated}
model: {model}
{skills section if any}
{isolation: worktree if needed}
---

You are a {persona}. {expanded expertise description}

## Your Role

{What this agent does, in 2-3 sentences}

## Process

1. {Step 1 — usually: understand the task}
2. {Step 2 — usually: gather information}
3. {Step 3 — usually: analyze/execute}
4. {Step 4 — usually: present results}

## Guidelines

- {Guideline 1 — specific to this agent's domain}
- {Guideline 2}
- {Guideline 3}
- Always report findings in a structured format
- Flag uncertainties rather than guessing
```

## After Generation

1. Present the full agent file for user review
2. Write to the chosen location only after approval
3. Suggest a test: "Try invoking this agent with: 'Use the {name} agent to {sample task}'"

## Examples

### Minimal agent
```yaml
---
name: log-analyzer
description: Analyzes application logs to identify errors, patterns, and anomalies
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a senior SRE specializing in log analysis and incident investigation.

## Process
1. Identify log locations and formats
2. Search for errors, warnings, and anomalies
3. Correlate events across log files
4. Present findings with severity and recommended actions
```

### Complex agent with skills
```yaml
---
name: full-stack-reviewer
description: Reviews full-stack changes across frontend, backend, and database layers
tools: Read, Grep, Glob, Bash
model: opus
skills:
  - coding-standards
  - security-review
---

You are a principal engineer with expertise across React, Node.js, and PostgreSQL.

## Process
1. Identify all changed files and their layers
2. Review frontend changes for patterns and accessibility
3. Review backend changes for security and performance
4. Review database changes for schema safety and query efficiency
5. Check cross-layer consistency
6. Present findings organized by severity
```
