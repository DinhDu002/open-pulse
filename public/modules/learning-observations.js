// Learning — Observations sub-module
import { get } from './api.js';

// ── Chart management ──────────────────────────────────────────────────────────

let activityChart = null;

function destroyCharts() {
  if (activityChart) { activityChart.destroy(); activityChart = null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, YYYY HH:mm');
}

function fmtDateShort(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function categoryClass(cat) {
  if (!cat) return '';
  var c = cat.toLowerCase();
  if (c === 'workflow') return 'workflow';
  if (c === 'testing') return 'testing';
  if (c === 'security') return 'security';
  return '';
}

function categoryBadgeHtml(cat) {
  if (!cat) return '';
  var cls = categoryClass(cat);
  return cls
    ? '<span class="badge ' + cls + '">' + escHtml(cat) + '</span>'
    : '<span class="badge">' + escHtml(cat) + '</span>';
}

function projectBadgeHtml(projectId) {
  if (!projectId) return '<span class="badge" style="background:rgba(139,143,163,0.15);color:var(--text-muted)">global</span>';
  return '<span class="badge" style="background:rgba(0,184,148,0.15);color:var(--success)">' + escHtml(projectId) + '</span>';
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '\u2026';
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el, initialState) {
  destroyCharts();
  el.innerHTML = '';

  var state = Object.assign(
    { project: '', category: '', from: '', to: '', search: '', page: 1, per_page: 20, activityOpen: false },
    initialState || {}
  );

  var debounceTimer = null;

  // ── Filter row ────────────────────────────────────────────────────────────

  var filterRow = document.createElement('div');
  filterRow.className = 'filter-row';

  var projectSelect = document.createElement('select');
  projectSelect.innerHTML = '<option value="">All projects</option>';

  var categorySelect = document.createElement('select');
  categorySelect.innerHTML = [
    '<option value="">All categories</option>',
    '<option value="workflow">workflow</option>',
    '<option value="testing">testing</option>',
    '<option value="security">security</option>',
    '<option value="performance">performance</option>',
    '<option value="patterns">patterns</option>',
  ].join('');
  if (state.category) {
    Array.from(categorySelect.options).forEach(function(opt) {
      if (opt.value === state.category) opt.selected = true;
    });
  }

  var fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.title = 'From date';
  fromInput.value = state.from;
  fromInput.style.cssText = 'padding:6px 8px;background:var(--surface);border:1px solid var(--border);' +
    'border-radius:6px;color:var(--text);font-size:13px;';

  var toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.title = 'To date';
  toInput.value = state.to;
  toInput.style.cssText = 'padding:6px 8px;background:var(--surface);border:1px solid var(--border);' +
    'border-radius:6px;color:var(--text);font-size:13px;';

  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search observations\u2026';
  searchInput.value = state.search;
  searchInput.style.minWidth = '200px';

  filterRow.appendChild(projectSelect);
  filterRow.appendChild(categorySelect);
  filterRow.appendChild(fromInput);
  filterRow.appendChild(toInput);
  filterRow.appendChild(searchInput);
  el.appendChild(filterRow);

  // ── Activity chart (collapsible) ──────────────────────────────────────────

  var chartToggle = document.createElement('div');
  chartToggle.className = 'chart-toggle';
  chartToggle.textContent = state.activityOpen ? '\u25bc Activity' : '\u25ba Activity';
  el.appendChild(chartToggle);

  var activityWrap = document.createElement('div');
  activityWrap.className = 'obs-activity-chart';
  activityWrap.style.display = state.activityOpen ? 'block' : 'none';

  var activityCard = document.createElement('div');
  activityCard.className = 'card';
  activityCard.style.marginBottom = '1rem';
  activityCard.innerHTML =
    '<div class="card-title">Observations per day (30 days)</div>' +
    '<div class="chart-wrap medium"><canvas id="op-obs-activity-canvas"></canvas></div>';
  activityWrap.appendChild(activityCard);
  el.appendChild(activityWrap);

  chartToggle.addEventListener('click', function() {
    state.activityOpen = !state.activityOpen;
    chartToggle.textContent = state.activityOpen ? '\u25bc Activity' : '\u25ba Activity';
    activityWrap.style.display = state.activityOpen ? 'block' : 'none';
    if (state.activityOpen) {
      loadActivityChart();
    } else {
      destroyCharts();
    }
  });

  // ── List + pagination containers ──────────────────────────────────────────

  var listWrap = document.createElement('div');
  el.appendChild(listWrap);

  var paginationWrap = document.createElement('div');
  el.appendChild(paginationWrap);

  // ── Load project options ──────────────────────────────────────────────────

  get('/instincts/projects').then(function(projects) {
    (projects || []).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id || p.project_id || '';
      opt.textContent = p.name || p.id || '';
      if (opt.value === state.project) opt.selected = true;
      projectSelect.appendChild(opt);
    });
  }).catch(function() {});

  // ── Activity chart loader ─────────────────────────────────────────────────

  function loadActivityChart() {
    get('/observations/activity?days=30').then(function(data) {
      destroyCharts();
      var canvas = document.getElementById('op-obs-activity-canvas');
      if (!canvas || !data || !data.length) return;
      var labels = data.map(function(d) { return fmtDateShort(d.date); });
      var counts = data.map(function(d) { return d.count; });
      activityChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            data: counts,
            backgroundColor: '#6c5ce7',
            borderWidth: 0,
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#2a2d3a' }, ticks: { maxTicksLimit: 10, font: { size: 11 } } },
            y: { grid: { color: '#2a2d3a' }, ticks: { stepSize: 1 } },
          },
        },
      });
    }).catch(function() {});
  }

  if (state.activityOpen) {
    loadActivityChart();
  }

  // ── List loader ───────────────────────────────────────────────────────────

  function loadList() {
    var qs = '?page=' + state.page + '&per_page=' + state.per_page;
    if (state.project)  qs += '&project='  + encodeURIComponent(state.project);
    if (state.category) qs += '&category=' + encodeURIComponent(state.category);
    if (state.from)     qs += '&from='     + encodeURIComponent(state.from);
    if (state.to)       qs += '&to='       + encodeURIComponent(state.to);
    if (state.search)   qs += '&search='   + encodeURIComponent(state.search);

    listWrap.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

    get('/observations' + qs).then(function(data) {
      var items = data.items || [];
      var total = data.total || 0;
      var totalPages = Math.ceil(total / state.per_page) || 1;

      listWrap.innerHTML = '';

      if (items.length === 0) {
        listWrap.innerHTML = '<div class="empty-state">No observations found</div>';
        paginationWrap.innerHTML = '';
        return;
      }

      items.forEach(function(obs) {
        var card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = obs.id;
        card.style.cssText = 'margin-bottom:10px;cursor:pointer;transition:border-color 0.15s;';

        var sessionSnippet = obs.session_id ? obs.session_id.slice(0, 8) : null;
        var sessionHtml = sessionSnippet
          ? '<span style="font-family:monospace;font-size:11px;color:var(--text-muted)">' +
              escHtml(sessionSnippet) + '\u2026</span>'
          : '';

        card.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
            '<span style="font-size:11px;color:var(--text-muted);font-family:monospace">' +
              escHtml(fmtDate(obs.observed_at)) +
            '</span>' +
            categoryBadgeHtml(obs.category) +
            projectBadgeHtml(obs.project_id) +
            sessionHtml +
          '</div>' +
          '<div style="font-size:13px;color:var(--text);line-height:1.5">' +
            escHtml(truncate(obs.observation, 150)) +
          '</div>';

        card.addEventListener('mouseenter', function() { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', function() { card.style.borderColor = ''; });
        card.addEventListener('click', function() {
          location.hash = '#learning/observations/' + card.dataset.id;
        });

        listWrap.appendChild(card);
      });

      // Pagination
      paginationWrap.innerHTML = '';
      if (totalPages > 1) {
        var pg = document.createElement('div');
        pg.className = 'pagination';

        var prevBtn = document.createElement('button');
        prevBtn.textContent = '\u2190 Prev';
        prevBtn.disabled = state.page <= 1;
        prevBtn.addEventListener('click', function() {
          if (state.page > 1) { state.page--; loadList(); }
        });

        var pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = 'Page ' + state.page + ' / ' + totalPages + ' (' + total + ' total)';

        var nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next \u2192';
        nextBtn.disabled = state.page >= totalPages;
        nextBtn.addEventListener('click', function() {
          if (state.page < totalPages) { state.page++; loadList(); }
        });

        pg.appendChild(prevBtn);
        pg.appendChild(pageInfo);
        pg.appendChild(nextBtn);
        paginationWrap.appendChild(pg);
      }
    }).catch(function(err) {
      listWrap.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
    });
  }

  // ── Filter event listeners ────────────────────────────────────────────────

  projectSelect.addEventListener('change', function() {
    state.project = projectSelect.value;
    state.page = 1;
    loadList();
  });

  categorySelect.addEventListener('change', function() {
    state.category = categorySelect.value;
    state.page = 1;
    loadList();
  });

  fromInput.addEventListener('change', function() {
    state.from = fromInput.value;
    state.page = 1;
    loadList();
  });

  toInput.addEventListener('change', function() {
    state.to = toInput.value;
    state.page = 1;
    loadList();
  });

  searchInput.addEventListener('input', function() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      state.search = searchInput.value;
      state.page = 1;
      loadList();
    }, 300);
  });

  loadList();
}

// ── Detail View ───────────────────────────────────────────────────────────────

export function renderDetail(el, id) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  get('/observations/' + encodeURIComponent(id)).then(function(obs) {
    el.innerHTML = '';
    renderDetailContent(el, obs);
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderDetailContent(el, obs) {
  // ── Breadcrumb ────────────────────────────────────────────────────────────

  var breadcrumb = document.createElement('div');
  breadcrumb.className = 'learning-breadcrumb';
  breadcrumb.innerHTML =
    '<a href="#learning/observations">Observations</a> / #' + escHtml(String(obs.id));
  el.appendChild(breadcrumb);

  // ── Metadata card ─────────────────────────────────────────────────────────

  var metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.style.marginBottom = '1rem';

  var sessionLinkHtml = obs.session_id
    ? '<a href="#sessions/' + encodeURIComponent(obs.session_id) + '" ' +
        'style="color:var(--accent);font-family:monospace;font-size:12px;text-decoration:none">' +
        escHtml(obs.session_id.slice(0, 8)) + '\u2026</a>'
    : '<span style="color:var(--text-muted)">—</span>';

  metaCard.innerHTML =
    '<div class="card-title">Metadata</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">' +
      '<div><span style="color:var(--text-muted)">Observed at: </span>' +
        '<span style="font-family:monospace;font-size:12px">' + escHtml(fmtDate(obs.observed_at)) + '</span>' +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Category: </span>' +
        categoryBadgeHtml(obs.category) +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Project: </span>' +
        projectBadgeHtml(obs.project_id) +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Session: </span>' +
        sessionLinkHtml +
      '</div>' +
    '</div>';
  el.appendChild(metaCard);

  // ── Observation text card ─────────────────────────────────────────────────

  var obsCard = document.createElement('div');
  obsCard.className = 'card';
  obsCard.style.marginBottom = '1rem';
  obsCard.innerHTML =
    '<div class="card-title">Observation</div>' +
    '<p style="font-size:13px;color:var(--text);line-height:1.7;margin:0;white-space:pre-wrap;word-break:break-word">' +
      escHtml(obs.observation || '') +
    '</p>';
  el.appendChild(obsCard);

  // ── Raw context (collapsible) ─────────────────────────────────────────────

  if (obs.raw_context) {
    var rawCard = document.createElement('div');
    rawCard.className = 'card';
    rawCard.style.marginBottom = '1rem';

    var rawToggle = document.createElement('div');
    rawToggle.className = 'chart-toggle';
    rawToggle.style.marginBottom = '0';
    rawToggle.textContent = '\u25ba Raw context';

    var rawPre = document.createElement('pre');
    rawPre.style.cssText =
      'display:none;margin:12px 0 0;padding:0;white-space:pre-wrap;word-break:break-all;' +
      'font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-muted);line-height:1.5;' +
      'max-height:400px;overflow-y:auto;';

    var parsed = null;
    try { parsed = JSON.parse(obs.raw_context); } catch (_) { parsed = obs.raw_context; }
    rawPre.textContent = JSON.stringify(parsed, null, 2);

    rawToggle.addEventListener('click', function() {
      var open = rawPre.style.display === 'block';
      rawPre.style.display = open ? 'none' : 'block';
      rawToggle.textContent = open ? '\u25ba Raw context' : '\u25bc Raw context';
    });

    rawCard.appendChild(rawToggle);
    rawCard.appendChild(rawPre);
    el.appendChild(rawCard);
  }

  // ── Linked instinct ───────────────────────────────────────────────────────

  if (obs.instinct_id) {
    var instinctCard = document.createElement('div');
    instinctCard.className = 'card';
    instinctCard.style.marginBottom = '1rem';
    instinctCard.innerHTML =
      '<div class="card-title">Linked Instinct</div>' +
      '<a href="#learning/instincts/' + encodeURIComponent(obs.instinct_id) + '" ' +
        'style="color:var(--accent);text-decoration:none;font-size:13px">View instinct #' +
        escHtml(String(obs.instinct_id)) + ' \u2192</a>';
    el.appendChild(instinctCard);
  }
}
