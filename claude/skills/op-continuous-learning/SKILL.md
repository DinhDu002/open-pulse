---
name: op-continuous-learning
description: Instinct-based learning system that observes sessions via hooks, creates atomic instincts with confidence scoring, and evolves them into skills/commands/agents. v2.1 adds project-scoped instincts to prevent cross-project contamination.
origin: open-pulse
version: 2.1.0
---

# Continuous Learning v2.1 - Instinct-Based Architecture

An advanced learning system that turns your Claude Code sessions into reusable knowledge through atomic "instincts" - small learned behaviors with confidence scoring.

**v2.1** adds **project-scoped instincts** — React patterns stay in your React project, Python conventions stay in your Python project, and universal patterns (like "always validate input") are shared globally.

## When to Activate

- Setting up automatic learning from Claude Code sessions
- Configuring instinct-based behavior extraction via hooks
- Tuning confidence thresholds for learned behaviors
- Reviewing, exporting, or importing instinct libraries
- Evolving instincts into full skills, commands, or agents
- Managing project-scoped vs global instincts
- Promoting instincts from project to global scope

## What's New in v2.1

| Feature | v2.0 | v2.1 |
|---------|------|------|
| Storage | Global (~/.claude/homunculus/) | Project-scoped (~/Workspace/open-pulse/projects/<hash>/) |
| Scope | All instincts apply everywhere | Project-scoped + global |
| Detection | None | git remote URL / repo path |
| Promotion | N/A | Project → global when seen in 2+ projects |
| Commands | 4 (status/evolve/export/import) | 6 (+promote/projects) |
| Cross-project | Contamination risk | Isolated by default |

## What's New in v2 (vs v1)

| Feature | v1 | v2 |
|---------|----|----|
| Observation | Stop hook (session end) | PreToolUse/PostToolUse (100% reliable) |
| Analysis | Main context | Background agent (Haiku) |
| Granularity | Full skills | Atomic "instincts" |
| Confidence | None | 0.3-0.9 weighted |
| Evolution | Direct to skill | Instincts -> cluster -> skill/command/agent |
| Sharing | None | Export/import instincts |

## The Instinct Model

An instinct is a small learned behavior:

```yaml
---
id: prefer-functional-style
trigger: "when writing new functions"
confidence: 0.7
domain: "code-style"
source: "session-observation"
scope: project
project_id: "a1b2c3d4e5f6"
project_name: "my-react-app"
---

# Prefer Functional Style

## Action
Use functional patterns over classes when appropriate.

## Evidence
- Observed 5 instances of functional pattern preference
- User corrected class-based approach to functional on 2025-01-15
```

**Properties:**
- **Atomic** -- one trigger, one action
- **Confidence-weighted** -- 0.3 = tentative, 0.9 = near certain
- **Domain-tagged** -- code-style, testing, git, debugging, workflow, etc.
- **Evidence-backed** -- tracks what observations created it
- **Scope-aware** -- `project` (default) or `global`

## How It Works

```
Session Activity (in a git repo)
      |
      | op-collector.js captures tool events (PostToolUse hook)
      | Full tool_input + tool_response, secrets scrubbed
      v
+---------------------------------------------+
|  data/events.jsonl → op-ingest → SQLite      |
|  (single source of truth for all events)     |
+---------------------------------------------+
      |
      | cl-export-events.js queries SQLite
      | by project root + time range
      | Observer agent reads (background, Haiku)
      v
+---------------------------------------------+
|     PATTERN DETECTION + REFLECT              |
|   * User corrections -> instinct             |
|   * Error resolutions -> instinct            |
|   * Repeated workflows -> instinct           |
|   * Temporal patterns (seq_num + success)    |
|   * Scope decision: project or global?       |
|   * Reflect: decay unsupported instincts     |
|   * Merge duplicates, delete < 0.1           |
+---------------------------------------------+
      |
      | Creates/updates
      v
+---------------------------------------------+
|  ~/Workspace/open-pulse/projects/<hash>/     |
|  instincts/personal/                         |
|   * prefer-functional.yaml (0.7) [project]   |
|   * use-react-hooks.yaml (0.9) [project]     |
+---------------------------------------------+
|  ~/Workspace/open-pulse/instincts/personal/  |
|  (GLOBAL)                                    |
|   * always-validate-input.yaml (0.85) [global]|
|   * grep-before-edit.yaml (0.6) [global]     |
+---------------------------------------------+
      |
      | /evolve clusters + /promote
      v
+---------------------------------------------+
|  ~/Workspace/open-pulse/projects/<hash>/     |
|  evolved/ (project-scoped)                   |
|  ~/Workspace/open-pulse/evolved/ (global)    |
|   * commands/new-feature.md                  |
|   * skills/testing-workflow.md               |
|   * agents/refactor-specialist.md            |
+---------------------------------------------+
      |
      | Feedback loop (approve/dismiss)
      v
+---------------------------------------------+
|  suggestion-analyzer scans instincts (YAML)  |
|  → suggestions with instinct_id traceability |
|  Approve: +0.15 confidence, user_validated   |
|  Dismiss: -0.2 confidence, 3x → archived    |
+---------------------------------------------+
```

## Project Detection

The system automatically detects your current project:

1. **`CLAUDE_PROJECT_DIR` env var** (highest priority)
2. **`git remote get-url origin`** -- hashed to create a portable project ID (same repo on different machines gets the same ID)
3. **`git rev-parse --show-toplevel`** -- fallback using repo path (machine-specific)
4. **Global fallback** -- if no project is detected, instincts go to global scope

Each project gets a 12-character hash ID (e.g., `a1b2c3d4e5f6`). A registry file at `~/Workspace/open-pulse/projects.json` maps IDs to human-readable names.

## Quick Start

### 1. Data Collection

CL uses events collected by Open Pulse's `op-collector.js` hook (registered automatically by `op-install.sh`). No separate hook configuration needed — just run the installer.

The collector captures full `tool_input` and `tool_response` (5KB each, secrets scrubbed), `seq_num` (tool call order), and `success` (boolean) for every tool call. This data is stored in SQLite and used by the CL observer for pattern detection.

### 2. Initialize Directory Structure

The system creates directories automatically on first use, but you can also create them manually:

```bash
# Global directories
mkdir -p ~/Workspace/open-pulse/{instincts/{personal,inherited},evolved/{agents,skills,commands},projects}

# Project directories are auto-created when the hook first runs in a git repo
```

### 3. Use the Instinct Commands

```bash
/instinct-status     # Show learned instincts (project + global)
/evolve              # Cluster related instincts into skills/commands
/instinct-export     # Export instincts to file
/instinct-import     # Import instincts from others
/promote             # Promote project instincts to global scope
/projects            # List all known projects and their instinct counts
```

## Commands

| Command | Description |
|---------|-------------|
| `/instinct-status` | Show all instincts (project-scoped + global) with confidence |
| `/evolve` | Cluster related instincts into skills/commands, suggest promotions |
| `/instinct-export` | Export instincts (filterable by scope/domain) |
| `/instinct-import <file>` | Import instincts with scope control |
| `/promote [id]` | Promote project instincts to global scope |
| `/projects` | List all known projects and their instinct counts |

## Configuration

Edit `config.json` to control the background observer:

```json
{
  "version": "2.1",
  "observer": {
    "enabled": false,
    "run_interval_minutes": 5,
    "min_observations_to_analyze": 20
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `observer.enabled` | `false` | Enable the background observer agent |
| `observer.run_interval_minutes` | `5` | How often the observer analyzes observations |
| `observer.min_observations_to_analyze` | `20` | Minimum observations before analysis runs |

Other behavior (instinct thresholds, project scoping, promotion criteria) is configured via code defaults in `instinct-cli.py`.

### Disabling the System

To temporarily disable all observation hooks and the observer agent:

```bash
touch ~/Workspace/open-pulse/disabled
```

To re-enable:

```bash
rm ~/Workspace/open-pulse/disabled
```

When the `disabled` file exists, the observer agent skips analysis cycles.

## File Structure

```
~/Workspace/open-pulse/
+-- identity.json           # Your profile, technical level
+-- projects.json           # Registry: project hash -> name/path/remote
+-- instincts/
|   +-- personal/           # Global auto-learned instincts
|   +-- inherited/          # Global imported instincts
+-- evolved/
|   +-- agents/             # Global generated agents
|   +-- skills/             # Global generated skills
|   +-- commands/           # Global generated commands
+-- projects/
    +-- a1b2c3d4e5f6/       # Project hash (from git remote URL)
    |   +-- project.json    # Per-project metadata mirror (id/name/root/remote)
    |   +-- instincts/
    |   |   +-- personal/   # Project-specific auto-learned
    |   |   +-- inherited/  # Project-specific imported
    |   +-- evolved/
    |       +-- skills/
    |       +-- commands/
    |       +-- agents/
    +-- f6e5d4c3b2a1/       # Another project
        +-- ...
```

## Scope Decision Guide

| Pattern Type | Scope | Examples |
|-------------|-------|---------|
| Language/framework conventions | **project** | "Use React hooks", "Follow Django REST patterns" |
| File structure preferences | **project** | "Tests in `__tests__`/", "Components in src/components/" |
| Code style | **project** | "Use functional style", "Prefer dataclasses" |
| Error handling strategies | **project** | "Use Result type for errors" |
| Security practices | **global** | "Validate user input", "Sanitize SQL" |
| General best practices | **global** | "Write tests first", "Always handle errors" |
| Tool workflow preferences | **global** | "Grep before Edit", "Read before Write" |
| Git practices | **global** | "Conventional commits", "Small focused commits" |

## Instinct Promotion (Project -> Global)

When the same instinct appears in multiple projects with high confidence, it's a candidate for promotion to global scope.

**Auto-promotion criteria:**
- Same instinct ID in 2+ projects
- Average confidence >= 0.8

**How to promote:**

```bash
# Promote a specific instinct
python3 instinct-cli.py promote prefer-explicit-errors

# Auto-promote all qualifying instincts
python3 instinct-cli.py promote

# Preview without changes
python3 instinct-cli.py promote --dry-run
```

The `/evolve` command also suggests promotion candidates.

## Confidence Scoring

Confidence evolves over time:

| Score | Meaning | Behavior |
|-------|---------|----------|
| 0.3 | Tentative | Suggested but not enforced |
| 0.5 | Moderate | Applied when relevant |
| 0.7 | Strong | Auto-approved for application |
| 0.9 | Near-certain | Core behavior |

**Confidence increases** when:
- Pattern is repeatedly observed
- User doesn't correct the suggested behavior
- Similar instincts from other sources agree
- User approves a suggestion linked to this instinct (+0.15)

**Confidence decreases** when:
- User explicitly corrects the behavior
- User dismisses a suggestion linked to this instinct (-0.2, archived after 3 dismissals)
- Observer Reflect phase finds no supporting evidence (-0.05, halved for user_validated)
- Contradicting evidence appears (-0.15)

## Unified Data Pipeline

CL shares data with the Open Pulse dashboard via a single collector (`op-collector.js`). The observer reads events from SQLite via `cl-export-events.js` instead of maintaining its own observation files. This eliminates duplicate data collection and ensures a single source of truth.

## Feedback Loop

The suggestion analyzer (`op-suggestion-analyzer.js`) scans instinct files using YAML frontmatter parsing (not regex). Each suggestion carries an `instinct_id` for traceability. When users approve or dismiss suggestions via the dashboard:

- **Approve**: source instinct confidence +0.15 (capped at 0.95), marked `user_validated: true`
- **Dismiss**: source instinct confidence -0.2 (floored at 0.0), `dismiss_count` incremented
- **3 dismissals**: instinct archived (moved to `instincts/archive/`)

The suggestion DB upsert preserves resolved status — re-running the analyzer won't reset approved/dismissed suggestions back to pending.

## Cold Start

On install, `cl-seed-instincts.js` provides two sources of initial instincts:

1. **Universal starter pack** (10 instincts, scope: global, confidence: 0.5):
   grep-before-edit, read-before-write, test-after-change, small-focused-commits, validate-user-input, handle-errors-explicitly, check-existing-before-creating, prefer-dedicated-tools, verify-before-done, immutable-data-patterns

2. **CLAUDE.md parser**: extracts rules from project CLAUDE.md files by detecting:
   - Lines with ALWAYS/NEVER/MUST/SHOULD/DO NOT indicators
   - Bullet points under headers containing "rules", "conventions", "guidelines"

Seeding is idempotent — existing instinct files are never overwritten.

## Storage Retention

Three-tier retention runs daily to bound storage growth:

| Tier | Age | Action |
|------|-----|--------|
| Hot | 0-7 days | Full events with tool_input/tool_response |
| Warm | 7-90 days | NULL out tool_input and tool_response (keep metadata) |
| Cold | 90+ days | Delete events entirely |

Configure via `config.json`: `retention_warm_days` (default 7), `retention_cold_days` (default 90). Sessions are never deleted.

## Backward Compatibility

v2.1 is fully compatible with v2.0 and v1:
- Existing global instincts in `~/Workspace/open-pulse/instincts/` still work as global instincts
- Existing `~/.claude/skills/learned/` skills from v1 still work
- Gradual migration: run both in parallel

## Privacy

- Observations stay **local** on your machine
- Project-scoped instincts are isolated per project
- Only **instincts** (patterns) can be exported — not raw observations
- No actual code or conversation content is shared
- You control what gets exported and promoted

## Related

- Homunculus - Community project that inspired the instinct-based architecture (atomic observations, confidence scoring, instinct evolution pipeline)

---

*Instinct-based learning: teaching Claude your patterns, one project at a time.*
