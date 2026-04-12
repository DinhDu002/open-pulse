'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-promote-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');

describe('op-promote', () => {
  let db, promote;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    db = require('../../src/db/schema').createDb(TEST_DB);
    const { generateComponent, runAutoEvolve } = require('../../src/evolve/promote');
    const { getComponentPath } = require('../../src/lib/paths');
    const { slugify } = require('../../src/lib/slugify');
    promote = { generateComponent, runAutoEvolve, getComponentPath, slugify };
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('generateComponent returns markdown for rule type', () => {
    const content = promote.generateComponent({
      target_type: 'rule', title: 'Always run lint', description: 'Run lint before commit', category: 'workflow',
    });
    assert.ok(content.includes('Always run lint'));
    assert.ok(content.includes('Run lint before commit'));
  });

  it('generateComponent returns plain markdown for hook type', () => {
    const content = promote.generateComponent({
      target_type: 'hook', title: 'Auto format', description: 'Format on save', category: 'workflow', confidence: 0.9,
    });
    assert.ok(content.includes('Auto format'));
    assert.ok(content.includes('Format on save'));
  });

  it('generateComponent returns YAML frontmatter for skill type', () => {
    const content = promote.generateComponent({
      target_type: 'skill', title: 'Deploy checklist', description: 'Steps to deploy', category: 'workflow',
    });
    assert.ok(content.includes('---'));
    assert.ok(content.includes('Deploy checklist') || content.includes('deploy-checklist'));
    assert.ok(content.includes('Steps to deploy'));
  });

  it('generateComponent returns YAML frontmatter for agent type', () => {
    const content = promote.generateComponent({
      target_type: 'agent',
      title: 'Test Runner',
      description: 'Runs the project test suite and reports failures',
    });
    assert.ok(content.startsWith('---\n'), 'must start with YAML frontmatter');
    assert.ok(content.includes('name: test-runner'), 'must have slugified name');
    assert.ok(content.includes('description: Runs the project test suite and reports failures'));
    assert.ok(content.includes('model: sonnet'), 'must have default model');
    assert.ok(content.includes('Runs the project test suite and reports failures'), 'must include body');
  });

  it('generateComponent agent description caps at 200 chars and uses first line', () => {
    const longDesc = 'First line of description.\nSecond line that should not appear in frontmatter.\n' + 'x'.repeat(300);
    const content = promote.generateComponent({
      target_type: 'agent',
      title: 'Long Desc',
      description: longDesc,
    });
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'frontmatter must exist');
    const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
    assert.ok(descLine.length <= 'description: '.length + 200, 'description line capped at 200 chars');
    assert.ok(descLine.includes('First line of description'));
    assert.ok(!descLine.includes('Second line'), 'second line must not leak into frontmatter');
  });

  it('getComponentPath returns correct path for each target_type', () => {
    const rulePath = promote.getComponentPath('rule', 'always-lint');
    assert.ok(rulePath.includes('rules'));
    assert.ok(rulePath.endsWith('.md'));

    const skillPath = promote.getComponentPath('skill', 'deploy-checklist');
    assert.ok(skillPath.includes('skills'));

    const agentPath = promote.getComponentPath('agent', 'code-reviewer');
    assert.ok(agentPath.includes('agents'));
    assert.ok(agentPath.endsWith('.md'));

    const hookPath = promote.getComponentPath('hook', 'auto-format');
    assert.ok(hookPath.includes('hooks'));
    assert.ok(hookPath.endsWith('.sh'));

    const knowledgePath = promote.getComponentPath('knowledge', 'project-facts');
    assert.ok(knowledgePath.includes('knowledge'));
    assert.ok(knowledgePath.endsWith('.md'));
  });

  it('getComponentPath uses OPEN_PULSE_CLAUDE_DIR env var', () => {
    const rulePath = promote.getComponentPath('rule', 'test-rule');
    assert.ok(rulePath.startsWith(TEST_CLAUDE_DIR));
  });

  it('slugify converts text to lowercase hyphenated slug', () => {
    assert.equal(promote.slugify('Always Run Lint!'), 'always-run-lint');
    assert.equal(promote.slugify('foo  bar'), 'foo-bar');
    assert.equal(promote.slugify('--leading-and-trailing--'), 'leading-and-trailing');
    // max 60 chars
    const long = 'a'.repeat(100);
    assert.equal(promote.slugify(long).length, 60);
  });

  it('runAutoEvolve skips items without sufficient confidence', () => {
    // Insert a low-confidence item — should NOT be promoted
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO auto_evolves (title, target_type, description, confidence, status, rejection_count, observation_count, created_at, updated_at)
      VALUES ('Low conf rule', 'rule', 'Some desc', 0.5, 'active', 0, 1, ?, ?)
    `).run(now, now);
    const result = promote.runAutoEvolve(db, { min_confidence: 0.85 });
    assert.equal(result.promoted, 0);
  });
});
