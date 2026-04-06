import { get } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, HH:mm');
}

// ── Tab state ─────────────────────────────────────────────────────────────────

const TABS = ['skills', 'agents', 'hooks', 'rules'];

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

function statusBadge(item) {
  const badge = document.createElement('span');
  const isActive = item.lastUsed || item.invocations > 0 || item.count > 0;
  badge.className = 'status-badge ' + (isActive ? 'active' : 'unused');
  badge.textContent = isActive ? 'Active' : 'Unused';
  return badge;
}

function renderSkillsTab(el, items, onSelect) {
  const cols = [
    { label: 'Name', render: i => i.name || i.skill || '—' },
    { label: 'Usage', key: 'count', center: true },
    { label: 'Last Used', render: i => fmtTime(i.lastUsed) },
    { label: 'Status', render: statusBadge },
  ];
  el.appendChild(makeItemTable(items, cols, onSelect));
}

function renderAgentsTab(el, items, onSelect) {
  const cols = [
    { label: 'Name', render: i => i.name || i.agent || '—' },
    { label: 'Usage', key: 'count', center: true },
    { label: 'Last Used', render: i => fmtTime(i.lastUsed) },
    { label: 'Status', render: statusBadge },
  ];
  el.appendChild(makeItemTable(items, cols, onSelect));
}

// ── Tab: Hooks ────────────────────────────────────────────────────────────────

function renderHooksTab(el, items) {
  const cols = [
    { label: 'Name', render: i => i.name || '—' },
    { label: 'Event', render: i => i.event || '—' },
    { label: 'Matcher', render: i => {
      const code = document.createElement('code');
      code.style.fontSize = '11px';
      code.style.color = 'var(--accent)';
      code.textContent = i.matcher || i.match || '—';
      return code;
    }},
  ];
  el.appendChild(makeItemTable(items, cols, null));
}

// ── Tab: Rules ────────────────────────────────────────────────────────────────

function renderRulesTab(el, items) {
  const card = document.createElement('div');
  card.className = 'card';

  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No rules found';
    card.appendChild(empty);
  } else {
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.padding = '0';

    items.forEach(rule => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:10px 0; border-bottom:1px solid var(--border); font-size:13px; display:flex; align-items:center; gap:8px;';

      const badge = document.createElement('span');
      badge.className = 'badge badge-rule';
      badge.textContent = 'rule';

      const name = document.createElement('span');
      name.textContent = rule.name || rule;

      li.appendChild(badge);
      li.appendChild(name);
      ul.appendChild(li);
    });
    card.appendChild(ul);
  }

  el.appendChild(card);
}

// ── Detail overlay ────────────────────────────────────────────────────────────

function renderItemDetail(el, item, type, onBack) {
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
  el.appendChild(header);

  // Keywords
  const keywords = item.keywords || item.triggers || [];
  if (keywords.length > 0) {
    const kw = document.createElement('div');
    kw.className = 'keywords-bar';
    kw.style.marginBottom = '20px';
    keywords.forEach(k => {
      const badge = document.createElement('span');
      badge.className = 'keyword-badge';
      badge.textContent = k;
      kw.appendChild(badge);
    });
    el.appendChild(kw);
  }

  // Description
  if (item.description) {
    const desc = document.createElement('div');
    desc.className = 'item-description';
    desc.textContent = item.description;
    el.appendChild(desc);
  }

  // Invocation history
  const history = item.history || item.recentUses || [];
  if (history.length > 0) {
    const histCard = document.createElement('div');
    histCard.className = 'card';

    const histTitle = document.createElement('div');
    histTitle.className = 'card-title';
    histTitle.textContent = 'Recent Invocations';
    histCard.appendChild(histTitle);

    history.slice(0, 10).forEach(h => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 0; border-bottom:1px solid var(--border);';

      const time = document.createElement('div');
      time.className = 'timeline-label';
      time.textContent = fmtTime(h.timestamp || h.at);

      const prompt = document.createElement('div');
      prompt.className = 'invocation-prompt';
      prompt.textContent = h.prompt || h.input || h.reason || '';

      row.appendChild(time);
      row.appendChild(prompt);
      histCard.appendChild(row);
    });

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

  el.appendChild(tabsEl);
  el.appendChild(content);

  function loadTab(tab) {
    content.textContent = '';
    const sp = document.createElement('div');
    sp.className = 'empty-state';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    sp.appendChild(spinner);
    content.appendChild(sp);

    let apiPath;
    if (tab === 'skills') apiPath = '/inventory/skills?period=' + p;
    else if (tab === 'agents') apiPath = '/inventory/agents?period=' + p;
    else if (tab === 'hooks') apiPath = '/inventory/hooks';
    else if (tab === 'rules') apiPath = '/inventory/rules';

    get(apiPath).then(data => {
      content.textContent = '';
      const items = Array.isArray(data) ? data : (data.items || data[tab] || []);

      if (tab === 'skills') {
        renderSkillsTab(content, items, item => {
          renderItemDetail(content, item, 'skill', () => loadTab('skills'));
        });
      } else if (tab === 'agents') {
        renderAgentsTab(content, items, item => {
          renderItemDetail(content, item, 'agent', () => loadTab('agents'));
        });
      } else if (tab === 'hooks') {
        renderHooksTab(content, items);
      } else if (tab === 'rules') {
        renderRulesTab(content, items);
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
}

export function unmount() {
  // Nothing to clean up
}
