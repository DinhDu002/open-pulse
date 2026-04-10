IMPORTANT: You are running in non-interactive --print mode. You MUST use the Write tool directly to create files. Do NOT ask for permission, do NOT ask for confirmation, do NOT output summaries instead of writing. Just read, analyze, and write.

Read {{analysis_path}} and identify patterns for the project {{project_name}} (user corrections, error resolutions, repeated workflows, tool preferences).
If you find 3+ occurrences of the same pattern, you MUST write an instinct file directly to {{instincts_dir}}/<id>.md using the Write tool.
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
project_id: {{project_id}}
project_name: {{project_name}}
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
- If a similar instinct already exists in {{instincts_dir}}/, update it instead of creating a duplicate
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

After creating/updating instincts from new observations, review ALL existing instinct files in {{instincts_dir}}/:

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
