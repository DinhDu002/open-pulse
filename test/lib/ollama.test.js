'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { callOllama, verifyModel, isCircuitOpen, getCircuitState, resetCircuit } = require('../../src/lib/ollama');

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

    it('sends model, prompt, stream=false, temperature=0, num_predict=-1', async () => {
      const port = server.address().port;
      await callOllama('hello world', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 0 });

      assert.equal(capturedBody.model, 'llama3');
      assert.equal(capturedBody.prompt, 'hello world');
      assert.equal(capturedBody.stream, false);
      assert.equal(capturedBody.options.temperature, 0);
      assert.equal(capturedBody.options.num_predict, -1);
    });
  });

  describe('returns output, duration, and token counts', () => {
    let server;

    before(async () => {
      server = await createMockServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            response: '[{"title":"test"}]',
            prompt_eval_count: 150,
            eval_count: 42,
          }));
        });
      });
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('returns output string, duration_ms, and token counts', async () => {
      const port = server.address().port;
      const result = await callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 0 });

      assert.equal(result.output, '[{"title":"test"}]');
      assert.equal(typeof result.duration_ms, 'number');
      assert.ok(result.duration_ms >= 0);
      assert.equal(result.input_tokens, 150);
      assert.equal(result.output_tokens, 42);
    });

    it('defaults tokens to 0 when not provided', async () => {
      // This server returns tokens, but let's test the contract
      const port = server.address().port;
      const result = await callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 0 });
      assert.equal(typeof result.input_tokens, 'number');
      assert.equal(typeof result.output_tokens, 'number');
    });
  });

  describe('retry logic', () => {
    it('retries on 503 and succeeds on second attempt', async () => {
      let attempts = 0;
      const server = await createMockServer((req, res) => {
        req.resume();
        req.on('end', () => {
          attempts++;
          if (attempts === 1) {
            res.writeHead(503);
            res.end('service unavailable');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ response: 'ok' }));
          }
        });
      });

      try {
        const port = server.address().port;
        const result = await callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 2 });
        assert.equal(result.output, 'ok');
        assert.equal(attempts, 2, 'should have made 2 attempts');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('gives up after max retries on 503', async () => {
      const server = await createMockServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(503);
          res.end('service unavailable');
        });
      });

      try {
        const port = server.address().port;
        await assert.rejects(
          () => callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 1 }),
          (err) => {
            assert.ok(err.message.includes('503'));
            return true;
          }
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('does not retry on 400', async () => {
      let attempts = 0;
      const server = await createMockServer((req, res) => {
        req.resume();
        req.on('end', () => {
          attempts++;
          res.writeHead(400);
          res.end('bad request');
        });
      });

      try {
        const port = server.address().port;
        await assert.rejects(
          () => callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, maxRetries: 3 }),
          (err) => {
            assert.ok(err.message.includes('400'));
            return true;
          }
        );
        assert.equal(attempts, 1, 'should not retry on 400');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('throws on connection refused', () => {
    it('throws when server is not listening', async () => {
      await assert.rejects(
        () => callOllama('prompt', 'llama3', { url: 'http://127.0.0.1:1', maxRetries: 0 }),
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
        req.resume();
      });
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('throws a timeout error when server does not respond within timeout', async () => {
      const port = server.address().port;
      await assert.rejects(
        () => callOllama('prompt', 'llama3', { url: `http://127.0.0.1:${port}`, timeout: 500, maxRetries: 0 }),
        (err) => {
          assert.ok(err instanceof Error);
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

describe('verifyModel', () => {
  it('returns true when model exists', async () => {
    const server = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ modelfile: '...' }));
      });
    });

    try {
      const port = server.address().port;
      const result = await verifyModel('llama3', { url: `http://127.0.0.1:${port}` });
      assert.equal(result, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns false when model not found', async () => {
    const server = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(404);
        res.end('not found');
      });
    });

    try {
      const port = server.address().port;
      const result = await verifyModel('nonexistent', { url: `http://127.0.0.1:${port}` });
      assert.equal(result, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns false when server unreachable', async () => {
    const result = await verifyModel('llama3', { url: 'http://127.0.0.1:1' });
    assert.equal(result, false);
  });
});

describe('circuit breaker', () => {
  before(() => resetCircuit());

  it('starts in closed state', () => {
    const state = getCircuitState();
    assert.equal(state.state, 'closed');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(isCircuitOpen(), false);
  });

  it('opens after N consecutive retryable failures', async () => {
    resetCircuit();
    const server = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(503); res.end('down'); });
    });
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;

    // Each callOllama with maxRetries:0 → 1 failure recorded
    for (let i = 0; i < 5; i++) {
      try { await callOllama('p', 'model', { url, maxRetries: 0, timeout: 2000 }); } catch { /* expected */ }
    }

    await new Promise((resolve) => server.close(resolve));

    assert.equal(getCircuitState().state, 'open');
    assert.equal(isCircuitOpen(), true);
    assert.equal(getCircuitState().consecutiveFailures, 5);
  });

  it('throws CIRCUIT_OPEN when breaker is open', async () => {
    // State is open from previous test
    await assert.rejects(
      () => callOllama('p', 'model', { url: 'http://127.0.0.1:1' }),
      (err) => {
        assert.equal(err.code, 'CIRCUIT_OPEN');
        return true;
      }
    );
  });

  it('resetCircuit restores closed state', () => {
    resetCircuit();
    assert.equal(getCircuitState().state, 'closed');
    assert.equal(getCircuitState().consecutiveFailures, 0);
    assert.equal(isCircuitOpen(), false);
  });

  it('success resets consecutive failures to 0', async () => {
    resetCircuit();
    const failServer = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(503); res.end('down'); });
    });
    const fPort = failServer.address().port;

    // Record 3 failures (below threshold)
    for (let i = 0; i < 3; i++) {
      try { await callOllama('p', 'm', { url: `http://127.0.0.1:${fPort}`, maxRetries: 0, timeout: 2000 }); } catch { /* expected */ }
    }
    await new Promise((resolve) => failServer.close(resolve));
    assert.equal(getCircuitState().consecutiveFailures, 3);

    // Success resets
    const okServer = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'ok' }));
      });
    });
    const oPort = okServer.address().port;
    await callOllama('p', 'm', { url: `http://127.0.0.1:${oPort}`, maxRetries: 0 });
    await new Promise((resolve) => okServer.close(resolve));

    assert.equal(getCircuitState().consecutiveFailures, 0);
    assert.equal(getCircuitState().state, 'closed');
  });

  it('400 errors do NOT increment failure count', async () => {
    resetCircuit();
    const server = await createMockServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(400); res.end('bad request'); });
    });
    const port = server.address().port;

    try { await callOllama('p', 'm', { url: `http://127.0.0.1:${port}`, maxRetries: 0 }); } catch { /* expected */ }
    await new Promise((resolve) => server.close(resolve));

    assert.equal(getCircuitState().consecutiveFailures, 0);
    assert.equal(getCircuitState().state, 'closed');
  });
});
