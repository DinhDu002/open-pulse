// Projects sub-module
import { get, del } from './api.js';
import { fmtDate, fmtDateShort, escHtml } from './utils.js';

// ── Chart management ──────────────────────────────────────────────────────────

let charts = [];

export function destroyCharts() {
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

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el) {
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

export function renderDetail(el, projectId) {
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
}
