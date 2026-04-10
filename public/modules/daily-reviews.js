import { get, post } from './api.js';

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
  const colors = { pending: '#fdcb6e', accepted: '#00b894', dismissed: '#e17055' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[status] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = status || 'pending';
  return span;
}

async function renderStats(container) {
  const stats = await get('/daily-reviews/stats');
  const total = (stats.byStatus || []).reduce((sum, s) => sum + s.count, 0);
  const card = document.createElement('div');
  card.className = 'stat-grid';
  const c = document.createElement('div');
  c.className = 'stat-card';
  const valDiv = document.createElement('div');
  valDiv.className = 'stat-value';
  valDiv.textContent = total;
  const labelDiv = document.createElement('div');
  labelDiv.className = 'stat-label';
  labelDiv.textContent = 'suggestions';
  c.appendChild(valDiv);
  c.appendChild(labelDiv);
  card.appendChild(c);
  container.appendChild(card);
}

async function renderList(container, filterDate, filterStatus, page = 1) {
  const params = new URLSearchParams();
  if (filterDate) params.set('review_date', filterDate);
  if (filterStatus) params.set('status', filterStatus);
  params.set('page', page);
  params.set('per_page', '50');
  const data = await get(`/daily-reviews?${params}`);

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
  for (const col of ['Date', 'Category', 'Title', 'Action', 'Target', 'Confidence']) {
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
    const titleLink = document.createElement('a');
    titleLink.href = '#daily-reviews/' + row.id;
    titleLink.textContent = row.title;
    titleLink.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer';
    tdTitle.appendChild(titleLink);
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

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

async function renderDetail(el, reviewId) {
  el.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Loading…';
  el.appendChild(loading);

  try {
    const review = await get('/daily-reviews/' + reviewId);
    el.removeChild(loading);

    // Back link
    const backLink = document.createElement('a');
    backLink.href = '#daily-reviews';
    backLink.className = 'back-link';
    backLink.textContent = '\u2190 Back to Daily Reviews';
    el.appendChild(backLink);

    // Header card
    const header = document.createElement('div');
    header.className = 'card';
    header.style.marginBottom = '20px';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 12px 0;font-size:18px';
    title.textContent = review.title;
    header.appendChild(title);

    // Badges row
    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px';
    badges.appendChild(categoryBadge(review.category));
    badges.appendChild(actionBadge(review.action));
    badges.appendChild(statusBadge(review.status));
    header.appendChild(badges);

    // Meta row
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted)';

    const dateSpan = document.createElement('span');
    dateSpan.textContent = 'Date: ' + review.review_date;
    meta.appendChild(dateSpan);

    if (review.target_type) {
      const targetSpan = document.createElement('span');
      targetSpan.textContent = 'Target: ' + review.target_type;
      meta.appendChild(targetSpan);
    }

    if (review.confidence != null) {
      const confSpan = document.createElement('span');
      confSpan.textContent = 'Confidence: ' + review.confidence.toFixed(2);
      meta.appendChild(confSpan);
    }

    if (review.created_at) {
      const createdSpan = document.createElement('span');
      createdSpan.textContent = 'Created: ' + new Date(review.created_at).toLocaleString();
      meta.appendChild(createdSpan);
    }

    header.appendChild(meta);
    el.appendChild(header);

    // Description section
    if (review.description) {
      const descCard = document.createElement('div');
      descCard.className = 'card';
      descCard.style.marginBottom = '20px';
      const descTitle = document.createElement('div');
      descTitle.className = 'card-title';
      descTitle.textContent = 'Description';
      descCard.appendChild(descTitle);
      const descBody = document.createElement('div');
      descBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      descBody.textContent = review.description;
      descCard.appendChild(descBody);
      el.appendChild(descCard);
    }

    // Reasoning section
    if (review.reasoning) {
      const reasonCard = document.createElement('div');
      reasonCard.className = 'card';
      reasonCard.style.marginBottom = '20px';
      const reasonTitle = document.createElement('div');
      reasonTitle.className = 'card-title';
      reasonTitle.textContent = 'Reasoning';
      reasonCard.appendChild(reasonTitle);
      const reasonBody = document.createElement('div');
      reasonBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      reasonBody.textContent = review.reasoning;
      reasonCard.appendChild(reasonBody);
      el.appendChild(reasonCard);
    }

    // Vietnamese summary section
    if (review.summary_vi) {
      const viCard = document.createElement('div');
      viCard.className = 'card';
      viCard.style.marginBottom = '20px';
      const viTitle = document.createElement('div');
      viTitle.className = 'card-title';
      viTitle.textContent = 'Tóm tắt';
      viCard.appendChild(viTitle);
      const viBody = document.createElement('div');
      viBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      viBody.textContent = review.summary_vi;
      viCard.appendChild(viBody);
      el.appendChild(viCard);
    }

  } catch (err) {
    if (loading.parentNode === el) el.removeChild(loading);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load review: ' + err.message;
    el.appendChild(errDiv);
  }
}

export async function mount(app, { period, params } = {}) {
  if (params) {
    await renderDetail(app, params);
    return;
  }

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
    runBtn.textContent = 'Running\u2026';
    try {
      await post('/daily-reviews/run');
      mount(app, { period, params });
    } catch (err) {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Now';
      const errEl = document.createElement('div');
      errEl.style.cssText = 'color:#e17055;font-size:13px;margin-top:8px';
      errEl.textContent = err.message || 'Daily review failed';
      header.appendChild(errEl);
      setTimeout(() => errEl.remove(), 8000);
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
