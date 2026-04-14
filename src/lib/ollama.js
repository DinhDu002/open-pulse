'use strict';

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT = 90000;

async function callOllama(prompt, model, opts = {}) {
  const baseUrl = opts.url || DEFAULT_URL;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const startTime = Date.now();

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    output: data.response || '',
    duration_ms: Date.now() - startTime,
  };
}

module.exports = { callOllama };
