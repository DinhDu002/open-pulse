import { get, post } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—';
  return dayjs(ts).format('MMM D, HH:mm:ss');
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export function mount(el) {
  // Stat cards
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  grid.style.marginBottom = '24px';

  const statStatus = createStatCard('Status', '…');
  const statDb = createStatCard('DB Size', '…');
  const statEvents = createStatCard('Total Events', '…');
  grid.appendChild(statStatus.card);
  grid.appendChild(statDb.card);
  grid.appendChild(statEvents.card);
  el.appendChild(grid);

  // Config editor
  const configCard = document.createElement('div');
  configCard.className = 'card';
  configCard.style.marginBottom = '24px';

  const configTitle = document.createElement('div');
  configTitle.className = 'card-title';
  configTitle.textContent = 'Configuration';
  configCard.appendChild(configTitle);

  const configGroup = document.createElement('div');
  configGroup.className = 'form-group';
  const configArea = document.createElement('textarea');
  configArea.style.minHeight = '200px';
  configArea.placeholder = 'Loading config…';
  configGroup.appendChild(configArea);
  configCard.appendChild(configGroup);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save Config';

  const saveResult = document.createElement('span');
  saveResult.style.cssText = 'margin-left:12px; font-size:12px;';

  saveBtn.addEventListener('click', () => {
    let parsed;
    try {
      parsed = JSON.parse(configArea.value);
    } catch (e) {
      saveResult.style.color = 'var(--danger)';
      saveResult.textContent = 'Invalid JSON: ' + e.message;
      return;
    }
    saveBtn.disabled = true;
    post('/settings/config', parsed).then(() => {
      saveBtn.disabled = false;
      saveResult.style.color = 'var(--success)';
      saveResult.textContent = 'Saved';
      setTimeout(() => { saveResult.textContent = ''; }, 3000);
    }).catch(err => {
      saveBtn.disabled = false;
      saveResult.style.color = 'var(--danger)';
      saveResult.textContent = 'Save failed: ' + err.message;
    });
  });

  const saveBtnRow = document.createElement('div');
  saveBtnRow.style.display = 'flex';
  saveBtnRow.style.alignItems = 'center';
  saveBtnRow.appendChild(saveBtn);
  saveBtnRow.appendChild(saveResult);
  configCard.appendChild(saveBtnRow);
  el.appendChild(configCard);

  // Action buttons
  const actionsCard = document.createElement('div');
  actionsCard.className = 'card';
  actionsCard.style.marginBottom = '24px';

  const actionsTitle = document.createElement('div');
  actionsTitle.className = 'card-title';
  actionsTitle.textContent = 'Operations';
  actionsCard.appendChild(actionsTitle);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap;';

  const ingestBtn = document.createElement('button');
  ingestBtn.className = 'btn';
  ingestBtn.textContent = 'Trigger Ingest';

  const ingestResult = document.createElement('span');
  ingestResult.style.cssText = 'font-size:12px; margin-left:4px;';

  ingestBtn.addEventListener('click', () => {
    ingestBtn.disabled = true;
    ingestBtn.textContent = 'Ingesting…';
    post('/ingest', {}).then(res => {
      ingestBtn.disabled = false;
      ingestBtn.textContent = 'Trigger Ingest';
      ingestResult.style.color = 'var(--success)';
      ingestResult.textContent = 'Done: ' + (res.processed ?? '') + ' events';
      setTimeout(() => { ingestResult.textContent = ''; }, 4000);
    }).catch(err => {
      ingestBtn.disabled = false;
      ingestBtn.textContent = 'Trigger Ingest';
      ingestResult.style.color = 'var(--danger)';
      ingestResult.textContent = 'Failed: ' + err.message;
    });
  });

  const syncBtn = document.createElement('button');
  syncBtn.className = 'btn';
  syncBtn.textContent = 'Sync CL Data';

  const syncResult = document.createElement('span');
  syncResult.style.cssText = 'font-size:12px; margin-left:4px;';

  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    post('/sync', {}).then(res => {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync CL Data';
      syncResult.style.color = 'var(--success)';
      syncResult.textContent = 'Synced';
      setTimeout(() => { syncResult.textContent = ''; }, 4000);
    }).catch(err => {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync CL Data';
      syncResult.style.color = 'var(--danger)';
      syncResult.textContent = 'Failed: ' + err.message;
    });
  });

  actionsRow.appendChild(ingestBtn);
  actionsRow.appendChild(ingestResult);
  actionsRow.appendChild(syncBtn);
  actionsRow.appendChild(syncResult);
  actionsCard.appendChild(actionsRow);
  el.appendChild(actionsCard);

  // Recent Errors
  const errorsCard = document.createElement('div');
  errorsCard.className = 'card';

  const errorsTitle = document.createElement('div');
  errorsTitle.className = 'card-title';
  errorsTitle.textContent = 'Recent Errors';
  errorsCard.appendChild(errorsTitle);

  const errorsContent = document.createElement('div');
  const errSpinner = document.createElement('div');
  errSpinner.className = 'empty-state';
  const sp2 = document.createElement('span');
  sp2.className = 'spinner';
  errSpinner.appendChild(sp2);
  errorsContent.appendChild(errSpinner);
  errorsCard.appendChild(errorsContent);
  el.appendChild(errorsCard);

  // Load health data
  get('/health').then(data => {
    statStatus.valueEl.textContent = data.status || 'ok';
    statStatus.valueEl.style.color = data.status === 'ok' ? 'var(--success)' : 'var(--danger)';
    statDb.valueEl.textContent = data.dbSize || '—';
    statEvents.valueEl.textContent = data.totalEvents ?? '—';
  }).catch(() => {
    statStatus.valueEl.textContent = 'error';
    statStatus.valueEl.style.color = 'var(--danger)';
  });

  // Load config
  get('/settings/config').then(data => {
    configArea.value = JSON.stringify(data, null, 2);
  }).catch(() => {
    configArea.placeholder = 'Could not load config';
  });

  // Load errors
  get('/settings/errors').then(data => {
    errorsContent.removeChild(errSpinner);
    const errors = Array.isArray(data) ? data : (data.errors || []);

    if (errors.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.color = 'var(--success)';
      empty.textContent = 'No recent errors';
      errorsContent.appendChild(empty);
    } else {
      errors.forEach(err => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 0; border-bottom:1px solid var(--border);';

        const time = document.createElement('div');
        time.style.cssText = 'font-size:11px; color:var(--text-muted); margin-bottom:4px;';
        time.textContent = fmtTime(err.timestamp || err.at);

        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:13px; color:var(--danger); font-family:monospace;';
        msg.textContent = err.message || err.error || JSON.stringify(err);

        row.appendChild(time);
        row.appendChild(msg);
        errorsContent.appendChild(row);
      });
    }
  }).catch(() => {
    errorsContent.removeChild(errSpinner);
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Could not load errors';
    errorsContent.appendChild(empty);
  });
}

export function unmount() {
  // Nothing to clean up
}

// ── Internal ──────────────────────────────────────────────────────────────────

function createStatCard(label, initial) {
  const card = document.createElement('div');
  card.className = 'stat-card';

  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = 'stat-value';
  valueEl.textContent = initial;

  card.appendChild(labelEl);
  card.appendChild(valueEl);
  return { card, labelEl, valueEl };
}
