# Agent Template

```markdown
---
name: {kebab-case-name}
description: {One line — when to delegate to this agent}
tools: {Read, Grep, Glob, Bash}
model: {opus|sonnet|haiku}
---

You are a {persona/expertise}. {Expanded description of expertise.}

## Your Role

{What this agent does, 2-3 sentences.}

## Process

1. {Understand the task}
2. {Gather information}
3. {Analyze/execute}
4. {Present results}

## Guidelines

- {Domain-specific guideline 1}
- {Domain-specific guideline 2}
- Always report findings in structured format
- Flag uncertainties rather than guessing
```

## Model Selection

| Model | Use For | Cost |
|---|---|---|
| opus | Deep analysis, architecture, complex reasoning | High |
| sonnet | Balanced tasks, most agents | Medium |
| haiku | Simple scanning, lightweight tasks | Low |

## Common Tool Combinations

| Agent Type | Tools |
|---|---|
| Read-only analysis | Read, Grep, Glob |
| Code modification | Read, Grep, Glob, Edit, Write, Bash |
| Research | Read, Grep, Glob, WebSearch, WebFetch |
| Full capability | All tools |
