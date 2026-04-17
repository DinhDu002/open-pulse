'use strict';

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT = 90000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

// ── Circuit breaker ─────────────────────────────────────────────────────────

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 300_000; // 5 minutes

let circuitState = 'closed';
let consecutiveFailures = 0;
let lastFailureTime = 0;

function isCircuitOpen() {
  if (circuitState === 'closed') return false;
  if (circuitState === 'open') {
    if (Date.now() - lastFailureTime >= RECOVERY_TIMEOUT_MS) {
      circuitState = 'half-open';
      return false; // allow one probe request
    }
    return true;
  }
  // half-open — allow the probe
  return false;
}

function getCircuitState() {
  return { state: circuitState, consecutiveFailures, lastFailureTime };
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitState = 'closed';
}

function recordFailure() {
  consecutiveFailures++;
  lastFailureTime = Date.now();
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitState = 'open';
  }
}

function resetCircuit() {
  circuitState = 'closed';
  consecutiveFailures = 0;
  lastFailureTime = 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRetryable(err) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (err.status && err.status >= 500) return true;
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main call ───────────────────────────────────────────────────────────────

async function callOllama(prompt, model, opts = {}) {
  if (isCircuitOpen()) {
    const err = new Error('Ollama circuit breaker is open — skipping request');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  const baseUrl = opts.url || DEFAULT_URL;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const halfOpen = circuitState === 'half-open';
  const maxRetries = halfOpen ? 0 : (opts.maxRetries ?? MAX_RETRIES);
  const startTime = Date.now();

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    }
    try {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          think: opts.think !== undefined ? opts.think : false, // disable thinking by default for structured extraction
          options: { temperature: 0, num_predict: -1 },
        }),
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        if (isRetryable(err) && attempt < maxRetries) {
          lastErr = err;
          continue;
        }
        throw err; // caught by catch block which handles recordFailure
      }

      const data = await res.json();
      recordSuccess();
      return {
        output: data.response || '',
        duration_ms: Date.now() - startTime,
        input_tokens: data.prompt_eval_count || 0,
        output_tokens: data.eval_count || 0,
      };
    } catch (err) {
      lastErr = err;
      if (isRetryable(err) && attempt < maxRetries) continue;
      if (isRetryable(err)) recordFailure();
      throw err;
    }
  }
  throw lastErr;
}

async function verifyModel(model, opts = {}) {
  const baseUrl = opts.url || DEFAULT_URL;
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { callOllama, verifyModel, isCircuitOpen, getCircuitState, resetCircuit };
