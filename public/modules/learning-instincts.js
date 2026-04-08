// Learning — Instincts sub-module
import { get, post, put, del } from './api.js';
import { fmtDate, confColor, confLabel, escHtml, confidenceBarHtml } from './utils.js';

// ── Chart management ──────────────────────────────────────────────────────────

let charts = [];

function destroyCharts() {
  charts.forEach(function(c) { c.destroy(); });
  charts = [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function domainClass(domain) {
  if (!domain) return '';
  var d = domain.toLowerCase();
  if (d === 'workflow') return 'workflow';
  if (d === 'testing') return 'testing';
  if (d === 'security') return 'security';
  return '';
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el, initialState) {
  destroyCharts();
  el.innerHTML = '';

  var state = Object.assign(
    { domain: '', project: '', search: '', sort: 'confidence', page: 1, per_page: 20, chartsOpen: false },
    initialState || {}
  );

  var debounceTimer = null;

  // Filter row
  var filterRow = document.createElement('div');
  filterRow.className = 'filter-row';

  var domainSelect = document.createElement('select');
  domainSelect.innerHTML = '<option value="">All domains</option>';

  var projectSelect = document.createElement('select');
  projectSelect.innerHTML = '<option value="">All projects</option>';

  var sortOptions = [
    { value: 'confidence', label: 'Confidence' },
    { value: 'recent', label: 'Recently seen' },
    { value: 'seen', label: 'Most seen' },
    { value: 'newest', label: 'Newest' },
  ];
  var sortSelect = document.createElement('select');
  sortOptions.forEach(function(o) {
    var opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === state.sort) opt.selected = true;
    sortSelect.appendChild(opt);
  });

  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search instincts\u2026';
  searchInput.value = state.search;
  searchInput.style.minWidth = '200px';

  filterRow.appendChild(domainSelect);
  filterRow.appendChild(projectSelect);
  filterRow.appendChild(sortSelect);
  filterRow.appendChild(searchInput);
  el.appendChild(filterRow);

  // Chart toggle
  var chartToggle = document.createElement('div');
  chartToggle.className = 'chart-toggle';
  chartToggle.textContent = state.chartsOpen ? '\u25bc Charts' : '\u25ba Charts';
  el.appendChild(chartToggle);

  var chartsWrap = document.createElement('div');
  chartsWrap.style.cssText =
    'display:' + (state.chartsOpen ? 'grid' : 'none') + ';' +
    'grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;';

  var confCard = document.createElement('div');
  confCard.className = 'card';
  confCard.innerHTML =
    '<div class="card-title">Confidence Distribution</div>' +
    '<div class="chart-wrap medium"><canvas id="op-instincts-conf-chart"></canvas></div>';

  var domainCard = document.createElement('div');
  domainCard.className = 'card';
  domainCard.innerHTML =
    '<div class="card-title">By Domain</div>' +
    '<div class="chart-wrap medium"><canvas id="op-instincts-domain-chart"></canvas></div>';

  chartsWrap.appendChild(confCard);
  chartsWrap.appendChild(domainCard);
  el.appendChild(chartsWrap);

  chartToggle.addEventListener('click', function() {
    state.chartsOpen = !state.chartsOpen;
    chartToggle.textContent = state.chartsOpen ? '\u25bc Charts' : '\u25ba Charts';
    chartsWrap.style.display = state.chartsOpen ? 'grid' : 'none';
    if (state.chartsOpen) {
      renderChartsFromApi();
    } else {
      destroyCharts();
    }
  });

  // List + pagination containers
  var listWrap = document.createElement('div');
  el.appendChild(listWrap);

  var paginationWrap = document.createElement('div');
  el.appendChild(paginationWrap);

  // Load filter options from stats + projects
  Promise.all([
    get('/instincts/stats'),
    get('/instincts/projects'),
  ]).then(function(results) {
    var stats = results[0];
    var projects = results[1];

    (stats.byDomain || []).forEach(function(item) {
      var opt = document.createElement('option');
      opt.value = item.domain || '';
      opt.textContent = (item.domain || 'unknown') + ' (' + item.count + ')';
      if (item.domain === state.domain) opt.selected = true;
      domainSelect.appendChild(opt);
    });

    (projects || []).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id || p.project_id || p.name || '';
      opt.textContent = p.name || p.id || '';
      if (opt.value === state.project) opt.selected = true;
      projectSelect.appendChild(opt);
    });

    if (state.chartsOpen) {
      renderChartsWithStats(stats);
    }
  }).catch(function() {});

  function renderChartsFromApi() {
    get('/instincts/stats').then(function(stats) {
      renderChartsWithStats(stats);
    }).catch(function() {});
  }

  function renderChartsWithStats(stats) {
    destroyCharts();

    var confCanvas = document.getElementById('op-instincts-conf-chart');
    if (confCanvas) {
      var dist = stats.confidenceDistribution || { low: 0, medium: 0, high: 0 };
      charts.push(new Chart(confCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: ['Low (<0.3)', 'Medium (0.3-0.6)', 'High (>0.6)'],
          datasets: [{
            data: [dist.low || 0, dist.medium || 0, dist.high || 0],
            backgroundColor: ['#e17055', '#fdcb6e', '#00b894'],
            borderWidth: 0,
            borderRadius: 4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#2a2d3a' } },
            y: { grid: { color: '#2a2d3a' }, ticks: { stepSize: 1 } },
          },
        },
      }));
    }

    var domainCanvas = document.getElementById('op-instincts-domain-chart');
    if (domainCanvas) {
      var byDomain = stats.byDomain || [];
      charts.push(new Chart(domainCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: byDomain.map(function(d) { return d.domain || 'unknown'; }),
          datasets: [{
            data: byDomain.map(function(d) { return d.count; }),
            backgroundColor: '#6c5ce780',
            borderColor: '#6c5ce7',
            borderWidth: 1,
            borderRadius: 4,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#2a2d3a' }, ticks: { stepSize: 1 } },
            y: { grid: { display: false } },
          },
        },
      }));
    }
  }

  function loadList() {
    var qs = '?page=' + state.page + '&per_page=' + state.per_page;
    if (state.sort && state.sort !== 'confidence') qs += '&sort=' + encodeURIComponent(state.sort);
    if (state.domain) qs += '&domain=' + encodeURIComponent(state.domain);
    if (state.project) qs += '&project=' + encodeURIComponent(state.project);
    if (state.search) qs += '&search=' + encodeURIComponent(state.search);

    listWrap.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

    get('/instincts' + qs).then(function(data) {
      var items = data.items || [];
      var total = data.total || 0;
      var totalPages = Math.ceil(total / state.per_page) || 1;

      listWrap.innerHTML = '';

      if (items.length === 0) {
        listWrap.innerHTML = '<div class="empty-state">No instincts found</div>';
        paginationWrap.innerHTML = '';
        return;
      }

      items.forEach(function(inst) {
        var card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = inst.id;
        card.style.cssText = 'margin-bottom:10px;cursor:pointer;transition:border-color 0.15s;';

        var conf = inst.confidence || 0;
        var color = confColor(conf);
        var domCls = domainClass(inst.domain || inst.category || '');
        var domText = escHtml(inst.domain || inst.category || 'general');
        var badgeHtml = domCls
          ? '<span class="badge ' + domCls + '">' + domText + '</span>'
          : '<span class="badge">' + domText + '</span>';

        var projName = inst.project_name || inst.project_id || null;
        var projBadgeHtml = projName
          ? '<span class="badge" style="background:rgba(0,184,148,0.15);color:var(--success);margin-left:6px">' + escHtml(projName) + '</span>'
          : '<span class="badge" style="background:rgba(139,143,163,0.15);color:var(--text-muted);margin-left:6px">global</span>';

        var snippet = (inst.instinct || '').slice(0, 100);
        if ((inst.instinct || '').length > 100) snippet += '\u2026';

        var seenCount = inst.seen_count || inst.times_seen || 0;

        card.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
            '<span style="font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
              escHtml(inst.pattern) +
            '</span>' +
            badgeHtml +
            projBadgeHtml +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
            confidenceBarHtml(conf) +
            '<span class="conf-value" style="font-size:12px;color:' + color + ';font-family:monospace">' + conf.toFixed(2) + '</span>' +
            '<span style="font-size:12px;color:var(--text-muted);margin-left:4px">\u00b7 seen ' + seenCount + 'x</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);font-family:\'SF Mono\',monospace;line-height:1.5">' +
            escHtml(snippet) +
          '</div>';

        // Validate / Reject quick actions
        var actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
        actionsDiv.addEventListener('click', function(e) { e.stopPropagation(); });

        var vBtn = document.createElement('button');
        vBtn.className = 'btn btn-sm';
        vBtn.style.cssText = 'font-size:11px;padding:2px 10px;background:rgba(0,184,148,0.15);color:var(--success);border:1px solid var(--success);';
        vBtn.textContent = '\u2713 Validate';
        vBtn.addEventListener('click', (function(instId, cardEl) {
          return function() {
            vBtn.disabled = true;
            vBtn.textContent = '\u2026';
            put('/instincts/' + encodeURIComponent(instId) + '/validate')
              .then(function(res) {
                var cs = cardEl.querySelector('.conf-value');
                if (cs && res.confidence != null) {
                  cs.textContent = res.confidence.toFixed(2);
                  cs.style.color = '#00b894';
                  setTimeout(function() { cs.style.color = confColor(res.confidence); }, 1200);
                }
                vBtn.disabled = false; vBtn.textContent = '\u2713 Validate';
              })
              .catch(function() { vBtn.disabled = false; vBtn.textContent = '\u2713 Validate'; });
          };
        })(inst.id, card));

        var rBtn = document.createElement('button');
        rBtn.className = 'btn btn-sm';
        rBtn.style.cssText = 'font-size:11px;padding:2px 10px;background:rgba(225,112,85,0.15);color:var(--danger);border:1px solid var(--danger);';
        rBtn.textContent = '\u2717 Reject';
        rBtn.addEventListener('click', (function(instId, cardEl) {
          return function() {
            rBtn.disabled = true;
            rBtn.textContent = '\u2026';
            put('/instincts/' + encodeURIComponent(instId) + '/reject')
              .then(function(res) {
                if (res.archived) {
                  cardEl.style.opacity = '0';
                  cardEl.style.transition = 'opacity 0.3s';
                  setTimeout(function() { cardEl.remove(); }, 300);
                } else {
                  var cs = cardEl.querySelector('.conf-value');
                  if (cs && res.confidence != null) {
                    cs.textContent = res.confidence.toFixed(2);
                    cs.style.color = '#e17055';
                    setTimeout(function() { cs.style.color = confColor(res.confidence); }, 1200);
                  }
                  rBtn.disabled = false; rBtn.textContent = '\u2717 Reject';
                }
              })
              .catch(function() { rBtn.disabled = false; rBtn.textContent = '\u2717 Reject'; });
          };
        })(inst.id, card));

        actionsDiv.appendChild(vBtn);
        actionsDiv.appendChild(rBtn);
        card.appendChild(actionsDiv);

        card.addEventListener('mouseenter', function() { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', function() { card.style.borderColor = ''; });
        card.addEventListener('click', function() {
          location.hash = '#learning/instincts/' + card.dataset.id;
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

  sortSelect.addEventListener('change', function() {
    state.sort = sortSelect.value;
    state.page = 1;
    loadList();
  });

  domainSelect.addEventListener('change', function() {
    state.domain = domainSelect.value;
    state.page = 1;
    loadList();
  });

  projectSelect.addEventListener('change', function() {
    state.project = projectSelect.value;
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

  get('/instincts/' + encodeURIComponent(id)).then(function(inst) {
    el.innerHTML = '';
    renderDetailContent(el, inst);
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderDetailContent(el, inst) {
  var conf = inst.confidence || 0;
  var color = confColor(conf);
  var domCls = domainClass(inst.domain || inst.category || '');
  var domLabel = inst.domain || inst.category || 'general';
  var projName = inst.project_name || inst.project_id || null;

  // Breadcrumb
  var breadcrumb = document.createElement('div');
  breadcrumb.className = 'learning-breadcrumb';
  breadcrumb.innerHTML =
    '<a href="#learning/instincts">Instincts</a> / ' + escHtml(inst.pattern || 'Instinct #' + inst.id);
  el.appendChild(breadcrumb);

  // Metadata card
  var metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.style.marginBottom = '1rem';

  var domBadge = domCls
    ? '<span class="badge ' + domCls + '">' + escHtml(domLabel) + '</span>'
    : '<span class="badge">' + escHtml(domLabel) + '</span>';

  var projBadge = projName
    ? '<span class="badge" style="background:rgba(0,184,148,0.15);color:var(--success)">' + escHtml(projName) + '</span>'
    : '<span class="badge" style="background:rgba(139,143,163,0.15);color:var(--text-muted)">global</span>';

  var seenCount = inst.seen_count || inst.times_seen || 0;
  var firstSeen = fmtDate(inst.first_seen || inst.created_at);
  var lastSeen = fmtDate(inst.last_seen || inst.updated_at);

  metaCard.innerHTML =
    '<div class="card-title">Metadata</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">' +
      '<div><span style="color:var(--text-muted)">Domain: </span>' + domBadge + '</div>' +
      '<div><span style="color:var(--text-muted)">Project: </span>' + projBadge + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="color:var(--text-muted)">Confidence: </span>' +
        confidenceBarHtml(conf) +
        '<span style="color:' + color + ';font-family:monospace">' + conf.toFixed(2) + '</span>' +
        '<span style="color:var(--text-muted);font-size:11px">(' + confLabel(conf) + ')</span>' +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Seen: </span>' +
        '<span style="font-family:monospace">' + seenCount + 'x</span>' +
      '</div>' +
      '<div><span style="color:var(--text-muted)">First seen: </span>' +
        '<span style="font-family:monospace;font-size:12px">' + escHtml(firstSeen) + '</span>' +
      '</div>' +
      '<div><span style="color:var(--text-muted)">Last seen: </span>' +
        '<span style="font-family:monospace;font-size:12px">' + escHtml(lastSeen) + '</span>' +
      '</div>' +
    '</div>';
  el.appendChild(metaCard);

  // Vietnamese translation card
  var viCard = document.createElement('div');
  viCard.className = 'card';
  viCard.style.marginBottom = '1rem';

  var viTitle = document.createElement('div');
  viTitle.className = 'card-title';
  viTitle.textContent = 'Bản dịch tiếng Việt';
  viCard.appendChild(viTitle);

  var viBody = document.createElement('div');
  viBody.id = 'instinct-vi-body';
  viCard.appendChild(viBody);

  if (inst.instinct_vi) {
    var viPre = document.createElement('pre');
    viPre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text);line-height:1.6;margin:0';
    viPre.textContent = inst.instinct_vi;
    viBody.appendChild(viPre);
  } else {
    var translateBtn = document.createElement('button');
    translateBtn.className = 'btn btn-primary';
    translateBtn.textContent = 'Dịch sang tiếng Việt';
    translateBtn.addEventListener('click', function() {
      translateBtn.disabled = true;
      translateBtn.textContent = 'Đang dịch…';
      post('/instincts/' + encodeURIComponent(inst.id) + '/translate')
        .then(function(res) {
          viBody.innerHTML = '';
          var pre = document.createElement('pre');
          pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text);line-height:1.6;margin:0';
          pre.textContent = res.instinct_vi;
          viBody.appendChild(pre);
        })
        .catch(function(err) {
          translateBtn.disabled = false;
          translateBtn.textContent = 'Dịch sang tiếng Việt';
          alert('Lỗi: ' + err.message);
        });
    });
    viBody.appendChild(translateBtn);
  }
  el.appendChild(viCard);

  // Action buttons
  var actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;margin-bottom:1rem;';

  var editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.textContent = 'Edit Confidence';
  editBtn.addEventListener('click', function() {
    var newConf = prompt('New confidence (0.0 \u2013 1.0):', conf.toFixed(2));
    if (newConf === null) return;
    var val = parseFloat(newConf);
    if (isNaN(val) || val < 0 || val > 1) {
      alert('Invalid value. Enter a number between 0.0 and 1.0.');
      return;
    }
    put('/instincts/' + encodeURIComponent(inst.id), { confidence: val })
      .then(function() { renderDetail(el, inst.id); })
      .catch(function(err) { alert('Error: ' + err.message); });
  });

  var archiveBtn = document.createElement('button');
  archiveBtn.className = 'btn btn-danger';
  archiveBtn.textContent = 'Archive';
  archiveBtn.addEventListener('click', function() {
    if (!confirm('Archive this instinct? This will set confidence to 0.')) return;
    put('/instincts/' + encodeURIComponent(inst.id), { confidence: 0 })
      .then(function() { location.hash = '#learning/instincts'; })
      .catch(function(err) { alert('Error: ' + err.message); });
  });

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function() {
    if (!confirm('Permanently delete this instinct? This cannot be undone.')) return;
    del('/instincts/' + encodeURIComponent(inst.id))
      .then(function() { location.hash = '#learning/instincts'; })
      .catch(function(err) { alert('Error: ' + err.message); });
  });

  var validateBtn = document.createElement('button');
  validateBtn.className = 'btn';
  validateBtn.style.cssText = 'background:rgba(0,184,148,0.15);color:var(--success);border:1px solid var(--success)';
  validateBtn.textContent = '\u2713 Validate (+0.15)';
  validateBtn.addEventListener('click', function() {
    validateBtn.disabled = true;
    put('/instincts/' + encodeURIComponent(inst.id) + '/validate')
      .then(function() { renderDetail(el, inst.id); })
      .catch(function(err) { validateBtn.disabled = false; alert('Error: ' + err.message); });
  });

  var rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn';
  rejectBtn.style.cssText = 'background:rgba(225,112,85,0.15);color:var(--danger);border:1px solid var(--danger)';
  rejectBtn.textContent = '\u2717 Reject (-0.2)';
  rejectBtn.addEventListener('click', function() {
    if (!confirm('Reject this instinct? Confidence -0.2. After 3 rejections it will be archived.')) return;
    rejectBtn.disabled = true;
    put('/instincts/' + encodeURIComponent(inst.id) + '/reject')
      .then(function(res) {
        if (res.archived) { alert('Instinct archived after 3 rejections.'); location.hash = '#learning/instincts'; }
        else { renderDetail(el, inst.id); }
      })
      .catch(function(err) { rejectBtn.disabled = false; alert('Error: ' + err.message); });
  });

  actionsRow.appendChild(validateBtn);
  actionsRow.appendChild(rejectBtn);
  actionsRow.appendChild(editBtn);
  actionsRow.appendChild(archiveBtn);
  actionsRow.appendChild(deleteBtn);
  el.appendChild(actionsRow);

  // Content card
  var contentCard = document.createElement('div');
  contentCard.className = 'card';
  contentCard.style.marginBottom = '1rem';
  contentCard.innerHTML =
    '<div class="card-title">Instinct</div>' +
    '<pre style="white-space:pre-wrap;word-break:break-word;font-family:\'SF Mono\',monospace;' +
      'font-size:12px;color:var(--text);line-height:1.6;margin:0">' +
      escHtml(inst.instinct || '') +
    '</pre>';
  el.appendChild(contentCard);

  // Related suggestions
  var sugCard = document.createElement('div');
  sugCard.className = 'card';
  sugCard.innerHTML =
    '<div class="card-title">Related Suggestions</div>' +
    '<div id="sug-body" class="empty-state"><span class="spinner"></span></div>';
  el.appendChild(sugCard);

  get('/instincts/' + encodeURIComponent(inst.id) + '/suggestions')
    .then(function(suggestions) {
      var sugBody = sugCard.querySelector('#sug-body');
      if (!suggestions || suggestions.length === 0) {
        sugBody.textContent = 'No related suggestions';
        return;
      }
      sugBody.className = '';
      suggestions.forEach(function(sug) {
        var item = document.createElement('div');
        item.style.cssText = 'border-bottom:1px solid var(--border);padding:10px 0;';
        var status = sug.status || 'pending';
        var statusBadge = '<span class="badge ' + status + '">' + escHtml(status) + '</span>';
        var typeBadge = sug.type
          ? ' <span class="badge" style="background:rgba(108,92,231,0.15);color:var(--accent)">' +
              escHtml(sug.type) + '</span>'
          : '';
        var conf2 = sug.confidence != null ? Number(sug.confidence).toFixed(2) : '\u2014';
        item.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
            statusBadge + typeBadge +
            '<span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-family:monospace">' +
              'conf: ' + conf2 +
            '</span>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text);line-height:1.5">' +
            escHtml(sug.description || '') +
          '</div>';
        sugBody.appendChild(item);
      });
    })
    .catch(function(err) {
      sugCard.querySelector('#sug-body').innerHTML =
        '<p style="color:var(--danger)">Error: ' + escHtml(err.message) + '</p>';
    });
}
