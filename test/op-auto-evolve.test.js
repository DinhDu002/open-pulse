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
const TEST_CL_DIR = path.join(TEST_DIR, 'cl', 'instincts');

describe('op-auto-evolve', () => {
  let db, autoEvolve;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    fs.mkdirSync(TEST_CL_DIR, { recursive: true });
    db = require('../src/op-db').createDb(TEST_DB);
    autoEvolve = require('../src/op-auto-evolve');
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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

  // -- syncInstincts --

  it('syncInstincts upserts new instinct into auto_evolves', () => {
    const yaml = [
      '---',
      'name: always-test',
      'description: Always run tests before commit',
      'type: rule',
      'confidence: 0.1',
      'seen_count: 3',
      '---',
      '',
      'Always run tests before committing changes.',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'always-test.md'), yaml);

    autoEvolve.syncInstincts(db, TEST_CL_DIR);

    const rows = db.prepare('SELECT * FROM auto_evolves').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'always-test');
    assert.equal(rows[0].target_type, 'rule');
    assert.equal(rows[0].observation_count, 3);
  });

  it('syncInstincts increments confidence when observation_count grows', () => {
    const yaml = [
      '---',
      'name: always-test',
      'description: Always run tests before commit',
      'type: rule',
      'confidence: 0.2',
      'seen_count: 5',
      '---',
      '',
      'Always run tests before committing changes.',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'always-test.md'), yaml);

    autoEvolve.syncInstincts(db, TEST_CL_DIR);

    const row = db.prepare('SELECT * FROM auto_evolves WHERE title = ?').get('always-test');
    assert.equal(row.observation_count, 5);
    assert.ok(row.confidence > 0.1);
  });

  it('syncInstincts skips blacklisted target_types', () => {
    const yaml = [
      '---',
      'name: auto-format-hook',
      'description: Format on save',
      'type: hook',
      'confidence: 0.5',
      'seen_count: 10',
      '---',
    ].join('\n');
    fs.writeFileSync(path.join(TEST_CL_DIR, 'auto-format-hook.md'), yaml);

    const countBefore = db.prepare('SELECT COUNT(*) as c FROM auto_evolves').get().c;
    autoEvolve.syncInstincts(db, TEST_CL_DIR, ['agent', 'hook']);
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM auto_evolves').get().c;

    assert.equal(countAfter, countBefore);
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
      blacklist: ['agent', 'hook'],
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
      blacklist: ['agent', 'hook'],
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
        ('test-agent-1', 'Code reviewer agent', 'Reviews code', 'agent', 0.95, 30, 0, 'active', datetime('now'))
    `).run();

    autoEvolve.runAutoEvolve(db, {
      min_confidence: 0.85,
      blacklist: ['agent', 'hook'],
      logDir: TEST_LOG_DIR,
    });

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get('test-agent-1');
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
