'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-ingest-sync-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const PROJECT_DIR = path.join(TEST_DIR, 'myproj');
const SKILL_DIR = path.join(PROJECT_DIR, '.claude', 'skills', 'foo');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

describe('ingest/sync — project skills + stable ETag', () => {
  let db, syncComponentsWithDb;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    fs.mkdirSync(SKILL_DIR, { recursive: true });

    db = require('../../src/db/schema').createDb(TEST_DB);
    ({ syncComponentsWithDb } = require('../../src/ingest/sync'));
    const { upsertClProject } = require('../../src/db/projects');

    // Register the fake project so getKnownProjectPaths(db) picks it up.
    upsertClProject(db, {
      project_id: 'myproj-id',
      name: 'myproj',
      directory: PROJECT_DIR,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      session_count: 0,
    });

    // Seed the initial skill file with a known description.
    fs.writeFileSync(
      SKILL_FILE,
      '---\ndescription: test skill\n---\n\n# Foo\n\nBody content.\n',
      'utf8'
    );
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A) syncs project-scoped skills from <project>/.claude/skills/', () => {
    syncComponentsWithDb(db);
    const row = db.prepare(`
      SELECT type, name, source, plugin, project, description
      FROM components
      WHERE type = 'skill' AND source = 'project' AND name = 'foo'
    `).get();

    assert.ok(row, 'project skill `foo` should exist in components');
    assert.equal(row.type, 'skill');
    assert.equal(row.source, 'project');
    assert.equal(row.plugin, null);
    assert.equal(row.project, 'myproj');
    assert.equal(row.description, 'test skill');
  });

  it('B) ETag is stable across syncs when disk unchanged', async () => {
    const etag1 = syncComponentsWithDb(db);
    await new Promise(resolve => setTimeout(resolve, 60));
    const etag2 = syncComponentsWithDb(db);
    assert.equal(etag1, etag2, 'ETag must not change when disk content is unchanged');
  });

  it('C) ETag changes when skill description changes', () => {
    const etag1 = syncComponentsWithDb(db);
    fs.writeFileSync(
      SKILL_FILE,
      '---\ndescription: updated skill description\n---\n\n# Foo\n\nBody.\n',
      'utf8'
    );
    const etag2 = syncComponentsWithDb(db);
    assert.notEqual(etag1, etag2, 'ETag must change when description changes');
  });

  it('D) ETag changes when a new component is added', () => {
    const etag1 = syncComponentsWithDb(db);

    // Add a new project skill.
    const newSkillDir = path.join(PROJECT_DIR, '.claude', 'skills', 'bar');
    fs.mkdirSync(newSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(newSkillDir, 'SKILL.md'),
      '---\ndescription: bar skill\n---\n\n# Bar\n',
      'utf8'
    );

    const etag2 = syncComponentsWithDb(db);
    assert.notEqual(etag1, etag2, 'ETag must change when a new component is added');
  });
});
