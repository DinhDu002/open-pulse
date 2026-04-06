#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
PLIST_NAME="com.open-pulse"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "=== Open Pulse Uninstaller ==="

# 1. Remove skill symlinks
echo "[1/5] Removing skill symlinks..."
for skill_dir in "$REPO_DIR/claude/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  target="$CLAUDE_DIR/skills/$skill_name"
  if [ -L "$target" ]; then
    rm "$target"
    echo "  Removed: $skill_name"
  fi
done

# 2. Remove agent symlinks
echo "[2/5] Removing agent symlinks..."
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
echo "[3/5] Removing hooks from settings.json..."
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

# 4. Restore CL v2 paths
echo "[4/5] Restoring CL v2 paths..."
CL_DIR="$CLAUDE_DIR/skills/continuous-learning-v2"
if [ -d "$CL_DIR" ]; then
  for file in "$CL_DIR/scripts/detect-project.sh" "$CL_DIR/hooks/observe.sh" "$CL_DIR/agents/start-observer.sh" "$CL_DIR/scripts/instinct-cli.py"; do
    if [ -f "${file}.op-backup" ]; then
      mv "${file}.op-backup" "$file"
      echo "  Restored: $(basename "$file")"
    fi
  done
fi

# 5. Stop launchd service
echo "[5/5] Stopping launchd service..."
if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi
[ -f "$PLIST_PATH" ] && rm "$PLIST_PATH"

# Remove path file
rm -f "$HOME/.open-pulse-path"

echo ""
echo "=== Open Pulse uninstalled ==="
echo "Note: Data (DB, logs) NOT deleted. Remove manually if desired:"
echo "  rm -rf $REPO_DIR/data $REPO_DIR/logs $REPO_DIR/open-pulse.db"
