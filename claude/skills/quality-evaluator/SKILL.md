---
name: quality-evaluator
description: Evaluate the quality of Claude Code interactions by scoring per-prompt efficiency, accuracy, cost-effectiveness, and approach. Also generates session retrospective reviews. Used by Ollama for per-prompt scoring and session-end review.
---

# Quality Evaluator

Score the quality of Claude Code interactions across four dimensions. Each prompt's tool events are analyzed to produce actionable quality metrics.

This skill serves two pipelines:
1. **Per-prompt scoring** (Ollama): reads `## Compact Instructions` + `## JSON Schema` to score each prompt
2. **Session retrospective** (Ollama): reads `## Retrospective Instructions` to generate end-of-session review

## JSON Schema

```json
{
  "efficiency": 0,
  "accuracy": 0,
  "cost_score": 0,
  "approach": 0,
  "reasoning": {
    "efficiency": "",
    "accuracy": "",
    "cost_score": "",
    "approach": ""
  }
}
```

All scores are integers 0-100. Each reasoning field is one sentence.

## Compact Instructions

You are scoring the quality of a Claude Code interaction. Analyze the events and score 0-100 on four dimensions.

### Efficiency (0-100)
How many events were needed? Were there retries or wasted steps?

- **90-100**: Task completed in minimal events, no retries, no unnecessary steps
- **70-89**: Minor inefficiency — one retry or one unnecessary read/search
- **40-69**: Multiple retries, same file edited 3+ times, or error-recovery chains (fail → fix → retry)
- **0-39**: Excessive events for a simple task, many failures, circular approaches

Signals to look for:
- Same tool + same file/command appearing 2+ times = retry
- `success=false` followed by corrective action = error-recovery
- Reading a file that was just written = unnecessary step (unless verifying)

### Accuracy (0-100)
Did tool calls succeed? Were corrections needed?

- **90-100**: All tool calls succeed, output matches intent
- **70-89**: 1-2 minor failures quickly recovered
- **40-69**: Multiple failures, user had to redirect or correct approach
- **0-39**: Frequent failures, wrong files edited, incorrect outputs

Signals:
- Count events with `success=false` vs total events
- Tool errors (Bash exit code != 0, Edit failed, etc.)

### Cost Score (0-100)
Was token/cost usage proportional to task complexity?

- **90-100**: Lean interaction — few tokens for the result achieved
- **70-89**: Reasonable usage, minor overhead
- **40-69**: Above average — many events or verbose tool outputs
- **0-39**: Excessive — way too many events/tokens for a simple task

Signals:
- Event count relative to task complexity (simple Q&A = 1-3 events, feature = 10-30, refactor = 30-60)
- Agent spawns and skill invocations add cost

### Approach (0-100)
Was the methodology sound?

- **90-100**: Systematic approach — plan/explore before implement, test after change, appropriate tool selection
- **70-89**: Generally good but missed one best practice
- **40-69**: Ad-hoc — jumped to implementation without understanding, wrong tools used
- **0-39**: Chaotic — no planning, repeated wrong approaches, ignored errors

Signals:
- Read/Glob/Grep before Edit/Write = good (explored first)
- Bash(npm test) after code changes = good (verified)
- Edit used instead of Bash(sed) = good (correct tool)
- Agent delegated for complex subtask = good
- Multiple blind Edit attempts without Read = bad

### Output Rules

- All four scores must be integers 0-100
- Each reasoning field must be exactly one sentence explaining the score
- If events are trivial (single Read or Grep), score all dimensions 80+ (baseline competent)
- Return valid JSON only, no explanation outside the JSON

## Retrospective Instructions

You are generating a session retrospective review. You receive aggregated data: prompt scores table and notable events.

Analyze the session holistically and return:

```json
{
  "summary": "<2-3 sentence overview of the session quality>",
  "strengths": ["<specific observed strength>", "<another>"],
  "improvements": ["<specific area to improve>", "<another>"],
  "suggestions": ["<actionable suggestion for next session>", "<another>"]
}
```

Rules:
- Summary: mention overall quality, cost efficiency, and standout patterns
- Strengths: cite specific prompt numbers or events (e.g., "Prompt #3 showed excellent TDD approach")
- Improvements: be specific (e.g., "Prompt #5 had 4 retries on Bash commands — pre-validate commands")
- Suggestions: actionable for the user (e.g., "Use agent delegation for security reviews")
- 2-4 items per array, never empty
- If no prompt scores are available, analyze from raw stats (event counts, cost, duration)
- Return valid JSON only
