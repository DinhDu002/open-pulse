'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-vault-generator-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_PROJECT_DIR = path.join(TEST_DIR, 'my-project');

describe('op-vault-generator', () => {
  let db, dbMod, vg;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_PROJECT_DIR, { recursive: true });

    dbMod = require('../src/op-db');
    vg = require('../src/op-vault-generator');
    db = dbMod.createDb(TEST_DB);

    // Seed a project
    dbMod.upsertClProject(db, {
      project_id: 'proj-vault-test',
      name: 'Vault Test Project',
      directory: TEST_PROJECT_DIR,
      first_seen_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 3,
    });

    // Seed KG nodes
    dbMod.upsertKgNode(db, {
      id: 'tool:Read',
      type: 'tool',
      name: 'Read',
      properties: JSON.stringify({
        invocations: 42,
        sessions_used: 10,
        success_rate: 0.98,
        last_used: '2026-04-08T09:00:00Z',
      }),
    });

    dbMod.upsertKgNode(db, {
      id: 'tool:Edit',
      type: 'tool',
      name: 'Edit',
      properties: JSON.stringify({
        invocations: 20,
        sessions_used: 8,
        success_rate: 0.95,
        last_used: '2026-04-08T08:00:00Z',
      }),
    });

    dbMod.upsertKgNode(db, {
      id: 'component:agent:code-reviewer',
      type: 'component',
      name: 'code-reviewer',
      properties: JSON.stringify({
        component_type: 'agent',
        description: 'Reviews code for quality',
        invocations: 5,
        sessions_used: 3,
      }),
    });

    dbMod.upsertKgNode(db, {
      id: 'instinct:my-inst',
      type: 'instinct',
      name: 'prefer Read over cat',
      properties: JSON.stringify({
        project_id: 'proj-vault-test',
        category: 'workflow',
        confidence: 0.85,
        seen_count: 7,
        last_seen: '2026-04-07T00:00:00Z',
      }),
    });

    dbMod.upsertKgNode(db, {
      id: 'pattern:read-edit',
      type: 'pattern',
      name: 'Read → Edit',
      properties: JSON.stringify({
        source: 'tool:Read',
        target: 'tool:Edit',
        weight: 15,
      }),
    });

    // Session node (should be filtered out from vault)
    dbMod.upsertKgNode(db, {
      id: 'session:s1',
      type: 'session',
      name: 's1',
      properties: JSON.stringify({ started_at: '2026-04-08T10:00:00Z' }),
    });

    // Seed KG edges
    dbMod.upsertKgEdge(db, {
      source_id: 'tool:Read',
      target_id: 'tool:Edit',
      relationship: 'triggers',
      weight: 15,
    });
    dbMod.upsertKgEdge(db, {
      source_id: 'tool:Read',
      target_id: 'tool:Edit',
      relationship: 'co_occurs',
      weight: 8,
    });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // nodeIdToPath
  // ---------------------------------------------------------------------------

  it('nodeIdToPath maps id to correct file path', () => {
    assert.equal(vg.nodeIdToPath('tool:Read'), 'tools/Read.md');
    assert.equal(vg.nodeIdToPath('tool:Edit'), 'tools/Edit.md');
    assert.equal(vg.nodeIdToPath('component:agent:code-reviewer'), 'components/agent:code-reviewer.md');
    assert.equal(vg.nodeIdToPath('instinct:my-inst'), 'instincts/my-inst.md');
    assert.equal(vg.nodeIdToPath('pattern:read-edit'), 'patterns/read-edit.md');
    // Generic fallback for unknown types
    assert.equal(vg.nodeIdToPath('session:s1'), 'other/s1.md');
  });

  // ---------------------------------------------------------------------------
  // renderToolPage
  // ---------------------------------------------------------------------------

  it('renderToolPage generates valid markdown with backlinks', () => {
    const node = {
      id: 'tool:Read',
      type: 'tool',
      name: 'Read',
      properties: JSON.stringify({
        invocations: 42,
        sessions_used: 10,
        success_rate: 0.98,
        last_used: '2026-04-08T09:00:00Z',
      }),
    };

    const outgoingEdges = [
      { source_id: 'tool:Read', target_id: 'tool:Edit', relationship: 'triggers', weight: 15 },
      { source_id: 'tool:Read', target_id: 'tool:Grep', relationship: 'co_occurs', weight: 5 },
    ];

    const md = vg.renderToolPage(node, outgoingEdges);

    // Must have YAML frontmatter
    assert.ok(md.startsWith('---\n'), 'should start with frontmatter');
    assert.ok(md.includes('type: tool'), 'frontmatter should include type');
    assert.ok(md.includes('total_invocations: 42'), 'frontmatter should include invocations');
    assert.ok(md.includes('success_rate: 0.98'), 'frontmatter should include success rate');
    assert.ok(md.includes('generated_at:'), 'frontmatter should include generated_at');

    // Must have title
    assert.ok(md.includes('# Read'), 'should have h1 title');

    // Must have backlinks using Obsidian [[...]] syntax
    assert.ok(md.includes('[[tools/Edit]]'), 'should link to Edit with triggers relationship');
    assert.ok(md.includes('[[tools/Grep]]'), 'should link to Grep with co_occurs relationship');

    // Must have stats section
    assert.ok(md.includes('## Stats') || md.includes('## Relationships'), 'should have sections');
  });

  // ---------------------------------------------------------------------------
  // generateVault
  // ---------------------------------------------------------------------------

  it('generateVault creates index.md and tool files', () => {
    const result = vg.generateVault(db, 'proj-vault-test');

    const vaultDir = path.join(TEST_PROJECT_DIR, '.claude', 'knowledge');

    // Vault directory should exist
    assert.ok(fs.existsSync(vaultDir), 'vault dir should be created');

    // index.md must exist
    const indexPath = path.join(vaultDir, 'index.md');
    assert.ok(fs.existsSync(indexPath), 'index.md should exist');

    // index.md must contain auto-generated header comment
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    assert.ok(
      indexContent.includes('<!-- Auto-generated by Open Pulse'),
      'index.md should have auto-generated comment'
    );

    // index.md must have project title
    assert.ok(
      indexContent.includes('Vault Test Project'),
      'index.md should include project name'
    );

    // index.md must use [[backlinks]]
    assert.ok(indexContent.includes('[[tools/Read]]'), 'index.md should backlink to Read tool');

    // tools/Read.md must exist
    const readPath = path.join(vaultDir, 'tools', 'Read.md');
    assert.ok(fs.existsSync(readPath), 'tools/Read.md should exist');

    // Function should return stats
    assert.ok(typeof result.filesWritten === 'number', 'should return filesWritten count');
    assert.ok(typeof result.filesSkipped === 'number', 'should return filesSkipped count');
    assert.ok(result.filesWritten >= 2, 'should write at least index.md + Read.md');
  });

  it('generateVault skips unchanged files (SHA-256)', () => {
    // Clear any hashes left from prior test (tests run sequentially, share DB)
    db.prepare('DELETE FROM kg_vault_hashes WHERE project_id = ?').run('proj-vault-test');

    // First run — writes everything
    const result1 = vg.generateVault(db, 'proj-vault-test');
    assert.ok(result1.filesWritten >= 1, 'first run should write files');

    // Second run — content identical, should skip most files
    const result2 = vg.generateVault(db, 'proj-vault-test');
    assert.equal(result2.filesWritten, 0, 'second run should skip all unchanged files');
    assert.ok(result2.filesSkipped >= result1.filesWritten, 'second run should skip what was written');
  });

  it('generateAllVaults processes all projects', () => {
    // Add a second project (no directory — should be skipped gracefully)
    dbMod.upsertClProject(db, {
      project_id: 'proj-no-dir',
      name: 'No Dir Project',
      directory: null,
      first_seen_at: '2026-04-01T00:00:00Z',
      last_seen_at: '2026-04-08T00:00:00Z',
      session_count: 1,
    });

    const results = vg.generateAllVaults(db);

    // Should return an array of per-project results
    assert.ok(Array.isArray(results), 'should return an array');
    assert.ok(results.length >= 1, 'should process at least 1 project with a directory');

    // Each result should have projectId
    for (const r of results) {
      assert.ok(r.projectId, 'each result should have projectId');
      assert.ok(typeof r.filesWritten === 'number', 'each result should have filesWritten');
      assert.ok(typeof r.filesSkipped === 'number', 'each result should have filesSkipped');
    }

    // The no-dir project should not appear in results
    const noDirResult = results.find(r => r.projectId === 'proj-no-dir');
    assert.equal(noDirResult, undefined, 'project with null directory should be skipped');
  });
});
