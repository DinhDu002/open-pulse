// Projects sub-module
import { get, del } from './api.js';
import { fmtDate, escHtml } from './utils.js';

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

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mount(el, { params } = {}) {
  if (params) {
    renderDetail(el, decodeURIComponent(params));
  } else {
    renderList(el);
  }
}

// ── List View ─────────────────────────────────────────────────────────────────

function renderList(el) {
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

  // ── Project-scoped cards: Auto-evolves ─────────────────────────────────────

  buildAutoEvolvesCard(el, projectId);
}

// ── Reusable card builders ──────────────────────────────────────────────────

function statCellNode(label, value) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'text-align:center;padding:12px 8px;background:var(--bg);border-radius:8px';
  var lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px';
  lbl.textContent = String(label);
  var val = document.createElement('div');
  val.style.cssText = "font-size:16px;font-weight:700;font-family:'SF Mono',monospace";
  val.textContent = String(value);
  wrap.appendChild(lbl);
  wrap.appendChild(val);
  return wrap;
}

function replaceStats(statsRow, entries) {
  statsRow.textContent = '';
  entries.forEach(function(e) { statsRow.appendChild(statCellNode(e[0], e[1])); });
}

function makeBadge(text, color) {
  var span = document.createElement('span');
  span.style.cssText = 'padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:' + color + '26;color:' + color;
  span.textContent = text;
  return span;
}

function makePanelContents(statLabels) {
  var statsRow = document.createElement('div');
  statsRow.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:13px;margin-bottom:16px';
  statLabels.forEach(function(l) { statsRow.appendChild(statCellNode(l, '\u2014')); });

  var tableWrap = document.createElement('div');
  tableWrap.style.cssText = 'overflow-x:auto';
  var spinnerWrap = document.createElement('div');
  spinnerWrap.className = 'empty-state';
  var spinEl = document.createElement('span');
  spinEl.className = 'spinner';
  spinnerWrap.appendChild(spinEl);
  tableWrap.appendChild(spinnerWrap);

  return { statsRow: statsRow, tableWrap: tableWrap };
}

function makeListCard(title, statLabels) {
  var card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '1rem';

  var titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;
  card.appendChild(titleEl);

  var panel = makePanelContents(statLabels);
  card.appendChild(panel.statsRow);
  card.appendChild(panel.tableWrap);

  return { card: card, statsRow: panel.statsRow, tableWrap: panel.tableWrap };
}

function makeTabbedCard(title, tabs) {
  var card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '1rem';

  var titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;
  card.appendChild(titleEl);

  var tabsRow = document.createElement('div');
  tabsRow.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px';

  var panels = {};
  var buttons = {};

  function activate(key) {
    Object.keys(panels).forEach(function(k) {
      var isActive = k === key;
      panels[k].style.display = isActive ? 'block' : 'none';
      buttons[k].style.color = isActive ? 'var(--text)' : 'var(--text-muted)';
      buttons[k].style.borderBottomColor = isActive ? '#6c5ce7' : 'transparent';
    });
  }

  tabs.forEach(function(t, idx) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t.label;
    btn.style.cssText = 'background:none;border:none;padding:10px 16px;cursor:pointer;font-size:13px;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px;color:var(--text-muted)';
    btn.addEventListener('click', function() { activate(t.key); });

    var panel = document.createElement('div');
    panel.style.display = idx === 0 ? 'block' : 'none';

    tabsRow.appendChild(btn);
    buttons[t.key] = btn;
    panels[t.key] = panel;
  });

  card.appendChild(tabsRow);
  tabs.forEach(function(t) { card.appendChild(panels[t.key]); });

  // Activate first tab styling
  if (tabs.length > 0) activate(tabs[0].key);

  return { card: card, panels: panels };
}

function showEmpty(tableWrap, text) {
  tableWrap.textContent = '';
  var empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.style.padding = '20px';
  empty.textContent = text;
  tableWrap.appendChild(empty);
}

function showError(tableWrap, text) {
  tableWrap.textContent = '';
  var err = document.createElement('div');
  err.className = 'empty-state';
  err.style.padding = '20px';
  err.textContent = text;
  tableWrap.appendChild(err);
}

function buildTable(columns) {
  var table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  headerRow.style.borderBottom = '1px solid var(--border)';
  columns.forEach(function(text) {
    var th = document.createElement('th');
    th.style.cssText = 'padding:8px;text-align:left;color:var(--text-muted);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.5px';
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  var tbody = document.createElement('tbody');
  table.appendChild(tbody);
  return { table: table, tbody: tbody };
}

function td(text, style) {
  var cell = document.createElement('td');
  cell.style.cssText = 'padding:8px;' + (style || '');
  if (text !== undefined && text !== null) cell.textContent = String(text);
  return cell;
}

function tdNode(node, style) {
  var cell = document.createElement('td');
  cell.style.cssText = 'padding:8px;' + (style || '');
  cell.appendChild(node);
  return cell;
}

// ── Card 1: Auto-evolves ────────────────────────────────────────────────────

var AE_STATUS_COLORS = { active: '#6c5ce7', promoted: '#00b894', reverted: '#e17055' };

function buildAutoEvolvesCard(el, projectId) {
  var built = makeListCard('Auto-evolves', ['Total', 'Active', 'Promoted', 'Avg Confidence']);
  el.appendChild(built.card);

  get('/projects/' + encodeURIComponent(projectId) + '/auto-evolves?per_page=100')
    .then(function(data) {
      var rows = data.rows || [];
      var total = data.total || 0;
      var active = rows.filter(function(r) { return r.status === 'active'; }).length;
      var promoted = rows.filter(function(r) { return r.status === 'promoted'; }).length;
      var confSum = rows.reduce(function(s, r) { return s + (r.confidence || 0); }, 0);
      var avgConf = rows.length > 0 ? (confSum / rows.length * 100).toFixed(0) + '%' : '\u2014';
      replaceStats(built.statsRow, [
        ['Total', total],
        ['Active', active],
        ['Promoted', promoted],
        ['Avg Confidence', avgConf],
      ]);

      if (rows.length === 0) {
        showEmpty(built.tableWrap, 'No project-tagged auto-evolves yet');
        return;
      }

      var t = buildTable(['Title', 'Type', 'Confidence', 'Obs.', 'Status', 'Updated']);
      rows.slice(0, 10).forEach(function(r) {
        var tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        tr.appendChild(td(r.title, 'font-weight:600'));
        tr.appendChild(td(r.target_type || '\u2014'));
        tr.appendChild(td(Math.round((r.confidence || 0) * 100) + '%', "font-family:'SF Mono',monospace"));
        tr.appendChild(td(r.observation_count || 0, "font-family:'SF Mono',monospace"));
        tr.appendChild(tdNode(makeBadge(r.status, AE_STATUS_COLORS[r.status] || '#8b8fa3')));
        tr.appendChild(td(timeAgo(r.updated_at || r.created_at), 'color:var(--text-muted)'));
        t.tbody.appendChild(tr);
      });
      built.tableWrap.textContent = '';
      built.tableWrap.appendChild(t.table);
    })
    .catch(function() {
      showError(built.tableWrap, 'Failed to load auto-evolves');
    });
}

