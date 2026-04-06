'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-actions-test-${Date.now()}`);

describe('op-actions', () => {
  let actions;
  const mockClaudeDir = path.join(TEST_DIR, '.claude');

  before(() => {
    fs.mkdirSync(path.join(mockClaudeDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(mockClaudeDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(mockClaudeDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(mockClaudeDir, 'settings.json'), JSON.stringify({ hooks: {} }));
    actions = require('../src/op-actions');
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('createComponent creates a skill', () => {
    const result = actions.createComponent({
      type: 'skill', name: 'test-skill',
      content: '---\nname: test-skill\ndescription: test\n---\n# Test Skill',
    }, mockClaudeDir);
    assert.ok(result.success);
    assert.ok(fs.existsSync(path.join(mockClaudeDir, 'skills', 'test-skill', 'SKILL.md')));
  });

  it('createComponent creates an agent', () => {
    const result = actions.createComponent({
      type: 'agent', name: 'test-agent',
      content: '---\nname: test-agent\ndescription: test\n---\n# Test Agent',
    }, mockClaudeDir);
    assert.ok(result.success);
    assert.ok(fs.existsSync(path.join(mockClaudeDir, 'agents', 'test-agent.md')));
  });

  it('createComponent creates a rule', () => {
    const result = actions.createComponent({
      type: 'rule', name: 'test-rule',
      content: '# Test Rule\nDo this.',
    }, mockClaudeDir);
    assert.ok(result.success);
    assert.ok(fs.existsSync(path.join(mockClaudeDir, 'rules', 'test-rule.md')));
  });

  it('createComponent rejects duplicate', () => {
    const result = actions.createComponent({
      type: 'skill', name: 'test-skill', content: 'duplicate',
    }, mockClaudeDir);
    assert.ok(!result.success);
    assert.ok(result.error.includes('already exists'));
  });

  it('deleteComponent removes a skill', () => {
    const result = actions.deleteComponent({
      type: 'skill', name: 'test-skill',
    }, mockClaudeDir);
    assert.ok(result.success);
    assert.ok(!fs.existsSync(path.join(mockClaudeDir, 'skills', 'test-skill')));
  });

  it('deleteComponent removes an agent', () => {
    const result = actions.deleteComponent({
      type: 'agent', name: 'test-agent',
    }, mockClaudeDir);
    assert.ok(result.success);
    assert.ok(!fs.existsSync(path.join(mockClaudeDir, 'agents', 'test-agent.md')));
  });

  it('previewComponent returns path without creating', () => {
    const result = actions.previewComponent({
      type: 'skill', name: 'preview-skill',
    }, mockClaudeDir);
    assert.ok(result.path);
    assert.ok(!fs.existsSync(result.path));
  });
});
