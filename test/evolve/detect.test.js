'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../../src/db/schema');
const {
  validatePattern,
  buildPatternPrompt,
  upsertPattern,
} = require('../../src/evolve/detect');

// ---------------------------------------------------------------------------
// validatePattern
// ---------------------------------------------------------------------------

describe('validatePattern', () => {
  it('accepts a valid pattern', () => {
    const result = validatePattern({
      title: 'Always run tests after editing auth modules',
      description: 'User consistently runs test suite after modifying auth files.',
      target_type: 'rule',
    });
    assert.deepEqual(result, { valid: true });
  });

  it('rejects empty title', () => {
    const result = validatePattern({
      title: '',
      description: 'User consistently runs test suite after modifications.',
      target_type: 'rule',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('title'));
  });

  it('rejects title over 80 chars', () => {
    const result = validatePattern({
      title: 'a'.repeat(81),
      description: 'User consistently runs test suite after modifications.',
      target_type: 'rule',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('80'));
  });

  it('rejects invalid target_type', () => {
    const result = validatePattern({
      title: 'Valid title',
      description: 'User consistently runs test suite after modifications.',
      target_type: 'hook',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('target_type'));
  });

  it('rejects empty description', () => {
    const result = validatePattern({
      title: 'Valid title',
      description: '',
      target_type: 'skill',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('description'));
  });

  it('accepts all valid target_types', () => {
    for (const type of ['rule', 'skill', 'agent', 'workflow']) {
      const result = validatePattern({
        title: `Pattern for ${type}`,
        description: 'A valid description.',
        target_type: type,
      });
      assert.deepEqual(result, { valid: true }, `expected valid for target_type=${type}`);
    }
  });

  it('rejects null input', () => {
    assert.equal(validatePattern(null).valid, false);
  });

  it('rejects description shorter than 20 chars', () => {
    const result = validatePattern({
      title: 'Valid title',
      description: 'Too short.',
      target_type: 'rule',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('description'));
  });

  it('rejects invalid scope', () => {
    const result = validatePattern({
      title: 'Valid title',
      description: 'A sufficiently long description for the test.',
      target_type: 'rule',
      scope: 'invalid',
    });
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('scope'));
  });

  it('accepts valid scope values', () => {
    for (const scope of ['project', 'global']) {
      const result = validatePattern({
        title: 'Valid title',
        description: 'A sufficiently long description for the test.',
        target_type: 'rule',
        scope,
      });
      assert.deepEqual(result, { valid: true });
    }
  });

  it('accepts entry without scope (optional)', () => {
    const result = validatePattern({
      title: 'Valid title',
      description: 'A sufficiently long description for the test.',
      target_type: 'rule',
    });
    assert.deepEqual(result, { valid: true });
  });
});

// ---------------------------------------------------------------------------
// buildPatternPrompt
// ---------------------------------------------------------------------------

describe('buildPatternPrompt', () => {
  const sampleEvents = [
    { event_type: 'tool_call', name: 'Read', tool_input: '{"file_path":"/src/auth.js"}', tool_response: 'file content' },
    { event_type: 'tool_call', name: 'Edit', tool_input: '{"file_path":"/src/auth.js"}', tool_response: 'edited' },
    { event_type: 'tool_call', name: 'Bash', tool_input: '{"command":"npm test"}', tool_response: 'all pass' },
  ];

  it('includes the project name', () => {
    const prompt = buildPatternPrompt('my-project', sampleEvents);
    assert.ok(prompt.includes('my-project'), 'prompt should include project name');
  });

  it('includes compact skill content (target_type and Return a JSON array only)', () => {
    const prompt = buildPatternPrompt('my-project', sampleEvents);
    assert.ok(prompt.includes('target_type'), 'prompt should include target_type from skill schema');
    assert.ok(prompt.includes('Return a JSON array only'), 'prompt should include compact instructions footer');
  });

  it('includes formatted events', () => {
    const prompt = buildPatternPrompt('my-project', sampleEvents);
    assert.ok(prompt.includes('Read'), 'prompt should include event tool name Read');
    assert.ok(prompt.includes('npm test'), 'prompt should include event command');
  });
});

// ---------------------------------------------------------------------------
// upsertPattern (integration with in-memory DB)
// ---------------------------------------------------------------------------

describe('upsertPattern', () => {
  it('inserts new pattern with status=draft, confidence=0.3, observation_count=1', () => {
    const db = createDb(':memory:');

    const entry = {
      title: 'Always lint before commit',
      description: 'User consistently runs lint before committing.',
      target_type: 'rule',
      projects: ['open-pulse'],
    };

    const result = upsertPattern(db, entry);
    assert.equal(result.action, 'inserted');

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(result.id);
    assert.ok(row, 'row should exist in DB');
    assert.equal(row.status, 'draft');
    assert.equal(row.confidence, 0.3);
    assert.equal(row.observation_count, 1);
    assert.equal(row.title, 'Always lint before commit');
    assert.equal(row.target_type, 'rule');

    db.close();
  });

  it('bumps confidence and observation_count on duplicate (same title+type)', () => {
    const db = createDb(':memory:');

    const entry = {
      title: 'Use immutable updates',
      description: 'User always creates new objects instead of mutating.',
      target_type: 'rule',
    };

    // First insert
    const first = upsertPattern(db, entry);
    assert.equal(first.action, 'inserted');

    // Second upsert — same title + target_type → UPDATE path
    const second = upsertPattern(db, entry);
    assert.equal(second.action, 'updated');
    assert.equal(second.id, first.id, 'id should be stable (deterministic hash)');

    const row = db.prepare('SELECT * FROM auto_evolves WHERE id = ?').get(first.id);
    assert.equal(row.observation_count, 2);
    assert.equal(row.confidence, 0.45); // 0.3 + 0.15

    db.close();
  });
});
