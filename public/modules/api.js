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

async function getWithETag(path, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(BASE + path, { method: 'GET', headers });
  if (res.status === 304) return { data: null, etag, notModified: true };
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const newEtag = res.headers.get('etag') || null;
  return { data, etag: newEtag, notModified: false };
}

export const get = (path) => request('GET', path);
export { getWithETag };
export const post = (path, body) => request('POST', path, body);
export const put = (path, body) => request('PUT', path, body);
export const del = (path, body) => request('DELETE', path, body);
