# MCP (Model Context Protocol) Guide

## What Is MCP

Open standard for connecting AI tools to external data sources and services. Allows Claude to interact with GitHub, Slack, databases, design tools, and custom services.

## Configuration

In `settings.json`:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["/path/to/server/index.js"],
      "env": {
        "API_TOKEN": "$API_TOKEN"
      }
    }
  }
}
```

### Common Server Patterns

**NPX-based (no install)**:
```json
{
  "puppeteer": {
    "command": "npx",
    "args": ["@anthropic-ai/puppeteer-mcp"]
  }
}
```

**Local server**:
```json
{
  "memory": {
    "command": "node",
    "args": ["~/.claude/mcp-servers/memory/index.js"]
  }
}
```

**With environment variables**:
```json
{
  "github": {
    "command": "node",
    "args": ["/path/to/github-server.js"],
    "env": {
      "GITHUB_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

## Permissions

```json
{
  "permissions": {
    "allow": [
      "mcp__memory__*",
      "mcp__github__*"
    ],
    "deny": [
      "mcp__puppeteer__*"
    ]
  },
  "allowedMcpServers": ["memory", "github"],
  "deniedMcpServers": ["untrusted-server"]
}
```

## Using MCP Resources

Reference MCP resources in prompts:
```
Show me @github:repos/owner/repo/issues/123
Query @postgres:select * from users limit 10
Read @notion:databases/my-db
```

## Popular MCP Servers

| Server | Purpose | Source |
|---|---|---|
| Memory | Persistent storage across sessions | Anthropic |
| Puppeteer | Browser automation | Anthropic |
| GitHub | Issues, PRs, repos | Community |
| Slack | Messages, channels | Community |
| Google Drive | Docs, Sheets, Slides | Community |
| Figma | Design files | Figma (official) |
| Notion | Databases, pages | Community |
| PostgreSQL | SQL queries | Community |
| Context7 | Library documentation | Community |
| Exa | Neural web search | Exa |
| Firecrawl | Web scraping | Firecrawl |

## Building Custom MCP Servers

Use the `mcp-server-patterns` skill for detailed patterns. Key concepts:

- Servers expose **tools**, **resources**, and **prompts**
- Use Node/TypeScript SDK (`@modelcontextprotocol/sdk`)
- Validate inputs with Zod schemas
- Handle errors gracefully
- Use stdio transport for local servers

## Best Practices

- Store tokens in environment variables, never in config
- Use `allowedMcpServers` to control which servers are active
- Test servers independently before adding to Claude
- Use `deniedMcpServers` to block unwanted servers
- Monitor server performance — slow servers delay Claude
