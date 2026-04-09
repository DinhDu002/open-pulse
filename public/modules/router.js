// Hash-based SPA router

const ROUTES = {
  dashboard: () => import('./dashboard.js'),
  prompts: () => import('./prompts.js'),
  inventory: () => import('./inventory.js'),
  projects: () => import('./projects.js'),
  learning: () => import('./learning.js'),
  knowledge: () => import('./knowledge.js'),
  expert: () => import('./expert.js'),
  settings: () => import('./settings.js'),
};

// Pages that hide the period selector
const NO_PERIOD = new Set(['settings', 'learning', 'knowledge', 'projects']);

let currentModule = null;
let currentPeriod = '30d';

function getHash() {
  const hash = location.hash.slice(1) || 'dashboard';
  const [page, ...rest] = hash.split('/');
  return { page: page || 'dashboard', params: rest.join('/') };
}

function getLoader(page) {
  return ROUTES[page] || ROUTES.dashboard;
}

async function navigate() {
  const { page, params } = getHash();
  const app = document.getElementById('app');
  const periodSelector = document.getElementById('period-selector');

  // Update nav active state
  document.querySelectorAll('#nav a').forEach(a => {
    const href = a.getAttribute('href').slice(1);
    a.classList.toggle('active', href === page);
  });

  // Show/hide period selector
  if (periodSelector) {
    periodSelector.style.display = NO_PERIOD.has(page) ? 'none' : 'flex';
  }

  // Unmount current module
  if (currentModule && typeof currentModule.unmount === 'function') {
    currentModule.unmount();
  }
  currentModule = null;

  // Clear container
  app.textContent = '';
  const spinner = document.createElement('div');
  spinner.className = 'empty-state';
  const spinEl = document.createElement('span');
  spinEl.className = 'spinner';
  spinner.appendChild(spinEl);
  app.appendChild(spinner);

  try {
    const loader = getLoader(page);
    const mod = await loader();
    currentModule = mod;

    app.textContent = '';

    if (page === 'settings') {
      mod.mount(app);
    } else {
      mod.mount(app, { period: currentPeriod, params });
    }
  } catch (err) {
    app.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.style.color = 'var(--danger)';
    errDiv.textContent = 'Failed to load module: ' + err.message;
    app.appendChild(errDiv);
    console.error(err);
  }
}

function initPeriodSelector() {
  const selector = document.getElementById('period-selector');
  if (!selector) return;

  selector.addEventListener('click', e => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;

    const period = btn.dataset.period;
    if (period === currentPeriod) return;

    currentPeriod = period;

    // Update active state
    selector.querySelectorAll('.period-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.period === period);
    });

    // Re-mount current module with new period
    const { page, params } = getHash();
    if (currentModule && typeof currentModule.mount === 'function' && !NO_PERIOD.has(page)) {
      const app = document.getElementById('app');
      if (typeof currentModule.unmount === 'function') currentModule.unmount();
      app.textContent = '';
      currentModule.mount(app, { period: currentPeriod, params });
    }
  });
}

export function initRouter() {
  initPeriodSelector();
  window.addEventListener('hashchange', navigate);
  navigate();
}
