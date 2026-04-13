'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const TEST_DIR = path.join(os.tmpdir(), `op-observer-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('op-observer', () => {
  let db, observer;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = require('../../src/db/schema').createDb(TEST_DB);
    observer = require('../../src/evolve/observer');
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- queryActiveProjects --

  it('queryActiveProjects returns projects with recent events ordered by event count DESC', () => {
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p1', 'proj-one', '/tmp/observer-test-proj-one');
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p2', 'proj-two', '/tmp/observer-test-proj-two');
    db.prepare(`INSERT INTO cl_projects (project_id, name, directory) VALUES (?, ?, ?)`).run('p3', 'proj-idle', '/tmp/observer-test-proj-idle');

    // p1: 5 recent events, p2: 3 recent events, p3: 0 events
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (datetime('now'), 'tool_call', 'Read', '/tmp/observer-test-proj-one')`).run();
    }
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (datetime('now'), 'tool_call', 'Edit', '/tmp/observer-test-proj-two')`).run();
    }

    const result = observer.queryActiveProjects(db, 24, 10);
    assert.equal(result.length, 2, 'idle project with 0 events must be filtered out');
    assert.equal(result[0].project_id, 'p1', 'busiest project first');
    assert.equal(result[1].project_id, 'p2');
  });

  it('queryActiveProjects respects maxProjects limit', () => {
    const result = observer.queryActiveProjects(db, 24, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].project_id, 'p1');
  });

  it('queryActiveProjects filters projects below min event threshold of 3', () => {
    // p3 had 0; give it 2 events (still below 3)
    db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (datetime('now'), 'tool_call', 'Read', '/tmp/observer-test-proj-idle')`).run();
    db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory) VALUES (datetime('now'), 'tool_call', 'Read', '/tmp/observer-test-proj-idle')`).run();

    const result = observer.queryActiveProjects(db, 24, 10);
    assert.ok(!result.some(r => r.project_id === 'p3'), 'projects with <3 events must not appear');
  });

  // -- serializeFrontmatter --

  it('serializeFrontmatter produces a valid frontmatter block', () => {
    const out = observer.serializeFrontmatter({
      id: 'ae-123',
      name: 'test-pattern',
      type: 'rule',
      confidence: '0.75',
    });
    assert.ok(out.startsWith('---\n'));
    assert.ok(out.endsWith('\n---\n'));
    assert.ok(out.includes('id: ae-123'));
    assert.ok(out.includes('confidence: 0.75'));
  });

  it('serializeFrontmatter round-trips with parseFrontmatter', () => {
    const { parseFrontmatter } = require('../../src/lib/frontmatter');
    const original = { id: 'ae-abc', name: 'x', type: 'skill', confidence: '0.5' };
    const serialized = observer.serializeFrontmatter(original);
    // Append body so parseFrontmatter regex works (it requires closing --- followed by content)
    const parsed = parseFrontmatter(serialized + '\nbody');
    assert.deepEqual(parsed, original);
  });
});
