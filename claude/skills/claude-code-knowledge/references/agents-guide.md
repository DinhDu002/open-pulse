# Agents Guide

## What Are Agents

Agents (subagents) are specialized AI assistants that run in their own context window. They have custom system prompts, specific tool access, independent permissions, and can use different models. Results are returned to the main conversation.

## Locations & Scope

| Location | Scope |
|---|---|
| `.claude/agents/<name>.md` | Project |
| `~/.claude/agents/<name>.md` | Personal (all projects) |

## Agent Frontmatter Reference

```yaml
---
name: agent-id                   # Required. Lowercase, hyphens
description: When to use this    # Required. Claude uses for auto-delegation
tools: Read, Grep, Glob, Bash   # Optional. Allowed tools (default: all)
model: opus-4.6                  # Optional. Override session model
effort: high                     # Optional. Override effort level
skills:                          # Optional. Preload these skills
  - skill-name
mcpServers:                      # Optional. Enabled MCP servers
  - memory
isolation: worktree              # Optional. Use git worktree isolation
---

Agent instructions here...
```

## Agent vs Skill

| Aspect | Skill | Agent |
|---|---|---|
| Context | Shares main session context | Own isolated context |
| Best for | Domain knowledge, workflows | Delegated tasks, research |
| Context cost | Adds to main context | No impact on main context |
| Interaction | Can ask user questions | Returns result to main session |
| Tools | Limited by allowed-tools | Limited by tools field |

## How to Invoke

- **Automatic**: Claude detects need and delegates based on description
- **Manual**: "Use the security-reviewer subagent to check this"
- **Direct**: "Use a subagent to investigate X"
- **From code**: Via the Agent tool with `subagent_type` parameter

## Agent Tool Parameters

```
Agent tool call:
  description: "Short task description"    # Required
  prompt: "Detailed task instructions"     # Required
  subagent_type: "agent-name"             # Optional (matches agent file name)
  model: "sonnet"                          # Optional override
  isolation: "worktree"                    # Optional worktree isolation
  run_in_background: true                  # Optional async execution
```

## Built-in Agent Types

These are available without custom agent files:
- `general-purpose` — Default, broad capabilities
- `Explore` — Fast codebase exploration (quick/medium/very thorough)
- `Plan` — Implementation planning

## Agent Teams (Experimental)

Multiple independent Claude sessions coordinating through shared tasks and messaging.

**Enable**:
```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```

**Components**:
- **Team lead**: Main session creating and coordinating
- **Teammates**: Separate Claude instances
- **Task list**: Shared work items
- **Mailbox**: Inter-agent messaging

**Display modes**: `"in-process"`, `"tmux"`, `"split-panes"`, `"auto"`

## Best Practices

- Give agents clear, complete task descriptions (they have no conversation context)
- Specify what output format you expect
- Use `model: haiku` for lightweight tasks to save cost
- Use `isolation: worktree` when agent needs to modify files independently
- Use `run_in_background: true` when you don't need results immediately
- Keep tools list minimal — only what the agent actually needs
- Use the Explore agent type for codebase research (saves main context)
