'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `op-enrich-test-${Date.now()}.db`);

describe('op-knowledge-enricher', () => {
  let db, dbMod, enrichMod;

  before(() => {
    dbMod = require('../src/op-db');
    enrichMod = require('../src/op-knowledge-enricher');
    db = dbMod.createDb(TEST_DB);

    dbMod.upsertKgNode(db, {
      id: 'tool:Read',
      type: 'tool',
      name: 'Read',
      properties: '{"invocations":100,"sessions_used":20}',
    });
    dbMod.upsertKgNode(db, {
      id: 'tool:Edit',
      type: 'tool',
      name: 'Edit',
      properties: '{"invocations":50,"sessions_used":15}',
    });
    dbMod.upsertKgEdge(db, {
      source_id: 'tool:Read',
      target_id: 'tool:Edit',
      relationship: 'triggers',
      weight: 25,
    });
  });

  after(() => {
    if (db) db.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('buildEnrichmentPrompt returns prompt string for a node', () => {
    const prompt = enrichMod.buildEnrichmentPrompt(db, 'tool:Read');
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.includes('Read'), 'should mention node name');
    assert.ok(prompt.includes('triggers'), 'should mention relationships');
  });

  it('applyEnrichment updates node properties with summary', () => {
    enrichMod.applyEnrichment(db, 'tool:Read', 'Read is used for reading files.');
    const node = dbMod.getKgNode(db, 'tool:Read');
    const props = JSON.parse(node.properties);
    assert.equal(props.summary, 'Read is used for reading files.');
    assert.ok(props.enriched_at);
  });

  it('getUnenrichedNodes returns nodes without summary', () => {
    const unenriched = enrichMod.getUnenrichedNodes(db);
    // tool:Edit has no summary yet
    assert.ok(unenriched.some(n => n.id === 'tool:Edit'));
    // tool:Read was enriched in previous test
    assert.ok(!unenriched.some(n => n.id === 'tool:Read'));
  });
});
