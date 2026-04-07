import { get, post } from './api.js';

// ── Utilities ─────────────────────────────────────────────────────────────────

function timeAgo(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ── Node colors ───────────────────────────────────────────────────────────────

const NODE_COLORS = {
  tool:      '#00b894',
  component: '#6c5ce7',
  pattern:   '#e17055',
  instinct:  '#00cec9',
  session:   '#636e72',
  project:   '#fdcb6e',
};

function nodeColor(type) {
  return NODE_COLORS[type] || '#8b8fa3';
}

// ── Tab 1: Graph Explorer ─────────────────────────────────────────────────────

let cyInstance = null;

function buildCytoscapeStyles() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'label': 'data(label)',
        'color': '#e1e4eb',
        'font-size': '11px',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': '4px',
        'width': 'data(size)',
        'height': 'data(size)',
        'border-width': '1px',
        'border-color': 'rgba(255,255,255,0.1)',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': '2px',
        'border-color': '#6c5ce7',
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 'data(width)',
        'line-color': 'rgba(139,143,163,0.4)',
        'target-arrow-color': 'rgba(139,143,163,0.4)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
      },
    },
    {
      selector: 'node.dimmed',
      style: { 'opacity': 0.15 },
    },
    {
      selector: 'edge.dimmed',
      style: { 'opacity': 0.05 },
    },
  ];
}

function buildElements(graphData) {
  const nodes = (graphData.nodes || []).map(n => {
    const degree = n.degree || 1;
    const size = Math.min(Math.max(12 + Math.log2(degree + 1) * 6, 12), 48);
    return {
      data: {
        id: String(n.id),
        label: n.label || n.name || String(n.id),
        type: n.type || 'tool',
        color: nodeColor(n.type),
        size,
        properties: n,
      },
    };
  });

  const edges = (graphData.edges || []).map(e => {
    const weight = e.weight || 1;
    const width = Math.min(Math.max(Math.log2(weight), 1), 5);
    return {
      data: {
        id: 'e-' + e.source + '-' + e.target + '-' + Math.random().toString(36).slice(2),
        source: String(e.source),
        target: String(e.target),
        weight,
        width,
        label: e.label || '',
      },
    };
  });

  return [...nodes, ...edges];
}

function renderDetail(detailEl, node, nodeData) {
  detailEl.textContent = '';
  detailEl.style.display = 'block';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px; font-weight:600; margin-bottom:12px; color:var(--text); word-break:break-word;';
  title.textContent = node.data('label');
  detailEl.appendChild(title);

  const color = nodeColor(node.data('type'));
  const typeBadge = document.createElement('span');
  typeBadge.style.cssText = 'display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; margin-bottom:14px; background:' + color + '30; color:' + color + ';';
  typeBadge.textContent = node.data('type') || 'unknown';
  detailEl.appendChild(typeBadge);

  const props = node.data('properties') || {};
  const skip = new Set(['id', 'label', 'name', 'type', 'color', 'size']);
  const keys = Object.keys(props).filter(k => !skip.has(k));

  if (keys.length > 0) {
    const propList = document.createElement('div');
    propList.style.cssText = 'font-size:12px; color:var(--text-muted); border-top:1px solid var(--border); padding-top:10px; margin-bottom:10px;';
    keys.forEach(k => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.04);';
      const kEl = document.createElement('span');
      kEl.style.color = 'var(--text-muted)';
      kEl.textContent = k;
      const vEl = document.createElement('span');
      vEl.style.cssText = 'color:var(--text); font-family:monospace; font-size:11px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      const val = props[k];
      vEl.textContent = val === null || val === undefined ? '—' : String(val);
      row.appendChild(kEl);
      row.appendChild(vEl);
      propList.appendChild(row);
    });
    detailEl.appendChild(propList);
  }

  // Connections section
  const connSection = document.createElement('div');
  connSection.style.cssText = 'font-size:12px; color:var(--text-muted); border-top:1px solid var(--border); padding-top:10px;';
  const connTitle = document.createElement('div');
  connTitle.style.cssText = 'font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; color:var(--text-muted);';
  connTitle.textContent = 'Connections';
  connSection.appendChild(connTitle);
  detailEl.appendChild(connSection);

  if (nodeData) {
    const conns = nodeData.connections || [];
    if (conns.length === 0) {
      const none = document.createElement('div');
      none.style.color = 'var(--text-muted)';
      none.textContent = 'No connections';
      connSection.appendChild(none);
    } else {
      conns.slice(0, 8).forEach(c => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:3px 0; display:flex; align-items:center; gap:6px;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width:6px; height:6px; border-radius:50%; background:' + nodeColor(c.type) + '; flex-shrink:0;';
        const label = document.createElement('span');
        label.style.cssText = 'font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        label.textContent = c.label || c.name || String(c.id || '');
        item.appendChild(dot);
        item.appendChild(label);
        connSection.appendChild(item);
      });
      if (conns.length > 8) {
        const more = document.createElement('div');
        more.style.cssText = 'font-size:11px; color:var(--text-muted); margin-top:4px;';
        more.textContent = '+' + (conns.length - 8) + ' more';
        connSection.appendChild(more);
      }
    }
  } else {
    const loading = document.createElement('span');
    loading.className = 'spinner';
    connSection.appendChild(loading);
  }
}

function renderGraphExplorer(el) {
  // Controls bar
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap;';

  const typeFilter = document.createElement('select');
  typeFilter.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px;';
  [['', 'All'], ['tool', 'Tools'], ['component', 'Components'], ['pattern', 'Patterns'], ['instinct', 'Instincts']].forEach(([val, label]) => {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    typeFilter.appendChild(o);
  });

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search nodes\u2026';
  searchInput.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; flex:1; min-width:160px;';

  const statsWrap = document.createElement('div');
  statsWrap.style.cssText = 'display:flex; gap:8px; margin-left:auto;';

  const nodesBadge = document.createElement('span');
  nodesBadge.style.cssText = 'padding:3px 10px; border-radius:999px; font-size:12px; background:rgba(108,92,231,0.15); color:var(--accent);';
  nodesBadge.textContent = '0 nodes';

  const edgesBadge = document.createElement('span');
  edgesBadge.style.cssText = 'padding:3px 10px; border-radius:999px; font-size:12px; background:rgba(99,110,114,0.15); color:var(--text-muted);';
  edgesBadge.textContent = '0 edges';

  statsWrap.appendChild(nodesBadge);
  statsWrap.appendChild(edgesBadge);
  controls.appendChild(typeFilter);
  controls.appendChild(searchInput);
  controls.appendChild(statsWrap);
  el.appendChild(controls);

  // Graph + detail panel layout
  const graphLayout = document.createElement('div');
  graphLayout.style.cssText = 'display:flex; gap:16px; align-items:flex-start;';

  const cyWrap = document.createElement('div');
  cyWrap.style.cssText = 'flex:1; min-width:0;';

  const cyContainer = document.createElement('div');
  cyContainer.id = 'cy-container';
  cyContainer.style.cssText = 'width:100%; height:500px; background:var(--surface); border:1px solid var(--border); border-radius:10px; position:relative;';
  cyWrap.appendChild(cyContainer);
  graphLayout.appendChild(cyWrap);

  const detailPanel = document.createElement('div');
  detailPanel.style.cssText = 'width:220px; flex-shrink:0; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; display:none; max-height:500px; overflow-y:auto;';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.style.cssText = 'float:right; padding:2px 8px; font-size:16px; line-height:1; margin-bottom:8px;';
  closeBtn.addEventListener('click', () => {
    detailPanel.style.display = 'none';
    if (cyInstance) cyInstance.elements().removeClass('dimmed');
  });
  detailPanel.appendChild(closeBtn);
  graphLayout.appendChild(detailPanel);
  el.appendChild(graphLayout);

  // Loading indicator inside cy container
  const loadingEl = document.createElement('div');
  loadingEl.className = 'empty-state';
  loadingEl.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  loadingEl.appendChild(sp);
  cyContainer.appendChild(loadingEl);

  function applyFilters() {
    if (!cyInstance) return;
    const typeVal = typeFilter.value;
    const searchVal = searchInput.value.trim().toLowerCase();

    cyInstance.batch(() => {
      cyInstance.nodes().forEach(n => {
        const matchType = !typeVal || n.data('type') === typeVal;
        const matchSearch = !searchVal || (n.data('label') || '').toLowerCase().includes(searchVal);
        const visible = matchType && matchSearch;
        n.style('opacity', visible ? 1 : 0.08);
        if (visible) n.removeClass('dimmed');
        else n.addClass('dimmed');
      });
      cyInstance.edges().forEach(e => {
        const srcDimmed = e.source().hasClass('dimmed');
        const tgtDimmed = e.target().hasClass('dimmed');
        e.style('opacity', (!srcDimmed && !tgtDimmed) ? 1 : 0.05);
      });
    });

    const visibleNodes = cyInstance.nodes().filter(n => !n.hasClass('dimmed'));
    const visibleEdges = cyInstance.edges().filter(e => !e.hasClass('dimmed'));
    nodesBadge.textContent = visibleNodes.length + ' nodes';
    edgesBadge.textContent = visibleEdges.length + ' edges';
  }

  typeFilter.addEventListener('change', applyFilters);
  searchInput.addEventListener('input', debounce(applyFilters, 250));

  get('/knowledge/graph').then(graphData => {
    cyContainer.removeChild(loadingEl);

    if (!graphData || (!(graphData.nodes || []).length && !(graphData.edges || []).length)) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);';
      empty.textContent = 'No graph data available. Run sync first.';
      cyContainer.appendChild(empty);
      return;
    }

    const elements = buildElements(graphData);
    nodesBadge.textContent = (graphData.nodes || []).length + ' nodes';
    edgesBadge.textContent = (graphData.edges || []).length + ' edges';

    // cytoscape is a CDN global
    cyInstance = cytoscape({
      container: cyContainer,
      elements,
      style: buildCytoscapeStyles(),
      layout: {
        name: 'cose',
        animate: false,
        randomize: true,
        nodeRepulsion: 400000,
        idealEdgeLength: 80,
        edgeElasticity: 100,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1,
      },
    });

    cyInstance.on('tap', 'node', function(evt) {
      const node = evt.target;
      cyInstance.elements().addClass('dimmed');
      node.removeClass('dimmed');
      node.neighborhood().removeClass('dimmed');

      renderDetail(detailPanel, node, null);
      detailPanel.style.display = 'block';

      get('/knowledge/node/' + encodeURIComponent(node.id())).then(nodeData => {
        renderDetail(detailPanel, node, nodeData);
      }).catch(() => {
        renderDetail(detailPanel, node, { connections: [] });
      });
    });

    cyInstance.on('tap', function(evt) {
      if (evt.target === cyInstance) {
        detailPanel.style.display = 'none';
        cyInstance.elements().removeClass('dimmed');
        applyFilters();
      }
    });

  }).catch(err => {
    loadingEl.textContent = 'Failed to load graph: ' + err.message;
    loadingEl.style.color = 'var(--danger)';
  });
}

// ── Tab 2: Projects & Sync ────────────────────────────────────────────────────

function buildTh(text, align) {
  const th = document.createElement('th');
  th.textContent = text;
  if (align) th.style.textAlign = align;
  return th;
}

function renderProjectsSync(el) {
  const summaryGrid = document.createElement('div');
  summaryGrid.className = 'stat-grid';
  summaryGrid.style.marginBottom = '24px';

  const summaryLoading = document.createElement('div');
  summaryLoading.className = 'empty-state';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  summaryLoading.appendChild(sp);
  el.appendChild(summaryLoading);

  const tableCard = document.createElement('div');
  tableCard.className = 'card';
  tableCard.style.display = 'none';

  const tableTitle = document.createElement('div');
  tableTitle.className = 'card-title';
  tableTitle.textContent = 'Projects';
  tableCard.appendChild(tableTitle);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'sessions-table-wrap';
  tableCard.appendChild(tableWrap);
  el.appendChild(tableCard);

  function loadStatus() {
    get('/knowledge/status').then(status => {
      el.removeChild(summaryLoading);

      const statsData = [
        { label: 'Projects', value: (status.projects || []).length },
        { label: 'Nodes', value: status.node_count || 0 },
        { label: 'Edges', value: status.edge_count || 0 },
        { label: 'Last Sync', value: status.last_sync_at ? timeAgo(status.last_sync_at) : 'Never' },
      ];
      statsData.forEach(c => {
        const card = document.createElement('div');
        card.className = 'stat-card';
        const lbl = document.createElement('div');
        lbl.className = 'stat-label';
        lbl.textContent = c.label;
        const val = document.createElement('div');
        val.className = 'stat-value';
        val.style.fontSize = '22px';
        val.textContent = String(c.value);
        card.appendChild(lbl);
        card.appendChild(val);
        summaryGrid.appendChild(card);
      });
      el.insertBefore(summaryGrid, tableCard);

      const projects = status.projects || [];
      if (projects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No projects found. Run sync to discover projects.';
        tableWrap.appendChild(empty);
      } else {
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.appendChild(buildTh('Project', null));
        headerRow.appendChild(buildTh('Nodes', 'center'));
        headerRow.appendChild(buildTh('Vault Files', 'center'));
        headerRow.appendChild(buildTh('Sessions', 'center'));
        headerRow.appendChild(buildTh('', null));
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        projects.forEach(proj => {
          const tr = document.createElement('tr');
          tr.style.cursor = 'default';

          const tdName = document.createElement('td');
          tdName.style.fontWeight = '600';
          tdName.textContent = proj.name || proj.project_id || '—';

          const tdNodes = document.createElement('td');
          tdNodes.style.textAlign = 'center';
          tdNodes.textContent = String(proj.node_count || 0);

          const tdVault = document.createElement('td');
          tdVault.style.textAlign = 'center';
          tdVault.textContent = String(proj.vault_file_count || 0);

          const tdSessions = document.createElement('td');
          tdSessions.style.textAlign = 'center';
          tdSessions.textContent = String(proj.session_count || 0);

          const tdActions = document.createElement('td');
          tdActions.style.cssText = 'text-align:right; white-space:nowrap;';

          const syncBtn = document.createElement('button');
          syncBtn.className = 'btn btn-primary';
          syncBtn.style.cssText = 'margin-right:6px; padding:4px 12px; font-size:12px;';
          syncBtn.textContent = 'Sync';

          const enrichBtn = document.createElement('button');
          enrichBtn.className = 'btn';
          enrichBtn.style.cssText = 'padding:4px 12px; font-size:12px;';
          enrichBtn.textContent = 'Enrich';

          const projectId = proj.project_id || proj.name;

          syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Syncing\u2026';
            post('/knowledge/sync', {}).then(() => {
              return post('/knowledge/generate?project=' + encodeURIComponent(projectId), {});
            }).then(() => {
              syncBtn.textContent = 'Done';
              setTimeout(() => {
                syncBtn.disabled = false;
                syncBtn.textContent = 'Sync';
              }, 2000);
            }).catch(err => {
              syncBtn.disabled = false;
              syncBtn.textContent = 'Sync';
              alert('Sync failed: ' + err.message);
            });
          });

          enrichBtn.addEventListener('click', () => {
            enrichBtn.disabled = true;
            enrichBtn.textContent = 'Enriching\u2026';
            post('/knowledge/enrich?project=' + encodeURIComponent(projectId), {}).then(() => {
              enrichBtn.textContent = 'Done';
              setTimeout(() => {
                enrichBtn.disabled = false;
                enrichBtn.textContent = 'Enrich';
              }, 2000);
            }).catch(err => {
              enrichBtn.disabled = false;
              enrichBtn.textContent = 'Enrich';
              alert('Enrich failed: ' + err.message);
            });
          });

          tdActions.appendChild(syncBtn);
          tdActions.appendChild(enrichBtn);
          tr.appendChild(tdName);
          tr.appendChild(tdNodes);
          tr.appendChild(tdVault);
          tr.appendChild(tdSessions);
          tr.appendChild(tdActions);
          tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableWrap.appendChild(table);
      }

      tableCard.style.display = 'block';
    }).catch(err => {
      summaryLoading.textContent = 'Failed to load status: ' + err.message;
      summaryLoading.style.color = 'var(--danger)';
    });
  }

  loadStatus();
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

const TABS = [
  { key: 'graph', label: 'Graph Explorer' },
  { key: 'projects', label: 'Projects & Sync' },
];
let activeTab = 'graph';

export function mount(el) {
  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';

  const content = document.createElement('div');

  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (tab.key === activeTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.dataset.tab = tab.key;
    btn.addEventListener('click', () => {
      activeTab = tab.key;
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab.key));
      loadTab(tab.key);
    });
    tabsEl.appendChild(btn);
  });

  el.appendChild(tabsEl);
  el.appendChild(content);

  function loadTab(tab) {
    content.textContent = '';
    if (tab === 'graph') renderGraphExplorer(content);
    else if (tab === 'projects') renderProjectsSync(content);
  }

  loadTab(activeTab);
}

export function unmount() {
  if (cyInstance) {
    cyInstance.destroy();
    cyInstance = null;
  }
}
