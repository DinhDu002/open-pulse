'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-daily-review-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const REPO_DIR = path.join(__dirname, '../..');

describe('op-daily-review', () => {
  let db, review;

  before(() => {
    process.env.OPEN_PULSE_CLAUDE_DIR = TEST_CLAUDE_DIR;
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_CLAUDE_DIR, 'skills', 'test-skill'), { recursive: true });

    // Write sample component files
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'rules', 'test-rule.md'), '# Test Rule\n\nAlways test.');
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'agents', 'test-agent.md'), '---\nname: test\n---\nTest agent.');
    fs.writeFileSync(path.join(TEST_CLAUDE_DIR, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test\n---\nTest skill.');

    db = require('../../src/db/schema').createDb(TEST_DB);
    review = require('../../src/review/pipeline');

    // Seed some events for today
    const today = new Date().toISOString();
    const stmtE = db.prepare(`
      INSERT INTO events (session_id, timestamp, event_type, name, detail, estimated_cost_usd, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmtE.run('sess-1', today, 'tool_call', 'Read', 'Read file', 0.001, 100, 50);
    stmtE.run('sess-1', today, 'tool_call', 'Edit', 'Edit file', 0.002, 200, 100);
    stmtE.run('sess-1', today, 'skill_invoke', 'tdd-workflow', 'TDD', 0.01, 500, 300);

    const stmtS = db.prepare(`
      INSERT INTO sessions (session_id, started_at, model, total_cost_usd, total_input_tokens, total_output_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmtS.run('sess-1', today, 'sonnet', 0.013, 800, 450);
  });

  after(() => {
    if (db) db.close();
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -- collectWorkHistory --

  it('collectWorkHistory returns events for given date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = review.collectWorkHistory(db, today);
    assert.ok(history.events.length >= 3);
    assert.ok(history.sessions.length >= 1);
    assert.ok(typeof history.totalCost === 'number');
  });

  it('collectWorkHistory returns empty for future date', () => {
    const history = review.collectWorkHistory(db, '2099-01-01');
    assert.equal(history.events.length, 0);
  });

  // -- scanAllComponents --

  it('scanAllComponents reads rule, skill, agent files', () => {
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    assert.ok(components.rules.length >= 1);
    assert.ok(components.skills.length >= 1);
    assert.ok(components.agents.length >= 1);
    assert.ok(components.rules[0].content.includes('Test Rule'));
  });

  // -- loadBestPractices --

  it('loadBestPractices reads reference docs', () => {
    const practices = review.loadBestPractices(REPO_DIR);
    assert.ok(practices.length > 0, 'Should find at least one reference doc');
  });

  // -- buildPrompt --

  it('buildPrompt assembles template with all sections', () => {
    const history = review.collectWorkHistory(db, new Date().toISOString().slice(0, 10));
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    const practices = review.loadBestPractices(REPO_DIR);
    const prompt = review.buildPrompt(history, components, practices, {
      date: '2026-04-10',
      max_suggestions: 25,
    });
    assert.ok(prompt.includes('Daily Review'));
    assert.ok(prompt.includes('Work History Today'));
    assert.ok(prompt.includes('Rules'));
    assert.ok(prompt.includes('Best Practices'));
  });

  // -- parseSuggestions --

  it('parseSuggestions parses valid JSON array', () => {
    const output = JSON.stringify([{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Adopt TDD workflow',
      target_type: 'skill',
      action: 'create',
      confidence: 0.7,
      reasoning: 'User rarely runs tests first',
    }]);
    const result = review.parseSuggestions(output);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Use TDD');
  });

  it('parseSuggestions extracts JSON from markdown fences', () => {
    const output = 'Text\n```json\n[{"category":"cleanup","title":"Remove unused","description":"d","target_type":"rule","action":"remove","confidence":0.5,"reasoning":"r"}]\n```\nMore';
    const result = review.parseSuggestions(output);
    assert.equal(result.length, 1);
  });

  it('parseSuggestions returns empty array for invalid output', () => {
    const result = review.parseSuggestions('not json at all');
    assert.deepEqual(result, []);
  });

  // -- saveSuggestions --

  it('saveSuggestions inserts into daily_reviews table', () => {
    const suggestions = [{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Adopt TDD workflow',
      target_type: 'skill',
      action: 'create',
      confidence: 0.7,
      reasoning: 'Evidence',
    }];
    review.saveSuggestions(db, suggestions, '2026-04-10');

    const rows = db.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').all('2026-04-10');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].title, 'Use TDD');
    assert.equal(rows[0].status, 'pending');
  });

  it('saveSuggestions deduplicates by SHA-256 id', () => {
    const suggestions = [{
      category: 'adoption',
      title: 'Use TDD',
      description: 'Updated description',
      target_type: 'skill',
      action: 'create',
      confidence: 0.8,
      reasoning: 'More evidence',
    }];
    review.saveSuggestions(db, suggestions, '2026-04-10');

    const rows = db.prepare("SELECT * FROM daily_reviews WHERE title = 'Use TDD' AND review_date = '2026-04-10'").all();
    assert.equal(rows.length, 1);
  });

  // -- daily_review_insights table --

  it('daily_review_insights table exists with correct columns', () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('daily_review_insights')").all().map(c => c.name);
    const expected = ['id', 'review_date', 'insight_type', 'title', 'description', 'projects', 'target_type', 'severity', 'reasoning', 'summary_vi', 'status', 'created_at'];
    for (const col of expected) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  });

  // -- insight query helpers --

  it('saveInsights inserts into daily_review_insights', () => {
    const insights = [{
      insight_type: 'duplicate',
      title: 'Duplicate TDD rule',
      description: 'Same rule in 2 projects',
      projects: ['open-pulse', 'carthings'],
      target_type: 'rule',
      severity: 'warning',
      reasoning: 'Identical content',
      summary_vi: 'Quy tắc TDD trùng lặp',
    }];
    review.saveInsights(db, insights, '2026-04-10');
    const rows = db.prepare('SELECT * FROM daily_review_insights WHERE review_date = ?').all('2026-04-10');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].title, 'Duplicate TDD rule');
    assert.equal(rows[0].severity, 'warning');
    assert.equal(rows[0].status, 'pending');
    const projects = JSON.parse(rows[0].projects);
    assert.deepEqual(projects, ['open-pulse', 'carthings']);
  });

  it('queryInsights filters by insight_type', () => {
    const result = review.queryInsights(db, { insight_type: 'duplicate' });
    assert.ok(result.rows.length >= 1);
    assert.ok(result.total >= 1);
  });

  it('queryInsights returns empty for non-matching filter', () => {
    const result = review.queryInsights(db, { insight_type: 'conflict' });
    assert.equal(result.rows.length, 0);
  });

  it('getInsight returns single row', () => {
    const all = db.prepare('SELECT id FROM daily_review_insights LIMIT 1').get();
    const row = review.getInsight(db, all.id);
    assert.ok(row);
    assert.equal(row.title, 'Duplicate TDD rule');
  });

  it('updateInsightStatus changes status', () => {
    const all = db.prepare('SELECT id FROM daily_review_insights LIMIT 1').get();
    review.updateInsightStatus(db, all.id, 'resolved');
    const row = review.getInsight(db, all.id);
    assert.equal(row.status, 'resolved');
  });

  it('getInsightStats returns counts by type and severity', () => {
    const stats = review.getInsightStats(db);
    assert.ok(Array.isArray(stats.byType));
    assert.ok(Array.isArray(stats.bySeverity));
  });
});
