# Settings Guide

## Settings Files & Precedence (highest to lowest)

| Priority | Location | Scope |
|---|---|---|
| 1 | Managed: `/Library/Application Support/ClaudeCode/` (macOS) | Organization |
| 2 | CLI arguments | Temporary override |
| 3 | Local project: `.claude/settings.local.json` | Project (personal) |
| 4 | Shared project: `.claude/settings.json` | Project (shared) |
| 5 | User: `~/.claude/settings.json` | All projects |

## Complete Settings Reference

### Permissions
```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(npm run *)", "Edit(/src/**)"],
    "ask": ["Bash"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

**defaultMode options**: `"default"`, `"acceptEdits"`, `"plan"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`

**Permission patterns**:
- `"Bash(npm run *)"` — allow bash commands matching pattern
- `"Edit(/src/**)"` — allow edits to files matching glob
- `"mcp__server__tool"` — allow specific MCP tool
- `"Read"` — allow all reads (already default)

### Model & Performance
```json
{
  "model": "claude-opus-4-6",
  "modelProvider": "anthropic",
  "alwaysThinkingEnabled": true,
  "showThinkingSummaries": false,
  "contextCompactionTarget": 0.5
}
```

**modelProvider options**: `"anthropic"`, `"aws-bedrock"`, `"vertex-ai"`

### Hooks
```json
{
  "hooks": {
    "EventName": [{
      "matcher": "ToolName|OtherTool",
      "hooks": [{
        "type": "command",
        "command": "/path/to/script",
        "async": false,
        "timeout": 10000,
        "shell": "bash"
      }]
    }]
  },
  "disableAllHooks": false,
  "disableSkillShellExecution": false,
  "allowManagedHooksOnly": false
}
```

### MCP Servers
```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "TOKEN": "$ENV_VAR" }
    }
  },
  "allowedMcpServers": ["server-name"],
  "deniedMcpServers": ["blocked-server"]
}
```

### Environment & Context
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "$ANTHROPIC_API_KEY",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "additionalDirectories": ["/path/to/additional/dir"],
  "additionalWorkspaces": [],
  "claudeMdExcludes": ["/path/**"]
}
```

### Memory
```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "~/custom-memory-dir"
}
```

### Plugins
```json
{
  "enabledPlugins": ["superpowers", "skill-creator", "pr-review-toolkit"]
}
```

### Output & Debugging
```json
{
  "languageForMarkdownBlocks": "text",
  "outputFormat": "text",
  "verboseMode": false,
  "cleanupPeriodDays": 30
}
```

**outputFormat options**: `"text"`, `"json"`, `"stream-json"`

## Common Configuration Patterns

### Cost-optimized setup
```json
{
  "model": "claude-haiku-4-5-20251001",
  "permissions": { "defaultMode": "plan" }
}
```

### Security-enforced setup
```json
{
  "permissions": {
    "deny": ["Bash(rm -rf *)", "Bash(* | rm -rf *)"]
  },
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read",
      "hooks": [{ "type": "command", "command": "block-secrets.sh" }]
    }]
  }
}
```

### Auto-formatting setup
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "prettier --write $FILE" }]
    }]
  }
}
```
