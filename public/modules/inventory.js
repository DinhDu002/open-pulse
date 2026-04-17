import { get, getWithETag, post } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, HH:mm');
}

// ── Tab state ─────────────────────────────────────────────────────────────────

const TABS = ['skills', 'agents'];

let pollInterval = null;
let currentETag = null;
let inDetailView = false;

// ── Tab: Skills / Agents ──────────────────────────────────────────────────────

function makeItemTable(items, cols, onRowClick) {
  const wrap = document.createElement('div');
  wrap.className = 'sessions-table-wrap';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c.label;
    if (c.center) th.style.textAlign = 'center';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (!items || items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = cols.length;
    td.className = 'empty-state';
    td.textContent = 'No items found';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    items.forEach(item => {
      const tr = document.createElement('tr');
      if (onRowClick) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => onRowClick(item));
      }
      cols.forEach(c => {
        const td = document.createElement('td');
        if (c.center) td.style.textAlign = 'center';
        if (c.render) {
          const node = c.render(item);
          if (typeof node === 'string') td.textContent = node;
          else td.appendChild(node);
        } else {
          td.textContent = c.key ? (item[c.key] ?? '—') : '—';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function highlightKeywords(text, keywords) {
  const span = document.createElement('span');
  if (!text || !keywords || keywords.length === 0) {
    span.textContent = text || '';
    return span;
  }
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`\\b(${escaped.join('|')})`, 'gi');
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) span.appendChild(document.createTextNode(text.slice(last, match.index)));
    const b = document.createElement('strong');
    b.style.color = 'var(--accent)';
    b.textContent = match[0];
    span.appendChild(b);
    last = match.index + match[0].length;
  }
  if (last < text.length) span.appendChild(document.createTextNode(text.slice(last)));
  return span;
}

function statusBadge(item) {
  const badge = document.createElement('span');
  const isActive = item.lastUsed || item.invocations > 0 || item.count > 0;
  badge.className = 'status-badge ' + (isActive ? 'active' : 'unused');
  badge.textContent = isActive ? 'Active' : 'Unused';
  return badge;
}

function pluginBadge(item) {
  if (!item.plugin) return document.createTextNode('');
  const badge = document.createElement('span');
  badge.className = 'badge badge-origin';
  badge.textContent = item.plugin;
  return badge;
}

function projectBadges(item) {
  const container = document.createElement('span');
  const projects = item.projects || [item.project || 'global'];
  for (const proj of projects) {
    const badge = document.createElement('span');
    badge.className = proj === 'global' ? 'badge badge-project-global' : 'badge badge-project';
    badge.textContent = proj;
    badge.style.marginRight = '4px';
    container.appendChild(badge);
  }
  return container;
}

function renderSkillsTab(el, items, onSelect) {
  const cols = [
    { label: 'Name', render: i => i.name || i.skill || '—' },
    { label: 'Plugin', render: pluginBadge, center: true },
    { label: 'Project', render: projectBadges, center: true },
    { label: 'Usage', key: 'count', center: true },
    { label: 'Last Used', render: i => fmtTime(i.last_used) },
    { label: 'Status', render: statusBadge },
  ];
  el.appendChild(makeItemTable(items, cols, onSelect));
}

function agentClassBadge(item) {
  const badge = document.createElement('span');
  const isConfigured = item.agent_class === 'configured';
  badge.className = `badge badge-agent-${isConfigured ? 'configured' : 'builtin'}`;
  badge.textContent = isConfigured ? 'configured' : 'built-in';
  return badge;
}

function renderAgentsTab(el, items, onSelect) {
  const cols = [
    { label: 'Name', render: i => i.name || i.agent || '—' },
    { label: 'Type', render: agentClassBadge, center: true },
    { label: 'Plugin', render: pluginBadge, center: true },
    { label: 'Project', render: projectBadges, center: true },
    { label: 'Usage', key: 'count', center: true },
    { label: 'Last Used', render: i => fmtTime(i.last_used) },
    { label: 'Status', render: statusBadge },
  ];
  el.appendChild(makeItemTable(items, cols, onSelect));
}

// ── Detail overlay ────────────────────────────────────────────────────────────

function renderInvocationRows(container, history, keywords) {
  history.forEach(h => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0; border-bottom:1px solid var(--border);';

    const topLine = document.createElement('div');
    topLine.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';

    const time = document.createElement('span');
    time.className = 'timeline-label';
    time.textContent = fmtTime(h.timestamp || h.at);
    topLine.appendChild(time);

    row.appendChild(topLine);

    // Detail line
    const detail = h.detail || '';
    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'invocation-prompt';
      detailEl.textContent = detail;
      row.appendChild(detailEl);
    }

    // User prompt with highlighted keywords + trigger badge inside
    if (h.user_prompt) {
      const promptEl = document.createElement('div');
      promptEl.className = 'invocation-user-prompt';
      if (h.triggered_by) {
        const trigBadge = document.createElement('span');
        trigBadge.className = 'badge badge-trigger';
        const typeLabel = h.triggered_by.type === 'skill_invoke' ? 'skill' : 'agent';
        trigBadge.textContent = '\u2190 ' + typeLabel + ': ' + h.triggered_by.name;
        promptEl.appendChild(trigBadge);
        promptEl.appendChild(document.createTextNode(' '));
      }
      promptEl.appendChild(highlightKeywords(h.user_prompt, keywords));
      row.appendChild(promptEl);
    } else if (h.triggered_by) {
      // No user_prompt but has trigger — show badge standalone
      const trigBadge = document.createElement('div');
      trigBadge.className = 'badge badge-trigger';
      trigBadge.style.marginTop = '4px';
      const typeLabel = h.triggered_by.type === 'skill_invoke' ? 'skill' : 'agent';
      trigBadge.textContent = '\u2190 ' + typeLabel + ': ' + h.triggered_by.name;
      row.appendChild(trigBadge);
    }

    container.appendChild(row);
  });
}

function renderPagination(container, page, totalPages, onPageChange) {
  if (totalPages <= 1) return;

  const pager = document.createElement('div');
  pager.className = 'pagination';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '← Prev';
  prevBtn.disabled = page <= 1;
  prevBtn.addEventListener('click', () => onPageChange(page - 1));

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = 'Page ' + page + ' / ' + totalPages;

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next →';
  nextBtn.disabled = page >= totalPages;
  nextBtn.addEventListener('click', () => onPageChange(page + 1));

  pager.append(prevBtn, info, nextBtn);
  container.appendChild(pager);
}

function renderItemDetail(el, item, type, onBack, { onPageChange, onProjectChange, detailProject, onRefresh } = {}) {
  el.textContent = '';

  const header = document.createElement('div');
  header.className = 'detail-header';

  const back = document.createElement('button');
  back.className = 'back-btn';
  back.textContent = '← Back';
  back.addEventListener('click', onBack);

  const title = document.createElement('div');
  title.className = 'detail-title';
  title.textContent = item.name || item.skill || item.agent || 'Detail';

  header.appendChild(back);
  header.appendChild(title);

  if (typeof onRefresh === 'function') {
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.marginLeft = 'auto';
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      const originalText = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing…';
      Promise.resolve(onRefresh()).catch(err => {
        console.error('Detail refresh failed:', err);
      }).finally(() => {
        // Button may be gone after re-render, but guard anyway
        refreshBtn.disabled = false;
        refreshBtn.textContent = originalText;
      });
    });
    header.appendChild(refreshBtn);
  }

  el.appendChild(header);

  // Keywords (used for inline highlighting in user prompts, not displayed separately)
  const keywords = item.keywords || [];

  // Description
  if (item.description) {
    const desc = document.createElement('div');
    desc.className = 'item-description';
    desc.textContent = item.description;
    el.appendChild(desc);
  }

  // Project tabs
  const byProject = item.by_project || [];
  if (byProject.length > 0) {
    const totalCount = byProject.reduce((s, p) => s + p.count, 0);
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex; gap:0; margin-bottom:16px; border-bottom:2px solid var(--border); overflow-x:auto;';

    const allTab = document.createElement('button');
    allTab.style.cssText = 'padding:8px 16px; border:none; background:none; cursor:pointer; font-size:0.9rem; border-bottom:2px solid transparent; margin-bottom:-2px; white-space:nowrap; color:var(--text);';
    if (!detailProject) allTab.style.borderBottomColor = 'var(--accent)';
    allTab.textContent = 'All (' + totalCount + ')';
    allTab.addEventListener('click', () => onProjectChange && onProjectChange(''));
    tabBar.appendChild(allTab);

    byProject.forEach(p => {
      const projName = p.project || 'unknown';
      const tab = document.createElement('button');
      tab.style.cssText = 'padding:8px 16px; border:none; background:none; cursor:pointer; font-size:0.9rem; border-bottom:2px solid transparent; margin-bottom:-2px; white-space:nowrap; color:var(--text);';
      if (detailProject === projName) tab.style.borderBottomColor = 'var(--accent)';
      tab.textContent = projName + ' (' + p.count + ')';
      tab.addEventListener('click', () => onProjectChange && onProjectChange(projName));
      tabBar.appendChild(tab);
    });

    el.appendChild(tabBar);
  }

  // Triggers section (what this item triggers)
  const triggers = item.triggers || [];
  if (triggers.length > 0) {
    const trigCard = document.createElement('div');
    trigCard.className = 'card';
    const trigTitle = document.createElement('div');
    trigTitle.className = 'card-title';
    trigTitle.textContent = 'Triggers';
    trigCard.appendChild(trigTitle);

    triggers.forEach(t => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 0; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--border);';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (t.event_type === 'skill_invoke' ? 'badge-skill' : 'badge-agent');
      badge.textContent = t.event_type === 'skill_invoke' ? 'skill' : 'agent';
      const nameEl = document.createElement('span');
      nameEl.textContent = t.name;
      const count = document.createElement('span');
      count.className = 'text-muted';
      count.textContent = '(' + t.count + '\u00d7)';
      row.append(badge, nameEl, count);
      trigCard.appendChild(row);
    });
    el.appendChild(trigCard);
  }

  // Invocation history
  const history = item.invocations || [];
  const total = item.total || history.length;
  const page = item.page || 1;
  const perPage = item.per_page || 10;
  const totalPages = Math.ceil(total / perPage);

  if (total > 0) {
    const histCard = document.createElement('div');
    histCard.className = 'card';

    const histTitle = document.createElement('div');
    histTitle.className = 'card-title';
    histTitle.textContent = 'Invocations (' + total + ')';
    histCard.appendChild(histTitle);

    renderInvocationRows(histCard, history, keywords);
    renderPagination(histCard, page, totalPages, onPageChange);

    el.appendChild(histCard);
  } else {
    const noHist = document.createElement('div');
    noHist.className = 'empty-state';
    noHist.textContent = 'No invocation history';
    el.appendChild(noHist);
  }
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

let activeTab = 'skills';

export function mount(el, { period } = {}) {
  const p = period || '30d';

  // Tab bar
  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';

  const content = document.createElement('div');

  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (tab === activeTab ? ' active' : '');
    btn.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
    btn.dataset.tab = tab;
    btn.addEventListener('click', () => {
      activeTab = tab;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      loadTab(tab);
    });
    tabsEl.appendChild(btn);
  });

  const syncBtn = document.createElement('button');
  syncBtn.className = 'btn';
  syncBtn.textContent = 'Sync now';
  syncBtn.style.marginLeft = 'auto';
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    const originalText = syncBtn.textContent;
    syncBtn.textContent = 'Syncing…';
    try {
      await post('/sync', {});
      currentETag = null;
      if (!inDetailView) loadTab(activeTab);
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = originalText;
    }
  });
  tabsEl.appendChild(syncBtn);

  el.appendChild(tabsEl);
  el.appendChild(content);

  function loadTab(tab, isRefresh = false) {
    if (!isRefresh) {
      content.textContent = '';
      const sp = document.createElement('div');
      sp.className = 'empty-state';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      sp.appendChild(spinner);
      content.appendChild(sp);
    }

    let apiPath;
    if (tab === 'skills') apiPath = '/inventory/skills?period=' + p;
    else if (tab === 'agents') apiPath = '/inventory/agents?period=' + p;
    const fetchFn = isRefresh
      ? () => getWithETag(apiPath, currentETag)
      : () => get(apiPath).then(data => ({ data, etag: null, notModified: false }));

    fetchFn().then(result => {
      if (result.notModified) return; // ETag matched, nothing changed

      const data = result.data;
      if (result.etag) currentETag = result.etag;

      content.textContent = '';
      const items = Array.isArray(data) ? data : (data.items || data[tab] || []);

      if (tab === 'skills') {
        renderSkillsTab(content, items, item => {
          inDetailView = true;
          let detailProject = '';
          let currentPage = 1;
          function loadDetail(pg, proj) {
            if (proj !== undefined) detailProject = proj;
            currentPage = pg;
            const projParam = detailProject ? '&project=' + encodeURIComponent(detailProject) : '';
            const url = '/inventory/skills/' + encodeURIComponent(item.name) + '?period=' + p + '&page=' + pg + projParam;
            return get(url).then(detail => {
              renderItemDetail(content, detail, 'skill', () => { inDetailView = false; loadTab('skills'); }, {
                onPageChange: pg => loadDetail(pg),
                onProjectChange: proj => loadDetail(1, proj),
                detailProject,
                onRefresh: () => loadDetail(currentPage),
              });
            });
          }
          loadDetail(1);
        });
      } else if (tab === 'agents') {
        renderAgentsTab(content, items, item => {
          inDetailView = true;
          let detailProject = '';
          let currentPage = 1;
          function loadDetail(pg, proj) {
            if (proj !== undefined) detailProject = proj;
            currentPage = pg;
            const projParam = detailProject ? '&project=' + encodeURIComponent(detailProject) : '';
            const url = '/inventory/agents/' + encodeURIComponent(item.name) + '?period=' + p + '&page=' + pg + projParam;
            return get(url).then(detail => {
              renderItemDetail(content, detail, 'agent', () => { inDetailView = false; loadTab('agents'); }, {
                onPageChange: pg => loadDetail(pg),
                onProjectChange: proj => loadDetail(1, proj),
                detailProject,
                onRefresh: () => loadDetail(currentPage),
              });
            });
          }
          loadDetail(1);
        });
      }
    }).catch(err => {
      content.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'empty-state';
      errDiv.style.color = 'var(--danger)';
      errDiv.textContent = 'Failed to load ' + tab + ': ' + err.message;
      content.appendChild(errDiv);
    });
  }

  loadTab(activeTab);

  // Start polling every 60s with ETag
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (inDetailView) return;
    loadTab(activeTab, true);
  }, 60000);
}

export function unmount() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  inDetailView = false;
  currentETag = null;
}
