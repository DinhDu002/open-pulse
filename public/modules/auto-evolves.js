import { get, put, post } from './api.js';

function fmtTime(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, HH:mm');
}

function fmtFull(ts) {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleString();
}

function confidenceBar(score) {
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
  const label = document.createElement('span');
  label.textContent = pct + '%';
  label.style.color = color;
  const bar = document.createElement('span');
  bar.className = 'confidence-bar';
  const fill = document.createElement('span');
  fill.className = 'confidence-fill';
  fill.style.width = pct + '%';
  fill.style.background = color;
  bar.appendChild(fill);
  wrap.appendChild(label);
  wrap.appendChild(bar);
  return wrap;
}

function statusBadge(status) {
  const colors = { active: '#6c5ce7', promoted: '#00b894', reverted: '#e17055' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[status] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c}`;
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
  cards.className = 'stat-grid';
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
    const titleLink = document.createElement('a');
    titleLink.href = '#auto-evolves/' + row.id;
    titleLink.textContent = row.title;
    titleLink.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer';
    tdTitle.appendChild(titleLink);
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

async function renderDetail(el, id) {
  el.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Loading\u2026';
  el.appendChild(loading);

  try {
    const row = await get('/auto-evolves/' + id);
    el.removeChild(loading);

    const backLink = document.createElement('a');
    backLink.href = '#auto-evolves';
    backLink.className = 'back-link';
    backLink.textContent = '\u2190 Back to Auto-evolves';
    el.appendChild(backLink);

    // Header card
    const header = document.createElement('div');
    header.className = 'card';
    header.style.marginBottom = '20px';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 12px 0;font-size:18px';
    title.textContent = row.title;
    header.appendChild(title);

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px';
    badges.appendChild(typeBadge(row.target_type));
    badges.appendChild(statusBadge(row.status));
    badges.appendChild(confidenceBar(row.confidence));
    header.appendChild(badges);

    el.appendChild(header);

    // Meta card
    const metaCard = document.createElement('div');
    metaCard.className = 'card';
    metaCard.style.marginBottom = '20px';
    const metaTitle = document.createElement('div');
    metaTitle.className = 'card-title';
    metaTitle.textContent = 'Details';
    metaCard.appendChild(metaTitle);

    const fields = [
      ['ID', row.id],
      ['Target type', row.target_type],
      ['Observation count', row.observation_count],
      ['Rejection count', row.rejection_count],
      ['Created', fmtFull(row.created_at)],
      ['Updated', fmtFull(row.updated_at)],
    ];
    if (row.status === 'promoted' || row.promoted_at) {
      fields.push(['Promoted at', fmtFull(row.promoted_at)]);
      fields.push(['Promoted to', row.promoted_to || '\u2014']);
    }

    const dl = document.createElement('dl');
    dl.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:8px 16px;margin:0;font-size:14px';
    for (const [label, value] of fields) {
      const dt = document.createElement('dt');
      dt.style.cssText = 'color:var(--muted);font-weight:600';
      dt.textContent = label;
      dl.appendChild(dt);
      const dd = document.createElement('dd');
      dd.style.cssText = 'margin:0;word-break:break-all';
      dd.textContent = value ?? '\u2014';
      dl.appendChild(dd);
    }
    metaCard.appendChild(dl);
    el.appendChild(metaCard);

    // Description card
    if (row.description) {
      const descCard = document.createElement('div');
      descCard.className = 'card';
      descCard.style.marginBottom = '20px';
      const descTitle = document.createElement('div');
      descTitle.className = 'card-title';
      descTitle.textContent = 'Description';
      descCard.appendChild(descTitle);
      const descBody = document.createElement('div');
      descBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      descBody.textContent = row.description;
      descCard.appendChild(descBody);
      el.appendChild(descCard);
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:16px';

    if (row.status === 'active') {
      const promoteBtn = document.createElement('button');
      promoteBtn.className = 'btn btn-sm btn-success';
      promoteBtn.textContent = 'Promote now';
      promoteBtn.onclick = async () => {
        try {
          await post('/auto-evolves/' + id + '/promote');
          renderDetail(el, id);
        } catch (err) {
          alert('Promote failed: ' + err.message);
        }
      };
      actions.appendChild(promoteBtn);
    }

    if (row.status === 'promoted') {
      const revertBtn = document.createElement('button');
      revertBtn.className = 'btn btn-sm btn-danger';
      revertBtn.textContent = 'Revert';
      revertBtn.onclick = async () => {
        await put('/auto-evolves/' + id + '/revert');
        renderDetail(el, id);
      };
      actions.appendChild(revertBtn);
    }

    if (actions.children.length > 0) {
      el.appendChild(actions);
    }

  } catch (err) {
    if (loading.parentNode === el) el.removeChild(loading);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load: ' + err.message;
    el.appendChild(errDiv);
  }
}

export async function mount(app, opts = {}) {
  if (opts.params) {
    await renderDetail(app, opts.params);
    return;
  }

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
