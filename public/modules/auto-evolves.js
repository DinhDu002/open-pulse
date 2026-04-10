import { get, put } from './api.js';

function fmtTime(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, HH:mm');
}

function confidenceBar(score) {
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
  const bar = document.createElement('span');
  bar.className = 'confidence-bar';
  const fill = document.createElement('span');
  fill.className = 'confidence-fill';
  fill.style.width = pct + '%';
  fill.style.background = color;
  bar.appendChild(fill);
  return bar;
}

function statusBadge(status) {
  const colors = { active: 'var(--accent)', promoted: 'var(--success)', reverted: 'var(--danger)' };
  const span = document.createElement('span');
  span.className = 'badge';
  span.style.cssText = `background:${colors[status] || 'var(--text-muted)'}26;color:${colors[status] || 'var(--text-muted)'}`;
  span.textContent = status;
  return span;
}

function typeBadge(type) {
  const span = document.createElement('span');
  span.className = 'badge';
  span.textContent = type || 'unknown';
  return span;
}

async function renderStats(container) {
  const stats = await get('/auto-evolves/stats');
  const cards = document.createElement('div');
  cards.className = 'stats-grid';
  for (const { status, count } of (stats.byStatus || [])) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="stat-value">${count}</div><div class="stat-label">${status}</div>`;
    cards.appendChild(card);
  }
  container.appendChild(cards);
}

async function renderList(container, filterStatus) {
  const qs = filterStatus ? `?status=${filterStatus}` : '';
  const data = await get(`/auto-evolves${qs}`);

  if (!data.rows || data.rows.length === 0) {
    container.innerHTML = '<div class="empty-state">No auto-evolves yet</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>Title</th><th>Type</th><th>Confidence</th><th>Obs.</th><th>Status</th><th>Promoted</th><th>Actions</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const tdTitle = document.createElement('td');
    tdTitle.textContent = row.title;
    tr.appendChild(tdTitle);

    const tdType = document.createElement('td');
    tdType.appendChild(typeBadge(row.target_type));
    tr.appendChild(tdType);

    const tdConf = document.createElement('td');
    tdConf.appendChild(confidenceBar(row.confidence));
    tr.appendChild(tdConf);

    const tdObs = document.createElement('td');
    tdObs.textContent = row.observation_count;
    tr.appendChild(tdObs);

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(row.status));
    tr.appendChild(tdStatus);

    const tdPromoted = document.createElement('td');
    tdPromoted.textContent = fmtTime(row.promoted_at);
    tr.appendChild(tdPromoted);

    const tdActions = document.createElement('td');
    if (row.status === 'promoted') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-danger';
      btn.textContent = 'Revert';
      btn.onclick = async () => {
        await put(`/auto-evolves/${row.id}/revert`);
        mount(container.closest('#app'), {});
      };
      tdActions.appendChild(btn);
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export function mount(app, opts = {}) {
  app.textContent = '';

  const header = document.createElement('h2');
  header.textContent = 'Auto-evolve';
  app.appendChild(header);

  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  const filters = document.createElement('div');
  filters.className = 'filter-bar';
  for (const s of ['all', 'active', 'promoted', 'reverted']) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = s;
    btn.onclick = () => {
      listEl.textContent = '';
      renderList(listEl, s === 'all' ? '' : s);
    };
    filters.appendChild(btn);
  }
  app.appendChild(filters);

  const listEl = document.createElement('div');
  app.appendChild(listEl);
  renderList(listEl);
}

export function unmount() {}
