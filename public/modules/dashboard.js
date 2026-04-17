import { get } from './api.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtCost(v) { return '$' + (v || 0).toFixed(4); }

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ── Chart instances ───────────────────────────────────────────────────────────

let costChart = null;
let modelChart = null;
let skillsChart = null;
let agentsChart = null;
let toolsChart = null;
let pipelineChart = null;
function destroyCharts() {
  [costChart, modelChart, skillsChart, agentsChart, toolsChart, pipelineChart].forEach(c => {
    if (c) c.destroy();
  });
  costChart = modelChart = skillsChart = agentsChart = toolsChart = pipelineChart = null;
}

// ── Chart defaults ────────────────────────────────────────────────────────────

const CHART_DEFAULTS = {
  color: '#8b8fa3',
  borderColor: '#2a2d3a',
  backgroundColor: 'rgba(108,92,231,0.15)',
};

Chart.defaults.color = CHART_DEFAULTS.color;
Chart.defaults.borderColor = CHART_DEFAULTS.borderColor;

// ── Render ────────────────────────────────────────────────────────────────────

function renderStatCards(el, overview, costData) {
  const avgDur = overview.sessions > 0 ? fmtDur(overview.avgDurationMs) : '—';
  const totalCost = costData ? fmtCost(costData.total) : fmtCost(overview.totalCost);

  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.innerHTML = [
    { label: 'Sessions', value: overview.sessions ?? '—', sub: '' },
    { label: 'Total Cost', value: totalCost, cls: 'cost', sub: '' },
    { label: 'Total Events', value: overview.totalEvents ?? '—', sub: '' },
    { label: 'Avg Duration', value: avgDur, sub: '' },
  ].map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls || ''}">${c.value}</div>
      <div class="stat-sub">${c.sub}&nbsp;</div>
    </div>
  `).join('');
  el.appendChild(grid);
}

function renderCostChart(canvas, costData) {
  const ctx = canvas.getContext('2d');
  const daily = costData?.daily || [];
  costChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daily.map(d => d.date),
      datasets: [{
        label: 'Cost',
        data: daily.map(d => d.cost),
        backgroundColor: 'rgba(108,92,231,0.5)',
        borderColor: '#6c5ce7',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#2a2d3a' }, ticks: { maxTicksLimit: 10 } },
        y: { grid: { color: '#2a2d3a' }, ticks: { callback: v => '$' + v.toFixed(3) } },
      },
    },
  });
}

function renderModelChart(canvas, overview) {
  const models = overview.models || [];
  const ctx = canvas.getContext('2d');
  const palette = ['#6c5ce7', '#00b894', '#fdcb6e', '#e17055', '#74b9ff', '#a29bfe'];
  modelChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: models.map(m => m.model || 'unknown'),
      datasets: [{
        data: models.map(m => m.cost || 0),
        backgroundColor: palette.slice(0, models.length),
        borderWidth: 2,
        borderColor: '#1a1d27',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12 } },
        tooltip: { callbacks: { label: ctx => ctx.label + ': ' + fmtCost(ctx.raw) } },
      },
    },
  });
}

function renderRankingChart(canvas, items, labelKey, valueKey, color) {
  const top = (items || []).slice(0, 8);
  const ctx = canvas.getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(i => i[labelKey] || 'unknown'),
      datasets: [{
        data: top.map(i => i[valueKey] || 0),
        backgroundColor: color + '80',
        borderColor: color,
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
        x: { grid: { color: '#2a2d3a' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

function renderPipelineTrends(canvas, trends) {
  const data = trends || [];
  const ctx = canvas.getContext('2d');
  pipelineChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.day),
      datasets: [
        {
          label: 'Success',
          data: data.map(d => d.success || 0),
          backgroundColor: 'rgba(0,184,148,0.6)',
          borderColor: '#00b894',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Error',
          data: data.map(d => d.errors || 0),
          backgroundColor: 'rgba(225,112,85,0.6)',
          borderColor: '#e17055',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Skipped',
          data: data.map(d => d.skipped || 0),
          backgroundColor: 'rgba(253,203,110,0.6)',
          borderColor: '#fdcb6e',
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12 } } },
      scales: {
        x: { stacked: true, grid: { color: '#2a2d3a' }, ticks: { maxTicksLimit: 10 } },
        y: { stacked: true, grid: { color: '#2a2d3a' }, beginAtZero: true },
      },
    },
  });
}

// ── Learning Widget ───────────────────────────────────────────────────────────

function makeEl(tag, attrs, text) {
  const el = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v);
    });
  }
  if (text != null) el.textContent = text;
  return el;
}

function makeStatCard(label, id) {
  const card = makeEl('div', { class: 'stat-card' });
  card.appendChild(makeEl('div', { class: 'stat-label' }, label));
  card.appendChild(makeEl('div', { class: 'stat-value', id }, '—'));
  return card;
}

function renderAutoEvolveWidget(container) {
  const section = makeEl('div', { class: 'card', style: 'margin-top:1.5rem;' });

  const header = makeEl('div', { class: 'card-title', style: 'display:flex;justify-content:space-between;align-items:center;' });
  header.appendChild(makeEl('span', null, 'Auto-evolve'));
  header.appendChild(makeEl('a', { href: '#auto-evolves', style: 'font-size:0.8rem;color:var(--accent);text-decoration:none;' }, 'View all \u2192'));
  section.appendChild(header);

  const statsGrid = makeEl('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(3,1fr);' });
  statsGrid.appendChild(makeStatCard('Active', 'op-ae-active'));
  statsGrid.appendChild(makeStatCard('Promoted', 'op-ae-promoted'));
  statsGrid.appendChild(makeStatCard('Reverted', 'op-ae-reverted'));
  section.appendChild(statsGrid);

  container.appendChild(section);

  get('/auto-evolves/stats').then(function(stats) {
    const counts = { active: 0, promoted: 0, reverted: 0 };
    for (const { status, count } of (stats.byStatus || [])) {
      if (status in counts) counts[status] = count;
    }
    const elActive = document.getElementById('op-ae-active');
    const elPromoted = document.getElementById('op-ae-promoted');
    const elReverted = document.getElementById('op-ae-reverted');
    if (elActive) elActive.textContent = counts.active;
    if (elPromoted) elPromoted.textContent = counts.promoted;
    if (elReverted) elReverted.textContent = counts.reverted;
  }).catch(function() {
    const elActive = document.getElementById('op-ae-active');
    if (elActive) elActive.textContent = '—';
  });
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export function mount(el, { period } = {}) {
  const p = period || '30d';

  // Build skeleton
  const chartsRow = document.createElement('div');
  chartsRow.className = 'charts-row';
  chartsRow.innerHTML = `
    <div class="card">
      <div class="card-title">Cost Over Time</div>
      <div class="chart-wrap tall"><canvas id="op-chart-cost"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Model Mix</div>
      <div class="chart-wrap donut"><canvas id="op-chart-model"></canvas></div>
    </div>
  `;

  const rankingsRow = document.createElement('div');
  rankingsRow.className = 'rankings-row';
  rankingsRow.innerHTML = `
    <div class="card">
      <div class="card-title">Top Skills</div>
      <div class="chart-wrap medium"><canvas id="op-chart-skills"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Top Agents</div>
      <div class="chart-wrap medium"><canvas id="op-chart-agents"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Top Tools</div>
      <div class="chart-wrap medium"><canvas id="op-chart-tools"></canvas></div>
    </div>
  `;

  // Stat placeholder
  const statPlaceholder = document.createElement('div');
  statPlaceholder.className = 'stat-grid';
  statPlaceholder.innerHTML = Array(4).fill(0).map(() => `
    <div class="stat-card"><div class="stat-label">&nbsp;</div><div class="stat-value">—</div><div class="stat-sub">&nbsp;</div></div>
  `).join('');

  const pipelineCard = document.createElement('div');
  pipelineCard.className = 'card';
  pipelineCard.style.marginBottom = '1.5rem';
  pipelineCard.innerHTML = `
    <div class="card-title">Pipeline Success / Failure</div>
    <div class="chart-wrap tall"><canvas id="op-chart-pipeline"></canvas></div>
  `;

  el.appendChild(statPlaceholder);
  el.appendChild(chartsRow);
  el.appendChild(pipelineCard);
  el.appendChild(rankingsRow);

  // Load data
  Promise.all([
    get('/overview?period=' + p),
    get('/cost?period=' + p),
    get('/pipeline-runs/trends?days=' + (p === '24h' ? 1 : p === '7d' ? 7 : 30)),
  ]).then(([overview, costData, pipelineTrends]) => {
    // Replace stat grid
    const newGrid = document.createElement('div');
    renderStatCards(newGrid, overview, costData);
    el.replaceChild(newGrid.firstElementChild, statPlaceholder);

    // Charts
    renderCostChart(document.getElementById('op-chart-cost'), costData);
    renderModelChart(document.getElementById('op-chart-model'), overview);

    const topSkills = overview.topSkills || [];
    const topAgents = overview.topAgents || [];
    const topTools = overview.topTools || [];

    skillsChart = renderRankingChart(
      document.getElementById('op-chart-skills'), topSkills, 'name', 'count', '#00b894'
    );
    agentsChart = renderRankingChart(
      document.getElementById('op-chart-agents'), topAgents, 'name', 'count', '#fdcb6e'
    );
    toolsChart = renderRankingChart(
      document.getElementById('op-chart-tools'), topTools, 'name', 'count', '#6c5ce7'
    );

    // Pipeline trends
    renderPipelineTrends(document.getElementById('op-chart-pipeline'), pipelineTrends);
  }).catch(err => {
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load dashboard: ' + err.message;
    el.prepend(errDiv);
  });

  renderAutoEvolveWidget(el);
}

export function unmount() {
  destroyCharts();
}
