// Fetch wrapper for Open Pulse API
const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

export const get = (path) => request('GET', path);
export const post = (path, body) => request('POST', path, body);
export const put = (path, body) => request('PUT', path, body);
export const del = (path, body) => request('DELETE', path, body);
