// Projects sub-module
import { get, del } from './api.js';
import { fmtDate, fmtDateShort, escHtml } from './utils.js';

// ── Chart management ──────────────────────────────────────────────────────────

let charts = [];

function destroyCharts() {
  charts.forEach(function(c) { c.destroy(); });
  charts = [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function timeAgo(isoString) {
  if (!isoString) return '\u2014';
  var diff = Date.now() - new Date(isoString).getTime();
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// ── Mount / Unmount ──────────────────────────────────────────────────────────

export function mount(el, { params } = {}) {
  if (params) {
    renderDetail(el, decodeURIComponent(params));
  } else {
    renderList(el);
  }
}

export function unmount() {
  destroyCharts();
}

// ── List View ─────────────────────────────────────────────────────────────────

function renderList(el) {
  destroyCharts();
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  get('/projects').then(function(projects) {
    el.innerHTML = '';

    if (!projects || projects.length === 0) {
      el.innerHTML = '<div class="empty-state">No projects found. Start using Claude Code to collect data.</div>';
      return;
    }

    projects.forEach(function(proj) {
      el.appendChild(buildProjectCard(proj, el));
    });
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
  });
}

function buildProjectCard(proj, listEl) {
  var card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:12px;cursor:pointer;';
  card.addEventListener('click', function() {
    location.hash = '#projects/' + encodeURIComponent(id);
  });

  var id = proj.project_id || proj.id;

  // Build card content using escaped values only
  var nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px';
  var nameSpan = document.createElement('span');
  nameSpan.style.cssText = 'font-weight:600;font-size:14px;flex:1';
  nameSpan.textContent = proj.name || id;
  nameRow.appendChild(nameSpan);
  card.appendChild(nameRow);

  var dirDiv = document.createElement('div');
  dirDiv.style.cssText = 'font-size:12px;color:var(--text-muted);font-family:"SF Mono",monospace;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  dirDiv.title = proj.directory || '';
  dirDiv.textContent = proj.directory || '\u2014';
  card.appendChild(dirDiv);

  var statsDiv = document.createElement('div');
  statsDiv.style.cssText = 'display:flex;gap:16px;font-size:13px;color:var(--text-muted);margin-bottom:12px';

  var sessSpan = document.createElement('span');
  sessSpan.textContent = 'Sessions: ';
  var sessVal = document.createElement('strong');
  sessVal.style.color = 'var(--text)';
  sessVal.textContent = proj.session_count || 0;
  sessSpan.appendChild(sessVal);
  statsDiv.appendChild(sessSpan);

  var seenSpan = document.createElement('span');
  seenSpan.textContent = 'Last seen: ';
  var seenVal = document.createElement('strong');
  seenVal.style.color = 'var(--text)';
  seenVal.textContent = fmtDate(proj.last_seen_at);
  seenSpan.appendChild(seenVal);
  statsDiv.appendChild(seenSpan);

  card.appendChild(statsDiv);

  var actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px';

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (!confirm('Delete project "' + (proj.name || id) + '"? This cannot be undone.')) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting\u2026';
    del('/projects/' + encodeURIComponent(id))
      .then(function() { renderList(listEl); })
      .catch(function(err) {
        alert('Delete failed: ' + err.message);
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      });
  });

  actionsRow.appendChild(deleteBtn);
  card.appendChild(actionsRow);

  return card;
}

// ── Detail View ───────────────────────────────────────────────────────────────

function renderDetail(el, projectId) {
  destroyCharts();
  el.textContent = '';
  var spinner = document.createElement('div');
  spinner.className = 'empty-state';
  var spinEl = document.createElement('span');
  spinEl.className = 'spinner';
  spinner.appendChild(spinEl);
  el.appendChild(spinner);

  get('/projects/' + encodeURIComponent(projectId) + '/summary')
    .then(function(summary) {
      el.textContent = '';
      renderDetailContent(el, summary, projectId);
    })
    .catch(function(err) {
      el.textContent = '';
      var errP = document.createElement('p');
      errP.style.cssText = 'color:var(--danger);padding:20px';
      errP.textContent = 'Error: ' + err.message;
      el.appendChild(errP);
    });
}

function renderDetailContent(el, summary, projectId) {
  // ── Breadcrumb ────────────────────────────────────────────────────────────

  var breadcrumb = document.createElement('div');
  breadcrumb.className = 'learning-breadcrumb';
  var bcLink = document.createElement('a');
  bcLink.href = '#projects';
  bcLink.textContent = 'Projects';
  breadcrumb.appendChild(bcLink);
  breadcrumb.appendChild(document.createTextNode(' / ' + (summary.name || projectId)));
  el.appendChild(breadcrumb);

  // ── Header card ───────────────────────────────────────────────────────────

  var headerCard = document.createElement('div');
  headerCard.className = 'card';
  headerCard.style.marginBottom = '1rem';

  var titleDiv = document.createElement('div');
  titleDiv.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
  var titleSpan = document.createElement('span');
  titleSpan.style.cssText = 'font-size:16px;font-weight:700';
  titleSpan.textContent = summary.name || projectId;
  titleDiv.appendChild(titleSpan);
  headerCard.appendChild(titleDiv);

  var dirLine = document.createElement('div');
  dirLine.style.cssText = 'font-size:12px;color:var(--text-muted);font-family:"SF Mono",monospace;margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  dirLine.textContent = summary.directory || '\u2014';
  headerCard.appendChild(dirLine);

  var statsRow = document.createElement('div');
  statsRow.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:13px;margin-bottom:12px';
  statsRow.innerHTML =
    statCell('Sessions', summary.session_count || 0) +
    statCell('First seen', fmtDate(summary.first_seen)) +
    statCell('Last seen', fmtDate(summary.last_seen));
  headerCard.appendChild(statsRow);

  var actionsDiv = document.createElement('div');
  actionsDiv.style.cssText = 'display:flex;gap:8px';

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete Project';
  deleteBtn.addEventListener('click', function() {
    if (!confirm('Delete project "' + (summary.name || projectId) + '"? This cannot be undone.')) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting\u2026';
    del('/projects/' + encodeURIComponent(projectId))
      .then(function() { location.hash = '#projects'; })
      .catch(function(err) {
        alert('Delete failed: ' + err.message);
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete Project';
      });
  });
  actionsDiv.appendChild(deleteBtn);
  headerCard.appendChild(actionsDiv);

  el.appendChild(headerCard);

  // ── Timeline chart ────────────────────────────────────────────────────────

  var timelineCard = document.createElement('div');
  timelineCard.className = 'card';
  timelineCard.style.marginBottom = '1rem';

  var tlTitle = document.createElement('div');
  tlTitle.className = 'card-title';
  tlTitle.textContent = 'Timeline';
  timelineCard.appendChild(tlTitle);

  var chartWrap = document.createElement('div');
  chartWrap.className = 'chart-wrap tall';
  var canvas = document.createElement('canvas');
  canvas.id = 'op-proj-timeline-canvas';
  chartWrap.appendChild(canvas);
  timelineCard.appendChild(chartWrap);

  el.appendChild(timelineCard);

  get('/projects/' + encodeURIComponent(projectId) + '/timeline?weeks=8')
    .then(function(data) {
      var cvs = document.getElementById('op-proj-timeline-canvas');
      if (!cvs || !data || !data.length) {
        chartWrap.textContent = '';
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '20px';
        empty.textContent = 'No timeline data yet';
        chartWrap.appendChild(empty);
        return;
      }
      var labels = data.map(function(d) { return d.week || fmtDateShort(d.week_start); });
      var sessionCounts = data.map(function(d) { return d.session_count || 0; });
      charts.push(new Chart(cvs.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Sessions',
              data: sessionCounts,
              borderColor: '#6c5ce7',
              backgroundColor: '#6c5ce720',
              tension: 0.3,
              fill: true,
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
              title: { display: true, text: 'Sessions', color: '#8b8fa3', font: { size: 11 } },
            },
          },
        },
      }));
    })
    .catch(function() {
      chartWrap.textContent = '';
      var errEl = document.createElement('div');
      errEl.className = 'empty-state';
      errEl.style.padding = '20px';
      errEl.textContent = 'Failed to load timeline';
      chartWrap.appendChild(errEl);
    });

  // ── Pipeline Runs ─────────────────────────────────────────────────────────

  var runsCard = document.createElement('div');
  runsCard.className = 'card';
  runsCard.style.marginBottom = '1rem';

  var runsTitle = document.createElement('div');
  runsTitle.className = 'card-title';
  runsTitle.textContent = 'Pipeline Runs';
  runsCard.appendChild(runsTitle);

  // Stats row (same pattern as header stats)
  var runsStatsRow = document.createElement('div');
  runsStatsRow.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:13px;margin-bottom:16px';
  runsStatsRow.innerHTML =
    statCell('Total Runs', '\u2014') +
    statCell('Total Tokens', '\u2014') +
    statCell('Success Rate', '\u2014') +
    statCell('Avg Duration', '\u2014');
  runsCard.appendChild(runsStatsRow);

  // Table container
  var runsTableWrap = document.createElement('div');
  runsTableWrap.style.cssText = 'overflow-x:auto';
  var runsSpinner = document.createElement('div');
  runsSpinner.className = 'empty-state';
  var runsSpinEl = document.createElement('span');
  runsSpinEl.className = 'spinner';
  runsSpinner.appendChild(runsSpinEl);
  runsTableWrap.appendChild(runsSpinner);
  runsCard.appendChild(runsTableWrap);

  el.appendChild(runsCard);

  get('/pipeline-runs/stats?project_id=' + encodeURIComponent(projectId))
    .then(function(stats) {
      var totalTokens = (stats.total_input_tokens || 0) + (stats.total_output_tokens || 0);
      var rate = stats.total_runs > 0
        ? ((stats.success_count / stats.total_runs) * 100).toFixed(1) + '%'
        : '\u2014';
      var avgDur = stats.avg_duration_ms > 0
        ? (stats.avg_duration_ms / 1000).toFixed(1) + 's'
        : '\u2014';
      runsStatsRow.innerHTML =
        statCell('Total Runs', stats.total_runs) +
        statCell('Total Tokens', fmtTokens(totalTokens)) +
        statCell('Success Rate', rate) +
        statCell('Avg Duration', avgDur);
    })
    .catch(function() {});

  var PIPELINE_COLORS = {
    knowledge_extract: '#74b9ff',
    knowledge_scan: '#a29bfe',
    daily_review: '#fdcb6e',
    auto_evolve: '#00b894',
  };

  get('/projects/' + encodeURIComponent(projectId) + '/pipeline-runs?limit=20')
    .then(function(data) {
      runsTableWrap.textContent = '';
      if (!data.items || data.items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '20px';
        empty.textContent = 'No pipeline runs yet';
        runsTableWrap.appendChild(empty);
        return;
      }

      var table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px';

      // Header
      var thead = document.createElement('thead');
      var headerRow = document.createElement('tr');
      headerRow.style.borderBottom = '1px solid var(--border)';
      ['Time', 'Pipeline', 'Model', 'Tokens (in/out)', 'Duration', 'Status'].forEach(function(text) {
        var th = document.createElement('th');
        th.style.cssText = 'padding:8px;text-align:left';
        th.textContent = text;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      // Body
      var tbody = document.createElement('tbody');
      data.items.forEach(function(run) {
        var tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';

        // Time
        var tdTime = document.createElement('td');
        tdTime.style.cssText = 'padding:8px;color:var(--text-muted)';
        tdTime.textContent = timeAgo(run.created_at);
        tr.appendChild(tdTime);

        // Pipeline badge
        var tdPipeline = document.createElement('td');
        tdPipeline.style.padding = '8px';
        var badge = document.createElement('span');
        var color = PIPELINE_COLORS[run.pipeline] || '#636e72';
        badge.style.cssText = 'padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:' + color + '20;color:' + color;
        badge.textContent = run.pipeline.replace(/_/g, ' ');
        tdPipeline.appendChild(badge);
        tr.appendChild(tdPipeline);

        // Model
        var tdModel = document.createElement('td');
        tdModel.style.padding = '8px';
        tdModel.textContent = run.model || '\u2014';
        tr.appendChild(tdModel);

        // Tokens
        var tdTokens = document.createElement('td');
        tdTokens.style.cssText = "padding:8px;font-family:'SF Mono',monospace";
        tdTokens.textContent = fmtTokens(run.input_tokens) + ' / ' + fmtTokens(run.output_tokens);
        tr.appendChild(tdTokens);

        // Duration
        var tdDur = document.createElement('td');
        tdDur.style.cssText = "padding:8px;font-family:'SF Mono',monospace";
        tdDur.textContent = run.duration_ms > 0 ? (run.duration_ms / 1000).toFixed(1) + 's' : '\u2014';
        tr.appendChild(tdDur);

        // Status
        var tdStatus = document.createElement('td');
        tdStatus.style.padding = '8px';
        var statusSpan = document.createElement('span');
        if (run.status === 'success') {
          statusSpan.style.color = '#00b894';
          statusSpan.textContent = '\u2713';
        } else {
          statusSpan.style.color = '#d63031';
          statusSpan.textContent = '\u2717';
          statusSpan.title = run.error || '';
        }
        tdStatus.appendChild(statusSpan);
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      runsTableWrap.appendChild(table);
    })
    .catch(function() {
      runsTableWrap.textContent = '';
      var errEl = document.createElement('div');
      errEl.className = 'empty-state';
      errEl.style.padding = '20px';
      errEl.textContent = 'Failed to load pipeline runs';
      runsTableWrap.appendChild(errEl);
    });
}
