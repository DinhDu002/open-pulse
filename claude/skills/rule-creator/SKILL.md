---
name: rule-creator
description: Create Claude Code rules with conflict detection. Use when user wants to add behavioral rules to CLAUDE.md or rules/ directory with proper scope and deduplication.
---

# Rule Creator

Create a new Claude Code rule by collecting required information, detecting conflicts with existing rules, and generating a well-structured rule file.

## Required Information (collect ALL before generating)

You MUST collect all 5 fields. Ask one question at a time. Do NOT proceed until all fields are filled.

### 1. Rule Content
What behavior should Claude follow? Be specific and actionable.
- Good: "Use 2-space indentation for TypeScript files"
- Bad: "Format code properly"

### 2. Scope

| Scope | Location | When |
|---|---|---|
| Global (all projects) | `~/.claude/rules/<topic>.md` | Universal conventions |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` | Short, critical rules |
| Project (shared) | `.claude/CLAUDE.md` or `.claude/rules/<topic>.md` | Team conventions |
| Project (personal) | `./CLAUDE.local.md` | Personal preferences |
| Path-specific | Any `.md` with `paths:` frontmatter | Rules for specific file types |

### 3. Paths (if path-specific)
Glob patterns for which files this rule applies to:
- `"src/api/**/*.ts"` — API TypeScript files
- `"tests/**/*.test.ts"` — Test files
- `"*.md"` — Markdown files

### 4. Severity
- **CRITICAL** — Must follow, violations are bugs
- **IMPORTANT** — Should follow, exceptions need justification
- **GUIDELINE** — Recommended, flexible

### 5. Rationale
Why does this rule exist? This helps Claude judge edge cases.
- "Prevents silent data loss from mutation side effects"
- "Required by team code style guide"
- "Legal compliance requirement for session token storage"

## Pre-Generation Conflict Detection

Before generating, scan ALL existing rules for:

### Step 1: Read all rule sources
```
~/.claude/CLAUDE.md
~/.claude/rules/**/*.md
./.claude/CLAUDE.md (if in project)
./.claude/rules/**/*.md (if in project)
./CLAUDE.md (if in project)
./CLAUDE.local.md (if exists)
```

### Step 2: Check for conflicts
- **Duplicate**: Same or very similar rule already exists
  → Action: suggest updating existing rule instead of creating new one
- **Contradiction**: New rule conflicts with existing rule
  → Action: present both rules, ask user which takes precedence
- **Subsumption**: Existing broader rule already covers this case
  → Action: point out the broader rule, ask if specific rule is still needed
- **Complementary**: New rule extends an existing rule
  → Action: suggest merging into the existing rule

### Step 3: Present findings
If any issues found:
1. Show the existing rule(s) that conflict
2. Explain the type of conflict
3. Propose resolution (merge, replace, narrow scope, skip)
4. Wait for user decision before proceeding

## Generation Template

### Standalone rule file
```markdown
---
paths:                           # Only if path-specific
  - "src/api/**/*.ts"
---

# {Topic}

## {Rule Title} [{Severity}]

{Rule content — specific, actionable}

**Rationale**: {Why this rule exists}
```

### Addition to existing CLAUDE.md
```markdown
## {Rule Title}
- {Rule content}
```

## File Naming Convention

For standalone files in `rules/`:
- Topic-based: `coding-style.md`, `testing.md`, `security.md`
- Feature-based: `api-conventions.md`, `auth-rules.md`
- kebab-case, descriptive name

## After Generation

1. Present the rule content for user review
2. If standalone file: show the full file
3. If CLAUDE.md addition: show where it will be inserted
4. Write only after user approval
5. If rule goes in CLAUDE.md: count total lines — warn if approaching 200 lines

## When to Suggest Alternatives

- If the rule must happen 100% of the time → suggest a **hook** instead
  - "This sounds like it needs 100% enforcement. A hook would be more reliable than a rule. Want me to use /hook-creator instead?"
- If the rule is complex domain knowledge → suggest a **skill** instead
  - "This is more like domain knowledge than a behavioral rule. A skill might be better. Want me to use /claude-config-advisor?"
- If the rule is about remembering a fact → suggest **memory** instead
  - "This sounds like a fact to remember, not a behavior to enforce. Should I save it as memory instead?"

## Best Practices for Rules

- Keep rules short and specific (1-3 sentences)
- Lead with the action, not the explanation
- Include rationale for non-obvious rules
- Group related rules in the same file
- CLAUDE.md: under 200 lines total
- Rules should be things Claude wouldn't do by default
- Don't duplicate what's already in language/framework defaults
