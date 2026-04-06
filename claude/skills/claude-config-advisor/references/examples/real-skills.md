# Real Skill Examples (from current setup)

## Simple: security-review
```yaml
---
name: security-review
description: Use this skill when adding authentication, handling user input, working with secrets, or reviewing security-sensitive code
---

# Security Review
Review code for OWASP Top 10 vulnerabilities...
```
**Pattern**: Domain knowledge skill, auto-invoked on security topics.

## Complex with references: continuous-learning-v2
```
skills/continuous-learning-v2/
├── SKILL.md         # Main instructions + commands
├── agents/
│   └── observer.md  # Haiku agent for pattern detection
├── hooks/
│   └── observe.sh   # Pre/PostToolUse observation hooks
└── scripts/
    └── analyze.js   # Instinct analysis logic
```
**Pattern**: Full ecosystem skill with sub-agents, hooks, and scripts.

## Workflow skill: tdd-workflow
```yaml
---
name: tdd-workflow
description: Use when writing new features, fixing bugs, or refactoring code. Enforces write-tests-first methodology.
---

# TDD Workflow
1. Write test first (RED)
2. Run test — it should FAIL
3. Write minimal implementation (GREEN)
...
```
**Pattern**: Process/workflow skill that guides step-by-step.

## On-demand research: deep-research
```yaml
---
name: deep-research
description: Multi-source deep research using firecrawl and exa MCPs
---
```
**Pattern**: Research skill that combines multiple MCP tools.
