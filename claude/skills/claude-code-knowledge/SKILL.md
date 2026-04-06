---
name: claude-code-knowledge
description: Reference knowledge base for Claude Code features — skills, agents, hooks, rules, settings, memory, MCP servers. Use when answering questions about Claude Code capabilities or configuration.
---

# Claude Code Knowledge Base

Answer questions about Claude Code features by reading the relevant reference file below. Do NOT load all files — only read what's needed for the question.

## Reference Index

| Topic | File | When to read |
|---|---|---|
| Skills | `references/skills-guide.md` | Creating/understanding skills, frontmatter, patterns |
| Agents | `references/agents-guide.md` | Creating/understanding agents, subagents, teams |
| Hooks | `references/hooks-guide.md` | Hook events, types, configuration, scripts |
| Rules | `references/rules-guide.md` | CLAUDE.md, rules/, path-specific rules |
| Settings | `references/settings-guide.md` | settings.json options, scopes, permissions |
| Memory | `references/memory-guide.md` | Auto memory, MEMORY.md, types, limits |
| MCP | `references/mcp-guide.md` | MCP servers, configuration, permissions |
| Decision Matrix | `references/decision-matrix.md` | When to use skill vs agent vs hook vs rule |

## How to Use

1. Identify which topic the question relates to
2. Read ONLY the relevant reference file(s) using the Read tool
3. Answer based on the reference content
4. If the question spans multiple topics, read multiple files
5. If the reference doesn't cover the question, say so and suggest checking official docs

## Invocation

- Manual: `/claude-code-knowledge`
- Auto: when user asks about Claude Code features, configuration, or capabilities
