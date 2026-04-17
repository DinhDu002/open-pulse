'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const TEST_DIR = path.join(os.tmpdir(), `op-projects-test-${Date.now()}`);
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const TEST_PROJECTS_DIR = path.join(TEST_DIR, 'projects');

// cl_projects schema copied from src/db/schema.js (fidelity with production schema)
const CL_PROJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cl_projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT    NOT NULL UNIQUE,
  name            TEXT,
  directory       TEXT,
  first_seen_at   TEXT,
  last_seen_at    TEXT,
  session_count   INTEGER DEFAULT 0
);
`;

function writeInstalledPluginsJson(projectPath) {
  const pluginsDir = path.join(TEST_CLAUDE_DIR, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const content = {
    plugins: {
      'some-plugin': [
        { projectPath, scope: 'project' },
      ],
    },
  };
  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify(content, null, 2),
  );
}

describe('lib/projects', () => {
  let projectsLib;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });
    fs.mkdirSync(TEST_PROJECTS_DIR, { recursive: true });
    // Require AFTER setting env var so any module-level path resolution is correct.
    // Clear require cache in case other tests have loaded it.
    delete require.cache[require.resolve('../../src/lib/projects')];
    projectsLib = require('../../src/lib/projects');
  });

  after(() => {
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean between tests: wipe project dir + plugins registry
    fs.rmSync(TEST_PROJECTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_PROJECTS_DIR, { recursive: true });
    const pluginsJson = path.join(TEST_CLAUDE_DIR, 'plugins', 'installed_plugins.json');
    if (fs.existsSync(pluginsJson)) fs.unlinkSync(pluginsJson);
  });

  // -- getProjectSkills --

  describe('getProjectSkills', () => {
    it('finds skill with directory + SKILL.md convention', () => {
      const projPath = path.join(TEST_PROJECTS_DIR, 'myproj');
      const skillDir = path.join(projPath, '.claude', 'skills', 'foo');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# foo skill');
      writeInstalledPluginsJson(projPath);

      const skills = projectsLib.getProjectSkills(null);

      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'foo');
      assert.equal(skills[0].project, 'myproj');
      assert.equal(skills[0].filePath, path.join(skillDir, 'SKILL.md'));
    });

    it('finds skill with single .md file convention', () => {
      const projPath = path.join(TEST_PROJECTS_DIR, 'myproj');
      const skillsDir = path.join(projPath, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, 'api-contract.md');
      fs.writeFileSync(filePath, '# api contract');
      writeInstalledPluginsJson(projPath);

      const skills = projectsLib.getProjectSkills(null);

      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'api-contract');
      assert.equal(skills[0].project, 'myproj');
      assert.equal(skills[0].filePath, filePath);
    });

    it('skips directory without SKILL.md', () => {
      const projPath = path.join(TEST_PROJECTS_DIR, 'myproj');
      const ghostDir = path.join(projPath, '.claude', 'skills', 'ghostdir');
      fs.mkdirSync(ghostDir, { recursive: true });
      writeInstalledPluginsJson(projPath);

      const skills = projectsLib.getProjectSkills(null);

      assert.equal(skills.length, 0);
    });

    it('returns empty array when .claude/skills dir is missing', () => {
      const projPath = path.join(TEST_PROJECTS_DIR, 'myproj');
      fs.mkdirSync(projPath, { recursive: true });
      writeInstalledPluginsJson(projPath);

      const skills = projectsLib.getProjectSkills(null);

      assert.deepEqual(skills, []);
    });

    it('finds both directory and file skills in same project', () => {
      const projPath = path.join(TEST_PROJECTS_DIR, 'myproj');
      const skillsDir = path.join(projPath, '.claude', 'skills');
      fs.mkdirSync(path.join(skillsDir, 'foo'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'foo', 'SKILL.md'), '# foo');
      fs.writeFileSync(path.join(skillsDir, 'bar.md'), '# bar');
      writeInstalledPluginsJson(projPath);

      const skills = projectsLib.getProjectSkills(null);
      const names = skills.map((s) => s.name).sort();

      assert.deepEqual(names, ['bar', 'foo']);
    });
  });

  // -- getKnownProjectPaths --

  describe('getKnownProjectPaths', () => {
    it('merges paths from installed_plugins.json and cl_projects when db provided', () => {
      writeInstalledPluginsJson('/tmp/from-plugin');

      const db = new Database(':memory:');
      db.exec(CL_PROJECTS_SCHEMA);
      db.prepare(`
        INSERT INTO cl_projects (project_id, name, directory)
        VALUES (?, ?, ?)
      `).run('proj-1', 'from-db', '/tmp/from-db');

      const paths = projectsLib.getKnownProjectPaths(db);
      db.close();

      assert.equal(paths.length, 2);
      assert.ok(paths.includes('/tmp/from-plugin'));
      assert.ok(paths.includes('/tmp/from-db'));
    });

    it('returns only plugin paths when db is not provided', () => {
      writeInstalledPluginsJson('/tmp/from-plugin');

      const paths = projectsLib.getKnownProjectPaths();

      assert.deepEqual(paths, ['/tmp/from-plugin']);
    });

    it('deduplicates when same path in both sources', () => {
      writeInstalledPluginsJson('/tmp/shared');

      const db = new Database(':memory:');
      db.exec(CL_PROJECTS_SCHEMA);
      db.prepare(`
        INSERT INTO cl_projects (project_id, name, directory)
        VALUES (?, ?, ?)
      `).run('proj-1', 'shared', '/tmp/shared');

      const paths = projectsLib.getKnownProjectPaths(db);
      db.close();

      assert.equal(paths.length, 1);
      assert.equal(paths[0], '/tmp/shared');
    });

    it('ignores NULL directory rows in cl_projects', () => {
      writeInstalledPluginsJson('/tmp/from-plugin');

      const db = new Database(':memory:');
      db.exec(CL_PROJECTS_SCHEMA);
      db.prepare(`
        INSERT INTO cl_projects (project_id, name, directory)
        VALUES (?, ?, ?)
      `).run('proj-null', 'no-dir', null);

      const paths = projectsLib.getKnownProjectPaths(db);
      db.close();

      assert.deepEqual(paths, ['/tmp/from-plugin']);
    });

    it('tolerates missing cl_projects table gracefully', () => {
      writeInstalledPluginsJson('/tmp/from-plugin');

      const db = new Database(':memory:'); // No tables created
      const paths = projectsLib.getKnownProjectPaths(db);
      db.close();

      assert.deepEqual(paths, ['/tmp/from-plugin']);
    });
  });
});
