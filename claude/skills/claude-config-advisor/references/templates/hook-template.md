# Hook Template

## Settings.json Config
```json
{
  "hooks": {
    "{Event}": [{
      "matcher": "{Matcher}",
      "hooks": [{
        "type": "command",
        "command": "node \"{script_path}\"",
        "async": {true|false},
        "timeout": {milliseconds}
      }]
    }]
  }
}
```

## Script Template (Node.js)
```javascript
#!/usr/bin/env node

/**
 * Hook: {name}
 * Event: {event} | Matcher: {matcher}
 * Purpose: {description}
 */

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    
    // Available fields:
    // data.tool_name — tool being called
    // data.tool_input — tool parameters
    // data.session_id — current session
    // data.cwd — working directory
    
    // Your logic here
    
    // Optional: inject context into Claude
    // const output = {
    //   hookSpecificOutput: {
    //     hookEventName: "{event}",
    //     additionalContext: "..."
    //   }
    // };
    // process.stdout.write(JSON.stringify(output));
    
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Hook error: ${err.message}\n`);
    process.exit(1);
  }
});
```

## Common Event + Matcher Combinations

| Goal | Event | Matcher |
|---|---|---|
| Block dangerous commands | PreToolUse | Bash |
| Auto-format after edit | PostToolUse | Edit\|Write |
| Inject context at start | SessionStart | * |
| Collect metrics at end | Stop | * |
| Enrich user prompts | UserPromptSubmit | * |
| Block reading secrets | PreToolUse | Read |
