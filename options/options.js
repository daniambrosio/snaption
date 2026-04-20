const msg = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const $ = (id) => document.getElementById(id);

// Field slots map to compatible Notion property types
const COMPATIBLE_TYPES = {
  title:       ['title'],
  url:         ['url', 'rich_text'],
  description: ['rich_text'],
  tags:        ['multi_select', 'select'],
};

// Tokens for: which slots MUST have a property picked to save a template
const REQUIRED_SLOTS = ['title', 'url'];

let state = {
  databases: [],
  templates: [],
  defaultTemplateId: null,
  editing: null,            // template object being edited (null = closed)
  currentSchema: null,      // schema of the database currently chosen in editor
};

async function init() {
  const authStatus = await msg('GET_AUTH_STATUS');
  renderAuthSection(authStatus);

  if (authStatus.authenticated) {
    await loadStorage();
    await ensureDatabasesLoaded();
    renderTemplates();
    $('section-templates').classList.remove('hidden');
  }
}

async function loadStorage() {
  const stored = await chrome.storage.sync.get(['databases', 'templates', 'defaultTemplateId']);
  state.databases = stored.databases || [];
  state.templates = stored.templates || [];
  state.defaultTemplateId = stored.defaultTemplateId || null;
}

async function ensureDatabasesLoaded() {
  if (state.databases.length) return;
  const res = await msg('GET_DATABASES');
  if (res.error) { console.error(res.error); return; }
  state.databases = res;
  await chrome.storage.sync.set({ databases: state.databases });
}

// ─── Auth UI ────────────────────────────────────────────────────────────────
function renderAuthSection(authStatus) {
  if (authStatus.authenticated) {
    $('auth-connected').classList.remove('hidden');
    $('auth-disconnected').classList.add('hidden');
    $('auth-workspace').textContent = authStatus.workspace || '';
  } else {
    $('auth-connected').classList.add('hidden');
    $('auth-disconnected').classList.remove('hidden');
  }
}

// ─── Template list ──────────────────────────────────────────────────────────
function renderTemplates() {
  const list = $('templates-list');
  const empty = $('templates-empty');

  if (!state.templates.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = state.templates.map(tpl => `
    <div class="template-item ${tpl.id === state.defaultTemplateId ? 'is-default' : ''}" data-id="${tpl.id}">
      <div class="template-main">
        <div class="template-name">
          ${escapeHtml(tpl.name)}
          ${tpl.id === state.defaultTemplateId ? '<span class="badge badge-muted">Default</span>' : ''}
        </div>
        <div class="template-meta">
          → ${escapeHtml(tpl.databaseTitle || 'Unknown database')}
          ${tpl.includeScreenshot ? ' · 📸 screenshot' : ''}
        </div>
      </div>
      <div class="template-actions">
        ${tpl.id !== state.defaultTemplateId
          ? `<button class="link-btn" data-action="default" data-id="${tpl.id}">Set default</button>`
          : ''}
        <button class="link-btn" data-action="edit" data-id="${tpl.id}">Edit</button>
        <button class="link-btn danger" data-action="delete" data-id="${tpl.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

// ─── Template editor ────────────────────────────────────────────────────────
function openEditor(template = null) {
  state.editing = template
    ? structuredClone(template)
    : { id: crypto.randomUUID(), name: '', databaseId: '', mapping: {}, includeScreenshot: true };

  $('editor-title').textContent = template ? 'Edit template' : 'New template';
  $('tpl-name').value = state.editing.name;
  $('map-screenshot').checked = state.editing.includeScreenshot !== false;
  renderDatabaseSelect();
  hideEditorError();

  if (state.editing.databaseId) {
    $('tpl-db').value = state.editing.databaseId;
    loadSchemaAndRenderMapping(state.editing.databaseId);
  } else {
    $('mapping-section').classList.add('hidden');
  }

  $('template-editor').classList.remove('hidden');
}

function closeEditor() {
  state.editing = null;
  state.currentSchema = null;
  $('template-editor').classList.add('hidden');
}

function renderDatabaseSelect() {
  const select = $('tpl-db');
  select.innerHTML = '<option value="">— Select a database —</option>' +
    state.databases.map(db =>
      `<option value="${db.id}">${db.icon ? db.icon + ' ' : ''}${escapeHtml(db.title)}</option>`
    ).join('');
}

async function loadSchemaAndRenderMapping(databaseId) {
  if (!databaseId) {
    $('mapping-section').classList.add('hidden');
    return;
  }

  const res = await msg('GET_DB_SCHEMA', { databaseId });
  if (res.error) { showEditorError(res.error); return; }

  state.currentSchema = res;
  state.editing.databaseTitle = res.title;
  renderMappingDropdowns(res.properties, state.editing.mapping);
  $('mapping-section').classList.remove('hidden');
}

function renderMappingDropdowns(properties, currentMapping) {
  for (const slot of ['title', 'url', 'description', 'tags']) {
    const select = $(`map-${slot}`);
    const row = select.closest('tr');
    const compatible = properties.filter(p => COMPATIBLE_TYPES[slot].includes(p.type));
    const required = REQUIRED_SLOTS.includes(slot);

    // Hide optional rows that have no compatible property in this DB
    if (!required && compatible.length === 0) {
      row.classList.add('hidden');
      select.innerHTML = '';
      continue;
    }
    row.classList.remove('hidden');

    // Required rows with no compatible property: show a disabled explanatory option
    if (required && compatible.length === 0) {
      select.innerHTML = `<option value="">— no ${COMPATIBLE_TYPES[slot].join(' or ')} property in this database —</option>`;
      select.disabled = true;
      continue;
    }
    select.disabled = false;

    select.innerHTML =
      (required ? '' : '<option value="">— None —</option>') +
      compatible.map(p =>
        `<option value="${escapeHtml(p.name)}" data-type="${p.type}">${escapeHtml(p.name)} (${p.type})</option>`
      ).join('');

    const saved = currentMapping[slot];
    if (saved && compatible.some(p => p.name === saved.name)) {
      select.value = saved.name;
    } else if (slot === 'title' && compatible.length === 1) {
      select.value = compatible[0].name;
    } else if (slot === 'url') {
      const preferred = compatible.find(p => /^url$/i.test(p.name));
      if (preferred) select.value = preferred.name;
    }
  }
}

function readEditorState() {
  const mapping = {};
  for (const slot of ['title', 'url', 'description', 'tags']) {
    const select = $(`map-${slot}`);
    const name = select.value;
    if (!name) continue;
    const opt = select.options[select.selectedIndex];
    mapping[slot] = { name, type: opt.dataset.type };
  }

  return {
    id: state.editing.id,
    name: $('tpl-name').value.trim(),
    databaseId: $('tpl-db').value,
    databaseTitle: state.editing.databaseTitle,
    mapping,
    includeScreenshot: $('map-screenshot').checked,
  };
}

async function saveTemplate() {
  const tpl = readEditorState();

  if (!tpl.name) return showEditorError('Give the template a name.');
  if (!tpl.databaseId) return showEditorError('Pick a database.');
  for (const slot of REQUIRED_SLOTS) {
    if (!tpl.mapping[slot]) return showEditorError(`Pick a property for "${slot}".`);
  }

  // Upsert
  const idx = state.templates.findIndex(t => t.id === tpl.id);
  if (idx >= 0) state.templates[idx] = tpl;
  else state.templates.push(tpl);

  // First template becomes default automatically
  if (!state.defaultTemplateId) state.defaultTemplateId = tpl.id;

  await chrome.storage.sync.set({
    templates: state.templates,
    defaultTemplateId: state.defaultTemplateId,
  });

  closeEditor();
  renderTemplates();
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  state.templates = state.templates.filter(t => t.id !== id);
  if (state.defaultTemplateId === id) {
    state.defaultTemplateId = state.templates[0]?.id || null;
  }
  await chrome.storage.sync.set({
    templates: state.templates,
    defaultTemplateId: state.defaultTemplateId,
  });
  renderTemplates();
}

async function setDefault(id) {
  state.defaultTemplateId = id;
  await chrome.storage.sync.set({ defaultTemplateId: id });
  renderTemplates();
}

function showEditorError(text) {
  const el = $('editor-error');
  el.textContent = text;
  el.classList.remove('hidden');
}
function hideEditorError() { $('editor-error').classList.add('hidden'); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Token flow ──────────────────────────────────────────────────────────────
$('btn-save-token').addEventListener('click', async () => {
  $('token-error').classList.add('hidden');
  const token = $('token-input').value.trim();
  if (!token) return showTokenError('Paste your Notion integration token first.');

  const btn = $('btn-save-token');
  btn.disabled = true; btn.textContent = 'Verifying…';

  const res = await msg('SAVE_TOKEN', { token });
  if (res.error) {
    showTokenError(res.error);
    btn.disabled = false; btn.textContent = 'Connect';
    return;
  }

  $('token-input').value = '';
  init();
});

$('btn-logout').addEventListener('click', async () => {
  if (!confirm('Disconnect? This removes your token, cached databases, and templates.')) return;
  await msg('CLEAR_TOKEN');
  state.templates = [];
  state.databases = [];
  state.defaultTemplateId = null;
  $('section-templates').classList.add('hidden');
  renderAuthSection({ authenticated: false });
});

function showTokenError(text) {
  const el = $('token-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

// ─── Templates event wiring ─────────────────────────────────────────────────
$('btn-new-template').addEventListener('click', () => openEditor());

$('templates-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const template = state.templates.find(t => t.id === id);
  if (btn.dataset.action === 'edit' && template) openEditor(template);
  if (btn.dataset.action === 'delete') deleteTemplate(id);
  if (btn.dataset.action === 'default') setDefault(id);
});

$('btn-close-editor').addEventListener('click', closeEditor);
$('btn-cancel-template').addEventListener('click', closeEditor);
$('btn-save-template').addEventListener('click', saveTemplate);

$('tpl-db').addEventListener('change', async (e) => {
  state.editing.databaseId = e.target.value;
  state.editing.mapping = {}; // reset mapping when database changes
  await loadSchemaAndRenderMapping(e.target.value);
});

$('btn-refresh-dbs').addEventListener('click', async (e) => {
  e.preventDefault();
  const link = e.target;
  const originalText = link.textContent;
  link.textContent = 'Refreshing…';

  const selectedId = $('tpl-db').value;

  if (selectedId) {
    // Refresh the schema of the currently-selected database
    await loadSchemaAndRenderMapping(selectedId);
  } else {
    // Nothing selected → refresh the list of available databases
    await chrome.storage.sync.remove('databases');
    state.databases = [];
    await ensureDatabasesLoaded();
    renderDatabaseSelect();
  }

  link.textContent = originalText;
});

init();
