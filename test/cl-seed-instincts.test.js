'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `cl-seed-test-${Date.now()}`);

describe('cl-seed-instincts', () => {
  let mod;

  before(() => {
    mod = require('../scripts/cl-seed-instincts');
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'inherited'), { recursive: true });
  });

  it('seedStarter creates all starter instincts', () => {
    const count = mod.seedStarter(TEST_DIR);
    assert.equal(count, mod.STARTER_INSTINCTS.length);

    const files = fs.readdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'inherited'));
    assert.equal(files.length, mod.STARTER_INSTINCTS.length);

    // Verify content of one instinct
    const content = fs.readFileSync(
      path.join(TEST_DIR, 'cl', 'instincts', 'inherited', 'grep-before-edit.md'), 'utf8',
    );
    assert.ok(content.includes('id: grep-before-edit'));
    assert.ok(content.includes('confidence: 0.5'));
    assert.ok(content.includes('scope: global'));
  });

  it('seedStarter is idempotent', () => {
    mod.seedStarter(TEST_DIR);
    const count2 = mod.seedStarter(TEST_DIR);
    assert.equal(count2, 0, 'second run should skip existing files');
  });

  it('extractRulesFromClaudeMd finds rule-indicator lines', () => {
    const content = `# Project Guide

## Rules
- ALWAYS run tests before committing
- NEVER hardcode secrets in source code
- Some regular bullet point
- MUST use TypeScript for all new files
`;
    const rules = mod.extractRulesFromClaudeMd(content);
    assert.ok(rules.length >= 3, `found ${rules.length} rules`);
    assert.ok(rules.some(r => r.text.includes('run tests')));
    assert.ok(rules.some(r => r.text.includes('hardcode secrets')));
    assert.ok(rules.some(r => r.text.includes('TypeScript')));
  });

  it('extractRulesFromClaudeMd finds bullets under rules sections', () => {
    const content = `# Conventions

## Coding Guidelines
- Use functional components for React
- Prefer immutable data structures
`;
    const rules = mod.extractRulesFromClaudeMd(content);
    assert.ok(rules.length >= 2);
    assert.ok(rules.some(r => r.text.includes('functional components')));
  });

  it('extractRulesFromClaudeMd skips very short rules', () => {
    const content = '## Rules\n- Do it\n- ALWAYS validate and sanitize user input at boundaries\n';
    const rules = mod.extractRulesFromClaudeMd(content);
    // "Do it" is too short (< 10 chars), should be skipped
    assert.ok(!rules.some(r => r.text === 'Do it'));
    assert.ok(rules.some(r => r.text.includes('validate')));
  });

  it('ruleToId generates kebab-case IDs', () => {
    assert.equal(mod.ruleToId('ALWAYS run tests before committing'), 'always-run-tests-before-committing');
    assert.equal(mod.ruleToId('Use TypeScript!'), 'use-typescript');
  });

  it('ruleToDomain detects correct domains', () => {
    assert.equal(mod.ruleToDomain('always run tests'), 'testing');
    assert.equal(mod.ruleToDomain('use conventional commits'), 'git');
    assert.equal(mod.ruleToDomain('never expose secrets'), 'security');
    assert.equal(mod.ruleToDomain('prefer camelCase naming'), 'code-style');
    assert.equal(mod.ruleToDomain('check before doing'), 'workflow');
  });

  it('seedFromClaudeMd creates project-scoped instincts', () => {
    const claudeMd = path.join(TEST_DIR, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '## Rules\n- ALWAYS use strict mode in JavaScript files\n- NEVER push directly to main branch\n');

    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects', 'abc123', 'instincts', 'inherited'), { recursive: true });

    const count = mod.seedFromClaudeMd(TEST_DIR, claudeMd, 'abc123', 'my-project');
    assert.ok(count >= 2, `should seed at least 2, got ${count}`);

    const dir = path.join(TEST_DIR, 'cl', 'projects', 'abc123', 'instincts', 'inherited');
    const files = fs.readdirSync(dir);
    assert.ok(files.length >= 2);

    // Verify scope is project
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(content.includes('scope: project'));
    assert.ok(content.includes('project_id: abc123'));
  });

  it('seedFromClaudeMd returns 0 for missing file', () => {
    const count = mod.seedFromClaudeMd(TEST_DIR, '/nonexistent/CLAUDE.md', 'x', 'x');
    assert.equal(count, 0);
  });
});
