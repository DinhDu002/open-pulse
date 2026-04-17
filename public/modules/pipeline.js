import { get } from './api.js';
import { fmtDate, escHtml, truncate } from './utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status) {
  const colors = { success: '#00b894', error: '#e17055', skipped: '#fdcb6e' };
  const span = document.createElement('span');
  span.className = 'badge';
  const c = colors[status] || '#8b8fa3';
  span.style.cssText = `background:${c}26;color:${c}`;
  span.textContent = status;
  return span;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function fmtTokens(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function createStatCard(label, value) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'stat-value';
  valueEl.textContent = value;
  card.appendChild(labelEl);
  card.appendChild(valueEl);
  return { card, valueEl };
}

// ── State ────────────────────────────────────────────────────────────────────

let currentFilter = { pipeline: '', status: '' };
let currentPage = 1;

// ── Mount ────────────────────────────────────────────────────────────────────

export function mount(el) {
  currentPage = 1;
  currentFilter = { pipeline: '', status: '' };

  // Stat cards
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.style.marginBottom = '24px';

  const statTotal = createStatCard('Total Runs', '…');
  const statSuccess = createStatCard('Success Rate', '…');
  const statDuration = createStatCard('Avg Duration', '…');
  const statTokens = createStatCard('Total Tokens', '…');
  const statCost = createStatCard('Est. LLM Cost', '…');
  grid.appendChild(statTotal.card);
  grid.appendChild(statSuccess.card);
  grid.appendChild(statDuration.card);
  grid.appendChild(statTokens.card);
  grid.appendChild(statCost.card);
  el.appendChild(grid);

  // Ollama status card
  const ollamaCard = document.createElement('div');
  ollamaCard.className = 'card';
  ollamaCard.style.marginBottom = '24px';
  const ollamaTitle = document.createElement('div');
  ollamaTitle.className = 'card-title';
  ollamaTitle.textContent = 'Ollama Status';
  ollamaCard.appendChild(ollamaTitle);
  const ollamaContent = document.createElement('div');
  ollamaContent.style.cssText = 'display:flex;gap:24px;align-items:center;padding:4px 0;';
  ollamaContent.textContent = 'Checking…';
  ollamaCard.appendChild(ollamaContent);
  el.appendChild(ollamaCard);

  // Filters
  const filterRow = document.createElement('div');
  filterRow.style.cssText = 'display:flex;gap:10px;margin-bottom:16px;align-items:center;';

  const pipelineSelect = document.createElement('select');
  pipelineSelect.className = 'input';
  pipelineSelect.style.width = 'auto';
  pipelineSelect.innerHTML = '<option value="">All Pipelines</option><option value="knowledge_extract">Knowledge Extract</option><option value="pattern_detect">Pattern Detect</option><option value="knowledge_scan">Knowledge Scan</option>';
  pipelineSelect.addEventListener('change', () => {
    currentFilter.pipeline = pipelineSelect.value;
    currentPage = 1;
    loadRuns(tableBody, pagination);
  });

  const statusSelect = document.createElement('select');
  statusSelect.className = 'input';
  statusSelect.style.width = 'auto';
  statusSelect.innerHTML = '<option value="">All Status</option><option value="success">Success</option><option value="error">Error</option><option value="skipped">Skipped</option>';
  statusSelect.addEventListener('change', () => {
    currentFilter.status = statusSelect.value;
    currentPage = 1;
    loadRuns(tableBody, pagination);
  });

  filterRow.appendChild(pipelineSelect);
  filterRow.appendChild(statusSelect);
  el.appendChild(filterRow);

  // Table
  const tableCard = document.createElement('div');
  tableCard.className = 'card';

  const tableTitle = document.createElement('div');
  tableTitle.className = 'card-title';
  tableTitle.textContent = 'Pipeline Runs';
  tableCard.appendChild(tableTitle);

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Pipeline</th>
        <th>Project</th>
        <th>Model</th>
        <th>Status</th>
        <th>Duration</th>
        <th>Tokens</th>
        <th>Time</th>
        <th>Error</th>
      </tr>
    </thead>
  `;
  const tableBody = document.createElement('tbody');
  table.appendChild(tableBody);
  tableCard.appendChild(table);

  const pagination = document.createElement('div');
  pagination.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 0;';
  tableCard.appendChild(pagination);

  el.appendChild(tableCard);

  // By-pipeline breakdown
  const breakdownCard = document.createElement('div');
  breakdownCard.className = 'card';
  breakdownCard.style.marginTop = '24px';
  const breakdownTitle = document.createElement('div');
  breakdownTitle.className = 'card-title';
  breakdownTitle.textContent = 'Breakdown by Pipeline';
  breakdownCard.appendChild(breakdownTitle);
  const breakdownContent = document.createElement('div');
  breakdownCard.appendChild(breakdownContent);
  el.appendChild(breakdownCard);

  // Load data
  loadStats(statTotal, statSuccess, statDuration, statTokens, statCost, breakdownContent);
  loadOllama(ollamaContent);
  loadRuns(tableBody, pagination);
}

export function unmount() {
  currentPage = 1;
}

// ── Data Loading ─────────────────────────────────────────────────────────────

function estimateCost(inputTokens, outputTokens) {
  // Ollama local model — estimate based on electricity/opportunity cost (~$0.001/1K tokens)
  // This is a rough estimate; real cost for local models is negligible
  const totalTokens = (inputTokens || 0) + (outputTokens || 0);
  return totalTokens * 0.000001; // $0.001 per 1M tokens (essentially free)
}

async function loadStats(statTotal, statSuccess, statDuration, statTokens, statCost, breakdownEl) {
  try {
    const data = await get('/pipeline-runs/stats');
    statTotal.valueEl.textContent = data.total_runs;
    const rate = data.total_runs > 0 ? Math.round((data.success_count / data.total_runs) * 100) : 0;
    statSuccess.valueEl.textContent = rate + '%';
    statSuccess.valueEl.style.color = rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--danger)';
    statDuration.valueEl.textContent = fmtDuration(data.avg_duration_ms);
    const totalTk = (data.total_input_tokens || 0) + (data.total_output_tokens || 0);
    statTokens.valueEl.textContent = fmtTokens(totalTk);
    const cost = estimateCost(data.total_input_tokens, data.total_output_tokens);
    statCost.valueEl.textContent = cost < 0.01 ? '< $0.01' : '$' + cost.toFixed(2);
    statCost.valueEl.style.color = 'var(--success)';

    // Breakdown table
    if (data.by_pipeline && data.by_pipeline.length > 0) {
      const tbl = document.createElement('table');
      tbl.className = 'data-table';
      tbl.innerHTML = '<thead><tr><th>Pipeline</th><th>Runs</th><th>Input Tokens</th><th>Output Tokens</th></tr></thead>';
      const body = document.createElement('tbody');
      for (const row of data.by_pipeline) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escHtml(row.pipeline)}</td><td>${row.count}</td><td>${fmtTokens(row.input_tokens)}</td><td>${fmtTokens(row.output_tokens)}</td>`;
        body.appendChild(tr);
      }
      tbl.appendChild(body);
      breakdownEl.appendChild(tbl);
    } else {
      breakdownEl.textContent = 'No pipeline runs yet.';
    }
  } catch {
    statTotal.valueEl.textContent = '—';
    statCost.valueEl.textContent = '—';
  }
}

async function loadOllama(container) {
  try {
    const data = await get('/health/ollama');
    container.textContent = '';

    const statusEl = document.createElement('span');
    const isOnline = data.status === 'online';
    statusEl.textContent = isOnline ? 'Online' : 'Offline';
    statusEl.style.cssText = `font-weight:600;color:${isOnline ? 'var(--success)' : 'var(--danger)'}`;

    const modelEl = document.createElement('span');
    modelEl.style.color = 'var(--text-muted)';
    modelEl.textContent = `Model: ${data.model}`;

    const loadedEl = document.createElement('span');
    if (isOnline) {
      loadedEl.textContent = data.model_loaded ? 'Model loaded' : 'Model NOT loaded';
      loadedEl.style.color = data.model_loaded ? 'var(--success)' : 'var(--warning)';
    }

    const breakerEl = document.createElement('span');
    if (data.circuit_breaker) {
      const bs = data.circuit_breaker.state;
      breakerEl.textContent = `Breaker: ${bs}`;
      breakerEl.style.color = bs === 'closed' ? 'var(--success)' : bs === 'open' ? 'var(--danger)' : 'var(--warning)';
    }

    container.appendChild(statusEl);
    container.appendChild(modelEl);
    if (isOnline) container.appendChild(loadedEl);
    if (data.circuit_breaker) container.appendChild(breakerEl);
  } catch {
    container.textContent = 'Could not check Ollama status';
    container.style.color = 'var(--text-muted)';
  }
}

async function loadRuns(tableBody, paginationEl) {
  tableBody.innerHTML = '<tr><td colspan="8" class="empty-state"><span class="spinner"></span></td></tr>';

  try {
    const params = new URLSearchParams();
    if (currentFilter.pipeline) params.set('pipeline', currentFilter.pipeline);
    if (currentFilter.status) params.set('status', currentFilter.status);
    params.set('page', currentPage);
    params.set('limit', 20);

    const data = await get('/pipeline-runs?' + params.toString());
    const items = data.items || [];

    tableBody.innerHTML = '';
    if (items.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">No pipeline runs found</td></tr>';
    } else {
      for (const run of items) {
        const tr = document.createElement('tr');
        const tkStr = (run.input_tokens || run.output_tokens)
          ? `${fmtTokens(run.input_tokens)} / ${fmtTokens(run.output_tokens)}`
          : '—';
        const errorCell = run.error
          ? `<td title="${escHtml(run.error)}" style="color:var(--danger);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(truncate(run.error, 60))}</td>`
          : '<td>—</td>';

        tr.innerHTML = `
          <td>${escHtml(run.pipeline)}</td>
          <td>${escHtml(run.project_id || '—')}</td>
          <td>${escHtml(run.model || '—')}</td>
          <td></td>
          <td>${fmtDuration(run.duration_ms)}</td>
          <td>${tkStr}</td>
          <td>${fmtDate(run.created_at)}</td>
          ${errorCell}
        `;
        // Insert badge into status cell
        tr.children[3].appendChild(statusBadge(run.status));
        tableBody.appendChild(tr);
      }
    }

    // Pagination
    paginationEl.innerHTML = '';
    const totalPages = Math.ceil((data.total || 0) / 20);
    const info = document.createElement('span');
    info.style.cssText = 'font-size:12px;color:var(--text-muted)';
    info.textContent = `Page ${currentPage} of ${totalPages} (${data.total} runs)`;
    paginationEl.appendChild(info);

    if (totalPages > 1) {
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn';
      prevBtn.textContent = 'Prev';
      prevBtn.disabled = currentPage <= 1;
      prevBtn.addEventListener('click', () => { currentPage--; loadRuns(tableBody, paginationEl); });

      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn';
      nextBtn.textContent = 'Next';
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.addEventListener('click', () => { currentPage++; loadRuns(tableBody, paginationEl); });

      btns.appendChild(prevBtn);
      btns.appendChild(nextBtn);
      paginationEl.appendChild(btns);
    }
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:var(--danger)">Failed to load: ${escHtml(err.message)}</td></tr>`;
  }
}
