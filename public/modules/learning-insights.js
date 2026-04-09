// Learning — Insights sub-module (unified: instincts + suggestions)
// NOTE: innerHTML usage below is safe — all dynamic values pass through escHtml()
// which escapes &, <, >, and " to prevent XSS. No raw user input is ever inserted.
import { get, put, del } from './api.js';
import { fmtDate, confColor, escHtml, confidenceBarHtml } from './utils.js';

// ── Badge helpers ─────────────────────────────────────────────────────────────

function sourceBadge(source) {
  var colors = { observer: '#3b82f6', daily_analysis: '#f59e0b', manual: '#6b7280' };
  var labels = { observer: 'Observer', daily_analysis: 'Analysis', manual: 'Manual' };
  return '<span class="badge" style="background:' + (colors[source] || '#6b7280') + '">' +
    escHtml(labels[source] || source || 'unknown') + '</span>';
}

function targetBadge(type) {
  if (!type) return '';
  var colors = { rule: '#ef4444', hook: '#8b5cf6', skill: '#22c55e', agent: '#3b82f6', knowledge: '#6b7280' };
  return '<span class="badge" style="background:' + (colors[type] || '#6b7280') + '">' + escHtml(type) + '</span>';
}

function statusBadge(status) {
  var colors = { active: '#22c55e', promoted: '#8b5cf6', executed: '#3b82f6', archived: '#6b7280', reverted: '#ef4444' };
  return '<span class="badge" style="background:' + (colors[status] || '#6b7280') + '">' + escHtml(status || '') + '</span>';
}

function categoryBadge(category) {
  if (!category) return '';
  return '<span class="badge" style="background:rgba(108,92,231,0.25);color:#a78bfa">' + escHtml(category) + '</span>';
}

// ── List View ─────────────────────────────────────────────────────────────────

export function renderList(el) {
  el.innerHTML = '';

  var state = { source: '', status: '', target_type: '', search: '', page: 1, per_page: 20 };
  var debounceTimer = null;

  // Filter row
  var filterRow = document.createElement('div');
  filterRow.className = 'filter-row';

  var sourceSelect = document.createElement('select');
  sourceSelect.innerHTML =
    '<option value="">All sources</option>' +
    '<option value="observer">Observer</option>' +
    '<option value="daily_analysis">Daily Analysis</option>' +
    '<option value="manual">Manual</option>';

  var statusSelect = document.createElement('select');
  statusSelect.innerHTML =
    '<option value="">All statuses</option>' +
    '<option value="active">Active</option>' +
    '<option value="promoted">Promoted</option>' +
    '<option value="executed">Executed</option>' +
    '<option value="archived">Archived</option>' +
    '<option value="reverted">Reverted</option>';

  var targetSelect = document.createElement('select');
  targetSelect.innerHTML =
    '<option value="">All types</option>' +
    '<option value="rule">Rule</option>' +
    '<option value="hook">Hook</option>' +
    '<option value="skill">Skill</option>' +
    '<option value="agent">Agent</option>' +
    '<option value="knowledge">Knowledge</option>';

  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search insights\u2026';
  searchInput.style.minWidth = '200px';

  filterRow.appendChild(sourceSelect);
  filterRow.appendChild(statusSelect);
  filterRow.appendChild(targetSelect);
  filterRow.appendChild(searchInput);
  el.appendChild(filterRow);

  // Stats row
  var statsRow = document.createElement('div');
  statsRow.style.cssText = 'display:flex;gap:16px;margin-bottom:14px;font-size:13px;color:var(--text-muted)';
  el.appendChild(statsRow);

  // List + pagination containers
  var listWrap = document.createElement('div');
  el.appendChild(listWrap);

  var paginationWrap = document.createElement('div');
  el.appendChild(paginationWrap);

  // Load stats
  get('/insights/stats').then(function(stats) {
    var byStatus = stats.byStatus || [];
    statsRow.innerHTML = '';
    if (byStatus.length === 0) {
      var noStats = document.createElement('span');
      noStats.textContent = 'No stats';
      statsRow.appendChild(noStats);
      return;
    }
    byStatus.forEach(function(s, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.textContent = ' \u00b7 ';
        statsRow.appendChild(sep);
      }
      var span = document.createElement('span');
      var strong = document.createElement('strong');
      strong.style.color = 'var(--text)';
      strong.textContent = s.status;
      span.appendChild(strong);
      span.appendChild(document.createTextNode(': ' + s.count));
      statsRow.appendChild(span);
    });
  }).catch(function() {
    statsRow.textContent = 'Stats unavailable';
  });

  function buildQs() {
    var qs = '?page=' + state.page + '&per_page=' + state.per_page;
    if (state.source) qs += '&source=' + encodeURIComponent(state.source);
    if (state.status) qs += '&status=' + encodeURIComponent(state.status);
    if (state.target_type) qs += '&target_type=' + encodeURIComponent(state.target_type);
    if (state.search) qs += '&search=' + encodeURIComponent(state.search);
    return qs;
  }

  function loadList() {
    listWrap.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

    get('/insights' + buildQs()).then(function(data) {
      var items = data.items || [];
      var total = data.total || 0;
      var totalPages = Math.max(1, Math.ceil(total / state.per_page));

      listWrap.innerHTML = '';

      if (items.length === 0) {
        listWrap.innerHTML = '<div class="empty-state">No insights found</div>';
        paginationWrap.innerHTML = '';
        return;
      }

      items.forEach(function(insight) {
        var card = renderInsightCard(insight);
        listWrap.appendChild(card);
      });

      renderPagination(paginationWrap, state.page, totalPages, total, function(newPage) {
        state.page = newPage;
        loadList();
      });
    }).catch(function(err) {
      listWrap.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
    });
  }

  function renderInsightCard(insight) {
    var card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'margin-bottom:10px;cursor:pointer;transition:border-color 0.15s;';

    var conf = insight.confidence || 0;
    var color = confColor(conf);

    var snippet = (insight.description || '').slice(0, 120);
    if ((insight.description || '').length > 120) snippet += '\u2026';

    // Header row: title + badges
    var headerDiv = document.createElement('div');
    headerDiv.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap';

    var titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    titleSpan.textContent = insight.title || insight.pattern || 'Insight #' + insight.id;
    headerDiv.appendChild(titleSpan);

    headerDiv.innerHTML += sourceBadge(insight.source) +
      ' ' + categoryBadge(insight.category) +
      (insight.target_type ? ' ' + targetBadge(insight.target_type) : '') +
      ' ' + statusBadge(insight.status);
    card.appendChild(headerDiv);

    // Confidence bar row
    var confDiv = document.createElement('div');
    confDiv.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    confDiv.innerHTML = confidenceBarHtml(conf) +
      '<span class="conf-value" style="font-size:12px;color:' + color + ';font-family:monospace">' + conf.toFixed(2) + '</span>';
    card.appendChild(confDiv);

    // Snippet
    if (snippet) {
      var snippetDiv = document.createElement('div');
      snippetDiv.style.cssText = 'font-size:12px;color:var(--text-muted);line-height:1.5';
      snippetDiv.textContent = snippet;
      card.appendChild(snippetDiv);
    }

    // Inline validate / reject buttons
    var actionsDiv = document.createElement('div');
    actionsDiv.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    actionsDiv.addEventListener('click', function(e) { e.stopPropagation(); });

    var vBtn = document.createElement('button');
    vBtn.className = 'btn btn-sm';
    vBtn.style.cssText = 'font-size:11px;padding:2px 10px;background:rgba(0,184,148,0.15);color:var(--success);border:1px solid var(--success);';
    vBtn.textContent = '\u2713 Validate';
    vBtn.addEventListener('click', function() {
      vBtn.disabled = true;
      vBtn.textContent = '\u2026';
      put('/insights/' + encodeURIComponent(insight.id) + '/validate')
        .then(function(res) {
          var cs = card.querySelector('.conf-value');
          if (cs && res.confidence != null) {
            cs.textContent = res.confidence.toFixed(2);
            cs.style.color = '#00b894';
            setTimeout(function() { cs.style.color = confColor(res.confidence); }, 1200);
          }
          vBtn.disabled = false;
          vBtn.textContent = '\u2713 Validate';
        })
        .catch(function() { vBtn.disabled = false; vBtn.textContent = '\u2713 Validate'; });
    });

    var rBtn = document.createElement('button');
    rBtn.className = 'btn btn-sm';
    rBtn.style.cssText = 'font-size:11px;padding:2px 10px;background:rgba(225,112,85,0.15);color:var(--danger);border:1px solid var(--danger);';
    rBtn.textContent = '\u2717 Reject';
    rBtn.addEventListener('click', function() {
      rBtn.disabled = true;
      rBtn.textContent = '\u2026';
      put('/insights/' + encodeURIComponent(insight.id) + '/reject')
        .then(function(res) {
          if (res.archived || res.status === 'archived') {
            card.style.opacity = '0';
            card.style.transition = 'opacity 0.3s';
            setTimeout(function() { card.remove(); }, 300);
          } else {
            var cs = card.querySelector('.conf-value');
            if (cs && res.confidence != null) {
              cs.textContent = res.confidence.toFixed(2);
              cs.style.color = '#e17055';
              setTimeout(function() { cs.style.color = confColor(res.confidence); }, 1200);
            }
            rBtn.disabled = false;
            rBtn.textContent = '\u2717 Reject';
          }
        })
        .catch(function() { rBtn.disabled = false; rBtn.textContent = '\u2717 Reject'; });
    });

    actionsDiv.appendChild(vBtn);
    actionsDiv.appendChild(rBtn);
    card.appendChild(actionsDiv);

    card.addEventListener('mouseenter', function() { card.style.borderColor = 'var(--accent)'; });
    card.addEventListener('mouseleave', function() { card.style.borderColor = ''; });
    card.addEventListener('click', function() {
      location.hash = '#learning/insights/' + insight.id;
    });

    return card;
  }

  // Event handlers
  sourceSelect.addEventListener('change', function() {
    state.source = sourceSelect.value;
    state.page = 1;
    loadList();
  });

  statusSelect.addEventListener('change', function() {
    state.status = statusSelect.value;
    state.page = 1;
    loadList();
  });

  targetSelect.addEventListener('change', function() {
    state.target_type = targetSelect.value;
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

  get('/insights/' + encodeURIComponent(id)).then(function(insight) {
    el.innerHTML = '';
    renderDetailContent(el, insight);
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger);padding:20px">Error: ' + escHtml(err.message) + '</p>';
  });
}

function renderDetailContent(el, insight) {
  var conf = insight.confidence || 0;
  var color = confColor(conf);

  // Back link
  var back = document.createElement('div');
  back.style.cssText = 'margin-bottom:16px;';
  var backLink = document.createElement('a');
  backLink.href = '#learning/insights';
  backLink.style.cssText = 'color:var(--accent);text-decoration:none;font-size:13px';
  backLink.textContent = '\u2190 Back to Insights';
  back.appendChild(backLink);
  el.appendChild(back);

  // Title + badges
  var titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;';

  var h2 = document.createElement('h2');
  h2.style.cssText = 'font-size:16px;font-weight:700;flex:1;min-width:0;color:var(--text)';
  h2.textContent = insight.title || insight.pattern || 'Insight #' + insight.id;
  titleRow.appendChild(h2);

  titleRow.innerHTML += sourceBadge(insight.source) +
    ' ' + categoryBadge(insight.category) +
    (insight.target_type ? ' ' + targetBadge(insight.target_type) : '') +
    ' ' + statusBadge(insight.status);
  el.appendChild(titleRow);

  // Metadata card
  var metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.style.marginBottom = '1rem';

  var metaTitle = document.createElement('div');
  metaTitle.className = 'card-title';
  metaTitle.textContent = 'Metadata';
  metaCard.appendChild(metaTitle);

  var metaGrid = document.createElement('div');
  metaGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px';

  function metaRow(label, content) {
    var div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;gap:6px';
    var labelSpan = document.createElement('span');
    labelSpan.style.color = 'var(--text-muted)';
    labelSpan.textContent = label + ': ';
    div.appendChild(labelSpan);
    if (typeof content === 'string') {
      var valueSpan = document.createElement('span');
      valueSpan.style.cssText = 'font-family:monospace;font-size:12px';
      valueSpan.textContent = content;
      div.appendChild(valueSpan);
    } else {
      div.appendChild(content);
    }
    return div;
  }

  var confWrap = document.createElement('span');
  confWrap.style.cssText = 'display:flex;align-items:center;gap:4px';
  confWrap.innerHTML = confidenceBarHtml(conf) +
    '<span style="color:' + color + ';font-family:monospace">' + conf.toFixed(2) + '</span>';

  metaGrid.appendChild(metaRow('Confidence', confWrap));
  metaGrid.appendChild(metaRow('Observations', String(insight.observation_count || 0)));
  metaGrid.appendChild(metaRow('Validations', String(insight.validation_count || 0)));
  metaGrid.appendChild(metaRow('Rejections', String(insight.rejection_count || 0)));
  metaGrid.appendChild(metaRow('Created', fmtDate(insight.created_at)));
  metaGrid.appendChild(metaRow('Updated', fmtDate(insight.updated_at)));
  metaCard.appendChild(metaGrid);
  el.appendChild(metaCard);

  // Validate / Reject / Delete buttons
  var actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;margin-bottom:1rem;flex-wrap:wrap;';

  var validateBtn = document.createElement('button');
  validateBtn.className = 'btn';
  validateBtn.style.cssText = 'background:rgba(0,184,148,0.15);color:var(--success);border:1px solid var(--success)';
  validateBtn.textContent = '\u2713 Validate (+0.15)';
  validateBtn.addEventListener('click', function() {
    validateBtn.disabled = true;
    validateBtn.textContent = '\u2026';
    put('/insights/' + encodeURIComponent(insight.id) + '/validate')
      .then(function() { renderDetail(el, insight.id); })
      .catch(function(err) {
        validateBtn.disabled = false;
        validateBtn.textContent = '\u2713 Validate (+0.15)';
        alert('Error: ' + err.message);
      });
  });

  var rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn';
  rejectBtn.style.cssText = 'background:rgba(225,112,85,0.15);color:var(--danger);border:1px solid var(--danger)';
  rejectBtn.textContent = '\u2717 Reject (-0.2)';
  rejectBtn.addEventListener('click', function() {
    if (!confirm('Reject this insight? Confidence -0.2. After 3 rejections it will be archived.')) return;
    rejectBtn.disabled = true;
    rejectBtn.textContent = '\u2026';
    put('/insights/' + encodeURIComponent(insight.id) + '/reject')
      .then(function(res) {
        if (res.archived || res.status === 'archived') {
          alert('Insight archived after 3 rejections.');
          location.hash = '#learning/insights';
        } else {
          renderDetail(el, insight.id);
        }
      })
      .catch(function(err) {
        rejectBtn.disabled = false;
        rejectBtn.textContent = '\u2717 Reject (-0.2)';
        alert('Error: ' + err.message);
      });
  });

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function() {
    if (!confirm('Permanently delete this insight? This cannot be undone.')) return;
    del('/insights/' + encodeURIComponent(insight.id))
      .then(function() { location.hash = '#learning/insights'; })
      .catch(function(err) { alert('Error: ' + err.message); });
  });

  actionsRow.appendChild(validateBtn);
  actionsRow.appendChild(rejectBtn);
  actionsRow.appendChild(deleteBtn);
  el.appendChild(actionsRow);

  // Description
  if (insight.description) {
    var descCard = document.createElement('div');
    descCard.className = 'card';
    descCard.style.marginBottom = '1rem';

    var descTitle = document.createElement('div');
    descTitle.className = 'card-title';
    descTitle.textContent = 'Description';
    descCard.appendChild(descTitle);

    var descPre = document.createElement('pre');
    descPre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:13px;color:var(--text);line-height:1.6;margin:0';
    descPre.textContent = insight.description;
    descCard.appendChild(descPre);

    el.appendChild(descCard);
  }

  // Action data (claude_prompt + implementation_steps)
  var actionData = insight.action_data;
  if (actionData) {
    if (typeof actionData === 'string') {
      try { actionData = JSON.parse(actionData); } catch(e) { actionData = null; }
    }
    if (actionData && (actionData.claude_prompt || (actionData.implementation_steps && actionData.implementation_steps.length))) {
      var actionCard = document.createElement('div');
      actionCard.className = 'card';
      actionCard.style.marginBottom = '1rem';

      var actionTitle = document.createElement('div');
      actionTitle.className = 'card-title';
      actionTitle.textContent = 'Action Data';
      actionCard.appendChild(actionTitle);

      if (actionData.claude_prompt) {
        var promptHeader = document.createElement('div');
        promptHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';

        var promptLabel = document.createElement('span');
        promptLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px';
        promptLabel.textContent = 'Claude Prompt';
        promptHeader.appendChild(promptLabel);

        var copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-sm';
        copyBtn.style.cssText = 'font-size:11px;padding:2px 10px;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(actionData.claude_prompt).then(function() {
            copyBtn.textContent = 'Copied!';
            setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(function() {});
        });
        promptHeader.appendChild(copyBtn);
        actionCard.appendChild(promptHeader);

        var promptPre = document.createElement('pre');
        promptPre.style.cssText =
          'white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:\'SF Mono\',monospace;' +
          'color:var(--text);line-height:1.5;margin:0 0 12px;background:var(--bg);border:1px solid var(--border);' +
          'border-radius:6px;padding:12px;';
        promptPre.textContent = actionData.claude_prompt;
        actionCard.appendChild(promptPre);
      }

      if (actionData.implementation_steps && actionData.implementation_steps.length) {
        var stepsLabel = document.createElement('div');
        stepsLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;';
        stepsLabel.textContent = 'Implementation Steps';
        actionCard.appendChild(stepsLabel);

        var stepsList = document.createElement('ol');
        stepsList.style.cssText = 'padding-left:20px;font-size:13px;color:var(--text);line-height:1.6;';
        actionData.implementation_steps.forEach(function(step) {
          var li = document.createElement('li');
          li.style.marginBottom = '4px';
          li.textContent = step;
          stepsList.appendChild(li);
        });
        actionCard.appendChild(stepsList);
      }

      el.appendChild(actionCard);
    }
  }
}

// ── Pagination helper ─────────────────────────────────────────────────────────

function renderPagination(wrap, page, totalPages, total, onPage) {
  wrap.innerHTML = '';
  if (totalPages <= 1) return;

  var pg = document.createElement('div');
  pg.className = 'pagination';

  var prevBtn = document.createElement('button');
  prevBtn.textContent = '\u2190 Prev';
  prevBtn.disabled = page <= 1;
  prevBtn.addEventListener('click', function() {
    if (page > 1) onPage(page - 1);
  });

  var pageInfo = document.createElement('span');
  pageInfo.className = 'page-info';
  pageInfo.textContent = 'Page ' + page + ' / ' + totalPages + ' (' + total + ' total)';

  var nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next \u2192';
  nextBtn.disabled = page >= totalPages;
  nextBtn.addEventListener('click', function() {
    if (page < totalPages) onPage(page + 1);
  });

  pg.appendChild(prevBtn);
  pg.appendChild(pageInfo);
  pg.appendChild(nextBtn);
  wrap.appendChild(pg);
}
