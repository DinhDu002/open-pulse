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

function destroyCharts() {
  [costChart, modelChart, skillsChart, agentsChart, toolsChart].forEach(c => {
    if (c) c.destroy();
  });
  costChart = modelChart = skillsChart = agentsChart = toolsChart = null;
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

  el.appendChild(statPlaceholder);
  el.appendChild(chartsRow);
  el.appendChild(rankingsRow);

  // Load data
  Promise.all([
    get('/overview?period=' + p),
    get('/cost?period=' + p),
  ]).then(([overview, costData]) => {
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
  }).catch(err => {
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load dashboard: ' + err.message;
    el.prepend(errDiv);
  });
}

export function unmount() {
  destroyCharts();
}
