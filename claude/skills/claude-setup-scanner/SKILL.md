---
name: claude-setup-scanner
description: Scan Claude Code setup for optimization opportunities — unused components, overlaps, gaps, and automation suggestions based on continuous-learning instincts. Use for periodic setup audits.
---

# Claude Setup Scanner

Comprehensive audit of your Claude Code configuration with continuous-learning integration.

## Process

### Step 1: Inventory

Scan and list all components:

```bash
# Skills
ls ~/.claude/skills/*/SKILL.md 2>/dev/null
ls .claude/skills/*/SKILL.md 2>/dev/null

# Agents
ls ~/.claude/agents/*.md 2>/dev/null
ls .claude/agents/*.md 2>/dev/null

# Hooks (from settings.json)
# Read ~/.claude/settings.json → hooks section
# Read .claude/settings.json → hooks section

# Rules
ls ~/.claude/rules/**/*.md 2>/dev/null
ls .claude/rules/**/*.md 2>/dev/null

# MCP Servers (from settings.json)
# Read mcpServers section

# Plugins
# Read enabledPlugins section
```

For each component, read the **name** and **description** from frontmatter (not full content).

### Step 2: Continuous-Learning Integration

Read instincts from the continuous-learning system:

```bash
# Project-scoped instincts
ls ~/.claude/projects/*/memory/*.md 2>/dev/null

# Check for observations
ls ~/.claude/skills/op-continuous-learning/data/ 2>/dev/null
```

#### Instinct → Component Mapping

Analyze instincts with confidence >= 0.7:

| Instinct Pattern | Confidence | Suggested Component |
|---|---|---|
| Repeated action on specific event | >= 0.8 | **Hook** (automate the action) |
| Domain knowledge queried repeatedly | >= 0.7 | **Skill** (codify the knowledge) |
| Complex task delegated manually | >= 0.7 | **Agent** (formalize delegation) |
| Behavioral pattern consistently followed | >= 0.8 | **Rule** (document the convention) |
| Correction applied multiple times | >= 0.7 | **Rule or Hook** (prevent the mistake) |

### Step 3: Usage Analysis

Cross-reference inventory with usage data:

1. **Recently used**: Check git log for skill/agent file access patterns
2. **Session activity**: Check continuous-learning observations for tool/skill invocations
3. **Classify each component**:
   - **Active**: Used in last 30 days
   - **Stale**: Not used in 30-90 days
   - **Dead**: Not used in 90+ days or never invoked

### Step 4: Overlap Detection

For each pair of similar components:
1. Compare descriptions — do they overlap?
2. If descriptions are similar, read full content of both
3. Determine: duplicate, complementary, or different use cases
4. Suggest: merge, keep both, or remove one

### Step 5: Gap Analysis

Compare current setup against best practices from `claude-code-knowledge/references/decision-matrix.md`:

- Has security hooks? (PreToolUse for secrets, dangerous commands)
- Has quality hooks? (PostToolUse for formatting, linting)
- Has testing workflow? (TDD skill or similar)
- Has code review agents? (code-reviewer, security-reviewer)
- Has documentation? (CLAUDE.md, rules/ with clear structure)
- Has learning system? (continuous-learning or similar)

### Step 6: Cost Estimation

Estimate context token cost per session:
- CLAUDE.md + rules: ~X tokens (always loaded)
- Skills: ~Y tokens per invocation (loaded on demand)
- Agents: ~Z tokens per spawn (own context)
- Hooks: 0 tokens (scripts, not context)

Flag if total always-loaded content exceeds 5000 tokens.

### Step 7: Write Back to Learning

Create observations for the continuous-learning system:
- Unused components → "skill X unused for N days"
- Overlapping components → "skills A and B overlap in functionality"
- Missing best practices → "no security hook configured"

These observations will be processed by continuous-learning into instincts.

## Output: Report

Present findings organized by severity:

```markdown
## Scan Results — {date}

### CRITICAL
- {Security issues, broken hooks, conflicting rules}

### HIGH  
- {Unused components (>30 days), significant overlap}

### MEDIUM
- {Optimization opportunities, missing best practices}

### LOW
- {Minor improvements, nice-to-haves}

### Automation Opportunities (from instincts)
- {Instinct-based suggestions with confidence scores}

### Statistics
- Total skills: X (Y unused)
- Total agents: X (Y unused)
- Total hooks: X
- Total rules: X files
- Estimated context cost: X tokens/session
- Instincts analyzed: X (Y actionable)
```

## Actionable Recommendations

Each finding should include:
1. **What**: Description of the issue
2. **Why**: Impact if not addressed
3. **Action**: Specific command or skill to invoke
   - Remove unused: "Delete ~/.claude/skills/X/"
   - Merge overlap: "Use /skill-creator to merge A and B"
   - Fill gap: "Use /claude-config-advisor to create X"
   - Fix conflict: "Edit ~/.claude/rules/X.md to resolve"

## Invocation

- Manual: `/claude-setup-scanner`
- Recommended frequency: weekly or monthly
- After major setup changes (adding many skills, reorganizing rules)
