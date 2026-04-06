# Decision Matrix: When to Use What

## Quick Decision Tree

```
"I want to..."

├── "...always do X automatically when Y happens"
│   ├── Must happen 100% → HOOK
│   └── Should happen but advisory → RULE (in CLAUDE.md)
│
├── "...have expert knowledge about X available"
│   ├── Large knowledge base, read on demand → SKILL (with reference files)
│   └── Small behavioral guideline → RULE
│
├── "...delegate X to a specialist"
│   ├── Needs own context window → AGENT
│   ├── Needs web access or heavy research → AGENT
│   └── Simple delegation with shared context → SKILL (with context: fork)
│
├── "...follow convention X every session"
│   ├── Simple rule → RULE (CLAUDE.md or rules/)
│   └── Complex logic → SKILL (auto-invoked)
│
├── "...remember X across sessions"
│   ├── About me/my preferences → MEMORY (user type)
│   ├── How Claude should behave → RULE or MEMORY (feedback type)
│   ├── Project context → MEMORY (project type)
│   └── External system pointers → MEMORY (reference type)
│
├── "...connect to external service X"
│   └── → MCP SERVER
│
└── "...run X on a schedule"
    ├── During session → /loop skill
    ├── Cloud (even when computer off) → Scheduled task
    └── In CI/CD → GitHub Action
```

## Comparison Matrix

| Aspect | Skill | Agent | Hook | Rule | Memory | MCP |
|---|---|---|---|---|---|---|
| **Trigger** | On-demand or auto | On-demand or auto | Event-driven | Always loaded | On-demand | Tool call |
| **Context** | Main session | Own context | None (script) | Main session | Main session | External |
| **Reliability** | Advisory | Advisory | 100% deterministic | Advisory | Passive | Depends |
| **Complexity** | Any | Any | Simple logic | Simple | Data only | Any |
| **Latency** | Instant (context load) | Seconds (spawn) | < 5s (script) | Zero | Zero | Varies |
| **Token cost** | Skill size | Agent context | Zero | Rule size | Minimal | Zero |
| **Persistence** | File on disk | File on disk | Config + script | File on disk | File on disk | External |

## Common Scenarios

### "Auto-format code after editing"
**Answer**: Hook (PostToolUse, matcher: Edit|Write)
**Why not skill**: Must happen 100%, not advisory

### "Know best practices for Docker"
**Answer**: Skill (domain knowledge, reference files)
**Why not rule**: Too large for CLAUDE.md, loaded on demand

### "Review code for security issues"
**Answer**: Agent (needs own context, specialized tools)
**Why not skill**: Heavy analysis, shouldn't consume main context

### "Always use conventional commits"
**Answer**: Rule (in CLAUDE.md or rules/)
**Why not hook**: Behavioral convention, not deterministic enforcement

### "Track project deadlines"
**Answer**: Memory (project type)
**Why not rule**: Changes frequently, not behavioral

### "Query Jira tickets"
**Answer**: MCP Server
**Why not hook**: Needs bidirectional communication with external service

### "Check for secrets before committing"
**Answer**: Hook (PreToolUse, matcher: Bash, check for git commit)
**Why not rule**: Must happen 100%, not advisory

### "Research before coding"
**Answer**: Skill (workflow pattern, loaded when needed)
**Why not agent**: Guides behavior, doesn't delegate task

## Hybrid Patterns

Sometimes the best solution combines multiple components:

### Hook + Skill
Hook detects event → injects context suggesting a skill
Example: PostToolUse hook detects test failure → suggests "use /debug skill"

### Agent + Skill
Agent is spawned with preloaded skills for domain expertise
Example: code-reviewer agent loads coding-standards skill

### Rule + Hook
Rule describes desired behavior, hook enforces it
Example: Rule says "use immutable patterns", hook warns on mutation detected

### Memory + Skill
Memory stores learned preferences, skill applies them
Example: Memory records "user prefers React functional components", frontend skill reads this
