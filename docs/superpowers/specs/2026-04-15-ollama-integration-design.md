# Ollama Integration Design — Sub-project A

## Context

Open Pulse captures Claude Code events via hooks → JSONL → SQLite. Two new skills define extraction rules:
- `knowledge-extractor` — extracts project-specific knowledge entries
- `pattern-detector` — detects reusable behavioral patterns (rules, skills, agents, workflows)

Both skills have dual-purpose structure: `## Compact Instructions` + `## JSON Schema` for local 7B models, full body for frontier models.

**This spec covers**: wiring a local Ollama model (Qwen 2.5 7B) into the ingest pipeline so both extractions run automatically after each prompt. This is Sub-project A of a 3-part feature:
- **A. Ollama integration** (this spec)
- B. `/synthesize` slash command (future spec)
- C. Cleanup old systems (future spec)

## Architecture

```
pipeline.js ingest complete
        │
        ▼
setImmediate() ─── fire-and-forget, non-blocking
        │
        ├─── callOllama(knowledgePrompt) → validate → upsert knowledge_entries → render vault
        │
        └─── callOllama(patternPrompt)   → validate → upsert auto_evolves (status='draft')
        
Two sequential calls per prompt. Total ~10-60s. Invisible to user.
```

### Why this architecture

- **setImmediate fire-and-forget**: existing pattern in pipeline.js line 155. At 50-200 prompts/day, no backpressure risk.
- **Two sequential calls, not one combined**: 7B models produce cleaner output with single-schema prompts. Merging two schemas confuses small models.
- **Skip on failure, never retry**: events are already in DB. `/synthesize` (Opus) compensates for missed extractions. Data is never lost.
- **Native fetch, no new dependencies**: Node 20+ built-in fetch uses undici internally with connection pooling.

## New Files

### 1. `src/lib/skill-loader.js`

Shared utility for loading skill files. Replaces internal `loadSkillTemplate()` in extract.js.

```js
// Exports:
loadSkillBody(skillName)      // → full markdown body (frontmatter stripped) or null
loadCompactPrompt(skillName)  // → "## JSON Schema" + "## Compact Instructions" content or null
```

**`loadSkillBody(skillName)`**:
- Reads `claude/skills/<skillName>/SKILL.md`
- Strips YAML frontmatter (`/^---[\s\S]*?---\s*/`)
- Returns trimmed body or `null` if file missing

**`loadCompactPrompt(skillName)`**:
- Reads same file
- Extracts content under `## JSON Schema` heading (up to next `##`)
- Extracts content under `## Compact Instructions` heading (up to next `##`)
- Returns concatenated: `"## JSON Schema\n" + schemaContent + "\n## Instructions\n" + compactContent`
- Returns `null` if file or either section missing

### 2. `src/lib/ollama.js`

HTTP client for Ollama API. Single function.

```js
// Export:
callOllama(prompt, model, opts) // → { output, duration_ms } or throws
```

**Parameters:**
- `prompt` (string): the LLM prompt
- `model` (string): Ollama model name (e.g., `'qwen2.5:7b'`)
- `opts.url` (string): Ollama base URL (default `'http://localhost:11434'`)
- `opts.timeout` (number): timeout in ms (default 90000)

**Implementation:**
- `POST <url>/api/generate` with `{ model, prompt, stream: false, options: { temperature: 0, num_predict: 2048 } }`
- `AbortSignal.timeout(timeout)` for timeout handling
- On success: parse response JSON, return `{ output: response.response, duration_ms }`
- On `ECONNREFUSED` / `ECONNRESET` / timeout: throw with identifiable error code
- No retry logic — caller decides

**Ollama health check:**
- Single `GET <url>/api/tags` call during `buildApp()` in server.js
- Logs warning if Ollama unavailable — does not prevent server start
- No per-call health check (doubles HTTP overhead for no benefit)

### 3. `src/evolve/detect.js`

Pattern detection pipeline. Mirrors `src/knowledge/extract.js` structure.

```js
// Exports:
detectPatternsFromPrompt(db, promptId, opts)  // → { inserted, updated, skipped, errors }
buildPatternPrompt(projectName, events)        // → prompt string
validatePattern(entry)                          // → { valid, reason }
```

**`detectPatternsFromPrompt(db, promptId, opts)`**:
1. Load prompt record + events from DB (same query as knowledge extraction)
2. If < 3 events: skip (not enough signal for pattern detection)
3. Build prompt: `loadCompactPrompt('pattern-detector')` + formatted events
4. Call `callOllama(prompt, opts.model)`
5. Parse JSON response (reuse `parseJsonResponse` from extract.js)
6. Validate each entry: valid `target_type`, title not empty, title <= 80 chars, description not empty
7. Upsert into `auto_evolves` table:
   - ID: reuse `makeId(title, target_type)` from `src/evolve/sync.js` → `ae-<sha256(title::target_type).slice(0,16)>`
   - If existing (same id): bump `observation_count += 1`, update `confidence = MIN(0.95, confidence + 0.15)`
   - If new: `status='draft'`, `confidence=0.30`, `observation_count=1`
   - Set `projects` field from entry's `projects` array
8. Log to `pipeline_runs` (pipeline: `'pattern_detect'`)
9. Return counts

**`buildPatternPrompt(projectName, events)`**:
- Header: "Project: {projectName}"
- Events block: numbered list with `[event_type] name → response_excerpt`
- Skill template: `loadCompactPrompt('pattern-detector')`
- Footer: "Return a JSON array only."

**Error handling:**
- Ollama unavailable: log `pipeline_runs` status='skipped', reason='ollama_unavailable', return `{ skipped: true }`
- JSON parse failure: log status='error', return `{ errors: 1 }`
- Validation failures: count as `skipped`, log in pipeline_runs error field

### Event formatting for prompts

Both knowledge and pattern extraction need events formatted for the 7B model. Extract the event formatting logic from `buildExtractPrompt` in `extract.js` into a new shared function in `src/lib/format-events.js`:

```js
// Export:
formatEventsForLLM(events, opts)  // → formatted string
```

Output format:
```
1. [tool_call] Read src/auth/handler.js → "export function handleAuth..."
2. [tool_call] Edit src/auth/handler.js → success
3. [skill_invoke] tdd-workflow → "Running tests..."
4. [tool_call] Bash npm test → "12 passing, 0 failing"
```

Key fields per event: seq_num, event_type, name, truncated tool_input key, truncated tool_response (300 chars). Both `buildExtractPrompt` and `buildPatternPrompt` import and call this function.

## Modified Files

### 4. `src/knowledge/extract.js`

Changes:
- Remove internal `loadSkillTemplate()` function (lines 32-42)
- Import `{ loadSkillBody }` from `../lib/skill-loader`
- Replace `loadSkillTemplate()` call in `buildExtractPrompt()` with `loadSkillBody('knowledge-extractor')`
- Add Ollama path: when `opts.useOllama` is true, use `callOllama` + `loadCompactPrompt('knowledge-extractor')` instead of `callClaude` + full body
- Export `parseJsonResponse` for reuse by `detect.js`

### 5. `src/knowledge/scan.js`

Changes:
- Remove import of `loadSkillTemplate` from `./extract`
- Import `{ loadSkillBody }` from `../lib/skill-loader`
- Replace `loadSkillTemplate()` call with `loadSkillBody('knowledge-extractor')`
- Cold-start scan always uses Claude CLI (never Ollama) — no other changes

### 6. `src/ingest/pipeline.js`

Changes:
- Add `_detectPatterns` and `_patternConfig` variables (mirror `_extractKnowledge` pattern)
- Add `setPatternHook(detectFn, config)` export
- In `processContent()`, after knowledge extraction `setImmediate` block (line 155), add:
  ```js
  if (_detectPatterns) {
    for (const pid of promptIds) {
      setImmediate(() => {
        _detectPatterns(db, pid, _patternConfig || {}).catch(() => {});
      });
    }
  }
  ```
- Both hooks fire independently per prompt — knowledge first, then patterns

### 7. `src/server.js`

Changes:
- Import `{ detectPatternsFromPrompt }` from `./evolve/detect`
- Import `{ setPatternHook }` from `./ingest/pipeline`
- After knowledge hook registration (line 69), add:
  ```js
  if (config.pattern_detect_enabled !== false) {
    setPatternHook(detectPatternsFromPrompt, {
      model: config.ollama_model || 'qwen2.5:7b',
      url: config.ollama_url || 'http://localhost:11434',
      timeout: config.ollama_timeout_ms || 90000,
    });
  }
  ```
- If `knowledge_enabled` and Ollama config present: update knowledge hook to use Ollama path
- Add startup health check: `GET <ollama_url>/api/tags`, log result

## Config Changes

New keys in `config.json`:

| Key | Type | Default | Purpose |
|---|---|---|---|
| `ollama_url` | string | `"http://localhost:11434"` | Ollama API base URL |
| `ollama_model` | string | `"qwen2.5:7b"` | Model name for local extraction |
| `ollama_timeout_ms` | number | `90000` | HTTP request timeout |
| `pattern_detect_enabled` | boolean | `true` | Enable per-prompt pattern detection |

Existing `knowledge_enabled` controls knowledge extraction. New `knowledge_model` behavior: when set to `"local"`, knowledge extraction uses Ollama via `ollama_url`/`ollama_model`. Any other value (e.g., `"opus"`, `"haiku"`) uses Claude CLI as before. Default: `"local"`.

## Database Changes

No schema changes required:
- `knowledge_entries` table: unchanged, receives entries from Ollama same as from Claude
- `auto_evolves` table: already has all needed columns. New `status='draft'` value (TEXT column, no migration)
- `pipeline_runs` table: new pipeline value `'pattern_detect'` (TEXT column, no migration). Knowledge extraction keeps existing `'knowledge_extract'` pipeline name — local vs cloud distinguished by `model` column value

## Error Handling Summary

| Scenario | Behavior | Logged as |
|---|---|---|
| Ollama not running | Skip both extractions silently | `pipeline_runs` status='skipped' |
| Ollama timeout (>90s) | Skip, abort request | `pipeline_runs` status='skipped' |
| Model not loaded (cold start) | First call slow (30-60s), within 90s timeout | Normal operation |
| JSON parse failure | Skip entry, continue with others | `pipeline_runs` status='error' |
| Validation failure (bad title, missing body) | Reject individual entry | Count in pipeline_runs error field |
| Knowledge + pattern both fail | Each logged independently | Two separate pipeline_runs rows |

## Verification Plan

1. **Unit tests** (`test/lib/skill-loader.test.js`):
   - `loadSkillBody` returns full body, strips frontmatter
   - `loadCompactPrompt` extracts only Compact Instructions + JSON Schema
   - Returns null for missing files/sections

2. **Unit tests** (`test/lib/ollama.test.js`):
   - Mock HTTP server, verify request format (model, prompt, temperature, stream)
   - Verify timeout handling (AbortSignal)
   - Verify ECONNREFUSED handling

3. **Unit tests** (`test/evolve/detect.test.js`):
   - `validatePattern` accepts/rejects entries correctly
   - `buildPatternPrompt` includes compact section + formatted events
   - Upsert logic: new entry gets confidence 0.3, existing gets bumped

4. **Integration test** (`test/knowledge/knowledge.test.js`):
   - Existing tests pass with new skill-loader imports
   - buildExtractPrompt still includes skill template content

5. **Manual verification**:
   - Start server with Ollama running → check pipeline_runs for successful extractions
   - Start server without Ollama → check pipeline_runs for 'skipped' entries, no crashes
   - Check knowledge_entries and auto_evolves tables after a few prompts
