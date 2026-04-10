'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const helpers = { ...require('../src/lib/format'), ...require('../src/lib/frontmatter') };

describe('op-helpers', () => {
  describe('periodToDate', () => {
    it('returns null for "all"', () => {
      assert.equal(helpers.periodToDate('all'), null);
    });
    it('returns null for empty', () => {
      assert.equal(helpers.periodToDate(''), null);
    });
    it('returns null for null', () => {
      assert.equal(helpers.periodToDate(null), null);
    });
    it('returns ISO date for "7d"', () => {
      const result = helpers.periodToDate('7d');
      assert.ok(result);
      const d = new Date(result);
      assert.ok(!isNaN(d.getTime()));
    });
    it('returns null for invalid format "7w"', () => {
      assert.equal(helpers.periodToDate('7w'), null);
    });
  });

  describe('parseFrontmatter', () => {
    it('parses key-value pairs', () => {
      const result = helpers.parseFrontmatter('---\nname: test\ndescription: hello\n---\nbody');
      assert.equal(result.name, 'test');
      assert.equal(result.description, 'hello');
    });
    it('returns empty object for no frontmatter', () => {
      assert.deepEqual(helpers.parseFrontmatter('just text'), {});
    });
    it('strips quotes from values', () => {
      const result = helpers.parseFrontmatter('---\nname: "quoted"\n---');
      assert.equal(result.name, 'quoted');
    });
  });

  describe('parseQualifiedName', () => {
    it('splits plugin:name', () => {
      const r = helpers.parseQualifiedName('superpowers:tdd');
      assert.equal(r.plugin, 'superpowers');
      assert.equal(r.shortName, 'tdd');
    });
    it('returns null plugin for plain name', () => {
      const r = helpers.parseQualifiedName('tdd');
      assert.equal(r.plugin, null);
      assert.equal(r.shortName, 'tdd');
    });
  });

  describe('extractKeywordsFromPrompts', () => {
    it('extracts keywords from prompts', () => {
      const keywords = helpers.extractKeywordsFromPrompts([
        { user_prompt: 'fix the database migration error' },
        { user_prompt: 'database connection timeout error' },
      ]);
      assert.ok(keywords.includes('database'));
      assert.ok(keywords.includes('error'));
    });
    it('returns empty for no prompts', () => {
      assert.deepEqual(helpers.extractKeywordsFromPrompts([]), []);
    });
    it('filters stop words', () => {
      const keywords = helpers.extractKeywordsFromPrompts([
        { user_prompt: 'the quick brown fox' },
      ]);
      assert.ok(!keywords.includes('the'));
    });
  });

  describe('parsePagination', () => {
    it('returns defaults for empty query', () => {
      const r = helpers.parsePagination({});
      assert.equal(r.page, 1);
      assert.equal(r.perPage, 10);
    });
    it('clamps page to minimum 1', () => {
      assert.equal(helpers.parsePagination({ page: '-5' }).page, 1);
    });
    it('clamps per_page to maximum 50', () => {
      assert.equal(helpers.parsePagination({ per_page: '999' }).perPage, 50);
    });
    it('uses custom defaults', () => {
      const r = helpers.parsePagination({}, { perPage: 25 });
      assert.equal(r.perPage, 25);
    });
  });

  describe('errorReply', () => {
    it('sends error response with correct status', () => {
      let sentCode = null;
      let sentBody = null;
      const mockReply = {
        code(c) { sentCode = c; return this; },
        send(b) { sentBody = b; return this; },
      };
      helpers.errorReply(mockReply, 404, 'Not found');
      assert.equal(sentCode, 404);
      assert.deepEqual(sentBody, { error: 'Not found' });
    });
  });
});
