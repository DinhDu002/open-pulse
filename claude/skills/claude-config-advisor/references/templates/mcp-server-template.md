# MCP Server Template

## Settings.json Config
```json
{
  "mcpServers": {
    "{server-name}": {
      "command": "{node|npx|python}",
      "args": ["{path-to-server}"],
      "env": {
        "API_KEY": "$ENV_VAR_NAME"
      }
    }
  },
  "permissions": {
    "allow": ["mcp__{server-name}__*"]
  }
}
```

## NPX-based (no install needed)
```json
{
  "{name}": {
    "command": "npx",
    "args": ["{package-name}"]
  }
}
```

## Local server
```json
{
  "{name}": {
    "command": "node",
    "args": ["~/.claude/mcp-servers/{name}/index.js"]
  }
}
```

## When to Use MCP vs Other Components

| Need | Use |
|---|---|
| Query external API | MCP Server |
| Read external data source | MCP Server |
| Internal automation | Hook |
| Domain knowledge | Skill |
| Delegated task | Agent |
