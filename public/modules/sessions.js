import { get } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(v) { return '$' + (v || 0).toFixed(4); }

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function shortDir(dir) {
  if (!dir) return '—';
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

function fmtTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, HH:mm');
}

// ── Session List ──────────────────────────────────────────────────────────────

function renderList(el, sessions) {
  const card = document.createElement('div');
  card.className = 'sessions-card';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.style.marginBottom = '14px';
  title.textContent = 'Sessions';
  card.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'sessions-table-wrap';

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Started</th>
    <th>Directory</th>
    <th>Model</th>
    <th>Duration</th>
    <th style="text-align:center">Tools</th>
    <th>Cost</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (!sessions || sessions.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" class="empty-state">No sessions found</td>';
    tbody.appendChild(tr);
  } else {
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        location.hash = '#sessions/' + s.id;
      });

      const model = s.model ? s.model.split('/').pop().split('-').slice(0, 3).join('-') : '—';

      tr.innerHTML = `
        <td class="td-mono">${fmtTime(s.startedAt)}</td>
        <td class="td-dir" title="${s.directory || ''}">${shortDir(s.directory)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${model}</td>
        <td class="td-dur">${fmtDur(s.durationMs)}</td>
        <td class="td-tools">${s.toolUses ?? 0}</td>
        <td class="td-cost">${fmtCost(s.cost)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  el.appendChild(card);
}

// ── Session Detail ────────────────────────────────────────────────────────────

function dotClass(type) {
  if (!type) return '';
  const t = type.toLowerCase();
  if (t.includes('skill')) return 'skill';
  if (t.includes('agent')) return 'agent';
  if (t.includes('session')) return 'session';
  return 'tool';
}

function renderDetail(el, session) {
  // Header with back button
  const header = document.createElement('div');
  header.className = 'detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', () => { location.hash = '#sessions'; });

  const title = document.createElement('div');
  title.className = 'detail-title';
  title.textContent = session.id || 'Session Detail';

  header.appendChild(backBtn);
  header.appendChild(title);
  el.appendChild(header);

  // Stat cards
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Started</div>
      <div class="stat-value" style="font-size:16px">${fmtTime(session.startedAt)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Cost</div>
      <div class="stat-value cost">${fmtCost(session.cost)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Duration</div>
      <div class="stat-value">${fmtDur(session.durationMs)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Tool Uses</div>
      <div class="stat-value">${session.toolUses ?? 0}</div>
    </div>
  `;
  el.appendChild(grid);

  // Directory
  if (session.directory) {
    const dirCard = document.createElement('div');
    dirCard.className = 'card';
    dirCard.style.marginBottom = '24px';
    dirCard.innerHTML = `<div class="card-title">Directory</div>
      <code style="font-size:12px;color:var(--accent)">${shortDir(session.directory)}</code>`;
    el.appendChild(dirCard);
  }

  // Timeline
  const events = session.events || [];
  const tlCard = document.createElement('div');
  tlCard.className = 'card';

  const tlTitle = document.createElement('div');
  tlTitle.className = 'card-title';
  tlTitle.textContent = 'Event Timeline (' + events.length + ')';
  tlCard.appendChild(tlTitle);

  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No events recorded';
    tlCard.appendChild(empty);
  } else {
    const timeline = document.createElement('div');
    timeline.className = 'timeline';

    events.forEach(ev => {
      const evEl = document.createElement('div');
      const dc = dotClass(ev.type);
      evEl.className = 'timeline-event ' + dc;

      const dot = document.createElement('div');
      dot.className = 'timeline-dot ' + dc;
      evEl.appendChild(dot);

      const top = document.createElement('div');
      top.className = 'timeline-top';

      const badge = document.createElement('span');
      badge.className = 'event-type-badge ' + dc;
      badge.textContent = ev.type || 'event';

      const name = document.createElement('span');
      name.className = 'event-name';
      name.textContent = ev.name || ev.tool || '';

      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = ev.timestamp ? dayjs(ev.timestamp).format('HH:mm:ss') : '';

      top.appendChild(badge);
      top.appendChild(name);
      top.appendChild(time);
      evEl.appendChild(top);

      if (ev.input || ev.detail || ev.path) {
        const detail = document.createElement('div');
        detail.className = 'timeline-detail';
        detail.textContent = ev.input || ev.detail || ev.path || '';
        evEl.appendChild(detail);
      }

      timeline.appendChild(evEl);
    });

    tlCard.appendChild(timeline);
  }

  el.appendChild(tlCard);
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export function mount(el, { period, params } = {}) {
  const p = period || '30d';

  if (params) {
    // Detail view
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    loading.appendChild(sp);
    el.appendChild(loading);

    get('/sessions/' + params).then(session => {
      el.removeChild(loading);
      renderDetail(el, session);
    }).catch(err => {
      loading.textContent = 'Failed to load session: ' + err.message;
      loading.style.color = 'var(--danger)';
    });
  } else {
    // List view
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    loading.appendChild(sp);
    el.appendChild(loading);

    get('/sessions?period=' + p).then(data => {
      el.removeChild(loading);
      const sessions = Array.isArray(data) ? data : (data.sessions || []);
      renderList(el, sessions);
    }).catch(err => {
      loading.textContent = 'Failed to load sessions: ' + err.message;
      loading.style.color = 'var(--danger)';
    });
  }
}

export function unmount() {
  // No charts to destroy
}
