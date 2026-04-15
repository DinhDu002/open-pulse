'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'claude', 'skills', 'synthesize', 'SKILL.md');

describe('synthesize skill file', () => {
  it('exists at expected path', () => {
    assert.ok(fs.existsSync(SKILL_PATH), `Missing: ${SKILL_PATH}`);
  });

  it('has valid frontmatter with name and description', () => {
    const { parseFrontmatter } = require('../src/lib/frontmatter');
    const raw = fs.readFileSync(SKILL_PATH, 'utf8');
    const fm = parseFrontmatter(raw);
    assert.equal(fm.name, 'synthesize');
    assert.ok(fm.description, 'description should be non-empty');
  });

  it('references all required API endpoints', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const endpoints = [
      'GET /api/synthesize/data',
      'PUT /api/knowledge/entries/',
      'PUT /api/auto-evolves/',
      'DELETE /api/auto-evolves/',
      'POST /api/auto-evolves/',
      'POST /api/knowledge/vault/render',
    ];
    for (const ep of endpoints) {
      // Check for endpoint pattern in content (may be in curl examples or text)
      const urlPart = ep.replace(/^(GET|PUT|POST|DELETE) /, '');
      assert.ok(
        content.includes(urlPart) || content.includes(ep),
        `Missing endpoint reference: ${ep}`
      );
    }
  });

  it('documents both consolidation phases', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(content.includes('Knowledge Consolidation'), 'Missing Phase 1');
    assert.ok(content.includes('Pattern Consolidation'), 'Missing Phase 2');
  });

  it('documents --all flag for cross-project mode', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(content.includes('--all'), 'Missing --all flag');
    assert.ok(content.includes('Cross-Project'), 'Missing cross-project section');
  });

  it('documents quality criteria', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(content.includes('Quality Criteria'), 'Missing quality criteria section');
  });

  it('documents all target types', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    for (const type of ['rule', 'skill', 'agent', 'workflow']) {
      assert.ok(content.toLowerCase().includes(type), `Missing target type: ${type}`);
    }
  });
});
