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
    db = require('../src/op-db').createDb(TEST_DB);
    promote = require('../src/op-promote');
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('generateComponentContent returns markdown for rule type', () => {
    const content = promote.generateComponentContent({
      target_type: 'rule', title: 'Always run lint', description: 'Run lint before commit', category: 'workflow',
    });
    assert.ok(content.includes('Always run lint'));
    assert.ok(content.includes('Run lint before commit'));
  });

  it('generateComponentContent returns bash script for hook type', () => {
    const content = promote.generateComponentContent({
      target_type: 'hook', title: 'Auto format', description: 'Format on save', category: 'workflow', confidence: 0.9,
    });
    assert.ok(content.startsWith('#!/bin/bash'));
    assert.ok(content.includes('Auto format'));
    assert.ok(content.includes('Format on save'));
  });

  it('generateComponentContent returns YAML frontmatter for skill type', () => {
    const content = promote.generateComponentContent({
      target_type: 'skill', title: 'Deploy checklist', description: 'Steps to deploy', category: 'workflow',
    });
    assert.ok(content.includes('---'));
    assert.ok(content.includes('Deploy checklist') || content.includes('deploy-checklist'));
    assert.ok(content.includes('Steps to deploy'));
  });

  it('generateComponentContent returns YAML frontmatter with model:haiku for agent type', () => {
    const content = promote.generateComponentContent({
      target_type: 'agent', title: 'Code reviewer', description: 'Review code', category: 'quality',
    });
    assert.ok(content.includes('haiku'));
    assert.ok(content.includes('Review code'));
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

  it('promoteInsight creates file and updates status', () => {
    const { upsertInsight, getInsight } = require('../src/db/insights');
    upsertInsight(db, {
      id: 'promote-test', source: 'observer', category: 'workflow',
      target_type: 'rule', title: 'Always test', description: 'Always run tests before committing',
      confidence: 0.9,
    });

    const result = promote.promoteInsight(db, 'promote-test');
    assert.ok(result.promoted_to);
    assert.ok(fs.existsSync(result.promoted_to));

    const updated = getInsight(db, 'promote-test');
    assert.equal(updated.status, 'promoted');
    assert.equal(updated.promoted_to, result.promoted_to);
  });

  it('promoteInsight throws for missing insight', () => {
    assert.throws(
      () => promote.promoteInsight(db, 'nonexistent-id'),
      /not found/i
    );
  });

  it('revertInsight deletes file and updates status', () => {
    const { getInsight } = require('../src/db/insights');
    // promote-test was promoted in previous test
    const insight = getInsight(db, 'promote-test');
    assert.ok(insight.promoted_to);

    promote.revertInsight(db, 'promote-test');

    assert.ok(!fs.existsSync(insight.promoted_to));
    const reverted = getInsight(db, 'promote-test');
    assert.equal(reverted.status, 'reverted');
  });

  it('runPromotionCheck promotes all qualifying insights', () => {
    const { upsertInsight } = require('../src/db/insights');
    // Need observation_count >= 10 and confidence >= 0.85
    for (let i = 0; i < 10; i++) {
      upsertInsight(db, {
        id: 'promo-batch', source: 'observer', category: 'workflow',
        target_type: 'rule', title: 'Batch promote rule', description: 'Always batch promote',
        confidence: 0.9,
      });
    }

    const count = promote.runPromotionCheck(db);
    assert.ok(count >= 1);

    const filePath = promote.getComponentPath('rule', 'batch-promote-rule');
    assert.ok(fs.existsSync(filePath));
  });
});
