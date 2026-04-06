#!/bin/bash
set -euo pipefail

# ── Resolve repo directory ──
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
PLIST_NAME="com.open-pulse"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
NODE_PATH=$(which node)

echo "=== Open Pulse Installer ==="
echo "Repo: $REPO_DIR"

# ── 1. npm install ──
echo "[1/9] Installing dependencies..."
cd "$REPO_DIR"
npm install --production

# ── 2. Create runtime directories ──
echo "[2/9] Creating directories..."
mkdir -p "$REPO_DIR/data"
mkdir -p "$REPO_DIR/logs"
mkdir -p "$REPO_DIR/cl/instincts/personal"
mkdir -p "$REPO_DIR/cl/instincts/inherited"
mkdir -p "$REPO_DIR/cl/evolved"
mkdir -p "$REPO_DIR/cl/projects"

# ── 3. Initialize empty DB ──
echo "[3/9] Initializing database..."
node -e "require('$REPO_DIR/src/op-db').createDb('$REPO_DIR/open-pulse.db')"

# ── 4. Symlink skills ──
echo "[4/9] Symlinking skills..."
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

# ── 5. Symlink agents ──
echo "[5/9] Symlinking agents..."
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

# ── 6. Register hooks in settings.json ──
echo "[6/9] Registering hooks..."
node "$REPO_DIR/scripts/register-hooks.js" "$REPO_DIR"

# ── 7. Write repo path for hook discovery ──
echo "[7/9] Writing repo path..."
echo "$REPO_DIR" > "$HOME/.open-pulse-path"

# ── 8. Update CL v2 paths ──
echo "[8/9] Updating CL v2 paths..."
CL_DIR="$CLAUDE_DIR/skills/continuous-learning-v2"
if [ -d "$CL_DIR" ]; then
  OLD_PATH="\$HOME/Workspace/open-pulse"
  NEW_PATH="$REPO_DIR/cl"
  for file in "$CL_DIR/scripts/detect-project.sh" "$CL_DIR/hooks/observe.sh" "$CL_DIR/agents/start-observer.sh"; do
    if [ -f "$file" ]; then
      if [ ! -f "${file}.op-backup" ]; then
        cp "$file" "${file}.op-backup"
      fi
      # Use different delimiters since paths contain /
      sed -i '' "s|~/Workspace/open-pulse|${NEW_PATH}|g" "$file" 2>/dev/null || true
      sed -i '' "s|\${HOME}/Workspace/open-pulse|${NEW_PATH}|g" "$file" 2>/dev/null || true
      sed -i '' "s|\$HOME/Workspace/open-pulse|${NEW_PATH}|g" "$file" 2>/dev/null || true
    fi
  done
  # Python file uses Path.home() / "Workspace" / "open-pulse"
  PYTHON_FILE="$CL_DIR/scripts/instinct-cli.py"
  if [ -f "$PYTHON_FILE" ]; then
    if [ ! -f "${PYTHON_FILE}.op-backup" ]; then
      cp "$PYTHON_FILE" "${PYTHON_FILE}.op-backup"
    fi
    sed -i '' "s|Path.home() / \"Workspace\" / \"open-pulse\"|Path(\"${NEW_PATH}\")|g" "$PYTHON_FILE" 2>/dev/null || true
  fi
  echo "  CL v2 paths updated to $NEW_PATH"
fi

# ── 9. Setup launchd service ──
echo "[9/9] Setting up launchd service..."
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

echo ""
echo "=== Open Pulse installed ==="
echo "Dashboard: http://127.0.0.1:3827"
echo "Logs:      $REPO_DIR/logs/"
echo ""
echo "Management:"
echo "  Stop:    launchctl bootout gui/\$(id -u)/$PLIST_NAME"
echo "  Start:   launchctl bootstrap gui/\$(id -u) $PLIST_PATH"
echo "  Status:  launchctl print gui/\$(id -u)/$PLIST_NAME"
