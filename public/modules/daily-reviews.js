import { get, put, post } from './api.js';

function categoryBadge(cat) {
  const colors = {
    adoption: '#00b894', cleanup: '#e17055', agent_creation: '#6c5ce7',
    update: '#fdcb6e', optimization: '#74b9ff', integration: '#a29bfe',
    cost: '#fd79a8', security: '#d63031', refinement: '#00cec9',
  };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[cat] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = cat || 'general';
  return span;
}

function actionBadge(action) {
  const colors = { create: '#00b894', update: '#fdcb6e', remove: '#e17055', merge: '#74b9ff' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[action] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px`;
  span.textContent = action || '\u2014';
  return span;
}

function statusBadge(status) {
  const colors = { pending: 'var(--warning)', accepted: 'var(--success)', dismissed: 'var(--text-muted)' };
  const span = document.createElement('span');
  span.className = 'badge';
  span.style.cssText = `background:${colors[status] || 'var(--text-muted)'}26;color:${colors[status] || 'var(--text-muted)'}`;
  span.textContent = status;
  return span;
}

async function renderStats(container) {
  const stats = await get('/daily-reviews/stats');
  const cards = document.createElement('div');
  cards.className = 'stats-grid';
  for (const { status, count } of (stats.byStatus || [])) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const valDiv = document.createElement('div');
    valDiv.className = 'stat-value';
    valDiv.textContent = count;
    const labelDiv = document.createElement('div');
    labelDiv.className = 'stat-label';
    labelDiv.textContent = status;
    card.appendChild(valDiv);
    card.appendChild(labelDiv);
    cards.appendChild(card);
  }
  container.appendChild(cards);
}

async function renderList(container, filterDate, filterStatus) {
  const params = new URLSearchParams();
  if (filterDate) params.set('review_date', filterDate);
  if (filterStatus) params.set('status', filterStatus);
  const qs = params.toString() ? `?${params}` : '';
  const data = await get(`/daily-reviews${qs}`);

  if (!data.rows || data.rows.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'No daily reviews yet';
    container.appendChild(emptyDiv);
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Date', 'Category', 'Title', 'Action', 'Target', 'Confidence', 'Status', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.textContent = row.review_date;
    tr.appendChild(tdDate);

    const tdCat = document.createElement('td');
    tdCat.appendChild(categoryBadge(row.category));
    tr.appendChild(tdCat);

    const tdTitle = document.createElement('td');
    if (row.reasoning) {
      const details = document.createElement('details');
      details.className = 'inline-details';
      const summary = document.createElement('summary');
      summary.textContent = row.title;
      details.appendChild(summary);
      const p = document.createElement('p');
      p.className = 'reasoning-text';
      p.textContent = row.reasoning;
      details.appendChild(p);
      tdTitle.appendChild(details);
    } else {
      tdTitle.textContent = row.title;
    }
    tr.appendChild(tdTitle);

    const tdAction = document.createElement('td');
    tdAction.appendChild(actionBadge(row.action));
    tr.appendChild(tdAction);

    const tdTarget = document.createElement('td');
    tdTarget.textContent = row.target_type || '\u2014';
    tr.appendChild(tdTarget);

    const tdConf = document.createElement('td');
    tdConf.textContent = row.confidence ? row.confidence.toFixed(2) : '\u2014';
    tr.appendChild(tdConf);

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(row.status));
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    if (row.status === 'pending') {
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn btn-sm btn-success';
      acceptBtn.textContent = 'Accept';
      acceptBtn.onclick = async () => {
        await put(`/daily-reviews/${row.id}/accept`);
        container.textContent = '';
        renderList(container, filterDate, filterStatus);
      };
      tdActions.appendChild(acceptBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-sm';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.marginLeft = '4px';
      dismissBtn.onclick = async () => {
        await put(`/daily-reviews/${row.id}/dismiss`);
        container.textContent = '';
        renderList(container, filterDate, filterStatus);
      };
      tdActions.appendChild(dismissBtn);
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export function mount(app, opts = {}) {
  app.textContent = '';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px';
  const h2 = document.createElement('h2');
  h2.textContent = 'Daily Review';
  header.appendChild(h2);

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-sm';
  runBtn.textContent = 'Run Now';
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    try {
      await post('/daily-reviews/run');
      mount(app, opts);
    } catch (err) {
      runBtn.textContent = 'Failed';
    }
  };
  header.appendChild(runBtn);
  app.appendChild(header);

  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = new Date().toISOString().slice(0, 10);
  filterBar.appendChild(dateInput);

  for (const s of ['all', 'pending', 'accepted', 'dismissed']) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = s;
    btn.onclick = () => {
      listEl.textContent = '';
      renderList(listEl, dateInput.value, s === 'all' ? '' : s);
    };
    filterBar.appendChild(btn);
  }
  app.appendChild(filterBar);

  const listEl = document.createElement('div');
  app.appendChild(listEl);
  renderList(listEl);

  dateInput.onchange = () => {
    listEl.textContent = '';
    renderList(listEl, dateInput.value);
  };
}

export function unmount() {}
