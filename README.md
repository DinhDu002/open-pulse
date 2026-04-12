# Open Pulse

Local analytics dashboard for Claude Code — usage metrics, expert system, component lifecycle management.

## Quick Start

```bash
git clone <repo-url> ~/Workspace/open-pulse
cd ~/Workspace/open-pulse
./scripts/install.sh
```

Dashboard: http://127.0.0.1:3827

## Features

- **Dashboard** — Sessions, cost tracking, tool/skill/agent rankings
- **Inventory** — Skills, agents, hooks, rules with usage stats
- **Expert System** — Automation suggestions, setup scanner, component actions
- **Continuous Learning** — Instinct tracking, project-scoped observations

## Architecture

```
Hooks (collector) → JSONL files → Ingestion → SQLite → API → SPA Dashboard
```

- **Collector**: Hook scripts write events to `data/*.jsonl`
- **Ingestion**: Server atomically processes JSONL → SQLite every 10s
- **API**: Fastify server on port 3827
- **Dashboard**: Vanilla JS SPA with hash-based routing

## Management

```bash
# Stop service
launchctl bootout gui/$(id -u)/com.open-pulse

# Start service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.open-pulse.plist

# Check status
launchctl print gui/$(id -u)/com.open-pulse

# Run tests
npm test

# Uninstall
./scripts/uninstall.sh
```

## Tech Stack

- Node.js 20+, Fastify 5, better-sqlite3
- Chart.js 4, vanilla JS ES modules
- launchd (macOS service management)

## License

MIT
