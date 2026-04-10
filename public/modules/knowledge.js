import { get, post, put, del } from './api.js';
import { escHtml, debounce } from './utils.js';

// ── Utilities ─────────────────────────────────────────────────────────────────

function timeAgo(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// ── Category badge colors ─────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  domain:        '#fdcb6e',
  stack:         '#00b894',
  schema:        '#6c5ce7',
  api:           '#74b9ff',
  feature:       '#e17055',
  architecture:  '#00cec9',
  convention:    '#636e72',
  decision:      '#a29bfe',
  footgun:       '#d63031',
  contract:      '#0984e3',
  error_pattern: '#e84393',
};

const CATEGORIES = [
  'domain', 'stack', 'schema', 'api', 'feature',
  'architecture', 'convention', 'decision', 'footgun', 'contract', 'error_pattern',
];

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#8b8fa3';
}

function categoryBadge(cat) {
  const color = categoryColor(cat);
  const span = document.createElement('span');
  span.className = 'badge';
  span.style.cssText = 'background:' + color + '26; color:' + color + '; font-size:10px; padding:2px 8px;';
  span.textContent = cat || 'unknown';
  return span;
}

// ── Tab 1: Entries ────────────────────────────────────────────────────────────

let entriesState = { project: '', category: '', status: 'active', page: 1, perPage: 20 };

function renderEntriesList(el) {
  el.textContent = '';

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap;';

  const projectSelect = document.createElement('select');
  projectSelect.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px;';
  const allProjectsOpt = document.createElement('option');
  allProjectsOpt.value = '';
  allProjectsOpt.textContent = 'All Projects';
  projectSelect.appendChild(allProjectsOpt);

  const categorySelect = document.createElement('select');
  categorySelect.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px;';
  const allCatOpt = document.createElement('option');
  allCatOpt.value = '';
  allCatOpt.textContent = 'All Categories';
  categorySelect.appendChild(allCatOpt);
  CATEGORIES.forEach(cat => {
    const o = document.createElement('option');
    o.value = cat;
    o.textContent = cat;
    categorySelect.appendChild(o);
  });
  if (entriesState.category) categorySelect.value = entriesState.category;

  // Status filter buttons
  const statusBar = document.createElement('div');
  statusBar.style.cssText = 'display:flex; gap:6px; margin-left:auto;';
  ['all', 'active', 'outdated'].forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (entriesState.status === s ? ' btn-primary' : '');
    btn.style.cssText = 'padding:4px 12px; font-size:12px;';
    btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    btn.dataset.status = s;
    btn.addEventListener('click', () => {
      entriesState.status = s;
      entriesState.page = 1;
      statusBar.querySelectorAll('button').forEach(b => {
        b.className = 'btn' + (b.dataset.status === s ? ' btn-primary' : '');
      });
      loadList();
    });
    statusBar.appendChild(btn);
  });

  filterBar.appendChild(projectSelect);
  filterBar.appendChild(categorySelect);
  filterBar.appendChild(statusBar);
  el.appendChild(filterBar);

  // Stats row
  const statsRow = document.createElement('div');
  statsRow.style.cssText = 'margin-bottom:16px; font-size:12px; color:var(--text-muted);';
  el.appendChild(statsRow);

  // List container
  const listEl = document.createElement('div');
  el.appendChild(listEl);

  // Pagination
  const paginationEl = document.createElement('div');
  paginationEl.className = 'pagination';
  el.appendChild(paginationEl);

  // Load projects dropdown
  get('/knowledge/projects').then(projects => {
    (projects || []).forEach(p => {
      const o = document.createElement('option');
      o.value = p.project_id;
      o.textContent = p.name || p.project_id;
      projectSelect.appendChild(o);
    });
    if (entriesState.project) projectSelect.value = entriesState.project;
  });

  // Load stats
  function loadStats() {
    const qs = new URLSearchParams();
    if (entriesState.project) qs.set('project', entriesState.project);
    get('/knowledge/entries/stats?' + qs.toString()).then(stats => {
      statsRow.textContent = '';
      const total = stats.total || 0;
      const totalSpan = document.createElement('span');
      totalSpan.style.fontWeight = '600';
      totalSpan.textContent = total + ' entries';
      statsRow.appendChild(totalSpan);

      const topCats = (stats.by_category || []).slice(0, 3);
      if (topCats.length > 0) {
        statsRow.appendChild(document.createTextNode(' — '));
        topCats.forEach((item, i) => {
          if (i > 0) statsRow.appendChild(document.createTextNode(', '));
          const dot = document.createElement('span');
          dot.style.cssText = 'display:inline-block; width:8px; height:8px; border-radius:50%; background:' + categoryColor(item.category) + '; margin-right:3px;';
          statsRow.appendChild(dot);
          const t = document.createElement('span');
          t.textContent = item.category + ' (' + item.count + ')';
          statsRow.appendChild(t);
        });
      }
    }).catch(() => {});
  }

  // Load list
  function loadList() {
    listEl.textContent = '';
    paginationEl.textContent = '';
    loadStats();

    const qs = new URLSearchParams();
    if (entriesState.project) qs.set('project', entriesState.project);
    if (entriesState.category) qs.set('category', entriesState.category);
    if (entriesState.status && entriesState.status !== 'all') qs.set('status', entriesState.status);
    qs.set('page', entriesState.page);
    qs.set('per_page', entriesState.perPage);

    const loading = document.createElement('div');
    loading.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    loading.appendChild(sp);
    listEl.appendChild(loading);

    get('/knowledge/entries?' + qs.toString()).then(data => {
      listEl.textContent = '';
      const items = data.items || data.rows || [];
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No entries found.';
        listEl.appendChild(empty);
        return;
      }

      items.forEach(entry => {
        renderEntryCard(listEl, entry, loadList);
      });

      paginationEl.textContent = '';
      const totalPages = Math.ceil((data.total || 0) / (data.perPage || entriesState.perPage));
      if (totalPages > 1) {
        const prev = document.createElement('button');
        prev.className = 'btn';
        prev.textContent = '\u2190 Prev';
        prev.disabled = entriesState.page <= 1;
        prev.addEventListener('click', () => { entriesState.page--; loadList(); });

        const info = document.createElement('span');
        info.className = 'page-info';
        info.textContent = 'Page ' + entriesState.page + ' of ' + totalPages;

        const next = document.createElement('button');
        next.className = 'btn';
        next.textContent = 'Next \u2192';
        next.disabled = entriesState.page >= totalPages;
        next.addEventListener('click', () => { entriesState.page++; loadList(); });

        paginationEl.appendChild(prev);
        paginationEl.appendChild(info);
        paginationEl.appendChild(next);
      }
    }).catch(err => {
      listEl.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'empty-state';
      errEl.style.color = 'var(--danger)';
      errEl.textContent = 'Failed to load entries: ' + err.message;
      listEl.appendChild(errEl);
    });
  }

  projectSelect.addEventListener('change', () => { entriesState.project = projectSelect.value; entriesState.page = 1; loadList(); });
  categorySelect.addEventListener('change', () => { entriesState.category = categorySelect.value; entriesState.page = 1; loadList(); });

  loadList();
}

function renderEntryCard(container, entry, onRefresh) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:10px; cursor:pointer; transition:border-color 0.15s;';

  let expanded = false;

  // Card summary row
  const summary = document.createElement('div');

  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;';

  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-size:14px; font-weight:600; color:var(--text);';
  titleEl.textContent = entry.title || '(no title)';
  titleRow.appendChild(titleEl);

  titleRow.appendChild(categoryBadge(entry.category));

  if (entry.status === 'outdated') {
    const outdatedBadge = document.createElement('span');
    outdatedBadge.className = 'badge';
    outdatedBadge.style.cssText = 'background:#d6303126; color:#d63031; font-size:10px; padding:2px 8px;';
    outdatedBadge.textContent = 'outdated';
    titleRow.appendChild(outdatedBadge);
  }

  summary.appendChild(titleRow);

  if (entry.source_file) {
    const srcEl = document.createElement('div');
    srcEl.style.cssText = 'font-size:11px; color:var(--text-muted); margin-bottom:4px; font-family:monospace;';
    srcEl.textContent = entry.source_file;
    summary.appendChild(srcEl);
  }

  const excerpt = document.createElement('div');
  excerpt.style.cssText = 'font-size:12px; color:var(--text-muted); line-height:1.5;';
  excerpt.textContent = (entry.body || '').slice(0, 120) + ((entry.body || '').length > 120 ? '\u2026' : '');
  summary.appendChild(excerpt);

  const metaRow = document.createElement('div');
  metaRow.style.cssText = 'font-size:11px; color:var(--text-muted); margin-top:6px;';
  metaRow.textContent = timeAgo(entry.updated_at || entry.created_at);
  summary.appendChild(metaRow);

  card.appendChild(summary);

  // Expanded detail (hidden initially)
  const detail = document.createElement('div');
  detail.style.cssText = 'display:none; margin-top:12px; border-top:1px solid var(--border); padding-top:12px;';

  // Full body display
  const bodyDisplay = document.createElement('div');
  bodyDisplay.style.cssText = 'font-size:13px; line-height:1.7; color:var(--text); white-space:pre-wrap; margin-bottom:12px;';
  bodyDisplay.textContent = entry.body || '';

  // Edit form (hidden initially)
  const editForm = document.createElement('div');
  editForm.style.display = 'none';

  const editTitle = document.createElement('input');
  editTitle.type = 'text';
  editTitle.value = entry.title || '';
  editTitle.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:14px; font-weight:600; box-sizing:border-box; margin-bottom:8px;';

  const editCategorySelect = document.createElement('select');
  editCategorySelect.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; margin-bottom:8px;';
  CATEGORIES.forEach(cat => {
    const o = document.createElement('option');
    o.value = cat;
    o.textContent = cat;
    if (cat === entry.category) o.selected = true;
    editCategorySelect.appendChild(o);
  });

  const editBody = document.createElement('textarea');
  editBody.value = entry.body || '';
  editBody.style.cssText = 'width:100%; min-height:200px; padding:10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; font-family:"SF Mono",Monaco,Consolas,monospace; line-height:1.6; resize:vertical; box-sizing:border-box; margin-bottom:8px;';

  editForm.appendChild(editTitle);
  editForm.appendChild(editCategorySelect);
  editForm.appendChild(editBody);

  // Actions row
  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.style.cssText = 'padding:4px 12px; font-size:12px;';
  editBtn.textContent = 'Edit';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.style.cssText = 'padding:4px 12px; font-size:12px; display:none;';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.style.cssText = 'padding:4px 12px; font-size:12px; display:none;';
  cancelBtn.textContent = 'Cancel';

  const outdatedBtn = document.createElement('button');
  outdatedBtn.className = 'btn';
  outdatedBtn.style.cssText = 'padding:4px 12px; font-size:12px;';
  outdatedBtn.textContent = entry.status === 'outdated' ? 'Mark Active' : 'Mark Outdated';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.style.cssText = 'padding:4px 12px; font-size:12px; margin-left:auto;';
  deleteBtn.textContent = 'Delete';

  actionsRow.appendChild(editBtn);
  actionsRow.appendChild(saveBtn);
  actionsRow.appendChild(cancelBtn);
  actionsRow.appendChild(outdatedBtn);
  actionsRow.appendChild(deleteBtn);

  detail.appendChild(bodyDisplay);
  detail.appendChild(editForm);
  detail.appendChild(actionsRow);
  card.appendChild(detail);

  // Toggle expand on summary click
  card.addEventListener('mouseenter', () => { if (!expanded) card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('mouseleave', () => { if (!expanded) card.style.borderColor = ''; });

  summary.addEventListener('click', () => {
    expanded = !expanded;
    detail.style.display = expanded ? 'block' : 'none';
    card.style.borderColor = expanded ? 'var(--accent)' : '';
  });

  // Edit mode toggle
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bodyDisplay.style.display = 'none';
    editForm.style.display = 'block';
    editBtn.style.display = 'none';
    saveBtn.style.display = '';
    cancelBtn.style.display = '';
    outdatedBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
  });

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editTitle.value = entry.title || '';
    editCategorySelect.value = entry.category || '';
    editBody.value = entry.body || '';
    bodyDisplay.style.display = 'block';
    editForm.style.display = 'none';
    editBtn.style.display = '';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    outdatedBtn.style.display = '';
    deleteBtn.style.display = '';
  });

  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';
    put('/knowledge/entries/' + entry.id, {
      title: editTitle.value.trim(),
      category: editCategorySelect.value,
      body: editBody.value,
    }).then(() => {
      onRefresh();
    }).catch(err => {
      alert('Save failed: ' + err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });
  });

  outdatedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    outdatedBtn.disabled = true;
    const newStatus = entry.status === 'outdated' ? 'active' : 'outdated';
    put('/knowledge/entries/' + entry.id + '/outdated', { status: newStatus }).then(() => {
      onRefresh();
    }).catch(err => {
      alert('Failed: ' + err.message);
      outdatedBtn.disabled = false;
    });
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm('Delete this entry permanently?')) return;
    del('/knowledge/entries/' + entry.id).then(() => {
      onRefresh();
    }).catch(err => alert('Delete failed: ' + err.message));
  });

  container.appendChild(card);
}

// ── Tab 3: Scan ───────────────────────────────────────────────────────────────

function buildTh(text, align) {
  const th = document.createElement('th');
  th.textContent = text;
  if (align) th.style.textAlign = align;
  return th;
}

function renderScan(el) {
  el.textContent = '';

  const loading = document.createElement('div');
  loading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  loading.appendChild(sp);
  el.appendChild(loading);

  get('/knowledge/projects').then(projects => {
    el.removeChild(loading);

    const projects2 = projects || [];
    if (projects2.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No projects found.';
      el.appendChild(empty);
      return;
    }

    const tableCard = document.createElement('div');
    tableCard.className = 'card';

    const tableTitle = document.createElement('div');
    tableTitle.className = 'card-title';
    tableTitle.textContent = 'Projects';
    tableCard.appendChild(tableTitle);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'sessions-table-wrap';
    tableCard.appendChild(tableWrap);

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.appendChild(buildTh('Project Name', null));
    headerRow.appendChild(buildTh('Entries', 'center'));
    headerRow.appendChild(buildTh('Last Scan', 'center'));
    headerRow.appendChild(buildTh('Actions', 'right'));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    projects2.forEach(proj => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'default';

      const tdName = document.createElement('td');
      tdName.style.fontWeight = '600';
      tdName.textContent = proj.name || proj.project_id || '\u2014';

      const tdEntries = document.createElement('td');
      tdEntries.style.textAlign = 'center';
      tdEntries.textContent = String(proj.entry_count || 0);

      const tdLastScan = document.createElement('td');
      tdLastScan.style.textAlign = 'center';
      tdLastScan.textContent = proj.last_scan ? timeAgo(proj.last_scan) : '\u2014';

      const tdActions = document.createElement('td');
      tdActions.style.cssText = 'text-align:right; white-space:nowrap;';

      const scanBtn = document.createElement('button');
      scanBtn.className = 'btn btn-primary';
      scanBtn.style.cssText = 'padding:4px 12px; font-size:12px;';
      scanBtn.textContent = 'Scan';

      const projectId = proj.project_id || proj.name;

      scanBtn.addEventListener('click', () => {
        scanBtn.disabled = true;
        scanBtn.textContent = '';
        const btnSp = document.createElement('span');
        btnSp.className = 'spinner';
        btnSp.style.cssText = 'width:12px; height:12px; border-width:2px; display:inline-block; margin-right:4px;';
        scanBtn.appendChild(btnSp);
        scanBtn.appendChild(document.createTextNode('Scanning\u2026'));

        post('/knowledge/scan', { project_id: projectId }).then(() => {
          scanBtn.textContent = 'Done';
          setTimeout(() => {
            scanBtn.disabled = false;
            scanBtn.textContent = 'Scan';
          }, 2000);
        }).catch(err => {
          scanBtn.disabled = false;
          scanBtn.textContent = 'Scan';
          alert('Scan failed: ' + err.message);
        });
      });

      tdActions.appendChild(scanBtn);
      tr.appendChild(tdName);
      tr.appendChild(tdEntries);
      tr.appendChild(tdLastScan);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    el.appendChild(tableCard);
  }).catch(err => {
    loading.textContent = 'Failed to load projects: ' + err.message;
    loading.style.color = 'var(--danger)';
  });
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

const TABS = [
  { key: 'entries', label: 'Entries' },
  { key: 'scan',    label: 'Scan' },
];
let activeTab = 'entries';

export function mount(el, { params } = {}) {
  if (params) {
    const parts = params.split('/').filter(Boolean);
    if (parts[0] === 'scan') {
      activeTab = 'scan';
    } else if (parts[0] === 'entries') {
      activeTab = 'entries';
    }
  }

  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';
  const content = document.createElement('div');

  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (tab.key === activeTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.dataset.tab = tab.key;
    btn.addEventListener('click', () => {
      activeTab = tab.key;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab.key));
      location.hash = '#knowledge/' + tab.key;
    });
    tabsEl.appendChild(btn);
  });

  el.appendChild(tabsEl);
  el.appendChild(content);

  function loadTab(tab) {
    content.textContent = '';
    if (tab === 'scan') {
      renderScan(content);
    } else {
      renderEntriesList(content);
    }
  }

  loadTab(activeTab);
}

export function unmount() {
}
