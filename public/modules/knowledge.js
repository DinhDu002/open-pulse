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
        renderEntryCard(listEl, entry);
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

function renderEntryCard(container, entry) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:10px; cursor:pointer; transition:border-color 0.15s;';

  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;';

  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-size:14px; font-weight:600; color:var(--text);';
  titleEl.textContent = entry.title || '(no title)';
  titleRow.appendChild(titleEl);

  titleRow.appendChild(categoryBadge(entry.category));

  const statusBadge = document.createElement('span');
  statusBadge.className = 'badge';
  if (entry.status === 'outdated') {
    statusBadge.style.cssText = 'background:#d6303126; color:#d63031; font-size:10px; padding:2px 8px; margin-left:auto;';
    statusBadge.textContent = 'outdated';
  } else {
    statusBadge.style.cssText = 'background:#00b89426; color:#00b894; font-size:10px; padding:2px 8px; margin-left:auto;';
    statusBadge.textContent = 'active';
  }
  titleRow.appendChild(statusBadge);

  card.appendChild(titleRow);

  if (entry.source_file) {
    const srcEl = document.createElement('div');
    srcEl.style.cssText = 'font-size:11px; color:var(--text-muted); margin-bottom:4px; font-family:monospace;';
    srcEl.textContent = entry.source_file;
    card.appendChild(srcEl);
  }

  const excerpt = document.createElement('div');
  excerpt.style.cssText = 'font-size:12px; color:var(--text-muted); line-height:1.5;';
  excerpt.textContent = (entry.body || '').slice(0, 120) + ((entry.body || '').length > 120 ? '\u2026' : '');
  card.appendChild(excerpt);

  const metaRow = document.createElement('div');
  metaRow.style.cssText = 'font-size:11px; color:var(--text-muted); margin-top:6px;';
  metaRow.textContent = timeAgo(entry.updated_at || entry.created_at);
  card.appendChild(metaRow);

  card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.borderColor = ''; });

  card.addEventListener('click', () => {
    location.hash = '#knowledge/entries/' + entry.id;
  });

  container.appendChild(card);
}

// ── Detail Page ───────────────────────────────────────────────────────────────

async function renderDetail(el, entryId) {
  el.textContent = '';

  // Loading spinner
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  loading.appendChild(sp);
  el.appendChild(loading);

  let entry, history;
  try {
    [entry, history] = await Promise.all([
      get('/knowledge/entries/' + entryId),
      get('/knowledge/entries/' + entryId + '/history'),
    ]);
  } catch (err) {
    el.textContent = '';
    const errEl = document.createElement('div');
    errEl.className = 'empty-state';
    errEl.style.color = 'var(--danger)';
    errEl.textContent = 'Failed to load entry: ' + err.message;
    el.appendChild(errEl);
    return;
  }

  el.textContent = '';

  // Back link
  const backLink = document.createElement('a');
  backLink.href = '#knowledge/entries';
  backLink.style.cssText = 'display:inline-block; font-size:13px; color:var(--accent); text-decoration:none; margin-bottom:16px;';
  backLink.textContent = '\u2190 Back to Entries';
  el.appendChild(backLink);

  // Header card
  const headerCard = document.createElement('div');
  headerCard.className = 'card';
  headerCard.style.cssText = 'margin-bottom:16px;';

  const headerTop = document.createElement('div');
  headerTop.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px;';

  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-size:18px; font-weight:700; color:var(--text);';
  titleEl.textContent = entry.title || '(no title)';
  headerTop.appendChild(titleEl);

  headerTop.appendChild(categoryBadge(entry.category));

  const statusBadge = document.createElement('span');
  statusBadge.className = 'badge';
  if (entry.status === 'outdated') {
    statusBadge.style.cssText = 'background:#d6303126; color:#d63031; font-size:10px; padding:2px 8px; margin-left:auto;';
    statusBadge.textContent = 'outdated';
  } else {
    statusBadge.style.cssText = 'background:#00b89426; color:#00b894; font-size:10px; padding:2px 8px; margin-left:auto;';
    statusBadge.textContent = 'active';
  }
  headerTop.appendChild(statusBadge);

  headerCard.appendChild(headerTop);

  // Body display
  const bodyDisplay = document.createElement('div');
  bodyDisplay.style.cssText = 'font-size:13px; line-height:1.7; color:var(--text); white-space:pre-wrap; margin-bottom:12px;';
  bodyDisplay.textContent = entry.body || '';
  headerCard.appendChild(bodyDisplay);

  // Meta row
  const metaRow = document.createElement('div');
  metaRow.style.cssText = 'font-size:11px; color:var(--text-muted); margin-bottom:12px; display:flex; gap:16px; flex-wrap:wrap;';
  if (entry.source_file) {
    const src = document.createElement('span');
    src.style.fontFamily = 'monospace';
    src.textContent = entry.source_file;
    metaRow.appendChild(src);
  }
  const created = document.createElement('span');
  created.textContent = 'Created ' + timeAgo(entry.created_at);
  metaRow.appendChild(created);
  if (entry.updated_at && entry.updated_at !== entry.created_at) {
    const updated = document.createElement('span');
    updated.textContent = 'Updated ' + timeAgo(entry.updated_at);
    metaRow.appendChild(updated);
  }
  headerCard.appendChild(metaRow);

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
  headerCard.appendChild(editForm);

  // Action buttons
  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; align-items:center;';

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
  headerCard.appendChild(actionsRow);

  el.appendChild(headerCard);

  // Change History
  renderHistory(el, history || []);

  // Edit mode toggle
  editBtn.addEventListener('click', () => {
    bodyDisplay.style.display = 'none';
    metaRow.style.display = 'none';
    editForm.style.display = 'block';
    editBtn.style.display = 'none';
    saveBtn.style.display = '';
    cancelBtn.style.display = '';
    outdatedBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
  });

  cancelBtn.addEventListener('click', () => {
    editTitle.value = entry.title || '';
    editCategorySelect.value = entry.category || '';
    editBody.value = entry.body || '';
    bodyDisplay.style.display = 'block';
    metaRow.style.display = 'flex';
    editForm.style.display = 'none';
    editBtn.style.display = '';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    outdatedBtn.style.display = '';
    deleteBtn.style.display = '';
  });

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';
    put('/knowledge/entries/' + entry.id, {
      title: editTitle.value.trim(),
      category: editCategorySelect.value,
      body: editBody.value,
    }).then(() => {
      location.reload();
    }).catch(err => {
      alert('Save failed: ' + err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });
  });

  outdatedBtn.addEventListener('click', () => {
    outdatedBtn.disabled = true;
    const newStatus = entry.status === 'outdated' ? 'active' : 'outdated';
    put('/knowledge/entries/' + entry.id + '/outdated', { status: newStatus }).then(() => {
      location.reload();
    }).catch(err => {
      alert('Failed: ' + err.message);
      outdatedBtn.disabled = false;
    });
  });

  deleteBtn.addEventListener('click', () => {
    if (!confirm('Delete this entry permanently?')) return;
    del('/knowledge/entries/' + entry.id).then(() => {
      location.hash = '#knowledge/entries';
    }).catch(err => alert('Delete failed: ' + err.message));
  });
}

// ── Change History ────────────────────────────────────────────────────────────

function renderHistory(el, history) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '16px';

  const cardTitle = document.createElement('div');
  cardTitle.className = 'card-title';
  cardTitle.textContent = 'Change History (' + history.length + ')';
  card.appendChild(cardTitle);

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px; color:var(--text-muted); padding:8px 0;';
    empty.textContent = 'No changes recorded yet.';
    card.appendChild(empty);
    el.appendChild(card);
    return;
  }

  // Render history items in reverse chronological order (newest first)
  const items = [...history].reverse();

  items.forEach((item, idx) => {
    const itemEl = document.createElement('div');
    itemEl.style.cssText = 'border-top:1px solid var(--border); padding:12px 0;' + (idx === 0 ? 'border-top:none;' : '');

    // Header: timeAgo + change_type badge
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';

    const timeEl = document.createElement('span');
    timeEl.style.cssText = 'font-size:12px; color:var(--text-muted);';
    timeEl.textContent = timeAgo(item.changed_at);
    header.appendChild(timeEl);

    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge';
    let badgeColor = '#0984e3';
    if (item.change_type === 'created') badgeColor = '#00b894';
    else if (item.change_type === 'status_changed') badgeColor = '#e17055';
    typeBadge.style.cssText = 'background:' + badgeColor + '26; color:' + badgeColor + '; font-size:10px; padding:2px 8px;';
    typeBadge.textContent = item.change_type;
    header.appendChild(typeBadge);

    itemEl.appendChild(header);

    if (item.change_type === 'created') {
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:13px; color:var(--text-muted);';
      msg.textContent = "Entry created with category '" + (item.snapshot.category || 'unknown') + "'";
      itemEl.appendChild(msg);
    } else {
      // For updated/status_changed: find next item's snapshot (or current state) as "after"
      // The snapshot stored is the state BEFORE the change
      // next item in reverse = previous change = the "after" state of this item
      // We need to find what it changed TO. Since history is stored as pre-change snapshots,
      // for item[i] (reversed), the "after" state is the snapshot of item[i-1] (reversed)
      // i.e., the snapshot of the PREVIOUS item in original order
      // In reversed array: items[idx] is the snapshot before this change
      // items[idx-1] would be the snapshot before the previous change (= after this change)
      // The "after" for the last change (idx=0 in reversed = most recent) is the current entry state
      // We'll get current entry via the parent scope — but we don't have it here easily.
      // Instead, find what changed by comparing to the next recorded snapshot in original order.
      const originalIdx = history.length - 1 - idx;
      const afterSnapshot = originalIdx + 1 < history.length
        ? history[originalIdx + 1].snapshot
        : null; // current state not available in history items; skip showing "after" for most recent

      if (afterSnapshot) {
        const diffContainer = document.createElement('div');
        renderDiff(diffContainer, item.snapshot, afterSnapshot);
        itemEl.appendChild(diffContainer);
      } else {
        // Most recent change — just show the snapshot fields
        const snap = item.snapshot;
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:13px; color:var(--text-muted);';
        msg.textContent = item.change_type === 'status_changed'
          ? "Status changed (was '" + snap.status + "')"
          : 'Entry updated';
        itemEl.appendChild(msg);
      }
    }

    card.appendChild(itemEl);
  });

  el.appendChild(card);
}

// ── Diff Display ─────────────────────────────────────────────────────────────

function renderDiff(container, oldSnap, newSnap) {
  const fields = ['title', 'category', 'status', 'body'];

  fields.forEach(field => {
    const oldVal = (oldSnap[field] || '');
    const newVal = (newSnap[field] || '');
    if (oldVal === newVal) return;

    const fieldEl = document.createElement('div');
    fieldEl.style.cssText = 'margin-bottom:8px;';

    const fieldLabel = document.createElement('div');
    fieldLabel.style.cssText = 'font-size:11px; color:var(--text-muted); margin-bottom:4px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;';
    fieldLabel.textContent = field;
    fieldEl.appendChild(fieldLabel);

    if (field === 'body') {
      // Line-level diff
      const oldLines = oldVal.split('\n');
      const newLines = newVal.split('\n');

      const diffEl = document.createElement('div');
      diffEl.style.cssText = 'font-size:12px; font-family:"SF Mono",Monaco,Consolas,monospace; line-height:1.6;';

      // Simple LCS-based diff: find removed and added lines
      const removed = [];
      const added = [];
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);

      oldLines.forEach(line => {
        if (!newSet.has(line)) removed.push(line);
      });
      newLines.forEach(line => {
        if (!oldSet.has(line)) added.push(line);
      });

      // Show removed lines
      removed.forEach(line => {
        const lineEl = document.createElement('div');
        lineEl.style.cssText = 'background:#d6303120; border-left:3px solid #d63031; padding:2px 8px; white-space:pre-wrap; word-break:break-word;';
        lineEl.textContent = '- ' + line;
        diffEl.appendChild(lineEl);
      });

      // Show added lines
      added.forEach(line => {
        const lineEl = document.createElement('div');
        lineEl.style.cssText = 'background:#00b89420; border-left:3px solid #00b894; padding:2px 8px; white-space:pre-wrap; word-break:break-word;';
        lineEl.textContent = '+ ' + line;
        diffEl.appendChild(lineEl);
      });

      if (removed.length === 0 && added.length === 0) return; // no visible diff
      fieldEl.appendChild(diffEl);
    } else {
      // Inline old → new for short fields
      const inlineEl = document.createElement('div');
      inlineEl.style.cssText = 'font-size:13px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;';

      const oldSpan = document.createElement('span');
      oldSpan.style.cssText = 'text-decoration:line-through; color:#d63031;';
      oldSpan.textContent = oldVal || '(empty)';
      inlineEl.appendChild(oldSpan);

      const arrow = document.createElement('span');
      arrow.style.cssText = 'color:var(--text-muted);';
      arrow.textContent = '\u2192';
      inlineEl.appendChild(arrow);

      const newSpan = document.createElement('span');
      newSpan.style.cssText = 'color:#00b894;';
      newSpan.textContent = newVal || '(empty)';
      inlineEl.appendChild(newSpan);

      fieldEl.appendChild(inlineEl);
    }

    container.appendChild(fieldEl);
  });
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

        post('/knowledge/scan', { project_id: projectId }).then(result => {
          const count = result.extracted || 0;
          scanBtn.textContent = count > 0 ? count + ' entries extracted' : 'No new entries';
          // Update entry count in table
          if (count > 0) {
            const current = parseInt(tdEntries.textContent) || 0;
            tdEntries.textContent = String(current + (result.inserted || 0));
          }
          setTimeout(() => {
            scanBtn.disabled = false;
            scanBtn.textContent = 'Scan';
          }, 3000);
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
    if (parts[0] === 'entries' && parts[1]) {
      renderDetail(el, parts[1]);
      return;
    }
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
