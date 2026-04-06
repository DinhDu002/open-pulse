# Skill Template

```markdown
---
name: {kebab-case-name}
description: {One line — when to use this skill. Claude uses this for auto-invocation.}
---

# {Skill Title}

{Brief description of what this skill does and when to use it.}

## When to Activate

- {Trigger condition 1}
- {Trigger condition 2}

## Process

1. {Step 1}
2. {Step 2}
3. {Step 3}

## {Domain-Specific Section}

{Main content — knowledge, patterns, guidelines}

## Best Practices

- {Practice 1}
- {Practice 2}
```

## With Reference Files

```
skills/{name}/
├── SKILL.md              # Keep under 2000 tokens
└── references/
    ├── detailed-guide.md # Read on demand
    └── examples.md       # Read on demand
```

SKILL.md should contain an index telling Claude which reference to read for which topic.

## Key Frontmatter Options

| Field | Use When |
|---|---|
| `context: fork` | Skill consumes lots of context |
| `allowed-tools: Read Grep` | Restrict to safe tools only |
| `model: haiku` | Lightweight skill, save cost |
| `paths: ["src/**"]` | Auto-load context for matching files |
| `disable-model-invocation: true` | Manual-only (no auto-invoke) |
