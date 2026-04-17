'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  tokenize,
  jaccard,
  pickKeeper,
  planSynthesize,
  applySynthesize,
  runSynthesize,
  runSynthesizeAll,
} = require('../../src/knowledge/synthesize');

// ---------------------------------------------------------------------------
// tokenize — pure
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('returns empty set for null/empty input', () => {
    assert.equal(tokenize(null).size, 0);
    assert.equal(tokenize('').size, 0);
  });

  it('lowercases and strips punctuation', () => {
    const set = tokenize('Hello, World! Foo-bar.');
    assert.ok(set.has('hello'));
    assert.ok(set.has('world'));
    assert.ok(set.has('foo'));
    assert.ok(set.has('bar'));
  });

  it('drops stopwords', () => {
    const set = tokenize('the quick brown fox is not a dog');
    assert.ok(!set.has('the'));
    assert.ok(!set.has('is'));
    assert.ok(!set.has('not'));
    assert.ok(set.has('quick'));
    assert.ok(set.has('brown'));
    assert.ok(set.has('fox'));
    assert.ok(set.has('dog'));
  });

  it('drops words shorter than 3 chars', () => {
    const set = tokenize('go to store');
    assert.ok(!set.has('go'));
    assert.ok(!set.has('to'));
    assert.ok(set.has('store'));
  });

  it('de-duplicates tokens', () => {
    const set = tokenize('foo foo foo bar bar');
    assert.equal(set.size, 2);
  });
});

// ---------------------------------------------------------------------------
// jaccard — pure
// ---------------------------------------------------------------------------

describe('jaccard', () => {
  it('returns 0 for two empty sets', () => {
    assert.equal(jaccard(new Set(), new Set()), 0);
  });

  it('returns 0 when one set is empty', () => {
    assert.equal(jaccard(new Set(['a']), new Set()), 0);
  });

  it('returns 1 for identical sets', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  });

  it('computes partial overlap correctly', () => {
    // intersection {a,b}, union {a,b,c} → 2/3
    const sim = jaccard(new Set(['a', 'b']), new Set(['a', 'b', 'c']));
    assert.ok(Math.abs(sim - 2 / 3) < 1e-9);
  });

  it('returns 0 for disjoint sets', () => {
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
});

// ---------------------------------------------------------------------------
// pickKeeper — pure
// ---------------------------------------------------------------------------

describe('pickKeeper', () => {
  it('keeps the entry with the longer body', () => {
    const a = { id: 'a', body: 'short', updated_at: '2026-01-01' };
    const b = { id: 'b', body: 'much longer body text here', updated_at: '2026-01-01' };
    const r = pickKeeper(a, b);
    assert.equal(r.keep.id, 'b');
    assert.equal(r.drop.id, 'a');
  });

  it('on body tie, keeps the newer updated_at', () => {
    const a = { id: 'a', body: 'same', updated_at: '2026-01-02' };
    const b = { id: 'b', body: 'same', updated_at: '2026-01-01' };
    const r = pickKeeper(a, b);
    assert.equal(r.keep.id, 'a');
    assert.equal(r.drop.id, 'b');
  });
});

// ---------------------------------------------------------------------------
// planSynthesize — pure function, no DB
// ---------------------------------------------------------------------------

describe('planSynthesize', () => {
  it('returns [] for 0 or 1 entries', () => {
    assert.deepEqual(planSynthesize([]), []);
    assert.deepEqual(planSynthesize([{ id: '1', title: 't', body: 'b' }]), []);
  });

  it('returns [] when entries are unique', () => {
    const entries = [
      { id: 'a', title: 'Auth middleware stores session tokens unsafely', body: 'body a', source_file: null, category: 'footgun', updated_at: '2026-01-01' },
      { id: 'b', title: 'Database timer uses WAL mode for concurrency', body: 'body b', source_file: null, category: 'decision', updated_at: '2026-01-02' },
    ];
    assert.deepEqual(planSynthesize(entries), []);
  });

  it('merges titles with Jaccard >= 0.75', () => {
    const entries = [
      { id: 'a', title: 'Session extract needs review context', body: 'short', source_file: null, category: 'feature', updated_at: '2026-01-01' },
      { id: 'b', title: 'Session extract needs review context always', body: 'much longer body text describing the feature in detail', source_file: null, category: 'feature', updated_at: '2026-01-02' },
    ];
    const outcomes = planSynthesize(entries);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].keepId, 'b');
    assert.equal(outcomes[0].dropId, 'a');
    assert.equal(outcomes[0].reason, 'title_jaccard');
    assert.ok(outcomes[0].similarity >= 0.75);
  });

  it('does NOT merge titles below threshold', () => {
    const entries = [
      { id: 'a', title: 'Auth token footgun', body: 'x', source_file: null, category: 'footgun', updated_at: '2026-01-01' },
      { id: 'b', title: 'Database migration convention', body: 'y', source_file: null, category: 'convention', updated_at: '2026-01-01' },
    ];
    assert.deepEqual(planSynthesize(entries), []);
  });

  it('merges body-similar entries sharing (source_file, category)', () => {
    const entries = [
      { id: 'a', title: 'First wording of the retry issue',
        body: 'renaming processing files during ingest triggers retry logic retention cleanup background timer safety guards important',
        source_file: 'src/ingest/pipeline.js', category: 'footgun', updated_at: '2026-01-01' },
      { id: 'b', title: 'Second phrasing describes retry flow',
        body: 'renaming processing files during ingest triggers retry logic retention cleanup background timer safety guards important plus extra detail words',
        source_file: 'src/ingest/pipeline.js', category: 'footgun', updated_at: '2026-01-02' },
    ];
    const outcomes = planSynthesize(entries);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].reason, 'source_body_jaccard');
    assert.equal(outcomes[0].keepId, 'b');
  });

  it('does NOT merge body-similar entries with different source_file', () => {
    const entries = [
      { id: 'a', title: 'X', body: 'renaming processing files triggers retry logic cleanup background timer',
        source_file: 'src/ingest/pipeline.js', category: 'footgun', updated_at: '2026-01-01' },
      { id: 'b', title: 'Y', body: 'renaming processing files triggers retry logic cleanup background timer',
        source_file: 'src/other/module.js', category: 'footgun', updated_at: '2026-01-02' },
    ];
    assert.deepEqual(planSynthesize(entries), []);
  });

  it('does NOT merge entries with no source_file in pass 2', () => {
    const entries = [
      { id: 'a', title: 'Title one', body: 'shared body content with enough tokens for jaccard threshold testing here',
        source_file: null, category: 'footgun', updated_at: '2026-01-01' },
      { id: 'b', title: 'Title two', body: 'shared body content with enough tokens for jaccard threshold testing here other',
        source_file: null, category: 'footgun', updated_at: '2026-01-02' },
    ];
    // Titles are different enough (Jaccard < 0.75 for 'Title one' vs 'Title two')
    // Body is similar but no source_file → pass 2 skips.
    const outcomes = planSynthesize(entries);
    assert.equal(outcomes.length, 0);
  });

  it('uses configurable thresholds', () => {
    const entries = [
      { id: 'a', title: 'completely different title one', body: 'a b c', source_file: null, category: 'x', updated_at: '1' },
      { id: 'b', title: 'completely different title two', body: 'a b c d', source_file: null, category: 'x', updated_at: '2' },
    ];
    // Default threshold 0.75 → title Jaccard = 3/5 = 0.6 → no merge.
    assert.equal(planSynthesize(entries, { titleThreshold: 0.5 }).length, 1);
    assert.equal(planSynthesize(entries, { titleThreshold: 0.8 }).length, 0);
  });

  it('never drops the same entry twice across passes', () => {
    // a and b are title-similar (pass 1 merges). b and c share source_file + body
    // similarity — pass 2 should skip b because it's already marked outdated.
    const entries = [
      { id: 'a', title: 'shared title token sequence', body: 'short',
        source_file: 'src/x.js', category: 'footgun', updated_at: '1' },
      { id: 'b', title: 'shared title token sequence match', body: 'medium body text here enough for similarity threshold detection across this pair',
        source_file: 'src/x.js', category: 'footgun', updated_at: '2' },
      { id: 'c', title: 'completely different wording',
        body: 'medium body text here enough for similarity threshold detection across this pair more words',
        source_file: 'src/x.js', category: 'footgun', updated_at: '3' },
    ];
    const outcomes = planSynthesize(entries);
    // The core invariant: the `outdated` guard prevents re-processing; each id
    // can appear as `dropId` at most once (even if it showed up as `keepId`
    // earlier — chain merging is allowed).
    const dropIds = outcomes.map(o => o.dropId);
    assert.equal(new Set(dropIds).size, dropIds.length, 'no id should be dropped twice');
  });
});

// ---------------------------------------------------------------------------
// runSynthesize / applySynthesize / runSynthesizeAll — integration
// ---------------------------------------------------------------------------

describe('runSynthesize', () => {
  let db;
  let TEST_DIR;
  let TEST_DB;
  const PROJECT_ID = 'proj-synth-test';

  before(() => {
    TEST_DIR = path.join(os.tmpdir(), `op-synth-${Date.now()}`);
    TEST_DB = path.join(TEST_DIR, 'test.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    db = createDb(TEST_DB);

    upsertClProject(db, {
      project_id: PROJECT_ID,
      name: 'Synth Test',
      directory: TEST_DIR,
      first_seen_at: '2026-04-15T10:00:00Z',
      last_seen_at: '2026-04-15T10:00:00Z',
      session_count: 1,
    });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(PROJECT_ID);
    db.prepare('DELETE FROM knowledge_entry_history').run();
    db.prepare("DELETE FROM pipeline_runs WHERE pipeline = 'auto_synthesize'").run();
  });

  function seed(entry) {
    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');
    return insertKnowledgeEntry(db, { project_id: PROJECT_ID, ...entry });
  }

  it('returns {merged:0} for project with <2 active entries', () => {
    const r = runSynthesize(db, PROJECT_ID);
    assert.equal(r.merged, 0);
    assert.equal(r.entries, 0);

    seed({ category: 'domain', title: 'Solo entry', body: 'only one exists' });
    const r2 = runSynthesize(db, PROJECT_ID);
    assert.equal(r2.merged, 0);
    assert.equal(r2.entries, 1);
  });

  it('marks the shorter-body entry as outdated and records auto_merged history', () => {
    const a = seed({
      category: 'footgun', title: 'JSONL ingestion leaves processing files on crash',
      body: 'short body',
    });
    const b = seed({
      category: 'footgun', title: 'JSONL ingestion leaves processing files on crash always',
      body: 'much longer body describing the whole retry mechanism and file lifecycle in detail',
    });

    const r = runSynthesize(db, PROJECT_ID);
    assert.equal(r.merged, 1);
    assert.equal(r.outcomes[0].dropId, a.id);
    assert.equal(r.outcomes[0].keepId, b.id);

    const aAfter = db.prepare('SELECT status FROM knowledge_entries WHERE id = ?').get(a.id);
    const bAfter = db.prepare('SELECT status FROM knowledge_entries WHERE id = ?').get(b.id);
    assert.equal(aAfter.status, 'outdated');
    assert.equal(bAfter.status, 'active');

    const history = db.prepare(
      "SELECT * FROM knowledge_entry_history WHERE entry_id = ? AND change_type = 'auto_merged'"
    ).all(a.id);
    assert.equal(history.length, 1);
    const snapshot = JSON.parse(history[0].snapshot);
    assert.equal(snapshot.merged_into, b.id);
    assert.equal(snapshot.reason, 'title_jaccard');
    assert.ok(snapshot.similarity >= 0.75);
  });

  it('leaves genuinely distinct entries untouched', () => {
    const a = seed({ category: 'footgun', title: 'Auth tokens leak in logs',        body: 'unique body a' });
    const b = seed({ category: 'decision', title: 'Picked SQLite over Postgres',    body: 'unique body b' });
    const c = seed({ category: 'api',      title: 'POST events endpoint is async',  body: 'unique body c' });

    const r = runSynthesize(db, PROJECT_ID);
    assert.equal(r.merged, 0);

    for (const id of [a.id, b.id, c.id]) {
      const row = db.prepare('SELECT status FROM knowledge_entries WHERE id = ?').get(id);
      assert.equal(row.status, 'active');
    }
  });

  it('logs pipeline_runs row with status=success', () => {
    seed({ category: 'footgun', title: 'One entry only', body: 'the only body' });
    runSynthesize(db, PROJECT_ID);
    const runs = db.prepare("SELECT * FROM pipeline_runs WHERE pipeline = 'auto_synthesize' AND project_id = ?").all(PROJECT_ID);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'success');
  });

  it('skips already-outdated entries on subsequent runs (idempotent)', () => {
    const a = seed({
      category: 'footgun', title: 'Shared title wording',
      body: 'short',
    });
    const b = seed({
      category: 'footgun', title: 'Shared title wording match',
      body: 'a longer body text that will win the keeper selection',
    });

    runSynthesize(db, PROJECT_ID);
    const second = runSynthesize(db, PROJECT_ID);
    // On the second run a is already outdated → only 1 active entry → merged:0
    assert.equal(second.merged, 0);
    assert.equal(second.entries, 1);
  });
});

describe('runSynthesizeAll', () => {
  let db;
  let TEST_DIR;

  before(() => {
    TEST_DIR = path.join(os.tmpdir(), `op-synth-all-${Date.now()}`);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { createDb } = require('../../src/db/schema');
    const { upsertClProject } = require('../../src/db/projects');
    db = createDb(path.join(TEST_DIR, 't.db'));

    for (const id of ['proj-a', 'proj-b']) {
      upsertClProject(db, {
        project_id: id, name: id, directory: path.join(TEST_DIR, id),
        first_seen_at: '1', last_seen_at: '1', session_count: 0,
      });
    }

    const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');
    insertKnowledgeEntry(db, { project_id: 'proj-a', category: 'footgun', title: 'Shared topic phrase', body: 'short' });
    insertKnowledgeEntry(db, { project_id: 'proj-a', category: 'footgun', title: 'Shared topic phrase match', body: 'longer body for keeping' });
    insertKnowledgeEntry(db, { project_id: 'proj-b', category: 'decision', title: 'Unique decision A', body: 'x' });
  });

  after(() => {
    if (db) db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('runs synthesize for every cl_projects entry', () => {
    const results = runSynthesizeAll(db);
    assert.ok('proj-a' in results);
    assert.ok('proj-b' in results);
    assert.ok(results['proj-a'].merged >= 1, 'proj-a should merge its duplicate');
    assert.equal(results['proj-b'].merged, 0);
  });
});
