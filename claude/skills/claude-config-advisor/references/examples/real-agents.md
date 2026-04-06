# Real Agent Examples (from current setup)

## Read-only analyst: architect
```yaml
---
name: architect
description: Software architecture specialist for system design, scalability, and technical decision-making
tools: Read, Grep, Glob
---

You are a software architecture expert...
```
**Pattern**: Read-only tools, high-level analysis, opus model.

## Code modifier: build-error-resolver
```yaml
---
name: build-error-resolver
description: Build and TypeScript error resolution specialist. Fixes build/type errors with minimal diffs
tools: Read, Write, Edit, Bash, Grep, Glob
---
```
**Pattern**: Full write access, focused on fixing specific errors.

## Lightweight reviewer: code-reviewer
```yaml
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability
tools: Read, Grep, Glob, Bash
model: sonnet
---
```
**Pattern**: Read + Bash (for running tests), sonnet for cost efficiency.

## Research agent: docs-lookup
```yaml
---
name: docs-lookup
description: Look up library documentation using Context7 MCP
tools: Read, Grep, mcp__context7__resolve-library-id, mcp__context7__query-docs
---
```
**Pattern**: MCP tools for external service access.
