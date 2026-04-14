'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
