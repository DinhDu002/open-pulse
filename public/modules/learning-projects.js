// Learning — Projects sub-module
import { get, post } from './api.js';

// ── Chart management ──────────────────────────────────────────────────────────

let charts = [];

function destroyCharts() {
  charts.forEach(function(c) { c.destroy(); });
  charts = [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, YYYY HH:mm');
}

function fmtDateShort(ts) {
  if (!ts) return '';
  return dayjs(ts).format('MMM D');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '\u2026';
}

function pct(value) {
  if (value == null) return '\u2014';
  return Math.round(value * 100) + '%';
}

function statCell(label, value) {
  return (
    '<div style="text-align:center;padding:12px 8px;background:var(--bg);border-radius:8px">' +
      '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">' +
        escHtml(String(label)) +
      '</div>' +
      '<div style="font-size:16px;font-weight:700;font-family:\'SF Mono\',monospace">' +
        escHtml(String(value)) +
      '</div>' +
    '</div>'
  );
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el) {
  destroyCharts();
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  get('/instincts/projects').then(function(projects) {
    el.innerHTML = '';

    if (!projects || projects.length === 0) {
      el.innerHTML = '<div class="empty-state">No projects found. Start using Claude Code to collect data.</div>';
      return;
    }

    // Comparison charts (only if more than 1 project)
    if (projects.length > 1) {
      renderComparisonSection(el, projects);
    }

    // Project cards
    projects.forEach(function(proj) {
      el.appendChild(buildProjectCard(proj, el));
    });
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderComparisonSection(el, projects) {
  var compToggle = document.createElement('div');
  compToggle.className = 'chart-toggle';
  compToggle.textContent = '\u25ba Comparison';
  el.appendChild(compToggle);

  var chartsWrap = document.createElement('div');
  chartsWrap.style.cssText = 'display:none;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;';

  var chartDefs = [
    { id: 'op-proj-instincts-chart', title: 'Instincts per project', color: '#6c5ce7' },
    { id: 'op-proj-confidence-chart', title: 'Avg confidence per project', color: '#00b894' },
    { id: 'op-proj-obs-chart', title: 'Observations per project', color: '#74b9ff' },
    { id: 'op-proj-approve-chart', title: 'Approve rate % per project', color: '#fdcb6e' },
  ];

  chartDefs.forEach(function(def) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-title">' + escHtml(def.title) + '</div>' +
      '<div class="chart-wrap medium"><canvas id="' + def.id + '"></canvas></div>';
    chartsWrap.appendChild(card);
  });

  el.appendChild(chartsWrap);

  var chartsOpen = false;

  compToggle.addEventListener('click', function() {
    chartsOpen = !chartsOpen;
    compToggle.textContent = chartsOpen ? '\u25bc Comparison' : '\u25ba Comparison';
    chartsWrap.style.display = chartsOpen ? 'grid' : 'none';
    if (chartsOpen) {
      renderComparisonCharts(projects);
    } else {
      destroyCharts();
    }
  });
}

function renderComparisonCharts(projects) {
  destroyCharts();

  var names = projects.map(function(p) { return p.name || p.id || 'unknown'; });

  function makeHBar(id, values, color) {
    var canvas = document.getElementById(id);
    if (!canvas) return;
    charts.push(new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{
          data: values,
          backgroundColor: color + '80',
          borderColor: color,
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#2a2d3a' }, ticks: { stepSize: 1 } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } },
        },
      },
    }));
  }

  makeHBar(
    'op-proj-instincts-chart',
    projects.map(function(p) { return p.instincts || 0; }),
    '#6c5ce7'
  );
  makeHBar(
    'op-proj-confidence-chart',
    projects.map(function(p) { return p.avg_confidence != null ? +(p.avg_confidence).toFixed(2) : 0; }),
    '#00b894'
  );
  makeHBar(
    'op-proj-obs-chart',
    projects.map(function(p) { return p.observations || 0; }),
    '#74b9ff'
  );
  makeHBar(
    'op-proj-approve-chart',
    projects.map(function(p) { return p.approve_rate != null ? Math.round(p.approve_rate * 100) : 0; }),
    '#fdcb6e'
  );
}

function buildProjectCard(proj, listEl) {
  var card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:12px;';

  var running = proj.observer_running;
  var statusDot = running
    ? '<span style="color:var(--success);font-size:14px" title="Observer running">\u25cf</span>'
    : '<span style="color:var(--text-muted);font-size:14px" title="Observer stopped">\u25cb</span>';
  var statusLabel = running
    ? '<span style="color:var(--success);font-size:11px">running</span>'
    : '<span style="color:var(--text-muted);font-size:11px">stopped</span>';

  var pending = proj.pending || 0;
  var pendingBadge = pending > 0
    ? '<span class="badge pending" style="margin-left:6px">' + pending + ' pending</span>'
    : '';

  card.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<span style="font-weight:600;font-size:14px;flex:1">' + escHtml(proj.name || proj.id) + '</span>' +
      statusDot + statusLabel + pendingBadge +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-muted);font-family:\'SF Mono\',monospace;' +
      'margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
      escHtml(proj.directory || '') + '">' +
      escHtml(proj.directory || '\u2014') +
    '</div>' +
    '<div style="display:flex;gap:16px;font-size:13px;color:var(--text-muted);margin-bottom:12px">' +
      '<span>Sessions: <strong style="color:var(--text)">' + (proj.session_count || 0) + '</strong></span>' +
      '<span>Instincts: <strong style="color:var(--text)">' + (proj.instincts || 0) + '</strong></span>' +
      '<span>Observations: <strong style="color:var(--text)">' + (proj.observations || 0) + '</strong></span>' +
      (proj.approve_rate != null
        ? '<span>Approve rate: <strong style="color:var(--success)">' + pct(proj.approve_rate) + '</strong></span>'
        : '') +
    '</div>' +
    '<div style="display:flex;gap:8px" class="card-actions"></div>';

  var actionsRow = card.querySelector('.card-actions');

  var syncBtn = document.createElement('button');
  syncBtn.className = 'btn';
  syncBtn.textContent = 'Sync';
  syncBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing\u2026';
    post('/instincts/sync').then(function() {
      renderList(listEl);
    }).catch(function(err) {
      alert('Sync failed: ' + err.message);
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync';
    });
  });

  var viewBtn = document.createElement('button');
  viewBtn.className = 'btn btn-primary';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    location.hash = '#learning/projects/' + encodeURIComponent(proj.id);
  });

  actionsRow.appendChild(syncBtn);
  actionsRow.appendChild(viewBtn);

  return card;
}

// ── Detail View ───────────────────────────────────────────────────────────────

export function renderDetail(el, projectId) {
  destroyCharts();
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  Promise.all([
    get('/projects/' + encodeURIComponent(projectId) + '/summary'),
    get('/instincts/projects'),
  ]).then(function(results) {
    var summary = results[0];
    var allProjects = results[1] || [];
    var projMeta = allProjects.find(function(p) { return p.id === projectId; }) || {};

    el.innerHTML = '';
    renderDetailContent(el, summary, projMeta, projectId);
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderDetailContent(el, summary, projMeta, projectId) {
  // ── Breadcrumb ────────────────────────────────────────────────────────────

  var breadcrumb = document.createElement('div');
  breadcrumb.className = 'learning-breadcrumb';
  breadcrumb.innerHTML =
    '<a href="#learning/projects">Projects</a> / ' +
    escHtml(summary.name || projectId);
  el.appendChild(breadcrumb);

  // ── Header card ───────────────────────────────────────────────────────────

  var running = projMeta.observer_running || false;
  var sc = summary.suggestion_counts || {};

  var headerCard = document.createElement('div');
  headerCard.className = 'card';
  headerCard.style.marginBottom = '1rem';
  headerCard.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
      '<span style="font-size:16px;font-weight:700">' + escHtml(summary.name || projectId) + '</span>' +
      (running
        ? '<span style="color:var(--success);font-size:13px">\u25cf running</span>'
        : '<span style="color:var(--text-muted);font-size:13px">\u25cb stopped</span>') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-muted);font-family:\'SF Mono\',monospace;margin-bottom:12px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(summary.directory || '\u2014') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:13px;margin-bottom:12px">' +
      statCell('Sessions', summary.session_count || 0) +
      statCell('Instincts', summary.instinct_count || 0) +
      statCell('Observations', summary.observation_count || 0) +
      statCell('First seen', fmtDate(summary.first_seen)) +
    '</div>' +
    '<div id="proj-header-actions" style="display:flex;gap:8px"></div>';

  var headerActions = headerCard.querySelector('#proj-header-actions');

  var viewLogBtn = document.createElement('button');
  viewLogBtn.className = 'btn';
  viewLogBtn.textContent = 'View log';
  viewLogBtn.addEventListener('click', function() {
    var logSection = document.getElementById('op-proj-observer-log');
    if (logSection) logSection.scrollIntoView({ behavior: 'smooth' });
  });
  headerActions.appendChild(viewLogBtn);

  var syncBtn = document.createElement('button');
  syncBtn.className = 'btn';
  syncBtn.textContent = 'Sync';
  syncBtn.addEventListener('click', function() {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing\u2026';
    post('/instincts/sync').then(function() {
      renderDetail(el, projectId);
    }).catch(function(err) {
      alert('Sync failed: ' + err.message);
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync';
    });
  });
  headerActions.appendChild(syncBtn);

  el.appendChild(headerCard);

  // ── Learning timeline chart ───────────────────────────────────────────────

  var timelineCard = document.createElement('div');
  timelineCard.className = 'card';
  timelineCard.style.marginBottom = '1rem';
  timelineCard.innerHTML =
    '<div class="card-title">Learning Timeline</div>' +
    '<div class="chart-wrap tall"><canvas id="op-proj-timeline-canvas"></canvas></div>';
  el.appendChild(timelineCard);

  get('/projects/' + encodeURIComponent(projectId) + '/timeline?weeks=8')
    .then(function(data) {
      var canvas = document.getElementById('op-proj-timeline-canvas');
      if (!canvas || !data || !data.length) {
        timelineCard.querySelector('.chart-wrap').innerHTML =
          '<div class="empty-state" style="padding:20px">No timeline data yet</div>';
        return;
      }
      var labels = data.map(function(d) { return d.week || fmtDateShort(d.week_start); });
      var instinctCounts = data.map(function(d) { return d.instinct_count || 0; });
      var avgConf = data.map(function(d) {
        return d.avg_confidence != null ? +(Number(d.avg_confidence).toFixed(2)) : null;
      });
      charts.push(new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Instincts',
              data: instinctCounts,
              borderColor: '#6c5ce7',
              backgroundColor: '#6c5ce720',
              tension: 0.3,
              fill: true,
              yAxisID: 'y',
            },
            {
              label: 'Avg Confidence',
              data: avgConf,
              borderColor: '#00b894',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              yAxisID: 'y1',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, labels: { color: '#8b8fa3', font: { size: 11 } } },
          },
          scales: {
            x: { grid: { color: '#2a2d3a' }, ticks: { font: { size: 11 } } },
            y: {
              grid: { color: '#2a2d3a' },
              beginAtZero: true,
              title: { display: true, text: 'Instincts', color: '#8b8fa3', font: { size: 11 } },
            },
            y1: {
              position: 'right',
              min: 0,
              max: 1,
              grid: { display: false },
              title: { display: true, text: 'Confidence', color: '#8b8fa3', font: { size: 11 } },
              ticks: {
                callback: function(v) { return (v * 100).toFixed(0) + '%'; },
              },
            },
          },
        },
      }));
    })
    .catch(function() {
      timelineCard.querySelector('.chart-wrap').innerHTML =
        '<div class="empty-state" style="padding:20px">Failed to load timeline</div>';
    });

  // ── Top 5 instincts ───────────────────────────────────────────────────────

  var instinctsCard = document.createElement('div');
  instinctsCard.className = 'card';
  instinctsCard.style.marginBottom = '1rem';
  instinctsCard.innerHTML =
    '<div style="display:flex;align-items:center;margin-bottom:12px">' +
      '<div class="card-title" style="margin:0;flex:1">Top Instincts</div>' +
      '<a href="#learning/instincts" style="font-size:12px;color:var(--accent);text-decoration:none">View all \u2192</a>' +
    '</div>' +
    '<div id="op-proj-instincts-body"><div class="empty-state"><span class="spinner"></span></div></div>';
  el.appendChild(instinctsCard);

  get('/instincts?project=' + encodeURIComponent(projectId) + '&per_page=5')
    .then(function(data) {
      var body = instinctsCard.querySelector('#op-proj-instincts-body');
      var items = data.items || [];
      if (items.length === 0) {
        body.innerHTML = '<div class="empty-state" style="padding:16px">No instincts yet</div>';
        return;
      }
      body.innerHTML = '';
      items.forEach(function(inst) {
        var conf = inst.confidence || 0;
        var color = conf < 0.3 ? '#e17055' : conf < 0.6 ? '#fdcb6e' : '#00b894';
        var row = document.createElement('div');
        row.style.cssText = 'border-bottom:1px solid var(--border);padding:8px 0;cursor:pointer;';
        row.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
              escHtml(inst.pattern || '') +
            '</span>' +
            '<span style="font-family:monospace;font-size:12px;color:' + color + '">' + conf.toFixed(2) + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' +
            escHtml(truncate(inst.instinct || '', 80)) +
          '</div>';
        row.addEventListener('click', function() {
          location.hash = '#learning/instincts/' + inst.id;
        });
        row.addEventListener('mouseenter', function() { row.style.borderColor = 'var(--accent)'; });
        row.addEventListener('mouseleave', function() { row.style.borderColor = ''; });
        body.appendChild(row);
      });
    })
    .catch(function() {
      instinctsCard.querySelector('#op-proj-instincts-body').innerHTML =
        '<p style="color:var(--danger);padding:16px">Failed to load instincts</p>';
    });

  // ── Recent 5 observations ─────────────────────────────────────────────────

  var obsCard = document.createElement('div');
  obsCard.className = 'card';
  obsCard.style.marginBottom = '1rem';
  obsCard.innerHTML =
    '<div style="display:flex;align-items:center;margin-bottom:12px">' +
      '<div class="card-title" style="margin:0;flex:1">Recent Observations</div>' +
      '<a href="#learning/observations" style="font-size:12px;color:var(--accent);text-decoration:none">View all \u2192</a>' +
    '</div>' +
    '<div id="op-proj-obs-body"><div class="empty-state"><span class="spinner"></span></div></div>';
  el.appendChild(obsCard);

  get('/observations?project=' + encodeURIComponent(projectId) + '&per_page=5')
    .then(function(data) {
      var body = obsCard.querySelector('#op-proj-obs-body');
      var items = data.items || [];
      if (items.length === 0) {
        body.innerHTML = '<div class="empty-state" style="padding:16px">No observations yet</div>';
        return;
      }
      body.innerHTML = '';
      items.forEach(function(obs) {
        var row = document.createElement('div');
        row.style.cssText = 'border-bottom:1px solid var(--border);padding:8px 0;cursor:pointer;';
        row.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">' +
            '<span style="font-size:11px;color:var(--text-muted);font-family:monospace">' +
              escHtml(fmtDate(obs.observed_at)) +
            '</span>' +
            (obs.category
              ? '<span class="badge">' + escHtml(obs.category) + '</span>'
              : '') +
          '</div>' +
          '<div style="font-size:13px;color:var(--text)">' +
            escHtml(truncate(obs.observation || '', 120)) +
          '</div>';
        row.addEventListener('click', function() {
          location.hash = '#learning/observations/' + obs.id;
        });
        row.addEventListener('mouseenter', function() { row.style.borderColor = 'var(--accent)'; });
        row.addEventListener('mouseleave', function() { row.style.borderColor = ''; });
        body.appendChild(row);
      });
    })
    .catch(function() {
      obsCard.querySelector('#op-proj-obs-body').innerHTML =
        '<p style="color:var(--danger);padding:16px">Failed to load observations</p>';
    });

  // ── Suggestions summary ───────────────────────────────────────────────────

  var sugCard = document.createElement('div');
  sugCard.className = 'card';
  sugCard.style.marginBottom = '1rem';
  sugCard.innerHTML =
    '<div class="card-title">Suggestions</div>' +
    '<div id="op-proj-sug-body"><div class="empty-state"><span class="spinner"></span></div></div>';
  el.appendChild(sugCard);

  get('/suggestions?project=' + encodeURIComponent(projectId))
    .then(function(suggestions) {
      var body = sugCard.querySelector('#op-proj-sug-body');
      var sugs = suggestions || [];

      var approved = sugs.filter(function(s) { return s.status === 'approved'; }).length;
      var dismissed = sugs.filter(function(s) { return s.status === 'dismissed'; }).length;
      var pending = sugs.filter(function(s) { return s.status === 'pending'; });

      var summaryHtml =
        '<div style="display:flex;gap:8px;margin-bottom:12px">' +
          '<span class="badge approved">' + approved + ' approved</span>' +
          '<span class="badge dismissed">' + dismissed + ' dismissed</span>' +
          '<span class="badge pending">' + pending.length + ' pending</span>' +
        '</div>';

      body.innerHTML = summaryHtml;

      if (pending.length === 0) {
        body.innerHTML += '<div style="font-size:13px;color:var(--text-muted)">No pending suggestions</div>';
        return;
      }

      var pendingList = document.createElement('div');
      pending.forEach(function(sug) {
        var item = document.createElement('div');
        item.style.cssText = 'border-bottom:1px solid var(--border);padding:8px 0;';
        var typeBadge = sug.type
          ? '<span class="badge" style="background:rgba(108,92,231,0.15);color:var(--accent);margin-right:6px">' +
              escHtml(sug.type) + '</span>'
          : '';
        var confStr = sug.confidence != null
          ? '<span style="font-size:11px;color:var(--text-muted);font-family:monospace;margin-left:auto">conf: ' +
              Number(sug.confidence).toFixed(2) + '</span>'
          : '';
        item.innerHTML =
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
            typeBadge + confStr +
          '</div>' +
          '<div style="font-size:13px;color:var(--text);line-height:1.5">' +
            escHtml(truncate(sug.description || '', 160)) +
          '</div>';
        pendingList.appendChild(item);
      });
      body.appendChild(pendingList);
    })
    .catch(function() {
      sugCard.querySelector('#op-proj-sug-body').innerHTML =
        '<p style="color:var(--danger)">Failed to load suggestions</p>';
    });

  // ── Observer log (collapsible, lazy-loaded) ───────────────────────────────

  var logCard = document.createElement('div');
  logCard.id = 'op-proj-observer-log';
  logCard.className = 'card';
  logCard.style.marginBottom = '1rem';

  var logToggle = document.createElement('div');
  logToggle.className = 'chart-toggle';
  logToggle.style.marginBottom = '0';
  logToggle.textContent = '\u25ba Observer log';

  var logBody = document.createElement('div');
  logBody.style.display = 'none';

  var logLoaded = false;

  logToggle.addEventListener('click', function() {
    var open = logBody.style.display === 'block';
    logBody.style.display = open ? 'none' : 'block';
    logToggle.textContent = open ? '\u25ba Observer log' : '\u25bc Observer log';

    if (!open && !logLoaded) {
      logLoaded = true;
      logBody.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
      get('/instincts/observer?project=' + encodeURIComponent(projectId) + '&lines=20')
        .then(function(data) {
          var lines = data.log || [];
          if (lines.length === 0) {
            logBody.innerHTML =
              '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No log entries found</div>';
            return;
          }
          var pre = document.createElement('pre');
          pre.style.cssText =
            'margin:12px 0 0;padding:0;white-space:pre-wrap;word-break:break-all;' +
            'font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-muted);' +
            'line-height:1.6;max-height:300px;overflow-y:auto;';
          pre.textContent = lines.join('\n');
          logBody.innerHTML = '';
          logBody.appendChild(pre);
        })
        .catch(function(err) {
          logBody.innerHTML =
            '<p style="color:var(--danger);font-size:12px">Failed to load log: ' + escHtml(err.message) + '</p>';
        });
    }
  });

  logCard.appendChild(logToggle);
  logCard.appendChild(logBody);
  el.appendChild(logCard);
}
