'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-plan-test-${Date.now()}`);
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');

function setupTestClaudeDir() {
  fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'skills', 'sample-skill'), { recursive: true });
  fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'agents'), { recursive: true });

  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'CLAUDE.md'), '# Global CLAUDE.md\nGlobal conventions go here.');
  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'rules', 'rule-a.md'), '# Rule A\nFirst rule.');
  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'rules', 'rule-b.md'), '# Rule B\nSecond rule.');
  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'skills', 'sample-skill', 'SKILL.md'), '# Sample Skill\nSkill body.');
  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'agents', 'sample-agent.md'), '# Sample Agent\nAgent body.');
  fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'settings.json'), JSON.stringify({ hooks: {} }));
}

function cleanupTestClaudeDir() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

before(() => {
  setupTestClaudeDir();
});

after(() => {
  cleanupTestClaudeDir();
});

// ---------------------------------------------------------------------------
// parsePlanOutput
// ---------------------------------------------------------------------------

describe('parsePlanOutput', () => {
  const { parsePlanOutput } = require('../../src/review/plan');

  it('extracts both fenced blocks when present', () => {
    const raw = '```markdown plan\n# Plan title\nStep 1.\n```\n\n```text handoff\nDo X then Y.\n```';
    const result = parsePlanOutput(raw);
    assert.equal(result.plan_md, '# Plan title\nStep 1.');
    assert.equal(result.handoff_prompt, 'Do X then Y.');
  });

  it('throws when markdown plan block is missing', () => {
    const raw = '```text handoff\nOnly handoff here.\n```';
    assert.throws(() => parsePlanOutput(raw), /missing.*markdown plan/i);
  });

  it('throws when text handoff block is missing', () => {
    const raw = '```markdown plan\nOnly plan here.\n```';
    assert.throws(() => parsePlanOutput(raw), /missing.*text handoff/i);
  });

  it('extracts blocks even with surrounding preamble or postamble', () => {
    const raw = 'Some preamble.\n\n```markdown plan\nPlan content.\n```\n\nMiddle text.\n\n```text handoff\nHandoff content.\n```\n\nFooter.';
    const result = parsePlanOutput(raw);
    assert.equal(result.plan_md, 'Plan content.');
    assert.equal(result.handoff_prompt, 'Handoff content.');
  });

  it('throws on empty input', () => {
    assert.throws(() => parsePlanOutput(''), /missing/i);
  });

  it('trims whitespace inside extracted blocks', () => {
    const raw = '```markdown plan\n   Plan with whitespace.   \n```\n\n```text handoff\n   Handoff with whitespace.   \n```';
    const result = parsePlanOutput(raw);
    assert.equal(result.plan_md, 'Plan with whitespace.');
    assert.equal(result.handoff_prompt, 'Handoff with whitespace.');
  });
});

// ---------------------------------------------------------------------------
// resolveTargetFiles
// ---------------------------------------------------------------------------

describe('resolveTargetFiles', () => {
  const { resolveTargetFiles } = require('../../src/review/plan');

  it('returns CLAUDE.md when target_type is null', () => {
    const files = resolveTargetFiles({ target_type: null }, TEST_CLAUDE_DIR, 100);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('CLAUDE.md')), 'CLAUDE.md present');
  });

  it('returns rule files when target_type is rule', () => {
    const files = resolveTargetFiles({ target_type: 'rule' }, TEST_CLAUDE_DIR, 100);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('rule-a.md')), 'rule-a present');
    assert.ok(paths.some(p => p.endsWith('rule-b.md')), 'rule-b present');
    assert.ok(paths.some(p => p.endsWith('CLAUDE.md')), 'CLAUDE.md still included');
  });

  it('returns SKILL.md files when target_type is skill', () => {
    const files = resolveTargetFiles({ target_type: 'skill' }, TEST_CLAUDE_DIR, 100);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('SKILL.md')), 'sample SKILL.md present');
  });

  it('returns agent files when target_type is agent', () => {
    const files = resolveTargetFiles({ target_type: 'agent' }, TEST_CLAUDE_DIR, 100);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('sample-agent.md')), 'sample-agent present');
  });

  it('returns only CLAUDE.md for unknown target_type', () => {
    const files = resolveTargetFiles({ target_type: 'nonsense' }, TEST_CLAUDE_DIR, 100);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('CLAUDE.md')), 'CLAUDE.md present');
    assert.ok(!paths.some(p => p.endsWith('rule-a.md')), 'no rules');
  });

  it('truncates the list when total content exceeds maxKb', () => {
    // Tiny cap (0 KB) — should truncate to almost nothing
    const files = resolveTargetFiles({ target_type: 'rule' }, TEST_CLAUDE_DIR, 0);
    const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
    // With 0 KB cap, only files that fit (or one as minimum) — assert significantly truncated
    assert.ok(files.length <= 2, `expected <=2 files after truncation, got ${files.length}`);
  });

  it('returns objects with path and content keys', () => {
    const files = resolveTargetFiles({ target_type: 'rule' }, TEST_CLAUDE_DIR, 100);
    for (const f of files) {
      assert.ok(typeof f.path === 'string');
      assert.ok(typeof f.content === 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// buildPlanPrompt
// ---------------------------------------------------------------------------

describe('buildPlanPrompt', () => {
  const { buildPlanPrompt } = require('../../src/review/plan');

  const sampleSuggestion = {
    title: 'Add Vietnamese diacritic checking rule',
    category: 'refinement',
    target_type: 'rule',
    action: 'create',
    description: 'Description here',
    reasoning: 'Reasoning here',
  };

  it('contains all suggestion fields', () => {
    const prompt = buildPlanPrompt(sampleSuggestion, []);
    assert.ok(prompt.includes(sampleSuggestion.title));
    assert.ok(prompt.includes(sampleSuggestion.category));
    assert.ok(prompt.includes(sampleSuggestion.target_type));
    assert.ok(prompt.includes(sampleSuggestion.action));
    assert.ok(prompt.includes(sampleSuggestion.description));
    assert.ok(prompt.includes(sampleSuggestion.reasoning));
  });

  it('contains target file paths and contents', () => {
    const targetFiles = [
      { path: '/fake/path/file1.md', content: 'File 1 content here' },
      { path: '/fake/path/file2.md', content: 'File 2 content here' },
    ];
    const prompt = buildPlanPrompt(sampleSuggestion, targetFiles);
    assert.ok(prompt.includes('/fake/path/file1.md'));
    assert.ok(prompt.includes('File 1 content here'));
    assert.ok(prompt.includes('/fake/path/file2.md'));
    assert.ok(prompt.includes('File 2 content here'));
  });

  it('always contains both fenced block instructions', () => {
    const prompt = buildPlanPrompt(sampleSuggestion, []);
    assert.ok(prompt.includes('markdown plan'));
    assert.ok(prompt.includes('text handoff'));
  });

  it('handles empty target files list', () => {
    const prompt = buildPlanPrompt(sampleSuggestion, []);
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes(sampleSuggestion.title));
  });
});
