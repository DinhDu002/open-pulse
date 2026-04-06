---
name: hook-creator
description: Create Claude Code hooks with proper configuration and scripts. Use when user wants to automate actions on tool events (PreToolUse, PostToolUse, Stop, SessionStart, etc.).
---

# Hook Creator

Create a new Claude Code hook by collecting required information, scanning for conflicts, and generating both the script file and settings.json configuration.

## Required Information (collect ALL before generating)

You MUST collect all 7 fields. Ask one question at a time. Do NOT proceed until all fields are filled.

### 1. Event
Which lifecycle event triggers this hook?

| Event | When | Common Use |
|---|---|---|
| PreToolUse | Before tool executes | Validation, security |
| PostToolUse | After tool succeeds | Formatting, metrics |
| PostToolUseFailure | After tool fails | Error recovery |
| UserPromptSubmit | User sends message | Routing, enrichment |
| SessionStart | Session begins | Init, notifications |
| Stop | Session ends | Cleanup, reports |
| SubagentStart | Agent spawns | Tracking |
| SubagentStop | Agent finishes | Result processing |
| Notification | Special events | OS alerts |

### 2. Matcher
What should this hook match?
- `"Bash"` — specific tool
- `"Edit|Write"` — multiple tools (OR)
- `"*"` — everything

### 3. Hook Type
- **command** — shell script (most common)
- **http** — HTTP endpoint call
- **prompt** — LLM evaluation
- **agent** — spawn subagent

### 4. Logic Description
What should this hook do? (plain language, will be translated to code)

### 5. Async
- **false** (default) — blocks until complete (for security checks, validation)
- **true** — runs in background (for metrics, logging, notifications)

### 6. Timeout
- Default: 5000ms (5 seconds)
- Max recommended sync: 10000ms (10 seconds)
- Max recommended async: 30000ms (30 seconds)
- Typecheck/build: up to 300000ms (5 minutes)

### 7. Scope
- **Global**: `~/.claude/settings.json` + `~/.claude/scripts/hooks/`
- **Project**: `.claude/settings.json` + `.claude/hooks/`
- **Local only**: `.claude/settings.local.json` + `.claude/hooks/`

## Pre-Generation Checks

Before generating, scan existing hooks for:

1. Read settings.json hooks section for the chosen event
2. Check if a hook with similar matcher already exists
3. Check if another hook already does something similar
4. If conflict → present and ask: merge, replace, or add alongside?

## Generation: Script File

### Command hook template (Node.js)
```javascript
#!/usr/bin/env node

/**
 * Hook: {name}
 * Event: {event}
 * Matcher: {matcher}
 * Purpose: {description}
 */

const fs = require('fs');

// Read input from stdin
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    
    // Hook logic here
    const toolName = data.tool_name;
    const toolInput = data.tool_input;
    
    // {logic implementation}
    
    // Output (optional — for hooks that inject context)
    // const output = {
    //   hookSpecificOutput: {
    //     hookEventName: "{event}",
    //     additionalContext: "Context to inject"
    //   }
    // };
    // process.stdout.write(JSON.stringify(output));
    
    process.exit(0); // Success: allow action
    // process.exit(2); // Block: prevent action (PreToolUse only)
  } catch (err) {
    // Non-blocking error: log and continue
    process.stderr.write(`Hook error: ${err.message}\n`);
    process.exit(1);
  }
});
```

### Command hook template (Bash)
```bash
#!/bin/bash
# Hook: {name}
# Event: {event}
# Purpose: {description}

INPUT=$(cat)

# Parse with jq
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
# TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

# Hook logic here
# {logic}

exit 0  # Success
# exit 2  # Block action (PreToolUse only)
```

## Generation: Settings Config

```json
{
  "hooks": {
    "{event}": [{
      "matcher": "{matcher}",
      "hooks": [{
        "type": "command",
        "command": "node \"{script_path}\"",
        "async": {async},
        "timeout": {timeout}
      }]
    }]
  }
}
```

## After Generation

1. Present BOTH the script file AND the settings.json config for review
2. **NEVER auto-add to settings.json** — always ask user to confirm
3. After approval:
   - Write script file to chosen location
   - Make script executable: `chmod +x <script_path>`
   - Merge config into settings.json (append to existing event array, don't replace)
4. Suggest testing: "Test with mock input: `echo '{"tool_name":"Bash","tool_input":{"command":"test"}}' | node <script_path>`"

## Exit Code Reference

| Code | Meaning | When to Use |
|---|---|---|
| 0 | Success, allow | Default — hook processed successfully |
| 2 | Block action | PreToolUse: prevent dangerous operation |
| Other | Non-blocking error | Logged but doesn't stop execution |

## Safety Rules

- NEVER auto-modify settings.json without explicit user approval
- NEVER create hooks that could break Claude Code flow
- Always include error handling in scripts
- Always test with mock input before declaring complete
- Sync hooks MUST complete within timeout or Claude hangs
- Use async: true for anything that might be slow
