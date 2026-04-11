// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_DIR = path.resolve(__dirname, '../..');
const TEST_DIR = path.join(os.tmpdir(), `op-e2e-${Date.now()}`);

let app;
let baseURL;

test.beforeAll(async () => {
  // 1. Temp directory structure
  for (const sub of [
    'data',
    'cl/instincts/inherited',
    'cl/instincts/personal',
    '.claude/skills',
    '.claude/agents',
  ]) {
    fs.mkdirSync(path.join(TEST_DIR, sub), { recursive: true });
  }

  // 2. Symlink public/ so server can serve frontend assets
  fs.symlinkSync(path.join(REPO_DIR, 'public'), path.join(TEST_DIR, 'public'));

  // 3. Environment — isolated DB + dirs
  process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
  process.env.OPEN_PULSE_DIR = TEST_DIR;
  process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

  // 4. Boot server on random port
  const { buildApp } = require('../../src/server');
  app = buildApp({ disableTimers: true });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = address;

  // 5. Seed auto_evolves rows
  const Database = require('better-sqlite3');
  const db = new Database(process.env.OPEN_PULSE_DB);
  const insert = db.prepare(`
    INSERT INTO auto_evolves
      (id, title, description, target_type, confidence, observation_count, status, created_at, updated_at)
    VALUES
      (@id, @title, @description, @target_type, @confidence, @observation_count, @status, datetime('now'), datetime('now'))
  `);
  insert.run({
    id: 'ae-with-desc',
    title: 'Has Body Pattern',
    description: 'Detailed body text for this pattern',
    target_type: 'rule',
    confidence: 0.9,
    observation_count: 15,
    status: 'active',
  });
  insert.run({
    id: 'ae-no-desc',
    title: 'No Body Pattern',
    description: '',
    target_type: 'skill',
    confidence: 0.5,
    observation_count: 3,
    status: 'active',
  });
  db.close();
});

test.afterAll(async () => {
  if (app) await app.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.OPEN_PULSE_DB;
  delete process.env.OPEN_PULSE_DIR;
  delete process.env.OPEN_PULSE_CLAUDE_DIR;
});

test('C1: row with description shows details/summary — click expands body', async ({ page }) => {
  await page.goto(`${baseURL}/#auto-evolves`);
  await page.waitForSelector('.data-table');

  // details element wraps the title
  const details = page.locator('details.inline-details', { hasText: 'Has Body Pattern' });
  await expect(details).toBeVisible();

  // body hidden by default (details collapsed)
  const body = details.locator('pre.evolve-body');
  await expect(body).toBeHidden();

  // click summary to expand
  await details.locator('summary').click();
  await expect(body).toBeVisible();
  await expect(body).toContainText('Detailed body text for this pattern');
});

test('C2: row without description shows plain text — no details element', async ({ page }) => {
  await page.goto(`${baseURL}/#auto-evolves`);
  await page.waitForSelector('.data-table');

  // find the cell containing the title
  const cell = page.locator('td', { hasText: 'No Body Pattern' });
  await expect(cell).toBeVisible();

  // no <details> inside — just plain text
  const details = cell.locator('details');
  await expect(details).toHaveCount(0);
});
