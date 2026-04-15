'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-auto-evolve-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const TEST_LOG_DIR = path.join(TEST_DIR, 'logs');
describe('op-auto-evolve', () => {
  let db, autoEvolve;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    db = require('../../src/db/schema').createDb(TEST_DB);
    const { generateComponent, runAutoEvolve } = require('../../src/evolve/promote');
    const { revertAutoEvolve } = require('../../src/evolve/revert');
    const { slugify } = require('../../src/lib/slugify');
    const { extractBody } = require('../../src/lib/frontmatter');
    const { getComponentPath } = require('../../src/lib/paths');
    autoEvolve = { generateComponent, runAutoEvolve, revertAutoEvolve, slugify, extractBody, getComponentPath };
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- extractBody --

  it('extractBody returns text after frontmatter', () => {
    const content = '---\nid: test\ntype: rule\n---\n\n# Title\n\nBody text here.\n';
    assert.equal(autoEvolve.extractBody(content), '# Title\n\nBody text here.');
  });

  it('extractBody returns empty string when no frontmatter', () => {
    assert.equal(autoEvolve.extractBody('Just plain text'), '');
  });

  it('extractBody trims whitespace', () => {
    const content = '---\nid: x\n---\n\n\n  Some body  \n\n';
    assert.equal(autoEvolve.extractBody(content), 'Some body');
  });

  it('extractBody returns empty string when body is whitespace only (A3)', () => {
    const content = '---\nid: x\n---\n\n\n   \n\n';
    assert.equal(autoEvolve.extractBody(content), '');
  });

  // -- slugify --

  it('slugify converts title to kebab-case', () => {
    assert.equal(autoEvolve.slugify('Always Run Tests'), 'always-run-tests');
  });

  it('slugify caps at 60 chars', () => {
    const long = 'a'.repeat(100);
    assert.ok(autoEvolve.slugify(long).length <= 60);
  });

  // -- generateComponent --

  it('generateComponent returns markdown for rule type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'rule', title: 'Always lint', description: 'Run lint before commit',
    });
    assert.ok(content.includes('# Always lint'));
    assert.ok(content.includes('Run lint before commit'));
  });

  it('generateComponent returns YAML frontmatter for skill type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'skill', title: 'Deploy checklist', description: 'Steps to deploy',
    });
    assert.ok(content.includes('---'));
    assert.ok(content.includes('deploy-checklist'));
  });

  it('generateComponent returns markdown for knowledge type', () => {
    const content = autoEvolve.generateComponent({
      target_type: 'knowledge', title: 'Project uses Fastify', description: 'Not Express',
    });
    assert.ok(content.includes('# Project uses Fastify'));
  });

  // -- getComponentPath --

  it('getComponentPath returns correct path for each allowed type', () => {
    const rulePath = autoEvolve.getComponentPath('rule', 'always-lint');
    assert.ok(rulePath.endsWith(path.join('rules', 'always-lint.md')));

    const skillPath = autoEvolve.getComponentPath('skill', 'deploy');
    assert.ok(skillPath.includes(path.join('skills', 'deploy')));

    const knowledgePath = autoEvolve.getComponentPath('knowledge', 'facts');
    assert.ok(knowledgePath.endsWith(path.join('knowledge', 'facts.md')));
  });

  // -- runAutoEvolve --

  it('runAutoEvolve promotes when confidence >= threshold', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-promote-1', 'Use strict mode', 'Always use strict', 'rule', 0.90, 20, 0, 'active', datetime('now'))
    `).run();

    const result = autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['hook'],
      logDir: TEST_LOG_DIR,
    });

    assert.equal(result.promoted, 1);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-promote-1');
    assert.equal(row.status, 'promoted');
    assert.ok(row.promoted_to);
    assert.ok(fs.existsSync(row.promoted_to));
  });

  it('runAutoEvolve skips when confidence < threshold', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-skip-1', 'Maybe lint', 'Consider linting', 'rule', 0.5, 5, 0, 'active', datetime('now'))
    `).run();

    autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['hook'],
      logDir: TEST_LOG_DIR,
    });

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-skip-1');
    assert.equal(row.status, 'active');
  });

  it('runAutoEvolve writes to log file', () => {
    const logPath = path.join(TEST_LOG_DIR, 'auto-evolve.log');
    assert.ok(fs.existsSync(logPath));
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('PROMOTED'));
    assert.ok(content.includes('Use strict mode'));
  });

  it('runAutoEvolve does not promote blacklisted types', () => {
    db.prepare(`
      INSERT OR REPLACE INTO auto_evolves
        (id, title, description, target_type, confidence, observation_count, rejection_count, status, created_at)
      VALUES
        ('test-hook-1', 'Auto format hook', 'Format on save', 'hook', 0.95, 30, 0, 'active', datetime('now'))
    `).run();

    autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['hook'],
      logDir: TEST_LOG_DIR,
    });

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-hook-1');
    assert.equal(row.status, 'active');
  });

  // -- revertAutoEvolve --

  it('revertAutoEvolve deletes file and updates status', () => {
    const promoted = db.prepare(
      "SELECT * FROM auto_evolves WHERE status = 'promoted' LIMIT 1"
    ).get();
    assert.ok(promoted, 'Need a promoted row from earlier test');

    autoEvolve.revertAutoEvolve(db, promoted.id);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(promoted.id);
    assert.equal(row.status, 'reverted');
    assert.ok(!fs.existsSync(promoted.promoted_to));
  });

});
