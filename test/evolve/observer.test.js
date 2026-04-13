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

  // -- normalizeInstinctFile --

  it('normalizeInstinctFile computes canonical id matching sync.js:makeId', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-1.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: random-id-from-haiku',
      'name: always-test',
      'type: rule',
      'confidence: 0.8',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const content = fs.readFileSync(tmpFile, 'utf8');
    const meta = require('../../src/lib/frontmatter').parseFrontmatter(content);
    const expected = 'ae-' + crypto.createHash('sha256').update('always-test::rule').digest('hex').substring(0, 16);
    assert.equal(meta.id, expected);
  });

  it('normalizeInstinctFile clamps confidence when wasNew=true', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-2.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: clamp-me',
      'type: rule',
      'confidence: 0.85',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, true, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.75');
  });

  it('normalizeInstinctFile does not clamp confidence when wasNew=false', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-3.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: existing',
      'type: rule',
      'confidence: 0.85',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.85');
  });

  it('normalizeInstinctFile rounds confidence to 2 decimals', () => {
    const tmpFile = path.join(TEST_DIR, 'norm-4.md');
    fs.writeFileSync(tmpFile, [
      '---',
      'id: x',
      'name: round-me',
      'type: rule',
      'confidence: 0.123456',
      '---',
      '',
      'Body',
    ].join('\n'));

    observer.normalizeInstinctFile(tmpFile, false, 0.75);

    const meta = require('../../src/lib/frontmatter').parseFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(meta.confidence, '0.12');
  });

  // -- snapshotInstinctFiles --

  it('snapshotInstinctFiles returns a Set of all .md files under instincts subdirs', () => {
    const repoDir = path.join(TEST_DIR, 'repo-snap');
    const inheritedDir = path.join(repoDir, 'cl/instincts/inherited');
    const personalDir = path.join(repoDir, 'cl/instincts/personal');
    fs.mkdirSync(inheritedDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });
    fs.writeFileSync(path.join(inheritedDir, 'a.md'), '---\nname: a\ntype: rule\n---\n');
    fs.writeFileSync(path.join(personalDir, 'b.md'), '---\nname: b\ntype: rule\n---\n');
    fs.writeFileSync(path.join(personalDir, 'ignored.txt'), 'not markdown');

    const result = observer.snapshotInstinctFiles(path.join(repoDir, 'cl/instincts'));
    assert.equal(result.size, 2);
    assert.ok(result.has(path.join(inheritedDir, 'a.md')));
    assert.ok(result.has(path.join(personalDir, 'b.md')));
    assert.ok(!result.has(path.join(personalDir, 'ignored.txt')));
  });

  // -- renderObserverPrompt --

  it('renderObserverPrompt substitutes all double-brace placeholders', () => {
    const tmpTemplate = path.join(TEST_DIR, 'tmpl.md');
    fs.writeFileSync(tmpTemplate, 'Read {{analysis_path}} for project {{project_name}} ({{project_id}}) and write to {{instincts_dir}}.');

    const out = observer.renderObserverPrompt(tmpTemplate, {
      analysis_path: '/tmp/events.jsonl',
      instincts_dir: '/repo/cl/instincts/personal',
      project_id: 'p1',
      project_name: 'my-proj',
    });

    assert.ok(out.includes('/tmp/events.jsonl'));
    assert.ok(out.includes('my-proj'));
    assert.ok(out.includes('p1'));
    assert.ok(out.includes('/repo/cl/instincts/personal'));
    assert.ok(!out.includes('{{'), 'all placeholders replaced');
  });

  // -- processProject (with fake CLI runner) --

  it('processProject skips when fewer than 3 events since cursor', () => {
    const repoDir = path.join(TEST_DIR, 'repo-skip');
    fs.mkdirSync(path.join(repoDir, 'cl/instincts/personal'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'cl/instincts/inherited'), { recursive: true });

    let cliCalled = false;
    const fakeRunner = () => { cliCalled = true; return { stdout: '', usage: {} }; };

    const result = observer.processProject(db, {
      project: { project_id: 'p-skip', name: 'skip', directory: '/tmp/processproject-no-events' },
      repoDir,
      config: {
        observer_model: 'fake',
        observer_max_events_per_project: 100,
        observer_confidence_cap_on_first_detect: 0.75,
      },
      runClaude: fakeRunner,
    });

    assert.equal(cliCalled, false, 'CLI must not run when events below threshold');
    assert.equal(result.status, 'skipped');
  });

  it('processProject invokes CLI and normalizes new files', () => {
    const repoDir = path.join(TEST_DIR, 'repo-run');
    const instinctsDir = path.join(repoDir, 'cl/instincts/personal');
    fs.mkdirSync(instinctsDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'cl/instincts/inherited'), { recursive: true });

    const projRoot = '/tmp/processproject-with-events';
    // Seed 5 events for this project (all recent)
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO events (timestamp, event_type, name, working_directory, tool_input)
        VALUES (datetime('now'), 'tool_call', 'Edit', ?, '{}')`).run(projRoot);
    }

    // Fake runner: simulates Haiku writing an instinct YAML file
    const fakeRunner = () => {
      fs.writeFileSync(path.join(instinctsDir, 'new-pattern.md'), [
        '---',
        'name: new-pattern',
        'type: rule',
        'confidence: 0.85',
        '---',
        '',
        'Body text',
      ].join('\n'));
      return {
        stdout: '{"result":"done","usage":{"input_tokens":100,"output_tokens":50}}',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    };

    const result = observer.processProject(db, {
      project: { project_id: 'p-run', name: 'proj-run', directory: projRoot },
      repoDir,
      config: {
        observer_model: 'fake',
        observer_max_events_per_project: 100,
        observer_confidence_cap_on_first_detect: 0.75,
      },
      runClaude: fakeRunner,
    });

    assert.equal(result.status, 'success');
    assert.equal(result.input_tokens, 100);
    assert.equal(result.output_tokens, 50);
    assert.equal(result.events, 5);

    // Verify the new file was normalized (confidence clamped, id rewritten)
    const written = fs.readFileSync(path.join(instinctsDir, 'new-pattern.md'), 'utf8');
    assert.ok(written.includes('confidence: 0.75'), 'new file confidence clamped to 0.75');
    assert.ok(written.match(/id: ae-[a-f0-9]{16}/), 'canonical id set');
  });
});
