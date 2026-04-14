'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { callOllama } = require('../../src/lib/ollama');

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('callOllama', () => {
  describe('sends correct request format', () => {
    let server;
    let capturedBody;

    before(async () => {
      server = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          capturedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: 'ok' }));
        });
      });
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('sends model, prompt, stream=false, temperature=0, num_predict=2048', async () => {
      const port = server.address().port;
      await callOllama('hello world', 'llama3', { url: `http://127.0.0.1:${port}` });

      assert.equal(capturedBody.model, 'llama3');
      assert.equal(capturedBody.prompt, 'hello world');
      assert.equal(capturedBody.stream, false);
      assert.equal(capturedBody.options.temperature, 0);
      assert.equal(capturedBody.options.num_predict, 2048);
    });
  });

  describe('returns output and duration', () => {
    let server;

    before(async () => {
      server = await createMockServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: '[{"title":"test"}]' }));
        });
      });
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('returns output string and numeric duration_ms', async () => {
      const port = server.address().port;
      const result = await callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}` });

      assert.equal(result.output, '[{"title":"test"}]');
      assert.equal(typeof result.duration_ms, 'number');
      assert.ok(result.duration_ms >= 0);
    });
  });

  describe('throws on connection refused', () => {
    it('throws when server is not listening', async () => {
      // Port 1 is a privileged port that will always refuse connections
      await assert.rejects(
        () => callOllama('prompt', 'llama3', { url: 'http://127.0.0.1:1' }),
        (err) => {
          assert.ok(err instanceof Error);
          return true;
        }
      );
    });
  });

  describe('throws on timeout', () => {
    let server;

    before(async () => {
      server = await createMockServer((req, res) => {
        // Never respond — simulate timeout
        req.resume();
      });
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('throws a timeout error when server does not respond within timeout', async () => {
      const port = server.address().port;
      await assert.rejects(
        () => callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, timeout: 500 }),
        (err) => {
          assert.ok(err instanceof Error);
          // AbortSignal.timeout throws a DOMException with name 'TimeoutError'
          // or an AbortError depending on Node version
          const name = err.name;
          assert.ok(
            name === 'TimeoutError' || name === 'AbortError',
            `Expected TimeoutError or AbortError, got ${name}`
          );
          return true;
        }
      );
    });
  });
});
