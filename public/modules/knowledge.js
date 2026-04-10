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

// ── Node colors (for notes autocomplete) ─────────────────────────────────────

const NODE_COLORS = {
  tool:      '#00b894',
  component: '#6c5ce7',
  pattern:   '#e17055',
  instinct:  '#00cec9',
  session:   '#636e72',
  project:   '#fdcb6e',
  note:      '#74b9ff',
};

function nodeColor(type) {
  return NODE_COLORS[type] || '#8b8fa3';
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

// ── Tab 2: Notes ─────────────────────────────────────────────────────────────

function renderMarkdown(md) {
  // All user content is HTML-escaped first to prevent XSS (local-only tool)
  let html = escHtml(md);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:var(--bg);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;"><code>$2</code></pre>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:16px;margin:16px 0 8px;">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:20px;margin:16px 0 8px;">$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:12px;">$1</code>');
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, ref) => {
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.ref = escHtml(ref);
    a.className = 'note-backlink';
    a.style.cssText = 'color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);';
    a.textContent = '[[' + ref + ']]';
    return a.outerHTML;
  });
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  return html;
}

let notesState = { project: '', search: '', page: 1, perPage: 15 };

function renderNotesList(el) {
  el.textContent = '';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap;';

  const projectSelect = document.createElement('select');
  projectSelect.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px;';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All Projects';
  projectSelect.appendChild(allOpt);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search notes\u2026';
  searchInput.value = notesState.search;
  searchInput.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; flex:1; min-width:160px;';

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-primary';
  newBtn.textContent = '+ New Note';
  newBtn.style.cssText = 'margin-left:auto; padding:6px 16px; font-size:13px;';
  newBtn.addEventListener('click', () => { location.hash = '#knowledge/notes/new'; });

  header.appendChild(projectSelect);
  header.appendChild(searchInput);
  header.appendChild(newBtn);
  el.appendChild(header);

  const listEl = document.createElement('div');
  el.appendChild(listEl);

  const paginationEl = document.createElement('div');
  paginationEl.className = 'pagination';
  el.appendChild(paginationEl);

  get('/knowledge/projects').then(projects => {
    (projects || []).forEach(p => {
      const o = document.createElement('option');
      o.value = p.project_id;
      o.textContent = p.name || p.project_id;
      projectSelect.appendChild(o);
    });
    if (notesState.project) projectSelect.value = notesState.project;
  });

  function loadList() {
    listEl.textContent = '';
    const qs = new URLSearchParams();
    if (notesState.project) qs.set('project', notesState.project);
    if (notesState.search) qs.set('search', notesState.search);
    qs.set('page', notesState.page);
    qs.set('per_page', notesState.perPage);

    const loading = document.createElement('div');
    loading.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    loading.appendChild(sp);
    listEl.appendChild(loading);

    get('/knowledge/notes?' + qs.toString()).then(data => {
      listEl.textContent = '';
      if (data.items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = notesState.search ? 'No notes match your search.' : 'No notes yet. Create your first note!';
        listEl.appendChild(empty);
        paginationEl.textContent = '';
        return;
      }

      data.items.forEach(note => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'margin-bottom:10px; cursor:pointer; transition:border-color 0.15s;';
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = ''; });
        card.addEventListener('click', () => { location.hash = '#knowledge/notes/' + note.id; });

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size:14px; font-weight:600; color:var(--text);';
        titleEl.textContent = note.title;
        titleRow.appendChild(titleEl);

        const tags = typeof note.tags === 'string' ? JSON.parse(note.tags) : (note.tags || []);
        tags.forEach(t => {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.style.cssText = 'font-size:10px; padding:1px 8px;';
          badge.textContent = t;
          titleRow.appendChild(badge);
        });
        card.appendChild(titleRow);

        const excerpt = document.createElement('div');
        excerpt.style.cssText = 'font-size:12px; color:var(--text-muted); line-height:1.5; overflow:hidden; max-height:36px;';
        excerpt.textContent = note.body.replace(/[#*\[\]`]/g, '').slice(0, 120);
        card.appendChild(excerpt);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px; color:var(--text-muted); margin-top:6px;';
        meta.textContent = timeAgo(note.updated_at);
        card.appendChild(meta);

        listEl.appendChild(card);
      });

      paginationEl.textContent = '';
      const totalPages = Math.ceil(data.total / data.perPage);
      if (totalPages > 1) {
        const prev = document.createElement('button');
        prev.className = 'btn';
        prev.textContent = '\u2190 Prev';
        prev.disabled = notesState.page <= 1;
        prev.addEventListener('click', () => { notesState.page--; loadList(); });

        const info = document.createElement('span');
        info.className = 'page-info';
        info.textContent = 'Page ' + notesState.page + ' of ' + totalPages;

        const next = document.createElement('button');
        next.className = 'btn';
        next.textContent = 'Next \u2192';
        next.disabled = notesState.page >= totalPages;
        next.addEventListener('click', () => { notesState.page++; loadList(); });

        paginationEl.appendChild(prev);
        paginationEl.appendChild(info);
        paginationEl.appendChild(next);
      }
    });
  }

  projectSelect.addEventListener('change', () => { notesState.project = projectSelect.value; notesState.page = 1; loadList(); });
  searchInput.addEventListener('input', debounce(() => { notesState.search = searchInput.value; notesState.page = 1; loadList(); }, 300));

  loadList();
}

// ── Note Editor ──────────────────────────────────────────────────────────────

function renderNoteEditor(el, noteId) {
  el.textContent = '';
  const isNew = noteId === 'new';

  const breadcrumb = document.createElement('div');
  breadcrumb.style.cssText = 'margin-bottom:16px; font-size:13px; color:var(--text-muted);';
  const bcLink = document.createElement('a');
  bcLink.href = '#knowledge/notes';
  bcLink.style.cssText = 'color:var(--accent);text-decoration:none;';
  bcLink.textContent = 'Notes';
  breadcrumb.appendChild(bcLink);
  breadcrumb.appendChild(document.createTextNode(' / ' + (isNew ? 'New Note' : 'Edit')));
  el.appendChild(breadcrumb);

  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex; gap:16px; align-items:flex-start;';
  const editorCol = document.createElement('div');
  editorCol.style.cssText = 'flex:1; min-width:0;';
  const previewCol = document.createElement('div');
  previewCol.style.cssText = 'flex:1; min-width:0;';
  layout.appendChild(editorCol);
  layout.appendChild(previewCol);
  el.appendChild(layout);

  // Project selector (new note only)
  const projectSelect = document.createElement('select');
  projectSelect.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; margin-bottom:12px;';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Note title';
  titleInput.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:15px; font-weight:600; box-sizing:border-box; margin-bottom:12px;';

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.placeholder = 'Tags: api, architecture, deployment';
  tagsInput.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; box-sizing:border-box; margin-bottom:12px;';

  const bodyWrap = document.createElement('div');
  bodyWrap.style.cssText = 'position:relative; margin-bottom:12px;';
  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.placeholder = 'Write in Markdown... Use [[slug]] to link.';
  bodyTextarea.style.cssText = 'width:100%; min-height:400px; padding:12px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; font-family:"SF Mono",Monaco,Consolas,monospace; line-height:1.6; resize:vertical; box-sizing:border-box;';

  const acDropdown = document.createElement('div');
  acDropdown.style.cssText = 'position:absolute; background:var(--surface); border:1px solid var(--border); border-radius:6px; max-height:200px; overflow-y:auto; z-index:100; display:none; min-width:240px; box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  bodyWrap.appendChild(bodyTextarea);
  bodyWrap.appendChild(acDropdown);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex; gap:8px;';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = isNew ? 'Create Note' : 'Save Changes';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.style.display = isNew ? 'none' : '';
  actionsRow.appendChild(saveBtn);
  actionsRow.appendChild(deleteBtn);

  if (isNew) editorCol.appendChild(projectSelect);
  editorCol.appendChild(titleInput);
  editorCol.appendChild(tagsInput);
  editorCol.appendChild(bodyWrap);
  editorCol.appendChild(actionsRow);

  // Preview
  const previewCard = document.createElement('div');
  previewCard.className = 'card';
  previewCard.style.cssText = 'max-height:500px; overflow-y:auto;';
  const previewTitle = document.createElement('div');
  previewTitle.className = 'card-title';
  previewTitle.textContent = 'Preview';
  const previewBody = document.createElement('div');
  previewBody.style.cssText = 'font-size:13px; line-height:1.7; color:var(--text);';
  previewBody.textContent = 'Preview appears here...';
  previewCard.appendChild(previewTitle);
  previewCard.appendChild(previewBody);
  previewCol.appendChild(previewCard);

  // Backlinks
  const backlinksCard = document.createElement('div');
  backlinksCard.className = 'card';
  backlinksCard.style.cssText = 'margin-top:12px;';
  const backlinksTitle = document.createElement('div');
  backlinksTitle.className = 'card-title';
  backlinksTitle.textContent = 'What links here';
  const backlinksList = document.createElement('div');
  backlinksList.style.cssText = 'font-size:12px;';
  backlinksCard.appendChild(backlinksTitle);
  backlinksCard.appendChild(backlinksList);
  previewCol.appendChild(backlinksCard);

  function updatePreview() {
    const md = bodyTextarea.value;
    if (md) {
      // Content is HTML-escaped inside renderMarkdown before any transformation
      previewBody.innerHTML = renderMarkdown(md);
    } else {
      previewBody.textContent = 'Preview appears here...';
    }
  }
  bodyTextarea.addEventListener('input', debounce(updatePreview, 200));

  // Autocomplete for [[
  let acActive = false;
  let noteData = null;

  bodyTextarea.addEventListener('input', () => {
    const val = bodyTextarea.value;
    const pos = bodyTextarea.selectionStart;
    const before = val.slice(0, pos);
    const match = before.match(/\[\[([^\]]*?)$/);

    if (match) {
      const query = match[1];
      const projectId = isNew ? projectSelect.value : (noteData && noteData.project_id);
      if (!projectId) { acDropdown.style.display = 'none'; return; }

      get('/knowledge/autocomplete?project=' + encodeURIComponent(projectId) + '&q=' + encodeURIComponent(query)).then(results => {
        acDropdown.textContent = '';
        if (results.length === 0) { acDropdown.style.display = 'none'; return; }
        results.slice(0, 12).forEach(r => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 12px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:6px;';
          item.addEventListener('mouseenter', () => { item.style.background = 'rgba(108,92,231,0.1)'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });

          const dot = document.createElement('span');
          dot.style.cssText = 'width:6px; height:6px; border-radius:50%; flex-shrink:0; background:' + nodeColor(r.type) + ';';
          const label = document.createElement('span');
          label.textContent = r.label;
          const typeTag = document.createElement('span');
          typeTag.style.cssText = 'font-size:10px; color:var(--text-muted); margin-left:auto;';
          typeTag.textContent = r.type;
          item.appendChild(dot);
          item.appendChild(label);
          item.appendChild(typeTag);

          item.addEventListener('click', () => {
            const insertVal = r.value + ']]';
            bodyTextarea.value = before.slice(0, before.length - match[1].length) + insertVal + val.slice(pos);
            bodyTextarea.focus();
            const newPos = before.length - match[1].length + insertVal.length;
            bodyTextarea.setSelectionRange(newPos, newPos);
            acDropdown.style.display = 'none';
            acActive = false;
            updatePreview();
          });
          acDropdown.appendChild(item);
        });
        acDropdown.style.display = 'block';
        acDropdown.style.top = (bodyTextarea.offsetHeight + 4) + 'px';
        acDropdown.style.left = '0px';
        acActive = true;
      });
    } else {
      acDropdown.style.display = 'none';
      acActive = false;
    }
  });

  bodyTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && acActive) { acDropdown.style.display = 'none'; acActive = false; e.preventDefault(); }
  });

  // Load data
  if (isNew) {
    get('/knowledge/projects').then(projects => {
      (projects || []).forEach(p => {
        const o = document.createElement('option');
        o.value = p.project_id;
        o.textContent = p.name || p.project_id;
        projectSelect.appendChild(o);
      });
    });
  } else {
    get('/knowledge/notes/' + noteId).then(data => {
      noteData = data;
      if (data.error) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'empty-state';
        err.textContent = 'Note not found.';
        el.appendChild(err);
        return;
      }
      titleInput.value = data.title;
      const tags = typeof data.tags === 'string' ? JSON.parse(data.tags) : (data.tags || []);
      tagsInput.value = tags.join(', ');
      bodyTextarea.value = data.body;
      breadcrumb.lastChild.textContent = ' / ' + data.title;
      updatePreview();

      (data.backlinks || []).forEach(bl => {
        const link = document.createElement('a');
        link.href = '#knowledge/notes/' + bl.id;
        link.style.cssText = 'display:block; padding:4px 0; color:var(--accent); text-decoration:none;';
        link.textContent = bl.title;
        backlinksList.appendChild(link);
      });
      if ((data.backlinks || []).length === 0) {
        backlinksList.textContent = 'No backlinks yet.';
        backlinksList.style.color = 'var(--text-muted)';
      }
    });
  }

  // Save
  saveBtn.addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) { alert('Title is required'); return; }
    const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
    const body = bodyTextarea.value;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';

    if (isNew) {
      const project_id = projectSelect.value;
      if (!project_id) { alert('Select a project'); saveBtn.disabled = false; saveBtn.textContent = 'Create Note'; return; }
      post('/knowledge/notes', { project_id, title, body, tags }).then(created => {
        location.hash = '#knowledge/notes/' + created.id;
      }).catch(err => { alert('Error: ' + err.message); saveBtn.disabled = false; saveBtn.textContent = 'Create Note'; });
    } else {
      put('/knowledge/notes/' + noteId, { title, body, tags }).then(() => {
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }, 1500);
      }).catch(err => { alert('Error: ' + err.message); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; });
    }
  });

  deleteBtn.addEventListener('click', () => {
    if (!confirm('Delete this note permanently?')) return;
    del('/knowledge/notes/' + noteId).then(() => { location.hash = '#knowledge/notes'; }).catch(err => alert('Error: ' + err.message));
  });
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

const TABS = [
  { key: 'entries', label: 'Entries' },
  { key: 'notes',   label: 'Notes' },
  { key: 'scan',    label: 'Scan' },
];
let activeTab = 'entries';

export function mount(el, { params } = {}) {
  let subRoute = null;
  if (params) {
    const parts = params.split('/').filter(Boolean);
    if (parts[0] === 'notes' && parts.length >= 2) {
      subRoute = parts.slice(1).join('/');
      activeTab = 'notes';
    } else if (parts[0] === 'notes') {
      activeTab = 'notes';
    } else if (parts[0] === 'scan') {
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
    if (tab === 'notes') {
      if (subRoute) renderNoteEditor(content, subRoute);
      else renderNotesList(content);
    } else if (tab === 'scan') {
      renderScan(content);
    } else {
      renderEntriesList(content);
    }
  }

  loadTab(activeTab);
}

export function unmount() {
}
