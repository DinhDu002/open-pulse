# Hooks Guide

## What Are Hooks

Hooks are shell commands, HTTP endpoints, LLM prompts, or agents that execute automatically at specific lifecycle points. They receive JSON context, can inspect/modify input, and return decisions.

## Hook Events (16 types)

### Session Events
| Event | When | Use Case |
|---|---|---|
| SessionStart | CLI starts | Initialize context, load config |
| SessionEnd | CLI ends | Cleanup, metrics |

### Tool Events
| Event | When | Use Case |
|---|---|---|
| PreToolUse | Before tool call | Validate input, security checks |
| PostToolUse | After successful tool | Auto-format, cache, metrics |
| PostToolUseFailure | After tool fails | Error recovery, logging |

### Permission Events
| Event | When | Use Case |
|---|---|---|
| PermissionRequest | Permission needed | Custom approval logic |
| PermissionDenied | Permission denied | Logging, alternative actions |

### User Events
| Event | When | Use Case |
|---|---|---|
| UserPromptSubmit | User sends message | Routing, enrichment, validation |
| Stop | Session stopping | Final verification, cleanup |
| StopFailure | Stop fails | Recovery |

### Agent Events
| Event | When | Use Case |
|---|---|---|
| SubagentStart | Subagent spawns | Tracking, resource allocation |
| SubagentStop | Subagent completes | Result processing |
| TaskCreated | Task created | Progress tracking |
| TaskCompleted | Task done | Next-step logic |
| TeammateIdle | Teammate waiting | Work assignment |

### Async Events
| Event | When | Use Case |
|---|---|---|
| FileChanged | File modified externally | Auto-reload, validation |
| CwdChanged | Working directory changes | Context update |
| ConfigChange | Config modified | Reload settings |
| WorktreeCreate | Worktree created | Setup isolation |
| WorktreeRemove | Worktree removed | Cleanup |
| InstructionsLoaded | CLAUDE.md loaded | Context enrichment |
| Notification | Special events | OS notifications |

### Compaction Events
| Event | When | Use Case |
|---|---|---|
| PreCompact | Before compaction | Save critical state |
| PostCompact | After compaction | Restore state |

## Hook Types (4)

### 1. Command Hook
```json
{
  "type": "command",
  "command": "/path/to/script.sh",
  "async": false,
  "shell": "bash",
  "timeout": 10000
}
```

### 2. HTTP Hook
```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/event",
  "timeout": 30000,
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"]
}
```

### 3. Prompt Hook
```json
{
  "type": "prompt",
  "prompt": "Is this command safe? Input: $ARGUMENTS",
  "model": "fast-model"
}
```

### 4. Agent Hook
```json
{
  "type": "agent",
  "agent": "Explore"
}
```

## Configuration

### In settings.json
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "/path/to/check.sh",
        "async": false,
        "timeout": 5000
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "eslint --fix $FILE"
      }]
    }]
  }
}
```

### Matcher Syntax
- `"Bash"` — exact tool name
- `"Edit|Write"` — multiple tools (OR)
- `"*"` — all tools/events

### Settings Locations
| Location | Scope |
|---|---|
| `~/.claude/settings.json` | All projects |
| `.claude/settings.json` | Single project |
| `.claude/settings.local.json` | Local only (gitignored) |
| Plugin `hooks/hooks.json` | Plugin-scoped |
| Skill/Agent frontmatter | While skill/agent active |

## Hook Input (stdin JSON)

```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "session_id": "abc-123",
  "cwd": "/Users/user/project",
  "model": "opus",
  "timestamp": "2026-04-06T10:00:00Z"
}
```

## Hook Output (stdout JSON)

### For UserPromptSubmit
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Extra context injected into Claude's prompt"
  }
}
```

### For PreToolUse (blocking)
Exit code 2 = block the tool call.

## Exit Codes

| Code | Meaning | Effect |
|---|---|---|
| 0 | Success | Parse stdout for JSON, continue |
| 2 | Blocking error | Prevents action |
| Other | Non-blocking error | Logged, continue |

## Best Practices

- Keep hooks fast (< 5 seconds for sync, < 30s for async)
- Use `async: true` for non-blocking operations (metrics, logging)
- Use `async: false` for security checks that must complete before tool executes
- Always handle errors gracefully — hooks should not crash Claude Code
- Use exit code 2 only for genuine security/safety blocks
- Test hooks with mock JSON input before deploying
- Store scripts in `~/.claude/scripts/hooks/` or `.claude/hooks/`
