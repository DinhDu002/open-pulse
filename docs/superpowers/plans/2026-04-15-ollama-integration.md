# Ollama Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a local Ollama model into the ingest pipeline to extract knowledge entries and detect behavioral patterns after each prompt.

**Architecture:** After pipeline ingests events, two sequential `setImmediate` calls invoke Ollama (Qwen 2.5 7B) — one for knowledge extraction using `knowledge-extractor` skill, one for pattern detection using `pattern-detector` skill. Both use compact skill sections (<600 tokens), validate output programmatically, and write to existing DB tables.

**Tech Stack:** Node.js 20+ native `fetch`, better-sqlite3, Ollama REST API (`/api/generate`), existing Fastify server.

**Spec:** `docs/superpowers/specs/2026-04-15-ollama-integration-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/skill-loader.js` | Create | Load skill body + extract compact sections |
| `src/lib/ollama.js` | Create | HTTP client for Ollama API |
| `src/lib/format-events.js` | Create | Shared event formatting for LLM prompts |
| `src/evolve/detect.js` | Create | Pattern detection pipeline (Ollama → auto_evolves) |
| `src/knowledge/extract.js` | Modify | Use skill-loader, add Ollama path |
| `src/knowledge/scan.js` | Modify | Use skill-loader |
| `src/ingest/pipeline.js` | Modify | Add pattern detection hook |
| `src/server.js` | Modify | Wire pattern hook + Ollama config |
| `config.json` | Modify | Add Ollama + pattern config keys |
| `test/lib/skill-loader.test.js` | Create | Tests for skill-loader |
| `test/lib/ollama.test.js` | Create | Tests for Ollama client |
| `test/lib/format-events.test.js` | Create | Tests for event formatting |
| `test/evolve/detect.test.js` | Create | Tests for pattern detection |

---

### Task 1: Create `src/lib/skill-loader.js`

**Files:**
- Create: `src/lib/skill-loader.js`
- Create: `test/lib/skill-loader.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/lib/skill-loader.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadSkillBody, loadCompactPrompt } = require('../../src/lib/skill-loader');

describe('skill-loader', () => {
  describe('loadSkillBody', () => {
    it('returns full body without frontmatter for existing skill', () => {
      const body = loadSkillBody('knowledge-extractor');
      assert.ok(body, 'should return non-null');
      assert.ok(!body.startsWith('---'), 'should not start with frontmatter');
      assert.ok(body.includes('# Knowledge Extractor'), 'should include title');
      assert.ok(body.includes('## Validation Rules'), 'should include full body sections');
    });

    it('returns null for missing skill', () => {
      const body = loadSkillBody('nonexistent-skill');
      assert.equal(body, null);
    });
  });

  describe('loadCompactPrompt', () => {
    it('extracts JSON Schema and Compact Instructions sections', () => {
      const compact = loadCompactPrompt('knowledge-extractor');
      assert.ok(compact, 'should return non-null');
      assert.ok(compact.includes('"category"'), 'should include JSON schema content');
      assert.ok(compact.includes('Return a JSON array only'), 'should include compact instructions');
    });

    it('does not include full body sections', () => {
      const compact = loadCompactPrompt('knowledge-extractor');
      assert.ok(!compact.includes('## Title Rules'), 'should not include Title Rules section');
      assert.ok(!compact.includes('## Validation Rules'), 'should not include Validation Rules section');
    });

    it('works for pattern-detector skill', () => {
      const compact = loadCompactPrompt('pattern-detector');
      assert.ok(compact, 'should return non-null');
      assert.ok(compact.includes('"target_type"'), 'should include pattern JSON schema');
      assert.ok(compact.includes('Return a JSON array only'), 'should include compact instructions');
    });

    it('returns null for missing skill', () => {
      const compact = loadCompactPrompt('nonexistent-skill');
      assert.equal(compact, null);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib/skill-loader.test.js`
Expected: FAIL with "Cannot find module '../../src/lib/skill-loader'"

- [ ] **Step 3: Write implementation**

```js
// src/lib/skill-loader.js
'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'claude', 'skills');

/**
 * Load full skill body (frontmatter stripped) for Opus/Claude consumption.
 * @param {string} skillName — directory name under claude/skills/
 * @returns {string|null}
 */
function loadSkillBody(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  try {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const stripped = raw.replace(/^---[\s\S]*?---\s*/, '');
    return stripped.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract ## JSON Schema + ## Compact Instructions sections for Ollama consumption.
 * @param {string} skillName — directory name under claude/skills/
 * @returns {string|null}
 */
function loadCompactPrompt(skillName) {
  const body = loadSkillBody(skillName);
  if (!body) return null;

  const extractSection = (heading) => {
    const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
    const match = body.match(re);
    return match ? match[1].trim() : null;
  };

  const schema = extractSection('JSON Schema');
  const compact = extractSection('Compact Instructions');

  if (!schema || !compact) return null;

  return `## JSON Schema\n\n${schema}\n\n## Instructions\n\n${compact}`;
}

module.exports = { loadSkillBody, loadCompactPrompt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib/skill-loader.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/skill-loader.js test/lib/skill-loader.test.js
git commit -m "feat: add skill-loader utility for dual-purpose skill extraction"
```

---

### Task 2: Create `src/lib/ollama.js`

**Files:**
- Create: `src/lib/ollama.js`
- Create: `test/lib/ollama.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/lib/ollama.test.js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { callOllama } = require('../../src/lib/ollama');

describe('callOllama', () => {
  let server;
  let serverPort;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        // Echo back a mock Ollama response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response: '[{"title":"test"}]',
          total_duration: 1000000000,
        }));
      });
    });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('sends correct request to Ollama API', async () => {
    let receivedBody;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: '[]', total_duration: 500000000 }));
      });
    });

    await callOllama('test prompt', 'qwen2.5:7b', {
      url: `http://127.0.0.1:${serverPort}`,
    });

    assert.equal(receivedBody.model, 'qwen2.5:7b');
    assert.equal(receivedBody.prompt, 'test prompt');
    assert.equal(receivedBody.stream, false);
    assert.equal(receivedBody.options.temperature, 0);
    assert.equal(receivedBody.options.num_predict, 2048);
  });

  it('returns output and duration', async () => {
    const result = await callOllama('test', 'qwen2.5:7b', {
      url: `http://127.0.0.1:${serverPort}`,
    });

    assert.equal(result.output, '[{"title":"test"}]');
    assert.ok(result.duration_ms >= 0);
  });

  it('throws on connection refused', async () => {
    await assert.rejects(
      () => callOllama('test', 'qwen2.5:7b', {
        url: 'http://127.0.0.1:1',
        timeout: 2000,
      }),
      (err) => {
        assert.ok(err.code === 'ECONNREFUSED' || err.message.includes('fetch'));
        return true;
      },
    );
  });

  it('throws on timeout', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, _res) => {
      // Never respond — trigger timeout
    });

    await assert.rejects(
      () => callOllama('test', 'qwen2.5:7b', {
        url: `http://127.0.0.1:${serverPort}`,
        timeout: 500,
      }),
      (err) => {
        assert.ok(err.name === 'TimeoutError' || err.message.includes('abort') || err.message.includes('timeout'));
        return true;
      },
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib/ollama.test.js`
Expected: FAIL with "Cannot find module '../../src/lib/ollama'"

- [ ] **Step 3: Write implementation**

```js
// src/lib/ollama.js
'use strict';

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT = 90000;

/**
 * Call Ollama API for text generation.
 * @param {string} prompt
 * @param {string} model — e.g. 'qwen2.5:7b'
 * @param {object} [opts]
 * @param {string} [opts.url] — Ollama base URL
 * @param {number} [opts.timeout] — timeout in ms
 * @returns {Promise<{output: string, duration_ms: number}>}
 */
async function callOllama(prompt, model, opts = {}) {
  const baseUrl = opts.url || DEFAULT_URL;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const startTime = Date.now();

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    output: data.response || '',
    duration_ms: Date.now() - startTime,
  };
}

module.exports = { callOllama };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib/ollama.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ollama.js test/lib/ollama.test.js
git commit -m "feat: add Ollama HTTP client for local model integration"
```

---

### Task 3: Create `src/lib/format-events.js`

Extract event formatting from `extract.js` lines 110-133 into a shared utility.

**Files:**
- Create: `src/lib/format-events.js`
- Create: `test/lib/format-events.test.js`
- Modify: `src/knowledge/extract.js`

- [ ] **Step 1: Write failing tests**

```js
// test/lib/format-events.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatEventsForLLM } = require('../../src/lib/format-events');

describe('formatEventsForLLM', () => {
  it('formats basic tool call event', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: JSON.stringify({ file_path: 'src/server.js' }),
      tool_response: 'const fastify = require("fastify");',
    }];

    const result = formatEventsForLLM(events);
    assert.ok(result.includes('1. [tool_call] Read [src/server.js]'));
    assert.ok(result.includes('const fastify'));
  });

  it('truncates long tool_response to 300 chars', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Read',
      tool_input: '{}',
      tool_response: 'x'.repeat(500),
    }];

    const result = formatEventsForLLM(events);
    assert.ok(result.length < 500);
  });

  it('formats skill_invoke event', () => {
    const events = [{
      event_type: 'skill_invoke',
      name: 'tdd-workflow',
      tool_input: '{}',
      tool_response: 'Running tests...',
    }];

    const result = formatEventsForLLM(events);
    assert.ok(result.includes('[skill_invoke] tdd-workflow'));
  });

  it('handles events with no tool_input or tool_response', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Bash',
      tool_input: null,
      tool_response: null,
    }];

    const result = formatEventsForLLM(events);
    assert.ok(result.includes('1. [tool_call] Bash'));
  });

  it('extracts key fields from tool_input JSON', () => {
    const events = [{
      event_type: 'tool_call',
      name: 'Grep',
      tool_input: JSON.stringify({ pattern: 'loadSkillTemplate', path: 'src/' }),
      tool_response: 'match found',
    }];

    const result = formatEventsForLLM(events);
    assert.ok(result.includes('[loadSkillTemplate]') || result.includes('[src/]'));
  });

  it('returns empty string for empty events array', () => {
    assert.equal(formatEventsForLLM([]), '');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib/format-events.test.js`
Expected: FAIL with "Cannot find module '../../src/lib/format-events'"

- [ ] **Step 3: Write implementation**

```js
// src/lib/format-events.js
'use strict';

const MAX_RESPONSE_LENGTH = 300;

/**
 * Format events into a numbered list for LLM prompts.
 * Extracted from src/knowledge/extract.js buildExtractPrompt.
 *
 * @param {Array<object>} events
 * @returns {string}
 */
function formatEventsForLLM(events) {
  if (!events || events.length === 0) return '';

  return events.map((ev, i) => {
    let detail = '';

    if (ev.tool_input) {
      let input = {};
      try { input = JSON.parse(ev.tool_input); } catch { /* use empty */ }

      const key = input.file_path || input.command || input.pattern
        || input.path || input.query || null;
      if (key) detail += ` [${key}]`;
    }

    let response = '';
    if (ev.tool_response) {
      response = String(ev.tool_response).slice(0, MAX_RESPONSE_LENGTH);
      if (ev.tool_response.length > MAX_RESPONSE_LENGTH) response += '…';
    }

    const lines = [`${i + 1}. [${ev.event_type}] ${ev.name || ''}${detail}`];
    if (response) lines.push(`   → ${response}`);
    return lines.join('\n');
  }).join('\n');
}

module.exports = { formatEventsForLLM };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib/format-events.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Refactor `extract.js` to use `formatEventsForLLM`**

In `src/knowledge/extract.js`, replace the inline event formatting (lines 110-133) with an import:

Add at top (after line 5):
```js
const { formatEventsForLLM } = require('../lib/format-events');
```

Replace the `const eventLines = events.map(...)` block (lines 110-133) with:
```js
const eventLines = formatEventsForLLM(events);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All 292+ tests PASS (existing knowledge tests still pass)

- [ ] **Step 7: Commit**

```bash
git add src/lib/format-events.js test/lib/format-events.test.js src/knowledge/extract.js
git commit -m "refactor: extract event formatting into shared format-events utility"
```

---

### Task 4: Refactor `src/knowledge/extract.js` — use skill-loader + Ollama path

**Files:**
- Modify: `src/knowledge/extract.js`
- Modify: `src/knowledge/scan.js`
- Modify: `test/knowledge/knowledge.test.js`

- [ ] **Step 1: Replace `loadSkillTemplate` with `skill-loader` in extract.js**

Remove the internal `loadSkillTemplate` function (lines 27-42). Replace with import:

Add at top (after existing imports):
```js
const { loadSkillBody, loadCompactPrompt } = require('../lib/skill-loader');
const { callOllama } = require('../lib/ollama');
```

Replace `loadSkillTemplate()` calls in `buildExtractPrompt` (line 140) with:
```js
const skillTemplate = loadSkillBody('knowledge-extractor');
```

Update exports — remove `loadSkillTemplate`, keep everything else:
```js
module.exports = {
  buildExistingEntriesBlock,
  buildExtractPrompt,
  callClaude,
  parseJsonResponse,
  mergeOrUpdate,
  extractKnowledgeFromPrompt,
};
```

- [ ] **Step 2: Add `buildCompactExtractPrompt` function**

Add after `buildExtractPrompt` function:

```js
function buildCompactExtractPrompt(projectName, events) {
  const compact = loadCompactPrompt('knowledge-extractor');
  if (!compact) return null;

  const eventLines = formatEventsForLLM(events);

  return [
    `Project: ${projectName}`,
    '',
    'Events:',
    eventLines,
    '',
    compact,
  ].join('\n');
}
```

Add to exports: `buildCompactExtractPrompt`.

- [ ] **Step 3: Add Ollama path to `extractKnowledgeFromPrompt`**

Find the `extractKnowledgeFromPrompt` function. Add an Ollama branch based on `opts.model === 'local'`:

After the prompt-building logic, before `callClaude`, add:

```js
let claudeResult;
if (opts.model === 'local') {
  const compactPrompt = buildCompactExtractPrompt(projectName, promptEvents);
  if (!compactPrompt) {
    insertPipelineRun(db, { pipeline: 'knowledge_extract', project_id: projectId, model: opts.ollamaModel || 'qwen2.5:7b', status: 'skipped', error: 'compact prompt unavailable' });
    return { inserted: 0, updated: 0, skipped: true };
  }
  try {
    const ollamaResult = await callOllama(compactPrompt, opts.ollamaModel || 'qwen2.5:7b', {
      url: opts.ollamaUrl,
      timeout: opts.ollamaTimeout,
    });
    claudeResult = { output: ollamaResult.output, input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: ollamaResult.duration_ms };
  } catch (err) {
    const status = (err.code === 'ECONNREFUSED' || err.name === 'TimeoutError') ? 'skipped' : 'error';
    insertPipelineRun(db, { pipeline: 'knowledge_extract', project_id: projectId, model: opts.ollamaModel || 'qwen2.5:7b', status, error: err.message, duration_ms: err.duration_ms || 0 });
    return { inserted: 0, updated: 0, skipped: true };
  }
} else {
  // Existing callClaude path (unchanged)
  claudeResult = await callClaude(llmPrompt, model);
}
```

- [ ] **Step 4: Update `scan.js` to use skill-loader**

In `src/knowledge/scan.js`, replace:
```js
const { callClaude, parseJsonResponse, mergeOrUpdate, loadSkillTemplate } = require('./extract');
```
With:
```js
const { callClaude, parseJsonResponse, mergeOrUpdate } = require('./extract');
const { loadSkillBody } = require('../lib/skill-loader');
```

Replace `loadSkillTemplate()` call with `loadSkillBody('knowledge-extractor')`.

- [ ] **Step 5: Update test imports**

In `test/knowledge/knowledge.test.js`, update the import line to remove `loadSkillTemplate` if it was imported:
```js
// If test imports loadSkillTemplate, remove it. Tests already use buildExtractPrompt which calls loadSkillBody internally.
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/extract.js src/knowledge/scan.js test/knowledge/knowledge.test.js
git commit -m "refactor: use skill-loader in knowledge extraction, add Ollama path"
```

---

### Task 5: Create `src/evolve/detect.js`

**Files:**
- Create: `src/evolve/detect.js`
- Create: `test/evolve/detect.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/evolve/detect.test.js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../../src/db/schema');

// We'll test the pure functions first, then integration
const {
  validatePattern,
  buildPatternPrompt,
} = require('../../src/evolve/detect');

describe('pattern-detect', () => {
  describe('validatePattern', () => {
    it('accepts valid pattern', () => {
      const result = validatePattern({
        title: 'Always run tests after auth changes',
        description: 'User consistently runs tests after editing auth modules.',
        target_type: 'rule',
        scope: 'project',
        evidence: 'Observed 4 times',
      });
      assert.equal(result.valid, true);
    });

    it('rejects missing title', () => {
      const result = validatePattern({
        title: '',
        description: 'desc',
        target_type: 'rule',
      });
      assert.equal(result.valid, false);
      assert.ok(result.reason.includes('title'));
    });

    it('rejects title over 80 chars', () => {
      const result = validatePattern({
        title: 'x'.repeat(81),
        description: 'desc',
        target_type: 'rule',
      });
      assert.equal(result.valid, false);
    });

    it('rejects invalid target_type', () => {
      const result = validatePattern({
        title: 'Valid title',
        description: 'desc',
        target_type: 'invalid',
      });
      assert.equal(result.valid, false);
      assert.ok(result.reason.includes('target_type'));
    });

    it('rejects missing description', () => {
      const result = validatePattern({
        title: 'Valid title',
        description: '',
        target_type: 'rule',
      });
      assert.equal(result.valid, false);
    });

    it('accepts all valid target_types', () => {
      for (const type of ['rule', 'skill', 'agent', 'workflow']) {
        const result = validatePattern({
          title: 'Test',
          description: 'Test desc',
          target_type: type,
        });
        assert.equal(result.valid, true, `should accept target_type=${type}`);
      }
    });
  });

  describe('buildPatternPrompt', () => {
    it('includes project name', () => {
      const prompt = buildPatternPrompt('my-project', []);
      assert.ok(prompt.includes('my-project'));
    });

    it('includes compact skill content', () => {
      const prompt = buildPatternPrompt('proj', []);
      assert.ok(prompt.includes('"target_type"'), 'should include pattern JSON schema');
      assert.ok(prompt.includes('Return a JSON array only'), 'should include compact instructions');
    });

    it('includes formatted events', () => {
      const events = [{
        event_type: 'tool_call',
        name: 'Bash',
        tool_input: JSON.stringify({ command: 'npm test' }),
        tool_response: 'all passing',
      }];
      const prompt = buildPatternPrompt('proj', events);
      assert.ok(prompt.includes('[tool_call] Bash'));
      assert.ok(prompt.includes('npm test'));
    });
  });

  describe('upsertPattern (integration)', () => {
    let db;

    beforeEach(() => {
      db = createDb(':memory:');
    });

    it('inserts new pattern with draft status and confidence 0.3', () => {
      const { upsertPattern } = require('../../src/evolve/detect');

      const result = upsertPattern(db, {
        title: 'Always run tests after auth changes',
        description: 'User runs tests after editing auth.',
        target_type: 'rule',
        scope: 'project',
        evidence: 'Observed 4 times',
        projects: ['crm-backend'],
      });

      assert.equal(result.action, 'inserted');

      const row = db.prepare('SELECT * FROM auto_evolves WHERE title = ?').get('Always run tests after auth changes');
      assert.ok(row);
      assert.equal(row.status, 'draft');
      assert.equal(row.confidence, 0.3);
      assert.equal(row.observation_count, 1);
      assert.equal(row.target_type, 'rule');
    });

    it('bumps confidence and observation_count on duplicate', () => {
      const { upsertPattern } = require('../../src/evolve/detect');

      upsertPattern(db, { title: 'Test pattern', description: 'desc', target_type: 'rule', scope: 'project', evidence: 'ev', projects: [] });
      const result = upsertPattern(db, { title: 'Test pattern', description: 'updated desc', target_type: 'rule', scope: 'project', evidence: 'more ev', projects: [] });

      assert.equal(result.action, 'updated');

      const row = db.prepare('SELECT * FROM auto_evolves WHERE title = ?').get('Test pattern');
      assert.equal(row.observation_count, 2);
      assert.ok(row.confidence > 0.3, 'confidence should be bumped');
      assert.ok(row.confidence <= 0.95, 'confidence should not exceed 0.95');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/evolve/detect.test.js`
Expected: FAIL with "Cannot find module '../../src/evolve/detect'"

- [ ] **Step 3: Write implementation**

```js
// src/evolve/detect.js
'use strict';

const { loadCompactPrompt } = require('../lib/skill-loader');
const { formatEventsForLLM } = require('../lib/format-events');
const { callOllama } = require('../lib/ollama');
const { parseJsonResponse } = require('../knowledge/extract');
const { makeId } = require('./sync');
const { insertPipelineRun } = require('../db/pipeline-runs');

const VALID_TARGET_TYPES = new Set(['rule', 'skill', 'agent', 'workflow']);

// ---------------------------------------------------------------------------
// validatePattern
// ---------------------------------------------------------------------------

function validatePattern(entry) {
  if (!entry.title || entry.title.length === 0) {
    return { valid: false, reason: 'empty title' };
  }
  if (entry.title.length > 80) {
    return { valid: false, reason: 'title exceeds 80 chars' };
  }
  if (!VALID_TARGET_TYPES.has(entry.target_type)) {
    return { valid: false, reason: `invalid target_type: ${entry.target_type}` };
  }
  if (!entry.description || entry.description.length === 0) {
    return { valid: false, reason: 'empty description' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// buildPatternPrompt
// ---------------------------------------------------------------------------

function buildPatternPrompt(projectName, events) {
  const compact = loadCompactPrompt('pattern-detector');
  const eventLines = formatEventsForLLM(events);

  return [
    `Project: ${projectName}`,
    '',
    'Analyze the following tool usage events and detect reusable behavioral patterns.',
    '',
    'Events:',
    eventLines,
    '',
    compact || '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// upsertPattern
// ---------------------------------------------------------------------------

function upsertPattern(db, entry) {
  const id = makeId(entry.title, entry.target_type);
  const now = new Date().toISOString();

  const description = entry.evidence
    ? `${entry.description}\n\n## Evidence\n${entry.evidence}`
    : entry.description;

  const projects = entry.projects && entry.projects.length > 0
    ? JSON.stringify(entry.projects)
    : null;

  const existing = db.prepare('SELECT id, observation_count, confidence FROM auto_evolves WHERE id = ?').get(id);

  if (existing) {
    const newCount = existing.observation_count + 1;
    const newConf = Math.min(0.95, existing.confidence + 0.15);
    db.prepare(`
      UPDATE auto_evolves
      SET observation_count = ?, confidence = ?, description = ?, projects = ?, updated_at = ?
      WHERE id = ?
    `).run(newCount, parseFloat(newConf.toFixed(2)), description, projects, now, id);
    return { action: 'updated', id };
  }

  db.prepare(`
    INSERT INTO auto_evolves (id, title, description, target_type, confidence, observation_count, projects, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.title, description, entry.target_type, 0.3, 1, projects, 'draft', now, now);
  return { action: 'inserted', id };
}

// ---------------------------------------------------------------------------
// detectPatternsFromPrompt
// ---------------------------------------------------------------------------

async function detectPatternsFromPrompt(db, promptId, opts = {}) {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
  if (!prompt) return { inserted: 0, updated: 0, skipped: true };

  const events = db.prepare(
    'SELECT * FROM events WHERE prompt_id = ? ORDER BY seq_num ASC'
  ).all(promptId);

  if (events.length < 3) return { inserted: 0, updated: 0, skipped: true };

  const projectName = events[0]?.project_name || 'unknown';
  const projectId = events[0]?.project_name || null;
  const model = opts.model || 'qwen2.5:7b';

  const llmPrompt = buildPatternPrompt(projectName, events);

  let result;
  try {
    result = await callOllama(llmPrompt, model, {
      url: opts.url,
      timeout: opts.timeout,
    });
  } catch (err) {
    const status = (err.code === 'ECONNREFUSED' || err.name === 'TimeoutError') ? 'skipped' : 'error';
    insertPipelineRun(db, {
      pipeline: 'pattern_detect', project_id: projectId, model,
      status, error: err.message, duration_ms: 0,
    });
    return { inserted: 0, updated: 0, skipped: true };
  }

  const entries = parseJsonResponse(result.output);
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const entry of entries) {
    const check = validatePattern(entry);
    if (!check.valid) { errors++; continue; }

    const upsertResult = upsertPattern(db, entry);
    if (upsertResult.action === 'inserted') inserted++;
    else updated++;
  }

  insertPipelineRun(db, {
    pipeline: 'pattern_detect', project_id: projectId, model,
    status: 'success', duration_ms: result.duration_ms,
  });

  return { inserted, updated, errors };
}

module.exports = {
  validatePattern,
  buildPatternPrompt,
  upsertPattern,
  detectPatternsFromPrompt,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/evolve/detect.test.js`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolve/detect.js test/evolve/detect.test.js
git commit -m "feat: add pattern detection pipeline with Ollama integration"
```

---

### Task 6: Wire pipeline hooks and server config

**Files:**
- Modify: `src/ingest/pipeline.js`
- Modify: `src/server.js`
- Modify: `config.json`

- [ ] **Step 1: Add pattern detection hook to `pipeline.js`**

At the top of `src/ingest/pipeline.js`, after the existing `_extractKnowledge` variables (line 10), add:

```js
let _detectPatterns = null;
let _patternConfig = null;

function setPatternHook(detectFn, config) {
  _detectPatterns = detectFn;
  _patternConfig = config;
}
```

In `processContent` function, after the knowledge extraction block (after line 159), add:

```js
// Trigger pattern detection for new prompts (non-blocking)
if (_detectPatterns) {
  for (const pid of promptIds) {
    setImmediate(() => {
      _detectPatterns(db, pid, _patternConfig || {}).catch(() => {});
    });
  }
}
```

Update exports (line 261) to include `setPatternHook`:
```js
module.exports = { ingestFile, ingestAll, MAX_RETRIES, setKnowledgeHook, setPatternHook };
```

- [ ] **Step 2: Wire hooks in `server.js`**

Add imports at the top of `src/server.js`:
```js
const { detectPatternsFromPrompt } = require('./evolve/detect');
const { setPatternHook } = require('./ingest/pipeline');
```

After the knowledge hook registration (after line 69), add:

```js
// Pattern detection via Ollama (per-prompt)
if (config.pattern_detect_enabled !== false) {
  setPatternHook(detectPatternsFromPrompt, {
    model: config.ollama_model || 'qwen2.5:7b',
    url: config.ollama_url || 'http://localhost:11434',
    timeout: config.ollama_timeout_ms || 90000,
  });
}
```

Update the knowledge hook to pass Ollama config when `knowledge_model === 'local'`:
```js
if (config.knowledge_enabled !== false) {
  setKnowledgeHook(extractKnowledgeFromPrompt, {
    maxEvents: config.knowledge_max_events_per_prompt ?? 50,
    model: config.knowledge_model || 'local',
    ollamaModel: config.ollama_model || 'qwen2.5:7b',
    ollamaUrl: config.ollama_url || 'http://localhost:11434',
    ollamaTimeout: config.ollama_timeout_ms || 90000,
  });
}
```

- [ ] **Step 3: Update `config.json`**

Add new keys to `config.json`:

```json
{
  "knowledge_enabled": true,
  "knowledge_model": "local",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "qwen2.5:7b",
  "ollama_timeout_ms": 90000,
  "pattern_detect_enabled": true
}
```

Keep all existing keys unchanged.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingest/pipeline.js src/server.js config.json
git commit -m "feat: wire Ollama-based knowledge extraction and pattern detection into pipeline"
```

---

### Task 7: Startup health check and final integration

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add Ollama health check on startup**

In `src/server.js` `buildApp` function, after route registration and before the return statement, add:

```js
// Ollama health check (non-blocking, informational only)
if (config.pattern_detect_enabled !== false || config.knowledge_model === 'local') {
  const ollamaUrl = config.ollama_url || 'http://localhost:11434';
  fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    .then(res => {
      if (res.ok) fastify.log.info(`Ollama available at ${ollamaUrl}`);
      else fastify.log.warn(`Ollama returned ${res.status} at ${ollamaUrl}`);
    })
    .catch(() => {
      fastify.log.warn(`Ollama not available at ${ollamaUrl} — local extraction will be skipped`);
    });
}
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Manual verification — with Ollama running**

Run: `npm start`

Check logs for: `Ollama available at http://localhost:11434`

Trigger a prompt via Claude Code session, then check:
```bash
sqlite3 open-pulse.db "SELECT pipeline, model, status FROM pipeline_runs ORDER BY created_at DESC LIMIT 5"
```
Expected: rows with `pipeline=knowledge_extract, model=qwen2.5:7b, status=success` and `pipeline=pattern_detect, model=qwen2.5:7b, status=success`

- [ ] **Step 4: Manual verification — without Ollama**

Stop Ollama, restart server. Trigger a prompt, then check:
```bash
sqlite3 open-pulse.db "SELECT pipeline, model, status, error FROM pipeline_runs ORDER BY created_at DESC LIMIT 5"
```
Expected: rows with `status=skipped`

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat: add Ollama startup health check"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update architecture diagram**

In CLAUDE.md `## Architecture Overview`, update the ASCII diagram to add:

```
                              │  Ollama     │──→ knowledge_entries + auto_evolves
                              │  (per-prompt│    local model extraction
                              │   extract)  │
```

- [ ] **Step 2: Update Configuration section**

Add new config keys to the config table in CLAUDE.md:

```
| `ollama_url` | `"http://localhost:11434"` | Ollama API base URL |
| `ollama_model` | `"qwen2.5:7b"` | Local model for per-prompt extraction |
| `ollama_timeout_ms` | 90000 | Ollama HTTP request timeout |
| `pattern_detect_enabled` | true | Enable per-prompt pattern detection |
```

- [ ] **Step 3: Update Data Flow section**

Add bullet point after knowledge extraction:

```
6b. **Pattern Detection**: After each prompt is ingested, `src/evolve/detect.js` invokes Ollama to detect reusable behavioral patterns from recent events. Entries stored in `auto_evolves` table with status `draft`.
```

- [ ] **Step 4: Update Directory Structure**

Add new files to the directory tree:

```
│   ├── lib/
│   │   ├── ...existing files...
│   │   ├── skill-loader.js     # loadSkillBody(), loadCompactPrompt()
│   │   ├── ollama.js           # callOllama() HTTP client
│   │   └── format-events.js    # formatEventsForLLM() shared formatter
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Ollama integration architecture"
```
