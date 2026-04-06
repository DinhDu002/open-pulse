# Memory Guide

## Auto Memory

Claude automatically saves learnings across sessions without manual intervention.

### Storage Structure
```
~/.claude/projects/<project-hash>/memory/
├── MEMORY.md          # Index file (loaded every session)
├── debugging.md       # Topic-specific memory
├── api-conventions.md
└── ...
```

### What Gets Remembered
- Build commands discovered during sessions
- Debugging insights and solutions
- Code style preferences from user corrections
- Architecture notes
- Workflow habits and preferences

### Limits
- First 200 lines or 25KB of MEMORY.md loaded at session start
- Topic files loaded on demand when referenced
- Memory auto-expires based on `cleanupPeriodDays` setting

### Configuration
```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "~/custom-memory-dir"
}
```

## Memory Types

| Type | Purpose | When to Save |
|---|---|---|
| **user** | Role, goals, preferences | Learning about user's background |
| **feedback** | Corrections and confirmations | User says "don't do X" or confirms approach |
| **project** | Ongoing work, goals, bugs | Learning project context |
| **reference** | External system pointers | Discovering where info lives |

## Memory File Format

```markdown
---
name: memory-name
description: One-line description for relevance matching
type: user|feedback|project|reference
---

Memory content here.
For feedback/project types:
**Why:** reason
**How to apply:** guidance
```

## MEMORY.md (Index)

```markdown
- [Title](file.md) — one-line hook (under 150 chars)
- [Another Memory](other.md) — brief description
```

- MEMORY.md is always loaded into context
- Lines after 200 are truncated — keep it concise
- Each entry should be one line
- Contains pointers to topic files, not content

## What NOT to Save

- Code patterns derivable from reading the code
- Git history (use `git log` / `git blame`)
- Debugging solutions (fix is in the code, context in commit message)
- Anything already in CLAUDE.md files
- Ephemeral task details (use tasks/plans instead)

## Other Persistence Mechanisms

| Mechanism | Scope | Use For |
|---|---|---|
| Auto memory | Cross-session | Facts useful in future conversations |
| Plans | Current session | Implementation approach alignment |
| Tasks | Current session | Breaking work into trackable steps |
| CLAUDE.md | Every session | Rules that apply always |
| Context files | Every session | Personal identity & preferences |
