'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-instinct-updater-test-${Date.now()}`);

describe('op-instinct-updater', () => {
  let mod;

  before(() => {
    mod = require('../src/op-instinct-updater');
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'inherited'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects', 'abc123', 'instincts', 'personal'), { recursive: true });
  });

  it('parseFrontmatter extracts meta and body', () => {
    const content = '---\nid: test-instinct\nconfidence: 0.7\ndomain: workflow\n---\n\n# Title\n\nBody text.';
    const { meta, body } = mod.parseFrontmatter(content);
    assert.equal(meta.id, 'test-instinct');
    assert.equal(meta.confidence, '0.7');
    assert.equal(meta.domain, 'workflow');
    assert.ok(body.includes('Body text.'));
  });

  it('parseFrontmatter returns empty meta for content without frontmatter', () => {
    const { meta, body } = mod.parseFrontmatter('Just plain text');
    assert.deepEqual(meta, {});
    assert.equal(body, 'Just plain text');
  });

  it('parseFrontmatter handles quoted values', () => {
    const content = '---\ntrigger: "when editing files"\nid: \'quoted-id\'\n---\n\nBody';
    const { meta } = mod.parseFrontmatter(content);
    assert.equal(meta.trigger, 'when editing files');
    assert.equal(meta.id, 'quoted-id');
  });

  it('serializeFrontmatter produces valid roundtrip', () => {
    const meta = { id: 'test', confidence: '0.7', domain: 'workflow' };
    const body = '# Title\n\nSome content.';
    const serialized = mod.serializeFrontmatter(meta, body);
    const { meta: parsed, body: parsedBody } = mod.parseFrontmatter(serialized);
    assert.equal(parsed.id, 'test');
    assert.equal(parsed.confidence, '0.7');
    assert.ok(parsedBody.includes('Some content.'));
  });

  it('findInstinctFile finds by frontmatter id', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'my-pattern.md');
    fs.writeFileSync(instinctPath, '---\nid: my-pattern\nconfidence: 0.6\n---\n\nBody');

    const found = mod.findInstinctFile(TEST_DIR, 'my-pattern');
    assert.equal(found, instinctPath);
  });

  it('findInstinctFile finds in project-scoped dirs', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'projects', 'abc123', 'instincts', 'personal', 'proj-pattern.md');
    fs.writeFileSync(instinctPath, '---\nid: proj-pattern\nconfidence: 0.8\n---\n\nBody');

    const found = mod.findInstinctFile(TEST_DIR, 'proj-pattern');
    assert.equal(found, instinctPath);
  });

  it('findInstinctFile falls back to filename match', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'no-id-field.md');
    fs.writeFileSync(instinctPath, '---\nconfidence: 0.5\n---\n\nNo id in frontmatter');

    const found = mod.findInstinctFile(TEST_DIR, 'no-id-field');
    assert.equal(found, instinctPath);
  });

  it('findInstinctFile returns null for non-existent instinct', () => {
    const found = mod.findInstinctFile(TEST_DIR, 'does-not-exist');
    assert.equal(found, null);
  });

  it('updateConfidence increases on approve (+0.15)', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'boost.md');
    fs.writeFileSync(instinctPath, '---\nid: boost\nconfidence: 0.6\n---\n\nBody');

    const result = mod.updateConfidence(instinctPath, +0.15);
    assert.equal(result.confidence, 0.75);

    // Verify file was written
    const { meta } = mod.parseFrontmatter(fs.readFileSync(instinctPath, 'utf8'));
    assert.equal(meta.confidence, '0.75');
    assert.equal(meta.user_validated, 'true');
  });

  it('updateConfidence decreases on dismiss (-0.2)', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'reduce.md');
    fs.writeFileSync(instinctPath, '---\nid: reduce\nconfidence: 0.7\n---\n\nBody');

    const result = mod.updateConfidence(instinctPath, -0.2);
    assert.equal(result.confidence, 0.5);
    assert.equal(result.dismiss_count, 1);

    const { meta } = mod.parseFrontmatter(fs.readFileSync(instinctPath, 'utf8'));
    assert.equal(meta.dismiss_count, '1');
  });

  it('updateConfidence clamps to [0.0, 0.95]', () => {
    const highPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'high.md');
    fs.writeFileSync(highPath, '---\nid: high\nconfidence: 0.9\n---\n\nBody');
    const r1 = mod.updateConfidence(highPath, +0.15);
    assert.equal(r1.confidence, 0.95);

    const lowPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'low.md');
    fs.writeFileSync(lowPath, '---\nid: low\nconfidence: 0.1\n---\n\nBody');
    const r2 = mod.updateConfidence(lowPath, -0.2);
    assert.equal(r2.confidence, 0.0);
  });

  it('updateConfidence tracks cumulative dismiss_count', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'multi.md');
    fs.writeFileSync(instinctPath, '---\nid: multi\nconfidence: 0.9\n---\n\nBody');

    mod.updateConfidence(instinctPath, -0.2);
    mod.updateConfidence(instinctPath, -0.2);
    const result = mod.updateConfidence(instinctPath, -0.2);
    assert.equal(result.dismiss_count, 3);
  });

  it('archiveInstinct moves file to archive dir', () => {
    const instinctPath = path.join(TEST_DIR, 'cl', 'instincts', 'personal', 'to-archive.md');
    fs.writeFileSync(instinctPath, '---\nid: to-archive\nconfidence: 0.1\n---\n\nBody');

    const archivePath = mod.archiveInstinct(instinctPath);
    assert.ok(!fs.existsSync(instinctPath), 'original should be deleted');
    assert.ok(fs.existsSync(archivePath), 'archive should exist');
    assert.ok(archivePath.includes('archive'), 'should be in archive dir');
    assert.ok(archivePath.includes('to-archive'), 'should contain original name');
  });
});
