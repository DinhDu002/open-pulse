# Real Hook Examples (from current setup)

## Security: block reading secrets
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/scripts/hooks/block-secrets-read.js",
        "async": false,
        "timeout": 5000
      }]
    }]
  }
}
```
**Pattern**: Sync PreToolUse hook that blocks (exit 2) reading .env files.

## Quality: auto-format after edit
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/scripts/hooks/quality-gate.js",
        "async": true,
        "timeout": 30000
      }]
    }]
  }
}
```
**Pattern**: Async PostToolUse hook for formatting/linting.

## Context: planning enforcement
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/scripts/hooks/plan-mode-enforcer.js",
        "async": false,
        "timeout": 5000
      }]
    }]
  }
}
```
**Pattern**: Sync UserPromptSubmit hook that injects additionalContext.

## Learning: session observation
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/skills/op-continuous-learning/hooks/observe.sh",
        "async": true,
        "timeout": 3000
      }]
    }]
  }
}
```
**Pattern**: Async observation hook (fire-and-forget, no blocking).
