#!/bin/bash
set -euo pipefail

# ── Resolve repo directory ──
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
PLIST_NAME="com.open-pulse"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
AGENT_PLIST_NAME="com.open-pulse.suggestion-agent"
AGENT_PLIST_PATH="$HOME/Library/LaunchAgents/${AGENT_PLIST_NAME}.plist"
NODE_PATH=$(which node)

echo "=== Open Pulse Installer ==="
echo "Repo: $REPO_DIR"

# ── 1. npm install ──
echo "[1/7] Installing dependencies..."
cd "$REPO_DIR"
npm install --production

# ── 2. Create runtime directories ──
echo "[2/7] Creating directories..."
mkdir -p "$REPO_DIR/data"
mkdir -p "$REPO_DIR/logs"
mkdir -p "$REPO_DIR/cl/instincts/personal"
mkdir -p "$REPO_DIR/cl/instincts/inherited"
mkdir -p "$REPO_DIR/cl/evolved"
mkdir -p "$REPO_DIR/cl/projects"

# ── 3. Initialize empty DB ──
echo "[3/9] Initializing database..."
node -e "require('$REPO_DIR/src/op-db').createDb('$REPO_DIR/open-pulse.db')"

# ── 4. Backfill prompts ──
echo "[4/9] Backfilling prompts..."
node "$REPO_DIR/scripts/op-backfill-prompts.js" --repo-dir "$REPO_DIR"

# ── 5. Seed instincts (cold start) ──
echo "[5/9] Seeding instincts..."
node "$REPO_DIR/scripts/cl-seed-instincts.js" --repo-dir "$REPO_DIR"

# ── 6. Symlink skills ──
echo "[6/9] Symlinking skills..."
for skill_dir in "$REPO_DIR/claude/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  target="$CLAUDE_DIR/skills/$skill_name"
  if [ -L "$target" ]; then
    echo "  Updating symlink: $skill_name"
    rm "$target"
    ln -s "$skill_dir" "$target"
  elif [ -d "$target" ]; then
    echo "  Skipping $skill_name (non-symlink directory exists)"
  else
    echo "  Creating symlink: $skill_name"
    ln -s "$skill_dir" "$target"
  fi
done

# ── 7. Symlink agents ──
echo "[7/9] Symlinking agents..."
for agent_file in "$REPO_DIR/claude/agents"/*.md; do
  [ -f "$agent_file" ] || continue
  agent_name=$(basename "$agent_file")
  target="$CLAUDE_DIR/agents/$agent_name"
  if [ -L "$target" ]; then
    rm "$target"
    ln -s "$agent_file" "$target"
  elif [ -f "$target" ]; then
    echo "  Skipping $agent_name (non-symlink file exists)"
  else
    ln -s "$agent_file" "$target"
  fi
done

# ── 8. Register hooks in settings.json ──
echo "[8/9] Registering hooks..."
node "$REPO_DIR/scripts/register-hooks.js" "$REPO_DIR"

# ── 9. Setup launchd services ──
echo "[9/9] Setting up launchd services..."
if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${REPO_DIR}/src/op-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${REPO_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_DIR}/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")</string>
    <key>OPEN_PULSE_DIR</key>
    <string>${REPO_DIR}</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# Suggestion agent (runs daily at 3 AM)
if launchctl list 2>/dev/null | grep -q "$AGENT_PLIST_NAME"; then
  launchctl bootout "gui/$(id -u)/$AGENT_PLIST_NAME" 2>/dev/null || true
fi

cat > "$AGENT_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${REPO_DIR}/scripts/op-daily-review.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${REPO_DIR}/logs/suggestion-agent-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_DIR}/logs/suggestion-agent-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")</string>
    <key>OPEN_PULSE_DIR</key>
    <string>${REPO_DIR}</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST_PATH"

echo ""
echo "=== Open Pulse installed ==="
echo "Dashboard: http://127.0.0.1:3827"
echo "Logs:      $REPO_DIR/logs/"
echo ""
echo "Daily review: runs daily at 3:00 AM"
echo "  Manual:  node $REPO_DIR/scripts/op-daily-review.js"
echo "  Logs:    $REPO_DIR/logs/suggestion-agent-stdout.log"
echo ""
echo "Management:"
echo "  Stop:    launchctl bootout gui/\$(id -u)/$PLIST_NAME"
echo "  Start:   launchctl bootstrap gui/\$(id -u) $PLIST_PATH"
echo "  Status:  launchctl print gui/\$(id -u)/$PLIST_NAME"
