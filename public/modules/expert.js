import { get, post } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, HH:mm');
}

// ── Tab: Suggestions ─────────────────────────────────────────────────────────

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

function typeBadge(type) {
  const span = document.createElement('span');
  const cls = { skill: 'badge-skill', agent: 'badge-agent', hook: 'badge-hook', rule: 'badge-rule' }[type] || 'badge-rule';
  span.className = 'badge ' + cls;
  span.textContent = type || 'unknown';
  return span;
}

function renderSuggestions(el) {
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  loading.appendChild(sp);
  el.appendChild(loading);

  get('/suggestions?status=pending').then(data => {
    el.removeChild(loading);
    const suggestions = Array.isArray(data) ? data : (data.suggestions || []);

    if (suggestions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No pending suggestions';
      el.appendChild(empty);
      return;
    }

    suggestions.forEach(s => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '12px';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:8px;';
      top.appendChild(typeBadge(s.type));

      const conf = document.createElement('span');
      conf.style.color = 'var(--text-muted)';
      conf.style.fontSize = '12px';
      conf.textContent = Math.round((s.confidence || 0) * 100) + '%';
      top.appendChild(conf);
      top.appendChild(confidenceBar(s.confidence));

      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:13px; margin-bottom:12px; line-height:1.6;';
      desc.textContent = s.description || s.reason || s.content || '';

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';

      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-primary';
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => {
        approveBtn.disabled = true;
        dismissBtn.disabled = true;
        post('/suggestions/' + s.id + '/approve', {}).then(() => {
          card.style.opacity = '0.4';
          card.style.pointerEvents = 'none';
        }).catch(err => {
          approveBtn.disabled = false;
          dismissBtn.disabled = false;
          alert('Failed: ' + err.message);
        });
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-danger';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', () => {
        approveBtn.disabled = true;
        dismissBtn.disabled = true;
        post('/suggestions/' + s.id + '/dismiss', {}).then(() => {
          card.style.opacity = '0.4';
          card.style.pointerEvents = 'none';
        }).catch(err => {
          approveBtn.disabled = false;
          dismissBtn.disabled = false;
          alert('Failed: ' + err.message);
        });
      });

      actions.appendChild(approveBtn);
      actions.appendChild(dismissBtn);

      card.appendChild(top);
      card.appendChild(desc);
      card.appendChild(actions);
      el.appendChild(card);
    });
  }).catch(err => {
    loading.textContent = 'Failed to load suggestions: ' + err.message;
    loading.style.color = 'var(--danger)';
  });
}

// ── Tab: Scanner ──────────────────────────────────────────────────────────────

function severityBadge(sev) {
  const span = document.createElement('span');
  span.className = 'badge';
  const colors = { critical: '#e17055', high: '#fdcb6e', medium: '#74b9ff', low: '#8b8fa3' };
  const bg = colors[sev] || '#8b8fa3';
  span.style.cssText = 'background:' + bg + '40; color:' + bg + ';';
  span.textContent = sev || 'info';
  return span;
}

function renderScanner(el) {
  // Run Scan button
  const runCard = document.createElement('div');
  runCard.className = 'card';
  runCard.style.marginBottom = '20px';

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-primary';
  runBtn.textContent = 'Run Scan';

  const resultArea = document.createElement('div');
  resultArea.style.marginTop = '16px';

  runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Scanning…';
    resultArea.textContent = '';

    post('/scanner/run', {}).then(report => {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Scan';

      const issues = report.issues || report.findings || [];
      const counts = { critical: 0, high: 0, medium: 0, low: 0 };
      issues.forEach(i => { if (counts[i.severity] !== undefined) counts[i.severity]++; });

      // Stats
      const statsGrid = document.createElement('div');
      statsGrid.className = 'stat-grid';
      statsGrid.style.marginBottom = '16px';
      Object.entries(counts).forEach(([sev, cnt]) => {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = '<div class="stat-label">' + sev + '</div><div class="stat-value">' + cnt + '</div>';
        statsGrid.appendChild(card);
      });
      resultArea.appendChild(statsGrid);

      // Issues
      if (issues.length === 0) {
        const ok = document.createElement('div');
        ok.className = 'empty-state';
        ok.style.color = 'var(--success)';
        ok.textContent = 'No issues found';
        resultArea.appendChild(ok);
      } else {
        issues.forEach(issue => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid var(--border);';
          row.appendChild(severityBadge(issue.severity));
          const msg = document.createElement('div');
          msg.style.fontSize = '13px';
          msg.textContent = issue.message || issue.description || '';
          row.appendChild(msg);
          resultArea.appendChild(row);
        });
      }
    }).catch(err => {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Scan';
      resultArea.textContent = 'Scan failed: ' + err.message;
      resultArea.style.color = 'var(--danger)';
    });
  });

  runCard.appendChild(runBtn);
  runCard.appendChild(resultArea);
  el.appendChild(runCard);

  // Scan history
  const histCard = document.createElement('div');
  histCard.className = 'card';

  const histTitle = document.createElement('div');
  histTitle.className = 'card-title';
  histTitle.textContent = 'Scan History';
  histCard.appendChild(histTitle);

  const histLoading = document.createElement('div');
  histLoading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  histLoading.appendChild(sp);
  histCard.appendChild(histLoading);

  get('/scanner/history').then(data => {
    histCard.removeChild(histLoading);
    const scans = Array.isArray(data) ? data : (data.scans || []);

    if (scans.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No scan history';
      histCard.appendChild(empty);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'sessions-table-wrap';
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Date</th><th style="text-align:center">Issues</th><th>Status</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      scans.forEach(scan => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = fmtTime(scan.createdAt || scan.at);
        const td2 = document.createElement('td');
        td2.style.textAlign = 'center';
        td2.textContent = scan.issueCount ?? scan.issues?.length ?? 0;
        const td3 = document.createElement('td');
        td3.textContent = scan.status || 'done';
        tr.appendChild(td1);
        tr.appendChild(td2);
        tr.appendChild(td3);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      histCard.appendChild(wrap);
    }
  }).catch(() => {
    histCard.removeChild(histLoading);
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Could not load scan history';
    histCard.appendChild(empty);
  });

  el.appendChild(histCard);
}

// ── Tab: Actions ──────────────────────────────────────────────────────────────

const ACTION_TYPES = ['skill', 'agent', 'hook', 'rule'];

function renderActions(el) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Create Action';
  card.appendChild(title);

  // Form
  const typeGroup = document.createElement('div');
  typeGroup.className = 'form-group';
  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Type';
  typeGroup.appendChild(typeLabel);
  const typeSelect = document.createElement('select');
  ACTION_TYPES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  });
  typeGroup.appendChild(typeSelect);

  const nameGroup = document.createElement('div');
  nameGroup.className = 'form-group';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  nameGroup.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. my-skill';
  nameGroup.appendChild(nameInput);

  const contentGroup = document.createElement('div');
  contentGroup.className = 'form-group';
  const contentLabel = document.createElement('label');
  contentLabel.textContent = 'Content';
  contentGroup.appendChild(contentLabel);
  const contentArea = document.createElement('textarea');
  contentArea.placeholder = 'Action content or template…';
  contentGroup.appendChild(contentArea);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px;';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn';
  previewBtn.textContent = 'Preview';

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.textContent = 'Create';

  const resultEl = document.createElement('div');
  resultEl.style.marginTop = '16px';

  previewBtn.addEventListener('click', () => {
    resultEl.textContent = '';
    const pre = document.createElement('pre');
    pre.style.cssText = 'background:var(--bg); border:1px solid var(--border); padding:12px; border-radius:6px; font-size:12px; overflow-x:auto; white-space:pre-wrap;';
    pre.textContent = JSON.stringify({
      type: typeSelect.value,
      name: nameInput.value,
      content: contentArea.value,
    }, null, 2);
    resultEl.appendChild(pre);
  });

  createBtn.addEventListener('click', () => {
    if (!nameInput.value.trim()) {
      alert('Name is required');
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    post('/actions', {
      type: typeSelect.value,
      name: nameInput.value.trim(),
      content: contentArea.value,
    }).then(result => {
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
      resultEl.textContent = '';
      const ok = document.createElement('div');
      ok.style.color = 'var(--success)';
      ok.textContent = 'Created successfully: ' + (result.name || nameInput.value);
      resultEl.appendChild(ok);
      nameInput.value = '';
      contentArea.value = '';
    }).catch(err => {
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
      resultEl.textContent = 'Failed: ' + err.message;
      resultEl.style.color = 'var(--danger)';
    });
  });

  btnRow.appendChild(previewBtn);
  btnRow.appendChild(createBtn);

  card.appendChild(typeGroup);
  card.appendChild(nameGroup);
  card.appendChild(contentGroup);
  card.appendChild(btnRow);
  card.appendChild(resultEl);

  el.appendChild(card);
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

const TABS = ['suggestions', 'scanner', 'actions'];
let activeTab = 'suggestions';

export function mount(el, { period } = {}) {
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
    if (tab === 'suggestions') renderSuggestions(content);
    else if (tab === 'scanner') renderScanner(content);
    else if (tab === 'actions') renderActions(content);
  }

  loadTab(activeTab);
}

export function unmount() {
  // Nothing to clean up
}
