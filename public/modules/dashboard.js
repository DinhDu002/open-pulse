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
let learningChart = null;

function destroyCharts() {
  [costChart, modelChart, skillsChart, agentsChart, toolsChart, learningChart].forEach(c => {
    if (c) c.destroy();
  });
  costChart = modelChart = skillsChart = agentsChart = toolsChart = learningChart = null;
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

function makeRecentRow(item) {
  const row = makeEl('div', { style: 'display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid #2a2d3a;' });
  const badgeClass = item.kind === 'instinct' ? 'badge workflow' : 'badge pending';
  const badge = makeEl('span', { class: badgeClass, style: 'flex-shrink:0;font-size:0.7rem;padding:2px 6px;' }, item.kind || '');
  const href = item.kind === 'instinct'
    ? '#learning/instincts/' + String(item.id || '')
    : '#learning/suggestions';
  const link = makeEl('a', { href, style: 'flex:1;color:var(--text);text-decoration:none;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
  link.title = item.title || '';
  link.textContent = item.title || '—';
  const conf = makeEl('span', { style: 'color:var(--muted);font-size:0.8rem;flex-shrink:0;' },
    item.confidence != null ? Number(item.confidence).toFixed(2) : '');
  row.appendChild(badge);
  row.appendChild(link);
  row.appendChild(conf);
  return row;
}

function renderLearningWidget(container) {
  const section = makeEl('div', { class: 'card', style: 'margin-top:1.5rem;' });

  // Header row
  const header = makeEl('div', { class: 'card-title', style: 'display:flex;justify-content:space-between;align-items:center;' });
  header.appendChild(makeEl('span', null, 'Learning'));
  header.appendChild(makeEl('a', { href: '#learning', style: 'font-size:0.8rem;color:var(--accent);text-decoration:none;' }, 'View all \u2192'));
  section.appendChild(header);

  // Stat cards grid
  const statsGrid = makeEl('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(4,1fr);margin-bottom:1rem;' });
  statsGrid.appendChild(makeStatCard('Instincts', 'op-ls-instincts'));
  statsGrid.appendChild(makeStatCard('Obs. Today', 'op-ls-obs'));
  statsGrid.appendChild(makeStatCard('Projects', 'op-ls-projects'));
  statsGrid.appendChild(makeStatCard('Pending', 'op-ls-pending'));
  section.appendChild(statsGrid);

  // Mini chart container
  const chartWrap = makeEl('div', { class: 'chart-wrap', style: 'height:100px;margin-bottom:1rem;' });
  chartWrap.appendChild(makeEl('canvas', { id: 'op-chart-learning' }));
  section.appendChild(chartWrap);

  // Recent list placeholder
  const recentEl = makeEl('div', { id: 'op-learning-recent' });
  section.appendChild(recentEl);

  container.appendChild(section);

  Promise.all([
    get('/instincts?per_page=1'),
    get('/observations/activity?days=1'),
    get('/instincts/projects'),
    get('/suggestions?status=pending'),
    get('/learning/activity?days=7'),
    get('/learning/recent?limit=5'),
  ]).then(function([instinctsRes, obsToday, projects, suggestions, activity, recent]) {
    // Populate stat cards
    const totalInstincts = instinctsRes && instinctsRes.total != null
      ? instinctsRes.total
      : (Array.isArray(instinctsRes) ? instinctsRes.length : '—');
    const obsCount = Array.isArray(obsToday) ? obsToday.reduce((s, d) => s + (d.count || 0), 0) : '—';
    const projectCount = Array.isArray(projects) ? projects.length : '—';
    const pendingCount = Array.isArray(suggestions) ? suggestions.length : '—';

    const elInstincts = document.getElementById('op-ls-instincts');
    const elObs = document.getElementById('op-ls-obs');
    const elProjects = document.getElementById('op-ls-projects');
    const elPending = document.getElementById('op-ls-pending');
    if (elInstincts) elInstincts.textContent = totalInstincts;
    if (elObs) elObs.textContent = obsCount;
    if (elProjects) elProjects.textContent = projectCount;
    if (elPending) elPending.textContent = pendingCount;

    // Mini bar chart
    const canvas = document.getElementById('op-chart-learning');
    if (canvas && Array.isArray(activity)) {
      const ctx = canvas.getContext('2d');
      learningChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: activity.map(d => d.date),
          datasets: [{
            data: activity.map(d => d.count || 0),
            backgroundColor: '#6c5ce7',
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#2a2d3a' }, ticks: { font: { size: 10 }, maxTicksLimit: 7 } },
            y: { grid: { color: '#2a2d3a' }, ticks: { font: { size: 10 }, stepSize: 1 } },
          },
        },
      });
    }

    // Recent list
    const recentContainer = document.getElementById('op-learning-recent');
    if (recentContainer) {
      recentContainer.textContent = '';
      if (Array.isArray(recent) && recent.length > 0) {
        recent.forEach(item => recentContainer.appendChild(makeRecentRow(item)));
      } else {
        recentContainer.appendChild(makeEl('div', { style: 'color:var(--muted);font-size:0.85rem;padding:0.5rem 0;' }, 'No recent learning activity.'));
      }
    }
  }).catch(function() {
    const recentContainer = document.getElementById('op-learning-recent');
    if (recentContainer) {
      recentContainer.textContent = '';
      recentContainer.appendChild(makeEl('div', { style: 'color:var(--muted);font-size:0.85rem;padding:0.5rem 0;' }, 'CL data unavailable.'));
    }
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

  renderLearningWidget(el);
}

export function unmount() {
  destroyCharts();
}
