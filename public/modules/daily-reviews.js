import { get, post, put } from './api.js';

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

function insightTypeBadge(type) {
  const colors = {
    duplicate: '#6c5ce7', conflict: '#d63031', gap: '#e17055',
    unused: '#8b8fa3', cross_dependency: '#74b9ff',
  };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[type] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = type || 'unknown';
  return span;
}

function severityBadge(severity) {
  const colors = { info: '#74b9ff', warning: '#fdcb6e', critical: '#d63031' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[severity] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c};font-size:10px;font-weight:600`;
  span.textContent = severity || 'info';
  return span;
}

function projectBadges(projectsJson) {
  const container = document.createElement('span');
  container.style.cssText = 'display:inline-flex;gap:4px;flex-wrap:wrap';
  let projects = [];
  try { projects = JSON.parse(projectsJson || '[]'); } catch { /* ignore */ }
  for (const p of projects) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.style.cssText = 'background:#a29bfe26;color:#a29bfe;font-size:10px';
    span.textContent = p;
    container.appendChild(span);
  }
  return container;
}

async function renderStats(container) {
  const [stats, insightStats] = await Promise.all([
    get('/daily-reviews/stats'),
    get('/daily-reviews/insights/stats'),
  ]);
  const sugTotal = (stats.byStatus || []).reduce((sum, s) => sum + s.count, 0);
  const insTotal = (insightStats.byType || []).reduce((sum, s) => sum + s.count, 0);

  const grid = document.createElement('div');
  grid.className = 'stat-grid';

  const sugCard = document.createElement('div');
  sugCard.className = 'stat-card';
  const sugVal = document.createElement('div');
  sugVal.className = 'stat-value';
  sugVal.textContent = sugTotal;
  const sugLabel = document.createElement('div');
  sugLabel.className = 'stat-label';
  sugLabel.textContent = 'suggestions';
  sugCard.appendChild(sugVal);
  sugCard.appendChild(sugLabel);
  grid.appendChild(sugCard);

  const insCard = document.createElement('div');
  insCard.className = 'stat-card';
  const insVal = document.createElement('div');
  insVal.className = 'stat-value';
  insVal.textContent = insTotal;
  const insLabel = document.createElement('div');
  insLabel.className = 'stat-label';
  insLabel.textContent = 'insights';
  insCard.appendChild(insVal);
  insCard.appendChild(insLabel);
  grid.appendChild(insCard);

  container.appendChild(grid);
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

async function renderInsightList(container, filterDate) {
  const params = new URLSearchParams();
  if (filterDate) params.set('review_date', filterDate);
  params.set('per_page', '50');
  const data = await get(`/daily-reviews/insights?${params}`);

  if (!data.rows || data.rows.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'No cross-project insights yet';
    container.appendChild(emptyDiv);
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Date', 'Type', 'Severity', 'Title', 'Projects', 'Target']) {
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

    const tdType = document.createElement('td');
    tdType.appendChild(insightTypeBadge(row.insight_type));
    tr.appendChild(tdType);

    const tdSev = document.createElement('td');
    tdSev.appendChild(severityBadge(row.severity));
    tr.appendChild(tdSev);

    const tdTitle = document.createElement('td');
    const titleLink = document.createElement('a');
    titleLink.href = '#daily-reviews/insight/' + row.id;
    titleLink.textContent = row.title;
    titleLink.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer';
    tdTitle.appendChild(titleLink);
    tr.appendChild(tdTitle);

    const tdProjects = document.createElement('td');
    tdProjects.appendChild(projectBadges(row.projects));
    tr.appendChild(tdProjects);

    const tdTarget = document.createElement('td');
    tdTarget.textContent = row.target_type || '\u2014';
    tr.appendChild(tdTarget);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

async function renderInsightDetail(el, insightId) {
  el.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Loading\u2026';
  el.appendChild(loading);

  try {
    const insight = await get('/daily-reviews/insights/' + insightId);
    el.removeChild(loading);

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
    title.textContent = insight.title;
    header.appendChild(title);

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px';
    badges.appendChild(insightTypeBadge(insight.insight_type));
    badges.appendChild(severityBadge(insight.severity));
    badges.appendChild(statusBadge(insight.status));
    header.appendChild(badges);

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted)';
    const dateSpan = document.createElement('span');
    dateSpan.textContent = 'Date: ' + insight.review_date;
    meta.appendChild(dateSpan);
    if (insight.target_type) {
      const targetSpan = document.createElement('span');
      targetSpan.textContent = 'Target: ' + insight.target_type;
      meta.appendChild(targetSpan);
    }
    header.appendChild(meta);

    // Projects
    if (insight.projects) {
      const projDiv = document.createElement('div');
      projDiv.style.cssText = 'margin-top:12px;font-size:13px';
      const projLabel = document.createElement('span');
      projLabel.style.cssText = 'color:var(--muted);margin-right:8px';
      projLabel.textContent = 'Projects:';
      projDiv.appendChild(projLabel);
      projDiv.appendChild(projectBadges(insight.projects));
      header.appendChild(projDiv);
    }

    el.appendChild(header);

    // Description
    if (insight.description) {
      const descCard = document.createElement('div');
      descCard.className = 'card';
      descCard.style.marginBottom = '20px';
      const descTitle = document.createElement('div');
      descTitle.className = 'card-title';
      descTitle.textContent = 'Description';
      descCard.appendChild(descTitle);
      const descBody = document.createElement('div');
      descBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      descBody.textContent = insight.description;
      descCard.appendChild(descBody);
      el.appendChild(descCard);
    }

    // Reasoning
    if (insight.reasoning) {
      const reasonCard = document.createElement('div');
      reasonCard.className = 'card';
      reasonCard.style.marginBottom = '20px';
      const reasonTitle = document.createElement('div');
      reasonTitle.className = 'card-title';
      reasonTitle.textContent = 'Reasoning';
      reasonCard.appendChild(reasonTitle);
      const reasonBody = document.createElement('div');
      reasonBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      reasonBody.textContent = insight.reasoning;
      reasonCard.appendChild(reasonBody);
      el.appendChild(reasonCard);
    }

    // Vietnamese summary
    if (insight.summary_vi) {
      const viCard = document.createElement('div');
      viCard.className = 'card';
      viCard.style.marginBottom = '20px';
      const viTitle = document.createElement('div');
      viTitle.className = 'card-title';
      viTitle.textContent = 'T\u00f3m t\u1eaft';
      viCard.appendChild(viTitle);
      const viBody = document.createElement('div');
      viBody.style.cssText = 'white-space:pre-wrap;font-size:14px;line-height:1.6';
      viBody.textContent = insight.summary_vi;
      viCard.appendChild(viBody);
      el.appendChild(viCard);
    }

    // Action buttons
    if (insight.status === 'pending') {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:16px';

      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'btn btn-sm';
      resolveBtn.style.cssText = 'background:#00b894;color:white';
      resolveBtn.textContent = 'Resolve';
      resolveBtn.onclick = async () => {
        await put('/daily-reviews/insights/' + insightId + '/resolve');
        renderInsightDetail(el, insightId);
      };
      actions.appendChild(resolveBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-sm';
      dismissBtn.style.cssText = 'background:#e17055;color:white';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.onclick = async () => {
        await put('/daily-reviews/insights/' + insightId + '/dismiss');
        renderInsightDetail(el, insightId);
      };
      actions.appendChild(dismissBtn);

      el.appendChild(actions);
    }

  } catch (err) {
    if (loading.parentNode === el) el.removeChild(loading);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load insight: ' + err.message;
    el.appendChild(errDiv);
  }
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
  // Detail routes
  if (params) {
    if (params.startsWith('insight/')) {
      await renderInsightDetail(app, params.slice(8));
    } else {
      await renderDetail(app, params);
    }
    return;
  }

  app.textContent = '';

  // Header + Run Now
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

  // Stats
  const statsEl = document.createElement('div');
  app.appendChild(statsEl);
  renderStats(statsEl);

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';
  const tabs = ['Suggestions', 'Cross-Project Insights'];
  const tabBtns = tabs.map((label, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    tabBar.appendChild(btn);
    return btn;
  });
  app.appendChild(tabBar);

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  filterBar.appendChild(dateInput);
  app.appendChild(filterBar);

  // Content area
  const contentEl = document.createElement('div');
  app.appendChild(contentEl);

  function showTab(index) {
    tabBtns.forEach((b, i) => b.className = 'tab-btn' + (i === index ? ' active' : ''));
    contentEl.textContent = '';
    if (index === 0) {
      renderList(contentEl, dateInput.value || undefined);
    } else {
      renderInsightList(contentEl, dateInput.value || undefined);
    }
  }

  tabBtns[0].onclick = () => showTab(0);
  tabBtns[1].onclick = () => showTab(1);
  dateInput.onchange = () => {
    const activeIdx = tabBtns.findIndex(b => b.classList.contains('active'));
    showTab(activeIdx);
  };

  // Initial render
  showTab(0);
}

export function unmount() {}
