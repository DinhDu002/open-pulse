# Rules Guide

## What Are Rules

Rules are markdown files providing persistent instructions loaded at the start of every session. They shape Claude's behavior, enforce conventions, and provide project context.

## CLAUDE.md Hierarchy (higher priority wins)

| Priority | Location | Scope | Shared |
|---|---|---|---|
| 1 (highest) | Managed: `/Library/Application Support/ClaudeCode/CLAUDE.md` | Organization | Admin |
| 2 | Project: `./CLAUDE.md` or `./.claude/CLAUDE.md` | Project | Yes (git) |
| 3 | User: `~/.claude/CLAUDE.md` | All projects | No |
| 4 | Local: `./CLAUDE.local.md` | Project (personal) | No (gitignored) |

## Rules Directory

For larger rulesets, organize into `rules/` directories:
```
.claude/
├── CLAUDE.md              # Main instructions (imports rules)
└── rules/
    ├── api-design.md
    ├── testing.md
    ├── security.md
    └── frontend/
        └── component-patterns.md

~/.claude/
├── CLAUDE.md
└── rules/
    ├── common/            # Always loaded (language-agnostic)
    │   ├── coding-style.md
    │   └── git-workflow.md
    └── rules-available/   # Include per-project via @ reference
        ├── php.md
        └── typescript.md
```

## Path-Specific Rules

Use frontmatter to scope rules to specific files:
```markdown
---
paths:
  - "src/api/**/*.ts"
  - "tests/**/*.test.ts"
---

# API Testing Rules
- Use supertest for HTTP testing
- Mock external services only
```

Path-specific rules are only loaded when Claude is working with matching files.

## Imports (@references)

Reference other files from CLAUDE.md:
```markdown
See @README.md for project overview.
Include @docs/git-instructions.md for workflow.
Personal overrides: @~/.claude/my-project-instructions.md
```

## What to Include

**DO include:**
- Build/test commands Claude can't guess
- Code style rules different from language defaults
- Testing instructions and required test runners
- Repository conventions (branch naming, PR format)
- Architectural decisions specific to project
- Environment quirks (required env vars, special setup)
- Common gotchas and non-obvious behaviors

**DON'T include:**
- Anything Claude can figure out from reading code
- Standard language conventions (PEP 8, Prettier defaults)
- Detailed API documentation (link instead)
- Information that changes frequently
- File-by-file codebase descriptions
- Long tutorials or explanations

## Best Practices

- Keep CLAUDE.md under 200 lines — longer files reduce adherence
- Use clear markdown structure (headers, bullets)
- Be specific: "Use 2-space indentation" not "Format code properly"
- Review for contradictions across all CLAUDE.md files
- Prune rules Claude already follows by default
- If a rule must happen 100% of the time, consider converting to a hook
- Treat CLAUDE.md like code: refactor when it grows unwieldy
