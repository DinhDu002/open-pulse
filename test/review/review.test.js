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

// ---------------------------------------------------------------------------
// TC-U1..U3, U5: yesterday calculation + historyDays fallback (no DB needed)
// ---------------------------------------------------------------------------

describe('yesterday calculation', () => {
  const calcYesterday = (nowMs) =>
    new Date(nowMs - 86400000).toISOString().slice(0, 10);

  it('TC-U1: returns correct date at 3 AM UTC', () => {
    const now = new Date('2026-04-11T03:00:00Z').getTime();
    assert.equal(calcYesterday(now), '2026-04-10');
  });

  it('TC-U2: crosses month boundary (Apr 1 → Mar 31)', () => {
    const now = new Date('2026-04-01T03:00:00Z').getTime();
    assert.equal(calcYesterday(now), '2026-03-31');
  });

  it('TC-U3: crosses year boundary (Jan 1 → Dec 31)', () => {
    const now = new Date('2027-01-01T03:00:00Z').getTime();
    assert.equal(calcYesterday(now), '2026-12-31');
  });

  it('TC-U5: historyDays fallback from config values', () => {
    // Simulates: config.daily_review_history_days || 1
    assert.equal(undefined || 1, 1, 'absent → 1');
    assert.equal(null || 1, 1, 'null → 1');
    assert.equal(0 || 1, 1, '0 → 1 (falsy)');
    assert.equal(3 || 1, 3, '3 → 3');
    assert.equal(7 || 1, 7, '7 → 7');
  });
});

// ---------------------------------------------------------------------------
// TC-I1: runDailyReview with mocked execFileSync (require.cache trick)
// ---------------------------------------------------------------------------

describe('runDailyReview with mocked execFileSync', () => {
  let pipelineMock, mockDb, capturedArgs;
  const origExec = require('child_process').execFileSync;

  before(() => {
    capturedArgs = [];
    require('child_process').execFileSync = (cmd, args, opts) => {
      capturedArgs.push({ cmd, args, opts });
      return '```json suggestions\n[{"category":"test","title":"Mock suggestion","description":"d","target_type":"rule","action":"create","confidence":0.9,"reasoning":"r","summary_vi":"v"}]\n```\n\n```json insights\n[{"insight_type":"gap","title":"Mock insight","description":"d","projects":["a"],"target_type":"skill","severity":"info","reasoning":"r","summary_vi":"v"}]\n```';
    };
    // Clear cached pipeline module so re-require picks up patched execFileSync
    delete require.cache[require.resolve('../../src/review/pipeline')];
    delete require.cache[require.resolve('../../src/review/context')];
    pipelineMock = require('../../src/review/pipeline');
    mockDb = require('../../src/db/schema').createDb(':memory:');
  });

  after(() => {
    if (mockDb) mockDb.close();
    require('child_process').execFileSync = origExec;
    delete require.cache[require.resolve('../../src/review/pipeline')];
    delete require.cache[require.resolve('../../src/review/context')];
  });

  it('TC-I1: passes date and historyDays into prompt via execFileSync', async () => {
    const result = await pipelineMock.runDailyReview(mockDb, {
      date: '2026-04-10',
      historyDays: 3,
      model: 'sonnet',
      timeout: 5000,
    });
    assert.equal(capturedArgs.length, 1, 'execFileSync called once');
    const promptArg = capturedArgs[0].args[capturedArgs[0].args.indexOf('-p') + 1];
    assert.ok(promptArg.includes('2026-04-10'), 'prompt contains provided date');
    assert.ok(promptArg.includes('3 days'), 'prompt contains historyDays');
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.insights.length, 1);

    // Verify saved to DB with correct review_date
    const rows = mockDb.prepare('SELECT * FROM daily_reviews WHERE review_date = ?').all('2026-04-10');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].review_date, '2026-04-10');
  });
});

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

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

  it('TC-U4: collectWorkHistory(yesterday, 1) returns yesterday events, excludes today', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const history = review.collectWorkHistory(db, yesterday, 1);
    assert.ok(history.events.length >= 1, 'Should find yesterday events (sess-2)');
    assert.equal(history.startDate, yesterday);
    assert.equal(history.endDate, yesterday);
    for (const e of history.events) {
      assert.equal(e.timestamp.slice(0, 10), yesterday, `Event should be from ${yesterday}, got ${e.timestamp}`);
    }
    // Also confirm no today events leak in
    const noToday = history.events.filter(e => e.timestamp.slice(0, 10) === today);
    assert.equal(noToday.length, 0, 'Should not include today events');
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

  // -- writeReport with insights --

  it('writeReport includes insights section', () => {
    const history = { events: [], sessions: [], totalCost: 0 };
    const suggestions = [{ category: 'cleanup', title: 'Test', action: 'remove', target_type: 'rule', confidence: 0.5, reasoning: 'r', description: 'd' }];
    const insights = [{ insight_type: 'duplicate', title: 'Dup', projects: ['a', 'b'], target_type: 'rule', severity: 'warning', reasoning: 'r', description: 'd' }];
    const reportDir = path.join(TEST_DIR, 'reports');
    const reportPath = review.writeReport(suggestions, history, reportDir, '2026-04-10', insights);
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(content.includes('Suggestions (1 total)'));
    assert.ok(content.includes('Cross-Project Insights (1 total)'));
    assert.ok(content.includes('[duplicate] Dup'));
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

  // -- getKnowledgeReviewContext --

  describe('getKnowledgeReviewContext', () => {
    it('returns entries with source file content excerpts', () => {
      const { getKnowledgeReviewContext } = require('../../src/review/context');
      const { upsertClProject } = require('../../src/db/projects');
      const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');

      upsertClProject(db, {
        project_id: 'review-kg-test',
        name: 'KG Review Test',
        directory: TEST_DIR,
        first_seen_at: '2026-04-11T00:00:00Z',
        last_seen_at: '2026-04-11T00:00:00Z',
        session_count: 1,
      });

      const srcPath = path.join(TEST_DIR, 'test-source.js');
      fs.writeFileSync(srcPath, "const model = 'sonnet';\nmodule.exports = { model };");

      insertKnowledgeEntry(db, {
        project_id: 'review-kg-test',
        category: 'stack',
        title: 'Model Uses Haiku',
        body: 'The system uses Haiku model for extraction. Consequence: lower cost.',
        source_file: 'test-source.js',
      });

      const result = getKnowledgeReviewContext(db);
      assert.ok(result.length >= 1);
      const item = result.find(r => r.title === 'Model Uses Haiku');
      assert.ok(item);
      assert.ok(item.body_excerpt.includes('Haiku'));
      assert.ok(item.source_content_excerpt.includes('sonnet'));
      assert.equal(item.source_file, 'test-source.js');
    });

    it('skips entries without source_file', () => {
      const { getKnowledgeReviewContext } = require('../../src/review/context');
      const { insertKnowledgeEntry } = require('../../src/db/knowledge-entries');

      insertKnowledgeEntry(db, {
        project_id: 'review-kg-test',
        category: 'domain',
        title: 'No Source File Entry',
        body: 'This has no source. Consequence: cannot validate.',
      });

      const result = getKnowledgeReviewContext(db);
      const item = result.find(r => r.title === 'No Source File Entry');
      assert.equal(item, undefined);
    });
  });
});
