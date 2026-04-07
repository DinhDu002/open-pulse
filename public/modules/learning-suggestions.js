// Learning — Suggestions sub-module
import { get, put } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

function fmtDate(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, YYYY HH:mm');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function confColor(c) {
  return c < 0.3 ? '#e17055' : c < 0.6 ? '#fdcb6e' : '#00b894';
}

function confidenceBarHtml(conf) {
  var color = confColor(conf);
  var pct = Math.round(conf * 100);
  return (
    '<span class="confidence-bar">' +
      '<span class="fill" style="display:block;width:' + pct + '%;height:100%;' +
        'background:' + color + ';border-radius:4px;"></span>' +
    '</span>'
  );
}

function typeBadgeHtml(type) {
  var t = (type || '').toLowerCase();
  var cls = '';
  if (t === 'skill') cls = 'badge-skill';
  else if (t === 'agent') cls = 'badge-agent';
  else if (t === 'hook') cls = 'badge-hook';
  else if (t === 'rule') cls = 'badge-rule';
  if (cls) {
    return '<span class="badge ' + cls + '">' + escHtml(type) + '</span>';
  }
  return '<span class="badge" style="background:rgba(108,92,231,0.15);color:var(--accent)">' + escHtml(type || 'unknown') + '</span>';
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el) {
  el.innerHTML = '';

  var state = {
    statusFilter: '',   // '' = all, 'pending', 'approved', 'dismissed'
    typeFilter: '',     // client-side type filter
    page: 1,
    allSuggestions: [], // suggestions matching status filter
    summaryAll: [],     // all suggestions for counts
  };

  // ── Filter row ────────────────────────────────────────────────────────────

  var filterRow = document.createElement('div');
  filterRow.className = 'filter-row';

  var statusSelect = document.createElement('select');
  statusSelect.innerHTML =
    '<option value="">All statuses</option>' +
    '<option value="pending">Pending</option>' +
    '<option value="approved">Approved</option>' +
    '<option value="dismissed">Dismissed</option>';

  var typeSelect = document.createElement('select');
  typeSelect.innerHTML =
    '<option value="">All types</option>' +
    '<option value="skill">Skill</option>' +
    '<option value="agent">Agent</option>' +
    '<option value="hook">Hook</option>' +
    '<option value="rule">Rule</option>';

  filterRow.appendChild(statusSelect);
  filterRow.appendChild(typeSelect);
  el.appendChild(filterRow);

  // ── Summary cards ─────────────────────────────────────────────────────────

  var summaryGrid = document.createElement('div');
  summaryGrid.className = 'stat-grid';
  summaryGrid.style.marginBottom = '1rem';
  summaryGrid.innerHTML =
    '<div class="stat-card">' +
      '<div class="stat-label">Pending</div>' +
      '<div class="stat-value" id="op-sug-pending" style="color:var(--warning)">—</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-label">Approved</div>' +
      '<div class="stat-value" id="op-sug-approved" style="color:var(--success)">—</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-label">Dismissed</div>' +
      '<div class="stat-value" id="op-sug-dismissed" style="color:var(--danger)">—</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-label">Approve Rate</div>' +
      '<div class="stat-value" id="op-sug-rate">—</div>' +
    '</div>';
  el.appendChild(summaryGrid);

  // ── List + pagination containers ──────────────────────────────────────────

  var listWrap = document.createElement('div');
  el.appendChild(listWrap);

  var paginationWrap = document.createElement('div');
  el.appendChild(paginationWrap);

  // ── Update summary cards ──────────────────────────────────────────────────

  function updateSummary(all) {
    var pending = all.filter(function(s) { return s.status === 'pending'; }).length;
    var approved = all.filter(function(s) { return s.status === 'approved'; }).length;
    var dismissed = all.filter(function(s) { return s.status === 'dismissed'; }).length;
    var resolved = approved + dismissed;
    var rate = resolved > 0 ? Math.round((approved / resolved) * 100) : 0;

    var pendingEl = el.querySelector('#op-sug-pending');
    var approvedEl = el.querySelector('#op-sug-approved');
    var dismissedEl = el.querySelector('#op-sug-dismissed');
    var rateEl = el.querySelector('#op-sug-rate');

    if (pendingEl) pendingEl.textContent = pending;
    if (approvedEl) approvedEl.textContent = approved;
    if (dismissedEl) dismissedEl.textContent = dismissed;
    if (rateEl) rateEl.textContent = rate + '%';
  }

  // ── Render current page ───────────────────────────────────────────────────

  function renderPage() {
    listWrap.innerHTML = '';
    paginationWrap.innerHTML = '';

    var typeFilter = state.typeFilter.toLowerCase();
    var filtered = typeFilter
      ? state.allSuggestions.filter(function(s) {
          return (s.type || '').toLowerCase() === typeFilter;
        })
      : state.allSuggestions.slice();

    if (filtered.length === 0) {
      listWrap.innerHTML = '<div class="empty-state">No suggestions found</div>';
      return;
    }

    var totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (state.page > totalPages) state.page = 1;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageItems = filtered.slice(start, start + PAGE_SIZE);

    pageItems.forEach(function(sug) {
      var status = sug.status || 'pending';
      var conf = sug.confidence != null ? Number(sug.confidence) : 0;
      var card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '10px';

      var statusBadge = '<span class="badge ' + escHtml(status) + '">' + escHtml(status) + '</span>';
      var confHtml = confidenceBarHtml(conf) +
        ' <span style="font-size:12px;color:' + confColor(conf) + ';font-family:monospace">' +
        conf.toFixed(2) + '</span>';

      var instinctLinkHtml = sug.instinct_id
        ? ' <a href="#learning/instincts/' + encodeURIComponent(sug.instinct_id) + '" ' +
            'style="font-size:12px;color:var(--accent);text-decoration:none;font-family:monospace" ' +
            'onclick="event.stopPropagation()">' +
            'instinct #' + escHtml(String(sug.instinct_id)) +
          '</a>'
        : '';

      var resolvedHtml = sug.resolved_at
        ? '<span style="font-size:11px;color:var(--text-muted)">Resolved: ' + escHtml(fmtDate(sug.resolved_at)) + '</span>'
        : '';

      var actionsHtml = '';
      if (status === 'pending') {
        actionsHtml =
          '<div style="display:flex;gap:8px;margin-top:10px">' +
            '<button class="btn btn-primary btn-approve" data-id="' + escHtml(String(sug.id)) + '" ' +
              'style="font-size:12px;padding:4px 12px">Approve</button>' +
            '<button class="btn btn-danger btn-dismiss" data-id="' + escHtml(String(sug.id)) + '" ' +
              'style="font-size:12px;padding:4px 12px">Dismiss</button>' +
          '</div>';
      }

      card.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
          statusBadge +
          typeBadgeHtml(sug.type) +
          '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
            confHtml +
          '</span>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:8px">' +
          escHtml(sug.description || '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          instinctLinkHtml +
          '<span style="font-size:11px;color:var(--text-muted)">Created: ' + escHtml(fmtDate(sug.created_at)) + '</span>' +
          resolvedHtml +
        '</div>' +
        actionsHtml;

      listWrap.appendChild(card);
    });

    // Pagination
    if (totalPages > 1) {
      var pg = document.createElement('div');
      pg.className = 'pagination';

      var prevBtn = document.createElement('button');
      prevBtn.textContent = '\u2190 Prev';
      prevBtn.disabled = state.page <= 1;
      prevBtn.addEventListener('click', function() {
        if (state.page > 1) { state.page--; renderPage(); }
      });

      var pageInfo = document.createElement('span');
      pageInfo.className = 'page-info';
      pageInfo.textContent = 'Page ' + state.page + ' / ' + totalPages + ' (' + filtered.length + ' total)';

      var nextBtn = document.createElement('button');
      nextBtn.textContent = 'Next \u2192';
      nextBtn.disabled = state.page >= totalPages;
      nextBtn.addEventListener('click', function() {
        if (state.page < totalPages) { state.page++; renderPage(); }
      });

      pg.appendChild(prevBtn);
      pg.appendChild(pageInfo);
      pg.appendChild(nextBtn);
      paginationWrap.appendChild(pg);
    }
  }

  // ── Fetch suggestions from API ────────────────────────────────────────────

  function loadSuggestions() {
    var qs = state.statusFilter ? '?status=' + encodeURIComponent(state.statusFilter) : '';
    listWrap.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
    paginationWrap.innerHTML = '';

    // Always fetch all for summary counts
    var summaryPromise = get('/suggestions');
    summaryPromise.then(function(all) {
      updateSummary(Array.isArray(all) ? all : []);
    }).catch(function() {});

    // Fetch status-filtered list
    var listPromise = state.statusFilter ? get('/suggestions' + qs) : summaryPromise;
    listPromise.then(function(data) {
      state.allSuggestions = Array.isArray(data) ? data : [];
      state.page = 1;
      renderPage();
    }).catch(function(err) {
      listWrap.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
    });
  }

  // ── Event delegation for approve / dismiss ────────────────────────────────

  listWrap.addEventListener('click', function(e) {
    var approveBtn = e.target.closest('.btn-approve');
    var dismissBtn = e.target.closest('.btn-dismiss');

    if (approveBtn) {
      var id = approveBtn.dataset.id;
      approveBtn.disabled = true;
      approveBtn.textContent = 'Approving\u2026';
      put('/suggestions/' + encodeURIComponent(id) + '/approve')
        .then(function() { loadSuggestions(); })
        .catch(function(err) {
          approveBtn.disabled = false;
          approveBtn.textContent = 'Approve';
          alert('Error: ' + err.message);
        });
    }

    if (dismissBtn) {
      var id2 = dismissBtn.dataset.id;
      dismissBtn.disabled = true;
      dismissBtn.textContent = 'Dismissing\u2026';
      put('/suggestions/' + encodeURIComponent(id2) + '/dismiss')
        .then(function() { loadSuggestions(); })
        .catch(function(err) {
          dismissBtn.disabled = false;
          dismissBtn.textContent = 'Dismiss';
          alert('Error: ' + err.message);
        });
    }
  });

  // ── Filter change listeners ───────────────────────────────────────────────

  statusSelect.addEventListener('change', function() {
    state.statusFilter = statusSelect.value;
    loadSuggestions();
  });

  typeSelect.addEventListener('change', function() {
    state.typeFilter = typeSelect.value;
    renderPage();
  });

  // ── Initial load ──────────────────────────────────────────────────────────

  loadSuggestions();
}

// ── Detail View ───────────────────────────────────────────────────────────────

export function renderDetail(el, id) {
  // No standalone detail view — render the full list
  renderList(el);
}
