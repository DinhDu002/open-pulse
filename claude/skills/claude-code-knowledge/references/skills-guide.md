# Skills Guide

## What Are Skills

Skills are markdown files (SKILL.md) with YAML frontmatter that extend Claude Code with custom knowledge, workflows, and instructions. They are loaded into context when invoked.

## Locations & Scope

| Location | Scope | Shared via git |
|---|---|---|
| `.claude/skills/<name>/SKILL.md` | Project | Yes |
| `~/.claude/skills/<name>/SKILL.md` | Personal (all projects) | No |
| Plugin `skills/<name>/SKILL.md` | Plugin-scoped | Via plugin |

## Frontmatter Reference

```yaml
---
name: kebab-case-name            # Required. Lowercase, hyphens, max 64 chars
description: When to use this    # Required. Claude uses this to auto-select
disable-model-invocation: true   # Optional. Only manual invocation via /name
user-invocable: false            # Optional. Only Claude can invoke (not user)
allowed-tools: Read Grep Bash    # Optional. Restrict tools available
model: opus-4.6                  # Optional. Override session model
effort: high                     # Optional. Override effort level
context: fork                    # Optional. Run in isolated subagent context
agent: Explore                   # Optional. Which subagent type (with context: fork)
paths:                           # Optional. Glob patterns to auto-load context
  - "src/api/**/*.ts"
shell: bash                      # Optional. bash or powershell
hooks:                           # Optional. Hooks scoped to this skill
  PreToolUse:
    - matcher: Bash
      hooks: [...]
---
```

## Skill Structure Patterns

### Minimal skill
```
skills/my-skill/
└── SKILL.md
```

### With supporting files
```
skills/my-skill/
├── SKILL.md              # Main instructions
├── reference.md          # Detailed docs (read on demand)
├── examples.md           # Usage examples
└── scripts/helper.py     # Executable scripts
```

### With sub-agents and hooks
```
skills/complex-skill/
├── SKILL.md
├── agents/
│   └── observer.md       # Skill-specific subagent
├── hooks/
│   └── validate.sh       # Skill-scoped hook
└── scripts/
    └── analyze.js
```

## String Substitutions

Available in SKILL.md body:
- `$ARGUMENTS` — full argument string passed to skill
- `$ARGUMENTS[N]` or `$N` — Nth argument (0-indexed)
- `${CLAUDE_SESSION_ID}` — current session ID
- `${CLAUDE_SKILL_DIR}` — directory containing SKILL.md

## Dynamic Context Injection

Use `` !`command` `` to inject command output into skill context:
```markdown
## Current Branch
!`git branch --show-current`

## Recent Changes
!`git log --oneline -5`
```

## Invocation

- **Manual**: User types `/skill-name` or `/skill-name args`
- **Auto**: Claude detects relevance from description and invokes via Skill tool
- **From skills**: One skill can invoke another via the Skill tool

## Built-in Skills

| Skill | Purpose |
|---|---|
| `/batch <instruction>` | Parallel decomposition across codebase in worktrees |
| `/claude-api` | Load Claude API reference |
| `/debug [description]` | Enable debug logging |
| `/loop [interval] <prompt>` | Run prompt repeatedly on interval |
| `/simplify [focus]` | Review and fix code quality |

## Best Practices

- Keep SKILL.md under 2000 tokens for fast loading
- Use reference files for detailed content (read on demand)
- Write clear descriptions — Claude uses these to auto-select skills
- Use `context: fork` for skills that consume a lot of context
- Use `allowed-tools` to restrict tools when appropriate
- Test skills by invoking and checking behavior
