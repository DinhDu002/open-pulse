import { get } from './api.js';
import { truncate } from './utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = s / 60;
  return m.toFixed(1) + 'm';
}

function formatCost(usd) {
  return '$' + (usd || 0).toFixed(4);
}

function formatTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('HH:mm');
}

function formatJson(str) {
  if (!str) return '';
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return str;
  }
}

// ── Color maps ────────────────────────────────────────────────────────────────

const EVENT_COLORS = {
  tool_call:    { bg: '#1a3a1a', color: '#56d364', icon: '🔧' },
  skill_invoke: { bg: '#3a1a2a', color: '#f778ba', icon: '⭐' },
  agent_spawn:  { bg: '#3a1a3a', color: '#d2a8ff', icon: '🤖' },
};

const TOOL_COLORS = {
  Read:   '#56d364',
  Glob:   '#56d364',
  Grep:   '#58a6ff',
  Edit:   '#6e9eff',
  Write:  '#6e9eff',
  Bash:   '#d29922',
  Agent:  '#d2a8ff',
  Skill:  '#f778ba',
};

function dotColor(eventType, toolName) {
  if (TOOL_COLORS[toolName]) return TOOL_COLORS[toolName];
  const ec = EVENT_COLORS[eventType];
  return ec ? ec.color : '#8b949e';
}

function eventTypeLabel(type) {
  if (type === 'tool_call') return 'tool';
  if (type === 'skill_invoke') return 'skill';
  if (type === 'agent_spawn') return 'agent';
  return type || 'event';
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function renderSummaryCards(el, { total, totalEvents, totalCost }) {
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.style.marginBottom = '20px';

  const cards = [
    { label: 'Prompts', value: String(total || 0), extra: '' },
    { label: 'Events', value: String(totalEvents || 0), extra: '' },
    { label: 'Total Cost', value: formatCost(totalCost), extra: ' cost' },
  ];

  cards.forEach(c => {
    const card = document.createElement('div');
    card.className = 'stat-card';

    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = c.label;

    const value = document.createElement('div');
    value.className = 'stat-value' + c.extra;
    value.textContent = c.value;

    card.appendChild(label);
    card.appendChild(value);
    grid.appendChild(card);
  });

  el.appendChild(grid);
}

// ── Prompt card (list item) ───────────────────────────────────────────────────

function renderPromptCard(prompt) {
  const card = document.createElement('div');
  card.className = 'card clickable';
  card.addEventListener('click', () => {
    location.hash = '#prompts/' + prompt.id;
  });

  // Title
  const title = document.createElement('div');
  title.className = 'prompt-card-title';
  title.textContent = truncate(prompt.prompt_text || '(no text)', 180);
  card.appendChild(title);

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'prompt-card-meta';

  const metaItems = [];
  if (prompt.project) metaItems.push('📁 ' + prompt.project);
  metaItems.push('🕐 ' + formatTime(prompt.started_at));
  if (prompt.duration_ms) metaItems.push('⏱ ' + formatDuration(prompt.duration_ms));
  if (prompt.cost) metaItems.push('💰 ' + formatCost(prompt.cost));
  if (prompt.event_count) metaItems.push('📊 ' + prompt.event_count + ' events');

  metaItems.forEach(text => {
    const span = document.createElement('span');
    span.textContent = text;
    meta.appendChild(span);
  });

  card.appendChild(meta);

  // Event type badges
  if (prompt.event_types && prompt.event_types.length > 0) {
    const badgeRow = document.createElement('div');
    badgeRow.className = 'badge-row';

    const types = Array.isArray(prompt.event_types)
      ? prompt.event_types
      : String(prompt.event_types).split(',');

    const counts = {};
    types.forEach(t => { const k = t.trim(); counts[k] = (counts[k] || 0) + 1; });

    Object.entries(counts).forEach(([type, count]) => {
      const ec = EVENT_COLORS[type];
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.background = ec ? ec.bg : 'var(--border)';
      badge.style.color = ec ? ec.color : 'var(--text-muted)';
      const icon = ec ? ec.icon + ' ' : '';
      badge.textContent = icon + eventTypeLabel(type) + (count > 1 ? ' ×' + count : '');
      badgeRow.appendChild(badge);
    });

    card.appendChild(badgeRow);
  }

  return card;
}

// ── Pagination ────────────────────────────────────────────────────────────────

function renderPagination(el, { page, perPage, total, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return;

  const wrap = document.createElement('div');
  wrap.className = 'pagination';
  wrap.style.display = 'flex';
  wrap.style.gap = '6px';
  wrap.style.marginTop = '20px';
  wrap.style.justifyContent = 'center';
  wrap.style.flexWrap = 'wrap';

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = '← Prev';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => onPage(page - 1));
  wrap.appendChild(prev);

  // Page number buttons (show up to 7, centered around current)
  const start = Math.max(1, page - 3);
  const end = Math.min(totalPages, start + 6);
  for (let i = start; i <= end; i++) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (i === page ? ' active' : '');
    btn.textContent = String(i);
    const pageNum = i;
    btn.addEventListener('click', () => onPage(pageNum));
    wrap.appendChild(btn);
  }

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = 'Next →';
  next.disabled = page >= totalPages;
  next.addEventListener('click', () => onPage(page + 1));
  wrap.appendChild(next);

  el.appendChild(wrap);
}

// ── List view ─────────────────────────────────────────────────────────────────

async function renderList(el, period) {
  const p = period || '30d';

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';

  const searchInput = document.createElement('input');
  searchInput.className = 'filter-input';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search prompts…';
  searchInput.style.cssText = 'padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:inherit;';
  filterBar.appendChild(searchInput);

  const projectSelect = document.createElement('select');
  projectSelect.className = 'filter-select';
  projectSelect.style.cssText = 'padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:inherit;cursor:pointer;';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'All projects';
  projectSelect.appendChild(defaultOpt);
  filterBar.appendChild(projectSelect);

  el.appendChild(filterBar);

  // Summary placeholder
  const summaryEl = document.createElement('div');
  el.appendChild(summaryEl);

  // Card list container
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  el.appendChild(listEl);

  // Pagination container
  const paginationEl = document.createElement('div');
  el.appendChild(paginationEl);

  // State
  let currentPage = 1;
  let currentQ = '';
  let currentProject = '';
  const perPage = 20;

  // Populate project dropdown from sessions
  get('/sessions?period=' + p).then(data => {
    const sessions = Array.isArray(data) ? data : (data.sessions || []);
    const projects = new Set();
    sessions.forEach(s => { if (s.directory) projects.add(s.directory); });
    projects.forEach(dir => {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = dir.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
      projectSelect.appendChild(opt);
    });
  }).catch(() => {});

  async function load() {
    listEl.textContent = '';
    paginationEl.textContent = '';
    summaryEl.textContent = '';

    const spinner = document.createElement('div');
    spinner.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    spinner.appendChild(sp);
    listEl.appendChild(spinner);

    try {
      const qs = new URLSearchParams({
        period: p,
        page: String(currentPage),
        per_page: String(perPage),
      });
      if (currentQ) qs.set('q', currentQ);
      if (currentProject) qs.set('project', currentProject);

      const data = await get('/prompts?' + qs.toString());
      const prompts = data.prompts || [];
      const total = data.total || 0;

      listEl.textContent = '';

      // Summary cards
      renderSummaryCards(summaryEl, {
        total,
        totalEvents: data.total_events,
        totalCost: data.total_cost,
      });

      if (prompts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No prompts found';
        listEl.appendChild(empty);
        return;
      }

      prompts.forEach(prompt => {
        listEl.appendChild(renderPromptCard(prompt));
      });

      renderPagination(paginationEl, {
        page: currentPage,
        perPage,
        total,
        onPage: (pg) => {
          currentPage = pg;
          load();
        },
      });
    } catch (err) {
      listEl.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'empty-state';
      errDiv.style.color = 'var(--danger)';
      errDiv.textContent = 'Failed to load prompts: ' + err.message;
      listEl.appendChild(errDiv);
    }
  }

  // Debounced search
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentQ = searchInput.value.trim();
      currentPage = 1;
      load();
    }, 300);
  });

  projectSelect.addEventListener('change', () => {
    currentProject = projectSelect.value;
    currentPage = 1;
    load();
  });

  load();
}

// ── Flow timeline (detail) ────────────────────────────────────────────────────

function renderFlowTimeline(el, events) {
  const timeline = document.createElement('div');
  timeline.className = 'flow-timeline';

  if (!events || events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No events recorded';
    timeline.appendChild(empty);
    el.appendChild(timeline);
    return;
  }

  events.forEach((ev, idx) => {
    const row = document.createElement('div');
    row.className = 'flow-event';

    // Seq number
    const seq = document.createElement('div');
    seq.className = 'flow-seq';
    seq.textContent = String(ev.seq_num != null ? ev.seq_num : idx + 1);
    row.appendChild(seq);

    // Colored dot
    const dot = document.createElement('div');
    dot.className = 'flow-dot';
    dot.style.background = dotColor(ev.type, ev.name);
    row.appendChild(dot);

    // Main area: name + detail
    const main = document.createElement('div');
    main.className = 'flow-main';

    const nameEl = document.createElement('span');
    nameEl.className = 'flow-name';
    nameEl.textContent = ev.name || ev.type || 'event';
    main.appendChild(nameEl);

    if (ev.detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'flow-detail';
      detailEl.textContent = truncate(ev.detail, 80);
      main.appendChild(detailEl);
    }

    row.appendChild(main);

    // Duration
    const dur = document.createElement('div');
    dur.className = 'flow-duration';
    dur.textContent = ev.duration_ms != null ? formatDuration(ev.duration_ms) : '';
    row.appendChild(dur);

    // Success indicator
    const status = document.createElement('div');
    status.className = 'flow-status';
    if (ev.success === true || ev.success === 1) {
      status.textContent = '✓';
      status.style.color = 'var(--success)';
    } else if (ev.success === false || ev.success === 0) {
      status.textContent = '✗';
      status.style.color = 'var(--danger)';
    }
    row.appendChild(status);

    // Expand on click — only if there is input or response to show
    const hasInput = ev.tool_input && ev.tool_input.trim();
    const hasResponse = ev.tool_response && ev.tool_response.trim();

    if (hasInput || hasResponse) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const isExpanded = row.classList.toggle('expanded');

        // Remove existing panel if any
        const existing = row.nextSibling;
        if (existing && existing.classList && existing.classList.contains('flow-detail-panel')) {
          existing.remove();
        }

        if (isExpanded) {
          const panel = document.createElement('div');
          panel.className = 'flow-detail-panel';

          if (hasInput) {
            const label = document.createElement('div');
            label.className = 'flow-detail-label';
            label.textContent = 'Input';
            panel.appendChild(label);

            const pre = document.createElement('pre');
            pre.className = 'flow-detail-pre';
            pre.textContent = formatJson(ev.tool_input);
            panel.appendChild(pre);
          }

          if (hasResponse) {
            const label = document.createElement('div');
            label.className = 'flow-detail-label';
            label.textContent = 'Response';
            panel.appendChild(label);

            const pre = document.createElement('pre');
            pre.className = 'flow-detail-pre';
            pre.textContent = formatJson(ev.tool_response);
            panel.appendChild(pre);
          }

          row.insertAdjacentElement('afterend', panel);
        }
      });
    }

    timeline.appendChild(row);
  });

  el.appendChild(timeline);
}

// ── Detail view ───────────────────────────────────────────────────────────────

async function renderDetail(el, promptId) {
  // Loading state
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  loading.appendChild(sp);
  el.appendChild(loading);

  try {
    const data = await get('/prompts/' + promptId);
    el.removeChild(loading);

    const prompt = data.prompt || data;
    const events = data.events || [];

    // Back link
    const backLink = document.createElement('a');
    backLink.href = '#prompts';
    backLink.className = 'back-link';
    backLink.textContent = '← Back to Prompts';
    el.appendChild(backLink);

    // Prompt header card
    const header = document.createElement('div');
    header.className = 'prompt-header card';
    header.style.marginBottom = '20px';

    const promptText = document.createElement('div');
    promptText.className = 'prompt-text';
    promptText.textContent = '\u201c' + (prompt.prompt_text || '(no text)') + '\u201d';
    header.appendChild(promptText);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'prompt-card-meta';
    meta.style.marginBottom = '0';

    if (prompt.project) {
      const proj = document.createElement('span');
      proj.textContent = '📁 ' + prompt.project;
      meta.appendChild(proj);
    }

    // Session link — built with DOM nodes to avoid innerHTML
    if (prompt.session_id) {
      const sessSpan = document.createElement('span');
      sessSpan.textContent = '🔗 Session: ';

      const sessLink = document.createElement('a');
      sessLink.href = '#sessions/' + prompt.session_id;
      sessLink.style.color = 'var(--accent)';
      sessLink.style.textDecoration = 'none';
      sessLink.textContent = prompt.session_id.slice(0, 8) + '…';

      sessSpan.appendChild(sessLink);
      meta.appendChild(sessSpan);
    }

    if (prompt.started_at) {
      const timeSpan = document.createElement('span');
      timeSpan.textContent = '🕐 ' + dayjs(prompt.started_at).format('MMM D, HH:mm');
      meta.appendChild(timeSpan);
    }

    if (prompt.duration_ms) {
      const durSpan = document.createElement('span');
      durSpan.textContent = '⏱ ' + formatDuration(prompt.duration_ms);
      meta.appendChild(durSpan);
    }

    if (prompt.cost) {
      const costSpan = document.createElement('span');
      costSpan.textContent = '💰 ' + formatCost(prompt.cost);
      meta.appendChild(costSpan);
    }

    const evtCount = events.length || prompt.event_count || 0;
    if (evtCount) {
      const evtSpan = document.createElement('span');
      evtSpan.textContent = '📊 ' + evtCount + ' events';
      meta.appendChild(evtSpan);
    }

    header.appendChild(meta);
    el.appendChild(header);

    // Flow timeline card
    const tlCard = document.createElement('div');
    tlCard.className = 'card';

    const tlTitle = document.createElement('div');
    tlTitle.className = 'card-title';
    tlTitle.textContent = 'Event Flow (' + events.length + ')';
    tlCard.appendChild(tlTitle);

    renderFlowTimeline(tlCard, events);
    el.appendChild(tlCard);

  } catch (err) {
    if (loading.parentNode === el) el.removeChild(loading);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load prompt: ' + err.message;
    el.appendChild(errDiv);
  }
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export async function mount(el, { period, params } = {}) {
  if (params) {
    await renderDetail(el, params);
  } else {
    await renderList(el, period);
  }
}

export function unmount() {
  // No charts to destroy
}
