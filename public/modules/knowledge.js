import { get, post, put, del } from './api.js';
import { escHtml, debounce } from './utils.js';

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

// ── Node colors ───────────────────────────────────────────────────────────────

const NODE_COLORS = {
  tool:      '#00b894',
  component: '#6c5ce7',
  pattern:   '#e17055',
  instinct:  '#00cec9',
  session:   '#636e72',
  project:   '#fdcb6e',
  note:      '#74b9ff',
};

function nodeColor(type) {
  return NODE_COLORS[type] || '#8b8fa3';
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
    Promise.all([get('/knowledge/status'), get('/knowledge/projects')]).then(([status, projects]) => {
      el.removeChild(summaryLoading);

      const statsData = [
        { label: 'Projects', value: (projects || []).length },
        { label: 'Nodes', value: status.nodeCount || 0 },
        { label: 'Edges', value: status.edgeCount || 0 },
        { label: 'Last Sync', value: status.lastSync ? timeAgo(status.lastSync) : 'Never' },
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

      const projects2 = projects || [];
      if (projects2.length === 0) {
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
        projects2.forEach(proj => {
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

// ── Tab 3: Notes ─────────────────────────────────────────────────────────────

function renderMarkdown(md) {
  // All user content is HTML-escaped first to prevent XSS (local-only tool)
  let html = escHtml(md);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:var(--bg);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;"><code>$2</code></pre>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:16px;margin:16px 0 8px;">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:20px;margin:16px 0 8px;">$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:12px;">$1</code>');
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, ref) => {
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.ref = escHtml(ref);
    a.className = 'note-backlink';
    a.style.cssText = 'color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);';
    a.textContent = '[[' + ref + ']]';
    return a.outerHTML;
  });
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  return html;
}

let notesState = { project: '', search: '', page: 1, perPage: 15 };

function renderNotesList(el) {
  el.textContent = '';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap;';

  const projectSelect = document.createElement('select');
  projectSelect.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px;';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All Projects';
  projectSelect.appendChild(allOpt);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search notes\u2026';
  searchInput.value = notesState.search;
  searchInput.style.cssText = 'padding:6px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; flex:1; min-width:160px;';

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-primary';
  newBtn.textContent = '+ New Note';
  newBtn.style.cssText = 'margin-left:auto; padding:6px 16px; font-size:13px;';
  newBtn.addEventListener('click', () => { location.hash = '#knowledge/notes/new'; });

  header.appendChild(projectSelect);
  header.appendChild(searchInput);
  header.appendChild(newBtn);
  el.appendChild(header);

  const listEl = document.createElement('div');
  el.appendChild(listEl);

  const paginationEl = document.createElement('div');
  paginationEl.className = 'pagination';
  el.appendChild(paginationEl);

  get('/knowledge/projects').then(projects => {
    (projects || []).forEach(p => {
      const o = document.createElement('option');
      o.value = p.project_id;
      o.textContent = p.name || p.project_id;
      projectSelect.appendChild(o);
    });
    if (notesState.project) projectSelect.value = notesState.project;
  });

  function loadList() {
    listEl.textContent = '';
    const qs = new URLSearchParams();
    if (notesState.project) qs.set('project', notesState.project);
    if (notesState.search) qs.set('search', notesState.search);
    qs.set('page', notesState.page);
    qs.set('per_page', notesState.perPage);

    const loading = document.createElement('div');
    loading.className = 'empty-state';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    loading.appendChild(sp);
    listEl.appendChild(loading);

    get('/knowledge/notes?' + qs.toString()).then(data => {
      listEl.textContent = '';
      if (data.items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = notesState.search ? 'No notes match your search.' : 'No notes yet. Create your first note!';
        listEl.appendChild(empty);
        paginationEl.textContent = '';
        return;
      }

      data.items.forEach(note => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'margin-bottom:10px; cursor:pointer; transition:border-color 0.15s;';
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = ''; });
        card.addEventListener('click', () => { location.hash = '#knowledge/notes/' + note.id; });

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size:14px; font-weight:600; color:var(--text);';
        titleEl.textContent = note.title;
        titleRow.appendChild(titleEl);

        const tags = typeof note.tags === 'string' ? JSON.parse(note.tags) : (note.tags || []);
        tags.forEach(t => {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.style.cssText = 'font-size:10px; padding:1px 8px;';
          badge.textContent = t;
          titleRow.appendChild(badge);
        });
        card.appendChild(titleRow);

        const excerpt = document.createElement('div');
        excerpt.style.cssText = 'font-size:12px; color:var(--text-muted); line-height:1.5; overflow:hidden; max-height:36px;';
        excerpt.textContent = note.body.replace(/[#*\[\]`]/g, '').slice(0, 120);
        card.appendChild(excerpt);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px; color:var(--text-muted); margin-top:6px;';
        meta.textContent = timeAgo(note.updated_at);
        card.appendChild(meta);

        listEl.appendChild(card);
      });

      paginationEl.textContent = '';
      const totalPages = Math.ceil(data.total / data.perPage);
      if (totalPages > 1) {
        const prev = document.createElement('button');
        prev.className = 'btn';
        prev.textContent = '\u2190 Prev';
        prev.disabled = notesState.page <= 1;
        prev.addEventListener('click', () => { notesState.page--; loadList(); });

        const info = document.createElement('span');
        info.className = 'page-info';
        info.textContent = 'Page ' + notesState.page + ' of ' + totalPages;

        const next = document.createElement('button');
        next.className = 'btn';
        next.textContent = 'Next \u2192';
        next.disabled = notesState.page >= totalPages;
        next.addEventListener('click', () => { notesState.page++; loadList(); });

        paginationEl.appendChild(prev);
        paginationEl.appendChild(info);
        paginationEl.appendChild(next);
      }
    });
  }

  projectSelect.addEventListener('change', () => { notesState.project = projectSelect.value; notesState.page = 1; loadList(); });
  searchInput.addEventListener('input', debounce(() => { notesState.search = searchInput.value; notesState.page = 1; loadList(); }, 300));

  loadList();
}

// ── Note Editor ──────────────────────────────────────────────────────────────

function renderNoteEditor(el, noteId) {
  el.textContent = '';
  const isNew = noteId === 'new';

  const breadcrumb = document.createElement('div');
  breadcrumb.style.cssText = 'margin-bottom:16px; font-size:13px; color:var(--text-muted);';
  const bcLink = document.createElement('a');
  bcLink.href = '#knowledge/notes';
  bcLink.style.cssText = 'color:var(--accent);text-decoration:none;';
  bcLink.textContent = 'Notes';
  breadcrumb.appendChild(bcLink);
  breadcrumb.appendChild(document.createTextNode(' / ' + (isNew ? 'New Note' : 'Edit')));
  el.appendChild(breadcrumb);

  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex; gap:16px; align-items:flex-start;';
  const editorCol = document.createElement('div');
  editorCol.style.cssText = 'flex:1; min-width:0;';
  const previewCol = document.createElement('div');
  previewCol.style.cssText = 'flex:1; min-width:0;';
  layout.appendChild(editorCol);
  layout.appendChild(previewCol);
  el.appendChild(layout);

  // Project selector (new note only)
  const projectSelect = document.createElement('select');
  projectSelect.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; margin-bottom:12px;';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Note title';
  titleInput.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:15px; font-weight:600; box-sizing:border-box; margin-bottom:12px;';

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.placeholder = 'Tags: api, architecture, deployment';
  tagsInput.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; box-sizing:border-box; margin-bottom:12px;';

  const bodyWrap = document.createElement('div');
  bodyWrap.style.cssText = 'position:relative; margin-bottom:12px;';
  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.placeholder = 'Write in Markdown... Use [[slug]] to link.';
  bodyTextarea.style.cssText = 'width:100%; min-height:400px; padding:12px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; font-family:"SF Mono",Monaco,Consolas,monospace; line-height:1.6; resize:vertical; box-sizing:border-box;';

  const acDropdown = document.createElement('div');
  acDropdown.style.cssText = 'position:absolute; background:var(--surface); border:1px solid var(--border); border-radius:6px; max-height:200px; overflow-y:auto; z-index:100; display:none; min-width:240px; box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  bodyWrap.appendChild(bodyTextarea);
  bodyWrap.appendChild(acDropdown);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex; gap:8px;';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = isNew ? 'Create Note' : 'Save Changes';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.style.display = isNew ? 'none' : '';
  actionsRow.appendChild(saveBtn);
  actionsRow.appendChild(deleteBtn);

  if (isNew) editorCol.appendChild(projectSelect);
  editorCol.appendChild(titleInput);
  editorCol.appendChild(tagsInput);
  editorCol.appendChild(bodyWrap);
  editorCol.appendChild(actionsRow);

  // Preview
  const previewCard = document.createElement('div');
  previewCard.className = 'card';
  previewCard.style.cssText = 'max-height:500px; overflow-y:auto;';
  const previewTitle = document.createElement('div');
  previewTitle.className = 'card-title';
  previewTitle.textContent = 'Preview';
  const previewBody = document.createElement('div');
  previewBody.style.cssText = 'font-size:13px; line-height:1.7; color:var(--text);';
  previewBody.textContent = 'Preview appears here...';
  previewCard.appendChild(previewTitle);
  previewCard.appendChild(previewBody);
  previewCol.appendChild(previewCard);

  // Backlinks
  const backlinksCard = document.createElement('div');
  backlinksCard.className = 'card';
  backlinksCard.style.cssText = 'margin-top:12px;';
  const backlinksTitle = document.createElement('div');
  backlinksTitle.className = 'card-title';
  backlinksTitle.textContent = 'What links here';
  const backlinksList = document.createElement('div');
  backlinksList.style.cssText = 'font-size:12px;';
  backlinksCard.appendChild(backlinksTitle);
  backlinksCard.appendChild(backlinksList);
  previewCol.appendChild(backlinksCard);

  function updatePreview() {
    const md = bodyTextarea.value;
    if (md) {
      // Content is HTML-escaped inside renderMarkdown before any transformation
      previewBody.innerHTML = renderMarkdown(md);
    } else {
      previewBody.textContent = 'Preview appears here...';
    }
  }
  bodyTextarea.addEventListener('input', debounce(updatePreview, 200));

  // Autocomplete for [[
  let acActive = false;
  let noteData = null;

  bodyTextarea.addEventListener('input', () => {
    const val = bodyTextarea.value;
    const pos = bodyTextarea.selectionStart;
    const before = val.slice(0, pos);
    const match = before.match(/\[\[([^\]]*?)$/);

    if (match) {
      const query = match[1];
      const projectId = isNew ? projectSelect.value : (noteData && noteData.project_id);
      if (!projectId) { acDropdown.style.display = 'none'; return; }

      get('/knowledge/autocomplete?project=' + encodeURIComponent(projectId) + '&q=' + encodeURIComponent(query)).then(results => {
        acDropdown.textContent = '';
        if (results.length === 0) { acDropdown.style.display = 'none'; return; }
        results.slice(0, 12).forEach(r => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 12px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:6px;';
          item.addEventListener('mouseenter', () => { item.style.background = 'rgba(108,92,231,0.1)'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });

          const dot = document.createElement('span');
          dot.style.cssText = 'width:6px; height:6px; border-radius:50%; flex-shrink:0; background:' + nodeColor(r.type) + ';';
          const label = document.createElement('span');
          label.textContent = r.label;
          const typeTag = document.createElement('span');
          typeTag.style.cssText = 'font-size:10px; color:var(--text-muted); margin-left:auto;';
          typeTag.textContent = r.type;
          item.appendChild(dot);
          item.appendChild(label);
          item.appendChild(typeTag);

          item.addEventListener('click', () => {
            const insertVal = r.value + ']]';
            bodyTextarea.value = before.slice(0, before.length - match[1].length) + insertVal + val.slice(pos);
            bodyTextarea.focus();
            const newPos = before.length - match[1].length + insertVal.length;
            bodyTextarea.setSelectionRange(newPos, newPos);
            acDropdown.style.display = 'none';
            acActive = false;
            updatePreview();
          });
          acDropdown.appendChild(item);
        });
        acDropdown.style.display = 'block';
        acDropdown.style.top = (bodyTextarea.offsetHeight + 4) + 'px';
        acDropdown.style.left = '0px';
        acActive = true;
      });
    } else {
      acDropdown.style.display = 'none';
      acActive = false;
    }
  });

  bodyTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && acActive) { acDropdown.style.display = 'none'; acActive = false; e.preventDefault(); }
  });

  // Load data
  if (isNew) {
    get('/knowledge/projects').then(projects => {
      (projects || []).forEach(p => {
        const o = document.createElement('option');
        o.value = p.project_id;
        o.textContent = p.name || p.project_id;
        projectSelect.appendChild(o);
      });
    });
  } else {
    get('/knowledge/notes/' + noteId).then(data => {
      noteData = data;
      if (data.error) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'empty-state';
        err.textContent = 'Note not found.';
        el.appendChild(err);
        return;
      }
      titleInput.value = data.title;
      const tags = typeof data.tags === 'string' ? JSON.parse(data.tags) : (data.tags || []);
      tagsInput.value = tags.join(', ');
      bodyTextarea.value = data.body;
      breadcrumb.lastChild.textContent = ' / ' + data.title;
      updatePreview();

      (data.backlinks || []).forEach(bl => {
        const link = document.createElement('a');
        link.href = '#knowledge/notes/' + bl.id;
        link.style.cssText = 'display:block; padding:4px 0; color:var(--accent); text-decoration:none;';
        link.textContent = bl.title;
        backlinksList.appendChild(link);
      });
      if ((data.backlinks || []).length === 0) {
        backlinksList.textContent = 'No backlinks yet.';
        backlinksList.style.color = 'var(--text-muted)';
      }
    });
  }

  // Save
  saveBtn.addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) { alert('Title is required'); return; }
    const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
    const body = bodyTextarea.value;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';

    if (isNew) {
      const project_id = projectSelect.value;
      if (!project_id) { alert('Select a project'); saveBtn.disabled = false; saveBtn.textContent = 'Create Note'; return; }
      post('/knowledge/notes', { project_id, title, body, tags }).then(created => {
        location.hash = '#knowledge/notes/' + created.id;
      }).catch(err => { alert('Error: ' + err.message); saveBtn.disabled = false; saveBtn.textContent = 'Create Note'; });
    } else {
      put('/knowledge/notes/' + noteId, { title, body, tags }).then(() => {
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }, 1500);
      }).catch(err => { alert('Error: ' + err.message); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; });
    }
  });

  deleteBtn.addEventListener('click', () => {
    if (!confirm('Delete this note permanently?')) return;
    del('/knowledge/notes/' + noteId).then(() => { location.hash = '#knowledge/notes'; }).catch(err => alert('Error: ' + err.message));
  });
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

const TABS = [
  { key: 'notes', label: 'Notes' },
  { key: 'projects', label: 'Projects & Sync' },
];
let activeTab = 'notes';

export function mount(el, { params } = {}) {
  let subRoute = null;
  if (params) {
    const parts = params.split('/').filter(Boolean);
    if (parts[0] === 'notes' && parts.length >= 2) {
      subRoute = parts.slice(1).join('/');
      activeTab = 'notes';
    } else if (parts[0] === 'projects') {
      activeTab = 'projects';
    } else if (parts[0] === 'notes') {
      activeTab = 'notes';
    }
  }

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
      location.hash = '#knowledge/' + tab.key;
    });
    tabsEl.appendChild(btn);
  });

  el.appendChild(tabsEl);
  el.appendChild(content);

  function loadTab(tab) {
    content.textContent = '';
    if (tab === 'notes') {
      if (subRoute) renderNoteEditor(content, subRoute);
      else renderNotesList(content);
    }
    else if (tab === 'projects') renderProjectsSync(content);
  }

  loadTab(activeTab);
}

export function unmount() {
}
