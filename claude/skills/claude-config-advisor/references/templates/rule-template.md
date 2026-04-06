# Rule Template

## Standalone Rule File
```markdown
---
paths:                    # Optional: only if path-specific
  - "src/api/**/*.ts"
---

# {Topic}

## {Rule Title} [{CRITICAL|IMPORTANT|GUIDELINE}]

{Specific, actionable rule content}

**Rationale**: {Why this rule exists}
```

## CLAUDE.md Addition
```markdown
## {Section Header}
- {Rule 1}
- {Rule 2}
```

## Naming Convention
- File: `{topic}.md` in kebab-case
- Examples: `coding-style.md`, `testing.md`, `api-conventions.md`

## Placement Guide

| Scope | Location |
|---|---|
| All projects | `~/.claude/rules/{topic}.md` |
| All projects (critical) | `~/.claude/CLAUDE.md` |
| Team shared | `.claude/rules/{topic}.md` |
| Personal | `./CLAUDE.local.md` |
| File-type specific | Any `.md` with `paths:` frontmatter |
