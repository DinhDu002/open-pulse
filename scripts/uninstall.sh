#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
PLIST_NAME="com.open-pulse"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
AGENT_PLIST_NAME="com.open-pulse.suggestion-agent"
AGENT_PLIST_PATH="$HOME/Library/LaunchAgents/${AGENT_PLIST_NAME}.plist"
OBSERVER_PLIST_NAME="com.open-pulse.observer"
OBSERVER_PLIST_PATH="$HOME/Library/LaunchAgents/${OBSERVER_PLIST_NAME}.plist"

echo "=== Open Pulse Uninstaller ==="

# 1. Remove skill symlinks
echo "[1/4] Removing skill symlinks..."
for skill_dir in "$REPO_DIR/claude/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  target="$CLAUDE_DIR/skills/$skill_name"
  if [ -L "$target" ]; then
    rm "$target"
    echo "  Removed: $skill_name"
  fi
done

# 2. Remove agent symlinks
echo "[2/4] Removing agent symlinks..."
for agent_file in "$REPO_DIR/claude/agents"/*.md; do
  [ -f "$agent_file" ] || continue
  agent_name=$(basename "$agent_file")
  target="$CLAUDE_DIR/agents/$agent_name"
  if [ -L "$target" ]; then
    rm "$target"
    echo "  Removed: $agent_name"
  fi
done

# 3. Remove hook entries from settings.json
echo "[3/4] Removing hooks from settings.json..."
SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  # Remove hooks that reference this repo
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf8'));
    const repoDir = '$REPO_DIR';
    for (const [event, groups] of Object.entries(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      settings.hooks[event] = groups.filter(g => {
        if (!Array.isArray(g.hooks)) return true;
        g.hooks = g.hooks.filter(h => !(h.command || '').includes(repoDir));
        return g.hooks.length > 0;
      });
    }
    fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2));
  "
  echo "  Hooks removed"
fi

# 4. Stop launchd services
echo "[4/4] Stopping launchd services..."
if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi
[ -f "$PLIST_PATH" ] && rm "$PLIST_PATH"

if launchctl list 2>/dev/null | grep -q "$AGENT_PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$AGENT_PLIST_NAME" 2>/dev/null || true
fi
[ -f "$AGENT_PLIST_PATH" ] && rm "$AGENT_PLIST_PATH"

# Observer service
if launchctl list 2>/dev/null | grep -q "$OBSERVER_PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$OBSERVER_PLIST_NAME" 2>/dev/null || true
fi
[ -f "$OBSERVER_PLIST_PATH" ] && rm "$OBSERVER_PLIST_PATH"

echo ""
echo "=== Open Pulse uninstalled ==="
echo "Note: Data (DB, logs) NOT deleted. Remove manually if desired:"
echo "  rm -rf $REPO_DIR/data $REPO_DIR/logs $REPO_DIR/open-pulse.db"
