'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `op-server-test-${Date.now()}`);

describe('op-server', () => {
  let app;

  before(async () => {
    fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'cl', 'instincts', 'personal'), { recursive: true });

    process.env.OPEN_PULSE_DB = path.join(TEST_DIR, 'test.db');
    process.env.OPEN_PULSE_DIR = TEST_DIR;
    process.env.OPEN_PULSE_CLAUDE_DIR = path.join(TEST_DIR, '.claude');

    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.claude', 'rules'), { recursive: true });

    const { buildApp } = require('../src/op-server');
    app = buildApp({ disableTimers: true });
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OPEN_PULSE_DB;
    delete process.env.OPEN_PULSE_DIR;
    delete process.env.OPEN_PULSE_CLAUDE_DIR;
  });

  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
  });

  it('GET /api/overview returns stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('total_sessions' in body);
    assert.ok('total_cost' in body);
  });

  it('GET /api/sessions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/suggestions returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/suggestions' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/scanner/latest returns null or object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scanner/latest' });
    assert.equal(res.statusCode, 200);
  });

  it('GET /api/config returns config object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('port' in body);
  });

  it('GET /api/events returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  it('GET /api/rankings/skills returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rankings/skills' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });
});
