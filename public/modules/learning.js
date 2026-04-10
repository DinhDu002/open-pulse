// Learning page — sidebar orchestrator with sub-routing
// NOTE: innerHTML usage below is safe — only static strings (no user input) are assigned.
import { get } from './api.js';

const SECTIONS = [
  { key: 'instincts', label: 'Instincts' },
];

let root = null;
let mainEl = null;
let currentSection = 'instincts';

const loaders = {
  instincts: () => import('./learning-instincts.js'),
};
let loadedModules = {};

function parseParams(params) {
  if (!params) return { section: 'instincts', detail: null };
  var parts = params.split('/');
  var section = SECTIONS.find(function(s) { return s.key === parts[0]; }) ? parts[0] : 'instincts';
  var detail = parts[1] || null;
  return { section, detail };
}

async function loadStats(statsEl) {
  try {
    var results = await Promise.all([
      get('/instincts?per_page=1'),
    ]);
    statsEl.innerHTML =
      '<div>Instincts: <span>' + results[0].total + '</span></div>';
  } catch(e) { statsEl.innerHTML = '<div>Stats unavailable</div>'; }
}

function renderSidebar(container, active) {
  var sidebar = document.createElement('div');
  sidebar.className = 'learning-sidebar';
  for (var i = 0; i < SECTIONS.length; i++) {
    var s = SECTIONS[i];
    var a = document.createElement('a');
    a.href = '#learning/' + s.key;
    a.textContent = s.label;
    if (s.key === active) a.className = 'active';
    sidebar.appendChild(a);
  }
  var stats = document.createElement('div');
  stats.className = 'sidebar-stats';
  stats.textContent = 'Loading...';
  sidebar.appendChild(stats);
  loadStats(stats);
  container.appendChild(sidebar);
}

async function renderSection(section, detail) {
  if (!mainEl) return;
  mainEl.innerHTML = '<div class="loading">Loading...</div>';
  if (!loadedModules[section]) {
    loadedModules[section] = await loaders[section]();
  }
  var mod = loadedModules[section];
  if (detail) {
    mod.renderDetail(mainEl, detail);
  } else {
    mod.renderList(mainEl);
  }
}

export function mount(el, { params }) {
  var parsed = parseParams(params);
  currentSection = parsed.section;

  root = document.createElement('div');
  var layout = document.createElement('div');
  layout.className = 'learning-layout';
  renderSidebar(layout, currentSection);

  mainEl = document.createElement('div');
  mainEl.className = 'learning-main';
  layout.appendChild(mainEl);
  root.appendChild(layout);

  var footer = document.createElement('div');
  footer.className = 'learning-footer';
  footer.innerHTML = '<div>Last sync: checking...</div><div>Observer: checking...</div>';
  root.appendChild(footer);

  get('/instincts/projects').then(function(projects) {
    var running = projects.filter(function(p) { return p.observer_running; }).length;
    footer.innerHTML =
      '<div>Projects: ' + projects.length + '</div>' +
      '<div>Observer: ' + (running > 0 ? '\u25CF ' + running + ' running' : '\u25CB stopped') + '</div>';
  }).catch(function() {});

  el.appendChild(root);
  renderSection(currentSection, parsed.detail);
}

export function unmount() {
  loadedModules = {};
  if (root) { root.remove(); root = null; }
  mainEl = null;
}
