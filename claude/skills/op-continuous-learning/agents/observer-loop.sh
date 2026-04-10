#!/usr/bin/env bash
# Continuous Learning v2 - Observer background loop
#
# Reads events from Open Pulse SQLite via cl-export-events.js,
# runs Haiku analysis to detect patterns, writes instinct files.
# Timer-only mode (no SIGUSR1 dependency).

set +e
unset CLAUDECODE

SLEEP_PID=""
IDLE_TIMEOUT_SECONDS="${OP_OBSERVER_IDLE_TIMEOUT_SECONDS:-1800}"
SESSION_LEASE_DIR="${PROJECT_DIR}/.observer-sessions"
ACTIVITY_FILE="${PROJECT_DIR}/.observer-last-activity"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cleanup() {
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup TERM INT

file_mtime_epoch() {
  local file="$1"
  if [ ! -f "$file" ]; then
    printf '0\n'
    return
  fi

  if stat -c %Y "$file" >/dev/null 2>&1; then
    stat -c %Y "$file" 2>/dev/null || printf '0\n'
    return
  fi

  if stat -f %m "$file" >/dev/null 2>&1; then
    stat -f %m "$file" 2>/dev/null || printf '0\n'
    return
  fi

  printf '0\n'
}

has_active_session_leases() {
  if [ ! -d "$SESSION_LEASE_DIR" ]; then
    return 1
  fi

  find "$SESSION_LEASE_DIR" -type f -name '*.json' -print -quit 2>/dev/null | grep -q .
}

latest_activity_epoch() {
  local activity_epoch
  activity_epoch="$(file_mtime_epoch "$ACTIVITY_FILE")"
  printf '%s\n' "$activity_epoch"
}

exit_if_idle_without_sessions() {
  if has_active_session_leases; then
    return
  fi

  local last_activity now_epoch idle_for
  last_activity="$(latest_activity_epoch)"
  now_epoch="$(date +%s)"
  idle_for=$(( now_epoch - last_activity ))

  if [ "$last_activity" -eq 0 ] || [ "$idle_for" -ge "$IDLE_TIMEOUT_SECONDS" ]; then
    echo "[$(date)] Observer idle without active session leases for ${idle_for}s; exiting" >> "$LOG_FILE"
    cleanup
  fi
}

analyze_observations() {
  local db_path="${REPO_DIR}/open-pulse.db"
  if [ ! -f "$db_path" ]; then
    echo "[$(date)] Database not found: $db_path, skipping analysis" >> "$LOG_FILE"
    return
  fi

  if [ "${OP_CL_IS_WINDOWS:-false}" = "true" ] && [ "${OP_OBSERVER_ALLOW_WINDOWS:-false}" != "true" ]; then
    echo "[$(date)] Skipping claude analysis on Windows due to known non-interactive hang issue (#295). Set OP_OBSERVER_ALLOW_WINDOWS=true to override." >> "$LOG_FILE"
    return
  fi

  if ! command -v claude >/dev/null 2>&1; then
    echo "[$(date)] claude CLI not found, skipping analysis" >> "$LOG_FILE"
    return
  fi

  # session-guardian: gate observer cycle (active hours, cooldown, idle detection)
  if ! bash "$(dirname "$0")/session-guardian.sh"; then
    echo "[$(date)] Observer cycle skipped by session-guardian" >> "$LOG_FILE"
    return
  fi

  # Export recent events from SQLite for this project
  MAX_ANALYSIS_LINES="${OP_OBSERVER_MAX_ANALYSIS_LINES:-500}"
  observer_tmp_dir="${PROJECT_DIR}/.observer-tmp"
  mkdir -p "$observer_tmp_dir"
  analysis_file="$(mktemp "${observer_tmp_dir}/op-observer-analysis.XXXXXX.jsonl")"

  local export_args="--db ${db_path} --limit ${MAX_ANALYSIS_LINES} --output ${analysis_file}"
  if [ -n "$PROJECT_ROOT" ]; then
    export_args="${export_args} --project-root ${PROJECT_ROOT}"
  fi

  # Read last-export timestamp for incremental export
  local since_file="${PROJECT_DIR}/.last-analysis-ts"
  if [ -f "$since_file" ]; then
    local since_ts
    since_ts="$(cat "$since_file" 2>/dev/null)"
    if [ -n "$since_ts" ]; then
      export_args="${export_args} --since ${since_ts}"
    fi
  fi

  export_output=$(node "${REPO_DIR}/scripts/cl-export-events.js" $export_args 2>>"$LOG_FILE")
  obs_count="${export_output%%	*}"
  obs_max_ts="${export_output#*	}"
  if [ "$obs_count" = "$obs_max_ts" ]; then
    obs_max_ts=""  # no tab found — empty or error output
  fi
  if [ -z "$obs_count" ] || [ "$obs_count" -eq 0 ] 2>/dev/null; then
    echo "[$(date)] No new events to analyze for ${PROJECT_NAME}" >> "$LOG_FILE"
    rm -f "$analysis_file"
    return
  fi

  if [ "$obs_count" -lt "$MIN_OBSERVATIONS" ]; then
    echo "[$(date)] Only $obs_count events (need $MIN_OBSERVATIONS), skipping analysis" >> "$LOG_FILE"
    rm -f "$analysis_file"
    return
  fi

  echo "[$(date)] Analyzing $obs_count events for project ${PROJECT_NAME}..." >> "$LOG_FILE"

  # Use relative path from PROJECT_DIR for cross-platform compatibility (#842).
  analysis_relpath=".observer-tmp/$(basename "$analysis_file")"

  prompt_file="$(mktemp "${observer_tmp_dir}/op-observer-prompt.XXXXXX")"
  cat > "$prompt_file" <<PROMPT
IMPORTANT: You are running in non-interactive --print mode. You MUST use the Write tool directly to create files. Do NOT ask for permission, do NOT ask for confirmation, do NOT output summaries instead of writing. Just read, analyze, and write.

Read ${analysis_relpath} and identify patterns for the project ${PROJECT_NAME} (user corrections, error resolutions, repeated workflows, tool preferences).
If you find 3+ occurrences of the same pattern, you MUST write an instinct file directly to ${INSTINCTS_DIR}/<id>.md using the Write tool.
Do NOT ask for permission to write files, do NOT describe what you would write, and do NOT stop at analysis when a qualifying pattern exists.

The data includes:
- event_type: one of "skill_invoke", "agent_spawn", or "tool_call" (use to identify skill/agent usage vs plain tool calls)
- seq_num: order of tool calls within a session (use to detect TEMPORAL PATTERNS like "user always does X after Y")
- success: true/false indicating if the tool call succeeded (use to detect error-recovery pairs)
- user_prompt: the user's most recent request (use to understand intent behind tool usage)

CRITICAL: Every instinct file MUST use this exact format:

---
id: kebab-case-name
trigger: when <specific condition>
confidence: <0.3-0.85 based on frequency: 3-5 times=0.5, 6-10=0.7, 11+=0.85>
domain: <one of: code-style, testing, git, debugging, workflow, file-patterns, component-quality>
source: session-observation
scope: project
project_id: ${PROJECT_ID}
project_name: ${PROJECT_NAME}
---

# Title

## Action
<what to do, one clear sentence>

## Evidence
- Observed N times in session <id>
- Pattern: <description>
- Last observed: <date>

Rules:
- Be conservative, only clear patterns with 3+ observations
- Use narrow, specific triggers
- Never include actual code snippets, only describe patterns
- When a qualifying pattern exists, write or update the instinct file in this run instead of asking for confirmation
- If a similar instinct already exists in ${INSTINCTS_DIR}/, update it instead of creating a duplicate
- The YAML frontmatter (between --- markers) with id field is MANDATORY
- If a pattern seems universal (not project-specific), set scope to global instead of project
- For temporal/workflow patterns (X always follows Y), set domain to workflow
- Examples of global patterns: always validate user input, prefer explicit error handling
- Examples of project patterns: use React functional components, follow Django REST framework conventions

COMPONENT QUALITY ANALYSIS (domain: component-quality):

When event_type is "skill_invoke" or "agent_spawn", also check for component quality issues:

a) POST-INVOCATION CORRECTION DENSITY: After a skill_invoke/agent_spawn, count tool_call events before the next different user_prompt. If 5+ tool calls follow in the same session, the component likely did not complete its job.

b) POST-INVOCATION ERROR CHAINS: After a skill_invoke/agent_spawn, if 2+ of the next 5 events have success=false, the component left the session in a broken state.

c) RETRY PATTERNS: Same skill/agent name appears 2+ times in the same session with different seq_nums. The user had to re-invoke it.

d) USER CORRECTION LANGUAGE: After skill_invoke/agent_spawn, if the next user_prompt contains correction words like "no", "wrong", "redo", "fix", "instead", "actually", the component produced incorrect results.

e) LOW SUCCESS RATE: A skill/agent has success=false on 2+ of its own invocations across the observations.

For component-quality instincts:
- id: quality-<component-name>-<issue-type> (e.g. quality-tdd-workflow-correction-density)
- trigger: "when skill <name> is invoked" or "when agent <name> is spawned"
- domain: component-quality
- scope: global (component quality is not project-specific)
- In ## Evidence, include: component name, signal type (correction-density/error-chain/retry/user-correction/low-success), session IDs, specific seq_num ranges

---

PHASE 2: REFLECT — Review existing instincts

After creating/updating instincts from new observations, review ALL existing instinct files in ${INSTINCTS_DIR}/:

For each existing instinct:
1. If NO supporting evidence in the recent observations above → reduce its confidence by 0.05 (read the file, update the confidence field, write back)
2. If the observations CONTRADICT the instinct → add "contradicted: true" to the YAML frontmatter and reduce confidence by 0.15
3. If two instincts describe essentially the SAME pattern → merge them: keep the higher-confidence one, combine their evidence sections, delete the duplicate
4. If an instinct's confidence drops below 0.1 → delete the file entirely

Confidence decay guidelines:
- High-confidence instincts (0.7+) decay slowly — only reduce if truly unsupported
- Low-confidence instincts (below 0.4) decay faster — they need fresh evidence to survive
- Instincts marked user_validated: true should decay at half rate (reduce by 0.025 instead of 0.05)
- NEVER increase confidence during reflect — that only happens from new pattern detection above

When updating confidence, use toFixed(2) to avoid floating point drift.
PROMPT

  timeout_seconds="${OP_OBSERVER_TIMEOUT_SECONDS:-120}"
  max_turns="${OP_OBSERVER_MAX_TURNS:-25}"
  exit_code=0

  case "$max_turns" in
    ''|*[!0-9]*)
      max_turns=10
      ;;
  esac

  if [ "$max_turns" -lt 4 ]; then
    max_turns=10
  fi

  # Ensure CWD is PROJECT_DIR so the relative analysis_relpath resolves correctly
  cd "$PROJECT_DIR" || { echo "[$(date)] Failed to cd to PROJECT_DIR ($PROJECT_DIR), skipping analysis" >> "$LOG_FILE"; rm -f "$prompt_file" "$analysis_file"; return; }

  # Prevent op-collector from recording this automated Haiku session.
  OP_SKIP_COLLECT=1 OP_HOOK_PROFILE=minimal claude --model haiku --max-turns "$max_turns" --print \
    --allowedTools "Read,Write" \
    -p "$(cat "$prompt_file")" >> "$LOG_FILE" 2>&1 &
  claude_pid=$!
  rm -f "$prompt_file"

  (
    sleep "$timeout_seconds"
    if kill -0 "$claude_pid" 2>/dev/null; then
      echo "[$(date)] Claude analysis timed out after ${timeout_seconds}s; terminating process" >> "$LOG_FILE"
      kill "$claude_pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  wait "$claude_pid"
  exit_code=$?
  kill "$watchdog_pid" 2>/dev/null || true
  rm -f "$analysis_file"

  if [ "$exit_code" -ne 0 ]; then
    echo "[$(date)] Claude analysis failed (exit $exit_code); watermark not advanced" >> "$LOG_FILE"
  else
    # Advance watermark to max timestamp from processed batch (not wall clock)
    if [ -n "$obs_max_ts" ]; then
      printf '%s\n' "$obs_max_ts" > "$since_file" 2>/dev/null || true
    fi
  fi
}

echo "$$" > "$PID_FILE"
echo "[$(date)] Observer started for ${PROJECT_NAME} (PID: $$)" >> "$LOG_FILE"

# Prune expired pending instincts before analysis
"${OP_CL_PYTHON_CMD:-python3}" "${SCRIPT_DIR}/../scripts/instinct-cli.py" prune --quiet >> "$LOG_FILE" 2>&1 || echo "[$(date)] Warning: instinct prune failed (non-fatal)" >> "$LOG_FILE"

while true; do
  exit_if_idle_without_sessions
  sleep "$OBSERVER_INTERVAL_SECONDS" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null
  SLEEP_PID=""

  exit_if_idle_without_sessions
  analyze_observations
done
