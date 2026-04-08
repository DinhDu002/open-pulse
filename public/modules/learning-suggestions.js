// Learning — Suggestions sub-module
import { get, post } from './api.js';
import { fmtDate, escHtml, confColor, confidenceBarHtml } from './utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

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

// NOTE: innerHTML usage below is safe — all dynamic values pass through escHtml()
// which escapes &, <, >, and " to prevent XSS. No raw user input is ever inserted.

// ── Vietnamese description ───────────────────────────────────────────────────

var CATEGORY_VI = {
  adoption: 'Khuyến nghị sử dụng', cleanup: 'Dọn dẹp', agent_creation: 'Tạo agent',
  update: 'Cập nhật', optimization: 'Tối ưu hóa', integration: 'Tích hợp',
  cost: 'Chi phí', security: 'Bảo mật', refinement: 'Tinh chỉnh',
};

var TYPE_VI = { skill: 'kỹ năng', agent: 'agent', hook: 'hook', rule: 'quy tắc' };

var STATUS_VI = { pending: 'chờ xử lý', approved: 'đã duyệt', dismissed: 'đã bỏ qua' };

function confLabelVi(c) {
  return c < 0.3 ? 'thấp' : c < 0.6 ? 'trung bình' : 'cao';
}

function describeSuggestionVi(sug) {
  var catVi = CATEGORY_VI[(sug.category || '').toLowerCase()] || sug.category || '—';
  var typeVi = TYPE_VI[(sug.type || '').toLowerCase()] || sug.type || '—';
  var statusVi = STATUS_VI[(sug.status || '').toLowerCase()] || sug.status || '—';
  var conf = sug.confidence != null ? Number(sug.confidence) : 0;

  var lines = [];
  lines.push('Đề xuất thuộc danh mục "' + catVi + '", loại thành phần: ' + typeVi + '.');
  lines.push('Trạng thái: ' + statusVi + '. Độ tin cậy ' + confLabelVi(conf) + ' (' + conf.toFixed(2) + ').');

  if (sug.category === 'adoption') {
    lines.push('Khuyến nghị sử dụng thành phần này nhiều hơn trong quy trình làm việc.');
  } else if (sug.category === 'cleanup') {
    lines.push('Đề xuất dọn dẹp thành phần không còn sử dụng hoặc lỗi thời.');
  } else if (sug.category === 'agent_creation') {
    lines.push('Đề xuất tạo agent mới để tự động hóa tác vụ lặp lại.');
  } else if (sug.category === 'update') {
    lines.push('Đề xuất cập nhật thành phần do phát hiện lỗi hoặc hiệu suất kém.');
  } else if (sug.category === 'optimization') {
    lines.push('Đề xuất tối ưu hóa chuỗi thao tác để giảm bước thừa.');
  } else if (sug.category === 'integration') {
    lines.push('Đề xuất tích hợp với dịch vụ hoặc công cụ bên ngoài.');
  } else if (sug.category === 'cost') {
    lines.push('Đề xuất tiết kiệm chi phí bằng cách thay đổi model hoặc cấu hình.');
  } else if (sug.category === 'security') {
    lines.push('Cảnh báo bảo mật — cần xem xét và xử lý sớm.');
  } else if (sug.category === 'refinement') {
    lines.push('Đề xuất tinh chỉnh cấu hình hoặc nội dung thành phần hiện có.');
  }

  return lines.join('\n');
}

// Format AI-generated Vietnamese description with bold labels
// Input lines: "Nghĩa là gì: ...\nVấn đề: ...\nCách xử lý: ..."
// escHtml is defined at top of file — escapes &, <, >, " to prevent XSS
function formatDescriptionVi(text) {
  var labels = ['Nghĩa là gì', 'Vấn đề', 'Cách xử lý'];
  return text.split('\n').filter(Boolean).map(function(line) {
    for (var i = 0; i < labels.length; i++) {
      var prefix = labels[i] + ':';
      if (line.startsWith(prefix)) {
        var content = line.slice(prefix.length).trim();
        return '<div style="margin-bottom:6px"><strong style="color:var(--text)">' +
          escHtml(labels[i]) + ':</strong> ' + escHtml(content) + '</div>';
      }
    }
    return '<div style="margin-bottom:6px">' + escHtml(line) + '</div>';
  }).join('');
}

var CATEGORY_COLORS = {
  adoption:       { bg: 'rgba(0,184,148,0.15)',   color: '#00b894' },
  cleanup:        { bg: 'rgba(225,112,85,0.15)',  color: '#e17055' },
  agent_creation: { bg: 'rgba(116,185,255,0.15)', color: '#74b9ff' },
  update:         { bg: 'rgba(214,48,49,0.15)',   color: '#d63031' },
  optimization:   { bg: 'rgba(108,92,231,0.15)',  color: '#6c5ce7' },
  integration:    { bg: 'rgba(162,155,254,0.15)', color: '#a29bfe' },
  cost:           { bg: 'rgba(253,203,110,0.15)', color: '#fdcb6e' },
  security:       { bg: 'rgba(255,71,87,0.15)',   color: '#ff4757' },
  refinement:     { bg: 'rgba(0,206,209,0.15)',   color: '#00ced1' },
};

function categoryBadgeHtml(cat) {
  if (!cat) return '';
  var style = CATEGORY_COLORS[cat] || { bg: 'rgba(139,143,163,0.15)', color: 'var(--text-muted)' };
  var label = cat.replace(/_/g, ' ');
  return '<span class="badge" style="background:' + style.bg + ';color:' + style.color + '">' + escHtml(label) + '</span>';
}

// ── Action data rendering (module-level for reuse in list + detail) ──────────
// NOTE: innerHTML content is XSS-safe — all dynamic values pass through escHtml()

function renderActionData(category, ad) {
  if (!ad) return '';
  var parts = [];
  if (category === 'adoption') {
    if (ad.usage_scenarios && ad.usage_scenarios.length) {
      parts.push('<details style="font-size:12px;color:var(--text-muted);margin-top:4px"><summary>Usage scenarios (' + ad.usage_scenarios.length + ')</summary>');
      for (var i = 0; i < ad.usage_scenarios.length; i++) {
        parts.push('<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">' + escHtml(ad.usage_scenarios[i]) + '</div>');
      }
      parts.push('</details>');
    }
    if (ad.sample_prompts && ad.sample_prompts.length) {
      parts.push('<details style="font-size:12px;color:var(--text-muted);margin-top:4px"><summary>Try these prompts (' + ad.sample_prompts.length + ')</summary>');
      for (var j = 0; j < ad.sample_prompts.length; j++) {
        parts.push('<div style="padding:4px 0;border-bottom:1px solid var(--border);font-family:monospace;font-size:11px">' + escHtml(ad.sample_prompts[j]) + '</div>');
      }
      parts.push('</details>');
    }
  }
  if (category === 'cleanup') {
    if (ad.file_path) parts.push('<span style="font-size:11px;color:var(--text-muted);font-family:monospace">' + escHtml(ad.file_path) + '</span>');
    if (ad.last_used) parts.push('<span style="font-size:11px;color:var(--text-muted)">Last used: ' + escHtml(ad.last_used.split('T')[0]) + '</span>');
  }
  if (category === 'agent_creation') {
    if (ad.target_agent) {
      parts.push('<span style="font-size:11px;color:var(--accent)">Redirect to: <strong>' + escHtml(ad.target_agent) + '</strong></span>');
      if (ad.reason) parts.push('<span style="font-size:11px;color:var(--text-muted)">' + escHtml(ad.reason) + '</span>');
    }
    if (ad.sample_prompts && ad.sample_prompts.length) {
      parts.push('<details style="font-size:12px;color:var(--text-muted);margin-top:4px"><summary>Sample prompts (' + ad.sample_prompts.length + ')</summary>');
      for (var k = 0; k < ad.sample_prompts.length; k++) {
        parts.push('<div style="padding:4px 0;border-bottom:1px solid var(--border);font-family:monospace;font-size:11px">' + escHtml(ad.sample_prompts[k]) + '</div>');
      }
      parts.push('</details>');
    }
  }
  if (category === 'update') {
    if (ad.error_rate != null) parts.push('<span style="font-size:11px;color:var(--danger)">Error rate: ' + Math.round(ad.error_rate * 100) + '% (' + (ad.errors || 0) + '/' + (ad.total || 0) + ')</span>');
    if (ad.avg_duration_ms) parts.push('<span style="font-size:11px;color:var(--warning)">Avg: ' + (ad.avg_duration_ms / 1000).toFixed(1) + 's</span>');
  }
  if (category === 'optimization' && ad.chain) {
    parts.push('<span style="font-size:11px;color:var(--accent);font-family:monospace">' + ad.chain.map(escHtml).join(' \u2192 ') + ' (' + (ad.frequency || 0) + 'x)</span>');
  }
  if (category === 'integration') {
    if (ad.with) parts.push('<span style="font-size:11px;color:var(--accent);font-family:monospace">' + escHtml(ad.name || '') + ' \u2194 ' + escHtml(ad.with) + '</span>');
    if (ad.integration_type) parts.push('<span style="font-size:11px;color:var(--text-muted)">via ' + escHtml(ad.integration_type) + '</span>');
    if (ad.benefit) parts.push('<span style="font-size:11px;color:var(--text-muted)">' + escHtml(ad.benefit) + '</span>');
  }
  if (category === 'cost') {
    if (ad.current_model) parts.push('<span style="font-size:11px;color:var(--warning)">Model: ' + escHtml(ad.current_model) + ' \u2192 ' + escHtml(ad.suggested || '?') + '</span>');
    if (ad.total_cost != null) parts.push('<span style="font-size:11px;color:var(--text-muted)">Total cost: $' + Number(ad.total_cost).toFixed(2) + '</span>');
  }
  if (category === 'security') {
    var sevColor = ad.severity === 'high' ? 'var(--danger)' : 'var(--warning)';
    parts.push('<span style="font-size:11px;color:' + sevColor + ';font-weight:600">' + escHtml(ad.severity || 'medium') + ': ' + escHtml(ad.issue || '') + '</span>');
    if (ad.file_path) parts.push('<span style="font-size:11px;color:var(--text-muted);font-family:monospace">' + escHtml(ad.file_path) + '</span>');
  }
  if (category === 'refinement') {
    if (ad.issues && ad.issues.length) {
      parts.push('<div style="font-size:11px;color:var(--danger)">' + ad.issues.map(escHtml).join(', ') + '</div>');
    }
    if (ad.file_path) {
      parts.push('<span style="font-size:11px;color:var(--text-muted);font-family:monospace">' + escHtml(ad.file_path) + '</span>');
    }
    if (ad.proposed_changes && ad.proposed_changes.length) {
      parts.push('<details style="font-size:12px;color:var(--text-muted);margin-top:4px">' +
        '<summary>Proposed changes (' + ad.proposed_changes.length + ')</summary>');
      for (var pc = 0; pc < ad.proposed_changes.length; pc++) {
        var change = ad.proposed_changes[pc];
        parts.push('<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px">' +
          '<strong>' + escHtml(change.change) + '</strong> ' + escHtml(change.section) +
          ': ' + escHtml(change.content || '') + '</div>');
      }
      parts.push('</details>');
    }
    if (ad.rationale) {
      parts.push('<div style="font-size:11px;color:var(--text-muted);font-style:italic">' + escHtml(ad.rationale) + '</div>');
    }
  }
  if (parts.length === 0) return '';
  return '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">' + parts.join('') + '</div>';
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el) {
  el.innerHTML = '';

  var state = {
    statusFilter: '',
    typeFilter: '',
    categoryFilter: '',
    page: 1,
    allSuggestions: [],
    summaryAll: [],
  };

  // ── Top action bar ────────────────────────────────────────────────────────

  var actionBar = document.createElement('div');
  actionBar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:12px;';

  var analyzeBtn = document.createElement('button');
  analyzeBtn.className = 'btn btn-primary';
  analyzeBtn.textContent = 'Run Analysis';
  analyzeBtn.addEventListener('click', function() {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing\u2026';
    post('/suggestions/analyze').then(function() {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Run Analysis';
      loadSuggestions();
    }).catch(function(err) {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Run Analysis';
      alert('Error: ' + err.message);
    });
  });
  actionBar.appendChild(analyzeBtn);
  el.appendChild(actionBar);

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

  var categorySelect = document.createElement('select');
  categorySelect.innerHTML =
    '<option value="">All categories</option>' +
    '<option value="adoption">Adoption</option>' +
    '<option value="cleanup">Cleanup</option>' +
    '<option value="agent_creation">Agent Creation</option>' +
    '<option value="update">Update</option>' +
    '<option value="optimization">Optimization</option>' +
    '<option value="integration">Integration</option>' +
    '<option value="cost">Cost</option>' +
    '<option value="security">Security</option>' +
    '<option value="refinement">Refinement</option>';

  filterRow.appendChild(statusSelect);
  filterRow.appendChild(typeSelect);
  filterRow.appendChild(categorySelect);
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
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-label">Categories</div>' +
      '<div class="stat-value" id="op-sug-categories" style="font-size:12px">—</div>' +
    '</div>';
  el.appendChild(summaryGrid);

  // ── List + pagination containers ──────────────────────────────────────────

  var listWrap = document.createElement('div');
  el.appendChild(listWrap);

  var paginationWrap = document.createElement('div');
  el.appendChild(paginationWrap);

  // ── Update summary cards ──────────────────────────────────────────────────

  function updateSummary(all) {
    var pending = 0, approved = 0, dismissed = 0;
    var catCounts = {};
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (s.status === 'pending') pending++;
      else if (s.status === 'approved') approved++;
      else if (s.status === 'dismissed') dismissed++;
      var cat = s.category || 'other';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    var resolved = approved + dismissed;
    var rate = resolved > 0 ? Math.round((approved / resolved) * 100) : 0;

    var pendingEl = el.querySelector('#op-sug-pending');
    var approvedEl = el.querySelector('#op-sug-approved');
    var dismissedEl = el.querySelector('#op-sug-dismissed');
    var rateEl = el.querySelector('#op-sug-rate');
    var catEl = el.querySelector('#op-sug-categories');

    if (pendingEl) pendingEl.textContent = pending;
    if (approvedEl) approvedEl.textContent = approved;
    if (dismissedEl) dismissedEl.textContent = dismissed;
    if (rateEl) rateEl.textContent = rate + '%';
    if (catEl) {
      var parts = [];
      for (var k in catCounts) {
        parts.push(catCounts[k] + ' ' + k.replace(/_/g, ' '));
      }
      catEl.textContent = parts.join(', ') || '—';
    }
  }

  // ── Render current page ───────────────────────────────────────────────────

  function renderPage() {
    listWrap.innerHTML = '';
    paginationWrap.innerHTML = '';

    var filtered = state.allSuggestions;
    if (state.typeFilter) {
      var tf = state.typeFilter.toLowerCase();
      filtered = filtered.filter(function(s) {
        return (s.type || '').toLowerCase() === tf;
      });
    }
    if (state.categoryFilter) {
      var cf = state.categoryFilter;
      filtered = filtered.filter(function(s) {
        return (s.category || '') === cf;
      });
    }

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
      card.style.cssText = 'margin-bottom:10px;cursor:pointer;';
      card.addEventListener('click', function(e) {
        if (e.target.closest('button')) return;
        location.hash = '#learning/suggestions/' + sug.id;
      });

      var statusBadge = '<span class="badge ' + escHtml(status) + '">' + escHtml(status) + '</span>';
      var confHtml = confidenceBarHtml(conf) +
        ' <span style="font-size:12px;color:' + confColor(conf) + ';font-family:monospace">' +
        conf.toFixed(2) + '</span>';

      var resolvedHtml = sug.resolved_at
        ? '<span style="font-size:11px;color:var(--text-muted)">Resolved: ' + escHtml(fmtDate(sug.resolved_at)) + '</span>'
        : '';

      var actionDataHtml = '';
      if (sug.action_data) {
        var ad;
        try { ad = typeof sug.action_data === 'string' ? JSON.parse(sug.action_data) : sug.action_data; } catch { ad = null; }
        if (ad) actionDataHtml = renderActionData(sug.category, ad);
      }

      card.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
          statusBadge +
          typeBadgeHtml(sug.type) +
          categoryBadgeHtml(sug.category) +
          '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
            confHtml +
          '</span>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:8px">' +
          escHtml(sug.description || '') +
        '</div>' +
        actionDataHtml +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<span style="font-size:11px;color:var(--text-muted)">Created: ' + escHtml(fmtDate(sug.created_at)) + '</span>' +
          resolvedHtml +
        '</div>';

      listWrap.appendChild(card);
    });

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

    var summaryPromise = get('/suggestions');
    summaryPromise.then(function(all) {
      state.summaryAll = Array.isArray(all) ? all : [];
      updateSummary(state.summaryAll);
    }).catch(function() {});

    var listPromise = state.statusFilter ? get('/suggestions' + qs) : summaryPromise;
    listPromise.then(function(data) {
      state.allSuggestions = Array.isArray(data) ? data : [];
      state.page = 1;
      renderPage();
    }).catch(function(err) {
      listWrap.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
    });
  }

  // ── Filter change listeners ───────────────────────────────────────────────

  statusSelect.addEventListener('change', function() {
    state.statusFilter = statusSelect.value;
    loadSuggestions();
  });

  typeSelect.addEventListener('change', function() {
    state.typeFilter = typeSelect.value;
    state.page = 1;
    renderPage();
  });

  categorySelect.addEventListener('change', function() {
    state.categoryFilter = categorySelect.value;
    state.page = 1;
    renderPage();
  });

  // ── Initial load ──────────────────────────────────────────────────────────

  loadSuggestions();
}

// ── Detail View ───────────────────────────────────────────────────────────────
// NOTE: All innerHTML usage below is XSS-safe — every dynamic value passes through
// escHtml() which escapes &, <, >, and ". No raw user/API input is ever inserted.

export function renderDetail(el, id) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  get('/suggestions').then(function(all) {
    var sug = (Array.isArray(all) ? all : []).find(function(s) { return String(s.id) === String(id); });
    if (!sug) {
      el.innerHTML = '<p style="color:var(--danger)">Suggestion not found</p>';
      return;
    }
    el.innerHTML = '';
    renderDetailContent(el, sug);
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderDetailContent(el, sug) {
  var status = sug.status || 'pending';
  var conf = sug.confidence != null ? Number(sug.confidence) : 0;
  var descShort = (sug.description || '').length > 60
    ? (sug.description || '').slice(0, 60) + '…'
    : (sug.description || '');

  // Breadcrumb
  var breadcrumb = document.createElement('div');
  breadcrumb.className = 'learning-breadcrumb';
  breadcrumb.innerHTML =
    '<a href="#learning/suggestions">Suggestions</a> / ' + escHtml(descShort);
  el.appendChild(breadcrumb);

  // Metadata card
  var metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.style.marginBottom = '1rem';
  metaCard.innerHTML =
    '<div class="card-title">Metadata</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">' +
      '<div><span style="color:var(--text-muted)">Status: </span>' +
        '<span class="badge ' + escHtml(status) + '">' + escHtml(status) + '</span></div>' +
      '<div><span style="color:var(--text-muted)">Type: </span>' + typeBadgeHtml(sug.type) + '</div>' +
      '<div><span style="color:var(--text-muted)">Category: </span>' + categoryBadgeHtml(sug.category) + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="color:var(--text-muted)">Confidence: </span>' +
        confidenceBarHtml(conf) +
        '<span style="color:' + confColor(conf) + ';font-family:monospace">' + conf.toFixed(2) + '</span>' +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Created: </span>' +
        '<span style="font-family:monospace;font-size:12px">' + escHtml(fmtDate(sug.created_at)) + '</span></div>' +
      (sug.resolved_at
        ? '<div><span style="color:var(--text-muted)">Resolved: </span>' +
            '<span style="font-family:monospace;font-size:12px">' + escHtml(fmtDate(sug.resolved_at)) + '</span></div>'
        : '') +
    '</div>';
  el.appendChild(metaCard);

  // Vietnamese description card (AI-generated or fallback + translate button)
  var viCard = document.createElement('div');
  viCard.className = 'card';
  viCard.style.marginBottom = '1rem';
  var viContentId = 'vi-content-' + sug.id;
  if (sug.description_vi) {
    viCard.innerHTML =
      '<div class="card-title">Mô tả</div>' +
      '<div id="' + viContentId + '" style="font-size:13px;color:var(--text);line-height:1.8;margin:0">' +
        formatDescriptionVi(sug.description_vi) +
      '</div>';
  } else {
    viCard.innerHTML =
      '<div class="card-title" style="display:flex;align-items:center;gap:8px">Mô tả' +
        '<button class="btn" id="translate-btn-' + sug.id + '" ' +
          'style="font-size:11px;padding:2px 8px">Dịch bằng AI</button>' +
      '</div>' +
      '<div id="' + viContentId + '">' +
        '<pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;' +
          'color:var(--text);line-height:1.7;margin:0">' +
          escHtml(describeSuggestionVi(sug)) +
        '</pre>' +
      '</div>';
  }
  el.appendChild(viCard);

  // Translate button handler
  if (!sug.description_vi) {
    var translateBtn = document.getElementById('translate-btn-' + sug.id);
    if (translateBtn) {
      translateBtn.addEventListener('click', function() {
        translateBtn.disabled = true;
        translateBtn.textContent = 'Đang dịch…';
        post('/suggestions/' + sug.id + '/translate').then(function(res) {
          var contentEl = document.getElementById(viContentId);
          if (contentEl && res.description_vi) {
            contentEl.innerHTML = formatDescriptionVi(res.description_vi);
          }
          translateBtn.style.display = 'none';
        }).catch(function() {
          translateBtn.disabled = false;
          translateBtn.textContent = 'Dịch bằng AI';
        });
      });
    }
  }

  // Description card (English)
  var descCard = document.createElement('div');
  descCard.className = 'card';
  descCard.style.marginBottom = '1rem';
  descCard.innerHTML =
    '<div class="card-title">Description</div>' +
    '<div style="font-size:13px;color:var(--text);line-height:1.6">' +
      escHtml(sug.description || '') +
    '</div>';
  el.appendChild(descCard);

  // Action data card
  if (sug.action_data) {
    var ad;
    try { ad = typeof sug.action_data === 'string' ? JSON.parse(sug.action_data) : sug.action_data; } catch { ad = null; }
    if (ad) {
      var adHtml = renderActionData(sug.category, ad);
      if (adHtml) {
        var adCard = document.createElement('div');
        adCard.className = 'card';
        adCard.style.marginBottom = '1rem';
        adCard.innerHTML = '<div class="card-title">Action Data</div>' + adHtml;
        el.appendChild(adCard);
      }
    }
  }

  // Evidence card
  if (sug.evidence) {
    var evidenceCard = document.createElement('div');
    evidenceCard.className = 'card';
    evidenceCard.style.marginBottom = '1rem';
    evidenceCard.innerHTML =
      '<div class="card-title">Evidence</div>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;font-family:\'SF Mono\',monospace;' +
        'font-size:12px;color:var(--text);line-height:1.6;margin:0">' +
        escHtml(sug.evidence) +
      '</pre>';
    el.appendChild(evidenceCard);
  }

}
