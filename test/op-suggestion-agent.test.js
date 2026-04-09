'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const {
  generateId,
  clamp,
  exportAnalysisData,
  buildPrompt,
  parseSuggestions,
  autoResolveStaleSuggestions,
  translateMissingInstincts,
  SECURITY_PATTERNS,
} = require('../scripts/op-suggestion-agent');

const TEST_DIR = path.join(os.tmpdir(), `op-suggestion-agent-test-${Date.now()}`);
let db;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

function seedSchema(db) {
  const { createDb } = require('../src/op-db');
  // createDb applies schema + migrations; use a fresh DB
  return db;
}

describe('op-suggestion-agent', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const dbPath = path.join(TEST_DIR, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Apply schema from op-db
    const { createDb } = require('../src/op-db');
    const freshDb = createDb(dbPath);
    freshDb.close();

    db.close();
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── generateId ──────────────────────────────────────────────────────────

  describe('generateId', () => {
    it('produces deterministic 16-char hex', () => {
      const id1 = generateId('cleanup', 'skill:old-thing');
      const id2 = generateId('cleanup', 'skill:old-thing');
      assert.equal(id1, id2);
      assert.equal(id1.length, 16);
      assert.match(id1, /^[0-9a-f]{16}$/);
    });

    it('different inputs produce different IDs', () => {
      const id1 = generateId('cleanup', 'skill:a');
      const id2 = generateId('cleanup', 'skill:b');
      assert.notEqual(id1, id2);
    });
  });

  // ── clamp ───────────────────────────────────────────────────────────────

  describe('clamp', () => {
    it('clamps within range', () => {
      assert.equal(clamp(0.5, 0, 0.95), 0.5);
      assert.equal(clamp(1.5, 0, 0.95), 0.95);
      assert.equal(clamp(-0.1, 0, 0.95), 0);
    });
  });

  // ── exportAnalysisData ──────────────────────────────────────────────────

  describe('exportAnalysisData', () => {
    it('returns valid structure with empty DB', () => {
      const data = exportAnalysisData(db);
      assert.ok(data.generated_at);
      assert.ok(data.period);
      assert.ok(Array.isArray(data.components));
      assert.ok(data.sessions_summary);
      assert.ok(Array.isArray(data.workflow_pairs));
      assert.ok(Array.isArray(data.error_clusters));
      assert.ok(Array.isArray(data.security_findings));
      assert.ok(Array.isArray(data.project_contexts));
      assert.ok(Array.isArray(data.co_use_patterns));
      assert.ok(data.previous_suggestions);
    });

    it('includes project contexts from working_directory', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO events (timestamp, session_id, event_type, name, success, working_directory)
        VALUES (?, 'sess-ctx-1', 'skill_invoke', 'my-skill', 1, '/Users/test/project-a')
      `).run(now);
      db.prepare(`
        INSERT INTO events (timestamp, session_id, event_type, name, success, working_directory)
        VALUES (?, 'sess-ctx-1', 'agent_spawn', 'my-agent', 1, '/Users/test/project-a')
      `).run(now);

      const data = exportAnalysisData(db);
      const ctx = data.project_contexts.find(p => p.project === '/Users/test/project-a');
      assert.ok(ctx, 'should include project-a context');
      assert.ok(ctx.events_30d >= 2);
      assert.ok(Array.isArray(ctx.components_used));
      assert.ok(ctx.components_used.includes('my-skill'));
    });

    it('includes co-use patterns for same-session components', () => {
      const now = new Date().toISOString();
      // Insert 2 co-occurring skill/agent events in 2 sessions (threshold is 2)
      for (const sid of ['sess-co-1', 'sess-co-2']) {
        db.prepare(`
          INSERT INTO events (timestamp, session_id, event_type, name, success)
          VALUES (?, ?, 'skill_invoke', 'skill-alpha', 1)
        `).run(now, sid);
        db.prepare(`
          INSERT INTO events (timestamp, session_id, event_type, name, success)
          VALUES (?, ?, 'agent_spawn', 'agent-beta', 1)
        `).run(now, sid);
      }

      const data = exportAnalysisData(db);
      const pair = data.co_use_patterns.find(p =>
        (p.component_a === 'agent-beta' && p.component_b === 'skill-alpha') ||
        (p.component_a === 'skill-alpha' && p.component_b === 'agent-beta')
      );
      assert.ok(pair, 'should detect co-use between skill-alpha and agent-beta');
      assert.ok(pair.shared_sessions >= 2);
    });

    it('includes component usage stats', () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR REPLACE INTO components (type, name, source, description, first_seen_at, last_seen_at)
        VALUES ('skill', 'test-skill', 'custom', 'A test skill for testing', ?, ?)
      `).run(now, now);

      db.prepare(`
        INSERT INTO events (timestamp, session_id, event_type, name, success, duration_ms, input_tokens, output_tokens, estimated_cost_usd)
        VALUES (?, 'sess-1', 'skill_invoke', 'test-skill', 1, 5000, 100, 50, 0.01)
      `).run(now);

      const data = exportAnalysisData(db);
      const comp = data.components.find(c => c.name === 'test-skill');
      assert.ok(comp, 'test-skill should be in components');
      assert.equal(comp.type, 'skill');
      assert.equal(comp.has_description, true);
      assert.ok(comp.invocations_30d >= 1);
    });

    it('includes sessions summary', () => {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (session_id, started_at, model, total_cost_usd, total_tool_calls, total_skill_invokes, total_agent_spawns)
        VALUES ('sess-1', ?, 'opus', 0.50, 10, 2, 1)
      `).run(new Date().toISOString());

      const data = exportAnalysisData(db);
      assert.ok(data.sessions_summary.total_30d >= 1);
    });

    it('detects security findings in files', () => {
      const tempFile = path.join(TEST_DIR, 'danger-agent.md');
      fs.writeFileSync(tempFile, 'dangerouslyDisableSandbox: true\nallowedTools: ["*"]');

      db.prepare(`
        INSERT OR REPLACE INTO components (type, name, source, file_path, description, first_seen_at, last_seen_at)
        VALUES ('agent', 'danger-agent', 'custom', ?, 'A dangerous agent', ?, ?)
      `).run(tempFile, new Date().toISOString(), new Date().toISOString());

      const data = exportAnalysisData(db);
      const findings = data.security_findings.filter(f => f.component === 'danger-agent');
      assert.ok(findings.length >= 2, 'Should detect dangerousSandbox + wildcardTools');
    });
  });

  // ── parseSuggestions ────────────────────────────────────────────────────

  describe('parseSuggestions', () => {
    it('parses valid JSON array from AI output', () => {
      const output = `Here are the suggestions:

[
  {
    "category": "cleanup",
    "type": "skill",
    "key": "cleanup:skill:old-helper",
    "confidence": 0.85,
    "description": "skill 'old-helper' has never been used in 60 days",
    "evidence": ["never_used", "installed_2026-02-01"],
    "action_data": { "action": "remove", "name": "old-helper" }
  },
  {
    "category": "cost",
    "type": "agent",
    "key": "cost:model:fast-agent",
    "confidence": 0.75,
    "description": "agent 'fast-agent' uses Opus but completes in 2.1s",
    "evidence": ["model:opus", "avg_dur:2100"],
    "action_data": { "action": "downgrade", "name": "fast-agent" }
  }
]

Those are my recommendations.`;

      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 2);
      assert.equal(suggestions[0].category, 'cleanup');
      assert.equal(suggestions[0].type, 'skill');
      assert.equal(suggestions[0].confidence, 0.85);
      assert.equal(suggestions[0].status, 'pending');
      assert.ok(suggestions[0].id.length === 16);
      assert.equal(suggestions[1].category, 'cost');
    });

    it('returns empty for non-JSON output', () => {
      assert.deepEqual(parseSuggestions('No suggestions today.'), []);
      assert.deepEqual(parseSuggestions(''), []);
    });

    it('filters out invalid suggestions', () => {
      const output = JSON.stringify([
        { category: 'cleanup', type: 'skill', description: 'valid', key: 'a' },
        { category: 'invalid_cat', type: 'skill', description: 'bad category', key: 'b' },
        { category: 'cleanup', type: 'invalid_type', description: 'bad type', key: 'c' },
        { category: 'cleanup', type: 'skill', description: '', key: 'd' },
        null,
        'not an object',
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0].category, 'cleanup');
    });

    it('clamps confidence to 0-0.95', () => {
      const output = JSON.stringify([
        { category: 'cleanup', type: 'skill', description: 'test', key: 'a', confidence: 1.5 },
        { category: 'cleanup', type: 'skill', description: 'test2', key: 'b', confidence: -0.5 },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions[0].confidence, 0.95);
      assert.equal(suggestions[1].confidence, 0);
    });

    it('generates deterministic IDs from category+key', () => {
      const output = JSON.stringify([
        { category: 'cleanup', type: 'skill', description: 'test', key: 'skill:old' },
      ]);
      const s1 = parseSuggestions(output);
      const s2 = parseSuggestions(output);
      assert.equal(s1[0].id, s2[0].id);
    });

    it('accepts adoption and integration categories', () => {
      const output = JSON.stringify([
        { category: 'adoption', type: 'skill', description: 'underused skill with value', key: 'adopt:skill:a',
          action_data: { action: 'adopt', name: 'a', usage_scenarios: ['scenario 1'], sample_prompts: ['/a --flag'] } },
        { category: 'integration', type: 'agent', description: 'link agents for synergy', key: 'int:agent:b',
          action_data: { action: 'integrate', name: 'b', with: 'c', integration_type: 'chain', benefit: 'saves time' } },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 2);
      assert.equal(suggestions[0].category, 'adoption');
      assert.equal(suggestions[1].category, 'integration');
      const ad0 = JSON.parse(suggestions[0].action_data);
      assert.equal(ad0.action, 'adopt');
      assert.ok(Array.isArray(ad0.usage_scenarios));
      const ad1 = JSON.parse(suggestions[1].action_data);
      assert.equal(ad1.action, 'integrate');
      assert.equal(ad1.with, 'c');
    });

    it('accepts redirect action in agent_creation category', () => {
      const output = JSON.stringify([
        { category: 'agent_creation', type: 'agent', description: 'use existing agent', key: 'redir:agent:x',
          action_data: { action: 'redirect', name: 'ad-hoc-spawn', target_agent: 'existing-agent', reason: 'same purpose' } },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0].category, 'agent_creation');
      const ad = JSON.parse(suggestions[0].action_data);
      assert.equal(ad.action, 'redirect');
      assert.equal(ad.target_agent, 'existing-agent');
    });
  });

  // ── buildPrompt ─────────────────────────────────────────────────────────

  describe('buildPrompt', () => {
    it('replaces template variables', () => {
      const data = {
        components: [],
        sessions_summary: {},
        workflow_pairs: [],
        error_clusters: [],
        security_findings: [],
        agent_spawns: [],
        previous_suggestions: {
          pending: 0, approved_30d: 8, dismissed_30d: 2,
          approval_rate: 80,
          dismissed_categories: { cleanup: 2 },
        },
      };

      // buildPrompt reads from PROMPT_PATH, which is scripts/op-suggestion-prompt.md
      const prompt = buildPrompt(data, { suggestion_agent_max_suggestions: 15 });
      assert.ok(prompt.includes('80'), 'Should include approval rate');
      assert.ok(prompt.includes('cleanup (2x)'), 'Should include dismissed categories');
      assert.ok(prompt.includes('15'), 'Should include max suggestions');
      assert.ok(prompt.includes('"components"'), 'Should include data JSON');
    });
  });

  // ── autoResolveStaleSuggestions ─────────────────────────────────────────

  describe('autoResolveStaleSuggestions', () => {
    it('archives insights for removed components', () => {
      // Insert an insight for a component that does not exist
      db.prepare(`
        INSERT OR REPLACE INTO insights (id, source, category, title, description, confidence, status, action_data, created_at, updated_at)
        VALUES ('resolve-test-1', 'daily_analysis', 'cleanup', 'Remove ghost-skill', 'test', 0.8, 'active', '{"action":"remove","name":"ghost-skill","type":"skill"}', ?, ?)
      `).run(new Date().toISOString(), new Date().toISOString());

      const resolved = autoResolveStaleSuggestions(db);
      assert.ok(resolved >= 1);

      const insight = db.prepare("SELECT status FROM insights WHERE id = 'resolve-test-1'").get();
      assert.equal(insight.status, 'archived');
    });

    it('keeps insights for existing components', () => {
      // test-skill was inserted in exportAnalysisData test
      db.prepare(`
        INSERT OR REPLACE INTO insights (id, source, category, title, description, confidence, status, action_data, created_at, updated_at)
        VALUES ('resolve-test-2', 'daily_analysis', 'cleanup', 'Remove test-skill', 'test', 0.8, 'active', '{"action":"remove","name":"test-skill","type":"skill"}', ?, ?)
      `).run(new Date().toISOString(), new Date().toISOString());

      autoResolveStaleSuggestions(db);

      const insight = db.prepare("SELECT status FROM insights WHERE id = 'resolve-test-2'").get();
      assert.equal(insight.status, 'active');
    });
  });

  // ── description_vi ─────────────────────────────────────────────────────

  describe('description_vi', () => {
    it('parseSuggestions preserves description_vi when present', () => {
      const output = JSON.stringify([
        {
          category: 'security', type: 'skill', key: 'security:skill:deploy-helper',
          description: "Skill 'deploy-helper' has high error rate",
          description_vi: "Nghĩa là gì: Skill có tỷ lệ lỗi cao.\nVấn đề: 35% lời gọi thất bại.\nCách xử lý: Thêm bước kiểm tra trước khi chạy.",
          confidence: 0.80,
        },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 1);
      assert.ok(suggestions[0].description_vi.startsWith('Nghĩa là gì:'));
    });

    it('parseSuggestions sets description_vi to null when absent', () => {
      const output = JSON.stringify([
        { category: 'cleanup', type: 'skill', key: 'a', description: 'test', confidence: 0.5 },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions[0].description_vi, null);
    });

    it('parseSuggestions truncates description_vi at 2000 chars', () => {
      const longVi = 'x'.repeat(3000);
      const output = JSON.stringify([
        { category: 'cleanup', type: 'skill', key: 'a', description: 'test', description_vi: longVi },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions[0].description_vi.length, 2000);
    });
  });

  // ── refinement category ────────────────────────────────────────────────

  describe('refinement', () => {
    it('parseSuggestions accepts refinement category', () => {
      const output = JSON.stringify([
        {
          category: 'refinement', type: 'skill', key: 'refinement:skill:tdd-workflow',
          description: 'Skill tdd-workflow has high correction density (avg 7.2 followup calls)',
          confidence: 0.72,
          action_data: {
            action: 'refine', name: 'tdd-workflow', file_path: '/path/to/SKILL.md',
            issues: ['high correction density (avg 7.2 followup calls)'],
            proposed_changes: [
              { section: '## Process', change: 'add', content: 'Verify all tests pass before completing' },
            ],
            rationale: 'Skill completes but leaves tests failing',
          },
        },
      ]);
      const suggestions = parseSuggestions(output);
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0].category, 'refinement');
      const ad = JSON.parse(suggestions[0].action_data);
      assert.equal(ad.action, 'refine');
      assert.ok(Array.isArray(ad.proposed_changes));
      assert.ok(Array.isArray(ad.issues));
    });

    it('exportAnalysisData returns component_quality_signals', () => {
      const now = new Date().toISOString();
      // Insert a skill invocation followed by 6 tool calls (some failing)
      db.prepare(`
        INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num, tool_input)
        VALUES (?, 'sess-qual-1', 'skill_invoke', 'flaky-skill', 1, 1, '{}')
      `).run(now);
      for (let i = 2; i <= 7; i++) {
        db.prepare(`
          INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num, tool_input)
          VALUES (?, 'sess-qual-1', 'tool_call', 'Edit', ?, ?, '{}')
        `).run(now, i <= 4 ? 0 : 1, i);
      }
      // Second session with same skill
      db.prepare(`
        INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num, tool_input)
        VALUES (?, 'sess-qual-2', 'skill_invoke', 'flaky-skill', 1, 1, '{}')
      `).run(now);
      for (let i = 2; i <= 5; i++) {
        db.prepare(`
          INSERT INTO events (timestamp, session_id, event_type, name, success, seq_num, tool_input)
          VALUES (?, 'sess-qual-2', 'tool_call', 'Read', 1, ?, '{}')
        `).run(now, i);
      }

      const data = exportAnalysisData(db);
      assert.ok(Array.isArray(data.component_quality_signals), 'should have component_quality_signals');
      const sig = data.component_quality_signals.find(s => s.component_name === 'flaky-skill');
      assert.ok(sig, 'should have signal for flaky-skill');
      assert.equal(sig.sessions, 2);
      assert.ok(sig.avg_followup_calls > 0, 'should have followup calls');
    });

    it('exportAnalysisData returns quality_instincts as empty array (cl_instincts dropped)', () => {
      const data = exportAnalysisData(db);
      assert.ok(Array.isArray(data.quality_instincts), 'should have quality_instincts');
      // cl_instincts table has been dropped; quality_instincts is always []
      assert.equal(data.quality_instincts.length, 0);
    });

    it('exportAnalysisData attaches file_content for high-error components', () => {
      const now = new Date().toISOString();
      const tempSkill = path.join(TEST_DIR, 'test-bad-skill.md');
      fs.writeFileSync(tempSkill, '# Bad Skill\n\nThis skill needs improvement.');

      // Register component with file_path
      db.prepare(`
        INSERT OR REPLACE INTO components (type, name, source, file_path, description, first_seen_at, last_seen_at)
        VALUES ('skill', 'bad-skill', 'custom', ?, 'A bad skill', ?, ?)
      `).run(tempSkill, now, now);

      // Insert events with high error rate (> 15% → 3 errors out of 10)
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO events (timestamp, session_id, event_type, name, success, duration_ms)
          VALUES (?, 'sess-bad-' || ?, 'skill_invoke', 'bad-skill', ?, 100)
        `).run(now, i, i < 3 ? 0 : 1);
      }

      const data = exportAnalysisData(db);
      const comp = data.components.find(c => c.name === 'bad-skill');
      assert.ok(comp, 'bad-skill should be in components');
      assert.ok(comp.file_content, 'should have file_content attached');
      assert.ok(comp.file_content.includes('Bad Skill'));
    });
  });

  // ── translateMissingInstincts ───────────────────────────────────────────

  describe('translateMissingInstincts', () => {
    it('always returns 0 (translation deferred)', async () => {
      const count = await translateMissingInstincts(db);
      assert.equal(count, 0);
    });

    it('returns 0 (cl_instincts dropped, translation deferred)', async () => {
      const count = await translateMissingInstincts(db);
      assert.equal(count, 0);
    });
  });

  // ── SECURITY_PATTERNS ──────────────────────────────────────────────────

  describe('SECURITY_PATTERNS', () => {
    it('detects dangerouslyDisableSandbox', () => {
      assert.ok(SECURITY_PATTERNS.dangerousSandbox.test('dangerouslyDisableSandbox: true'));
      assert.ok(!SECURITY_PATTERNS.dangerousSandbox.test('dangerouslyDisableSandbox: false'));
    });

    it('detects wildcard tools', () => {
      assert.ok(SECURITY_PATTERNS.wildcardTools.test('allowedTools: ["*"]'));
      assert.ok(SECURITY_PATTERNS.wildcardTools.test("allowedTools = ['*']"));
    });

    it('detects hardcoded secrets', () => {
      assert.ok(SECURITY_PATTERNS.hardcodedSecrets.test('api_key: "sk-12345678abcdefgh"'));
      assert.ok(!SECURITY_PATTERNS.hardcodedSecrets.test('api_key: "short"'));
    });

    it('detects env secret references', () => {
      assert.ok(SECURITY_PATTERNS.envSecrets.test('process.env.API_KEY'));
      assert.ok(SECURITY_PATTERNS.envSecrets.test('$ENV{SECRET}'));
    });
  });
});
