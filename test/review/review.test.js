'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-daily-review-test-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');
const TEST_CLAUDE_DIR = path.join(TEST_DIR, 'claude');
const TEST_PROJECT_DIR = path.join(TEST_DIR, 'fake-project');
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

    // Seed project directory for scanning tests
    fs.mkdirSync(path.join(TEST_PROJECT_DIR, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROJECT_DIR, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'CLAUDE.md'), '# Fake Project\nProject instructions.');
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, '.claude', 'rules', 'style.md'), '# Style\nUse tabs.');
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nHelper agent.');

    db = require('../../src/db/schema').createDb(TEST_DB);
    review = require('../../src/review/pipeline');

    // Seed cl_projects for project scanning tests
    db.prepare(
      'INSERT INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('proj-1', 'fake-project', TEST_PROJECT_DIR, new Date().toISOString(), new Date().toISOString(), 5);

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

    // Seed events for yesterday (multi-day history test)
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    stmtE.run('sess-2', yesterday, 'tool_call', 'Bash', 'Run tests', 0.003, 150, 80);
    stmtS.run('sess-2', yesterday, 'opus', 0.003, 150, 80);
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

  it('collectWorkHistory with historyDays=2 includes yesterday', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = review.collectWorkHistory(db, today, 2);
    assert.ok(history.events.length >= 4, `Should include today + yesterday events, got ${history.events.length}`);
    assert.ok(history.sessions.length >= 2, `Should include both sessions, got ${history.sessions.length}`);
    assert.ok(history.startDate);
    assert.ok(history.endDate);
  });

  it('collectWorkHistory with historyDays=1 matches default behavior', () => {
    const today = new Date().toISOString().slice(0, 10);
    const history1 = review.collectWorkHistory(db, today, 1);
    const historyDefault = review.collectWorkHistory(db, today);
    assert.equal(history1.events.length, historyDefault.events.length);
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
    assert.ok(prompt.includes('Work History'));
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

  // -- discoverProjectPaths --

  it('discoverProjectPaths finds projects from cl_projects', () => {
    const paths = review.discoverProjectPaths(db);
    assert.ok(paths.length >= 1);
    const found = paths.find(p => p.name === 'fake-project');
    assert.ok(found, 'Should find fake-project');
    assert.equal(found.directory, TEST_PROJECT_DIR);
  });

  it('discoverProjectPaths filters out non-existent directories', () => {
    db.prepare(
      'INSERT OR IGNORE INTO cl_projects (project_id, name, directory, first_seen_at, last_seen_at, session_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('proj-ghost', 'ghost', '/nonexistent/path', new Date().toISOString(), new Date().toISOString(), 0);
    const paths = review.discoverProjectPaths(db);
    const found = paths.find(p => p.name === 'ghost');
    assert.ok(!found, 'Should not include nonexistent directory');
  });

  // -- scanOneProject --

  it('scanOneProject reads project CLAUDE.md and .claude/ components', () => {
    const result = review.scanOneProject(TEST_PROJECT_DIR);
    assert.ok(result.claudeMd.includes('Fake Project'));
    assert.ok(result.rules.length >= 1);
    assert.ok(result.rules[0].content.includes('Use tabs'));
    assert.ok(result.agents.length >= 1);
  });

  it('scanOneProject returns empty for project without .claude/', () => {
    const emptyDir = path.join(TEST_DIR, 'empty-project');
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = review.scanOneProject(emptyDir);
    assert.equal(result.claudeMd, '');
    assert.deepEqual(result.rules, []);
  });

  // -- scanProjectConfigs --

  it('scanProjectConfigs returns configs keyed by project name', () => {
    const configs = review.scanProjectConfigs(db);
    assert.ok(configs['fake-project']);
    assert.ok(configs['fake-project'].claudeMd.includes('Fake Project'));
    assert.ok(configs['fake-project'].rules.length >= 1);
  });

  // -- parseReviewOutput --

  it('parseReviewOutput parses labeled suggestions + insights blocks', () => {
    const output = [
      'Analysis:',
      '```json suggestions',
      '[{"category":"cleanup","title":"Remove unused","description":"d","target_type":"rule","action":"remove","confidence":0.8,"reasoning":"r","summary_vi":"v"}]',
      '```',
      '',
      '```json insights',
      '[{"insight_type":"duplicate","title":"Dup rule","description":"d","projects":["a","b"],"target_type":"rule","severity":"warning","reasoning":"r","summary_vi":"v"}]',
      '```',
    ].join('\n');
    const result = review.parseReviewOutput(output);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].title, 'Remove unused');
    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].title, 'Dup rule');
  });

  it('parseReviewOutput falls back to single block as suggestions', () => {
    const output = '```json\n[{"category":"cleanup","title":"Test","description":"d","target_type":"rule","action":"remove","confidence":0.5,"reasoning":"r"}]\n```';
    const result = review.parseReviewOutput(output);
    assert.equal(result.suggestions.length, 1);
    assert.deepEqual(result.insights, []);
  });

  it('parseReviewOutput returns empty for invalid output', () => {
    const result = review.parseReviewOutput('not json');
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.insights, []);
  });

  it('buildPrompt includes project configs section', () => {
    const history = review.collectWorkHistory(db, new Date().toISOString().slice(0, 10));
    const components = review.scanAllComponents(TEST_CLAUDE_DIR);
    const practices = review.loadBestPractices(REPO_DIR);
    const projectConfigs = { 'fake-project': { directory: '/tmp', claudeMd: '# Fake', rules: [], skills: [], agents: [], knowledge: [], hooks: [] } };
    const prompt = review.buildPrompt(history, components, practices, {
      date: '2026-04-10',
      max_suggestions: 25,
      projectConfigs,
      historyDays: 1,
    });
    assert.ok(prompt.includes('Project Configurations'), 'Should have project configs section');
    assert.ok(prompt.includes('fake-project'), 'Should include project name');
    assert.ok(prompt.includes('# Fake'), 'Should include project CLAUDE.md content');
    assert.ok(prompt.includes('json suggestions'), 'Should have labeled suggestions block');
    assert.ok(prompt.includes('json insights'), 'Should have labeled insights block');
  });
});
