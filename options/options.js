import { initThemePicker } from '../shared/theme.js';

const msg = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const $ = (id) => document.getElementById(id);

initThemePicker($('theme-picker'));

let state = {
  databases: [],
  templates: [],
  defaultTemplateId: null,
  editing: null,            // template being edited (cloned from state.templates)
  currentSchema: null,      // schema of the database currently chosen in editor
  relationOptionsCache: {}, // relationDbId → [{ id, title }]
};

// ─── Init ───────────────────────────────────────────────────────────────────
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
  // Templates go through service worker (canonical path: migration happens there)
  const { templates, defaultTemplateId } = await msg('LOAD_TEMPLATES');
  state.templates = templates || [];
  state.defaultTemplateId = defaultTemplateId || null;

  const stored = await chrome.storage.sync.get(['databases']);
  state.databases = stored.databases || [];
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

  list.innerHTML = state.templates.map(tpl => {
    const propCount = Object.values(tpl.properties || {}).filter(c => c.mode !== 'skip').length;
    return `
    <div class="template-item ${tpl.id === state.defaultTemplateId ? 'is-default' : ''}" data-id="${tpl.id}">
      <div class="template-main">
        <div class="template-name">
          ${escapeHtml(tpl.name)}
          ${tpl.id === state.defaultTemplateId ? '<span class="badge badge-muted">Default</span>' : ''}
        </div>
        <div class="template-meta">
          → ${escapeHtml(tpl.databaseTitle || 'Unknown database')}
          · ${propCount} prop${propCount === 1 ? '' : 's'} configured
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
  `;
  }).join('');
}

// ─── Template editor ────────────────────────────────────────────────────────
function openEditor(template = null) {
  state.editing = template
    ? structuredClone(template)
    : { id: crypto.randomUUID(), name: '', databaseId: '', properties: {}, includeScreenshot: true };

  $('editor-title').textContent = template ? 'Edit template' : 'New template';
  $('tpl-name').value = state.editing.name;
  $('map-screenshot').checked = state.editing.includeScreenshot !== false;
  renderDatabaseSelect();
  hideEditorError();

  if (state.editing.databaseId) {
    $('tpl-db').value = state.editing.databaseId;
    loadSchemaAndRenderEditor(state.editing.databaseId);
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

async function loadSchemaAndRenderEditor(databaseId) {
  if (!databaseId) {
    $('mapping-section').classList.add('hidden');
    return;
  }

  $('properties-editor').innerHTML = '<div class="loading-small">Loading properties…</div>';
  $('mapping-section').classList.remove('hidden');

  const res = await msg('GET_DB_SCHEMA', { databaseId });
  if (res.error) { showEditorError(res.error); return; }

  console.log(`[Snaption] Schema for "${res.title}":`, res.properties.map(p => `${p.name} (${p.type}${p.readonly ? ', readonly' : ''})`));

  state.currentSchema = res;
  state.editing.databaseTitle = res.title;

  // Populate defaults for any property not yet configured in the template
  for (const prop of res.properties) {
    if (prop.readonly) continue;
    if (!state.editing.properties[prop.name]) {
      state.editing.properties[prop.name] = { mode: defaultModeFor(prop.type) };
      if (state.editing.properties[prop.name].mode === 'auto') {
        state.editing.properties[prop.name].autoField = defaultAutoFieldFor(prop.type);
      }
    }
  }

  renderPropertiesEditor(res.properties, state.editing.properties);
}

// Defaults: title auto-captures page title; all others start as "skip"
function defaultModeFor(type) {
  return type === 'title' ? 'auto' : 'skip';
}

function defaultAutoFieldFor(type) {
  switch (type) {
    case 'title':     return 'title';
    case 'url':       return 'url';
    case 'rich_text': return 'description';
    case 'date':      return 'now';
    default:          return null;
  }
}

function autoOptionFor(type) {
  switch (type) {
    case 'title':     return { field: 'title',       label: 'Auto — page title' };
    case 'url':       return { field: 'url',         label: 'Auto — page URL' };
    case 'rich_text': return { field: 'description', label: 'Auto — page description' };
    case 'date':      return { field: 'now',         label: 'Auto — today' };
    default:          return null;
  }
}

function typeIcon(type) {
  const map = {
    title: 'T', rich_text: '¶', url: '🔗', email: '✉', phone_number: '☎',
    number: '#', checkbox: '☐', date: '📅', select: '◉', multi_select: '⦿',
    status: '◐', relation: '⇄', people: '👥', files: '📎',
  };
  return map[type] || '•';
}

function renderPropertiesEditor(schemaProps, config) {
  const container = $('properties-editor');
  const visible = schemaProps.filter(p => !p.readonly);
  const hiddenCount = schemaProps.length - visible.length;

  if (!visible.length) {
    container.innerHTML = '<p class="hint">This database has no writable properties.</p>';
    return;
  }

  const countLabel = `<div class="property-count">Loaded ${schemaProps.length} propert${schemaProps.length === 1 ? 'y' : 'ies'} from this database${hiddenCount ? ` (${hiddenCount} read-only hidden)` : ''}.</div>`;

  container.innerHTML = countLabel + visible.map(prop =>
    renderPropertyRow(prop, config[prop.name] || { mode: defaultModeFor(prop.type) })
  ).join('');

  // Wire up events for each row
  container.querySelectorAll('.property-row').forEach(row => {
    const name = row.dataset.name;
    const sourceSelect = row.querySelector('.source-select');

    sourceSelect.addEventListener('change', () => onSourceChange(name));

    // If this is a relation with mode 'fixed', lazy-load its options
    const prop = visible.find(p => p.name === name);
    const currentMode = config[name]?.mode;
    if (prop.type === 'relation' && currentMode === 'fixed') {
      hydrateRelationOptions(row, prop);
    }

    wireValueEditor(row, prop);
  });
}

function renderPropertyRow(prop, config) {
  const autoOpt = autoOptionFor(prop.type);
  const mode = config.mode || 'skip';
  const typeLabel = prop.type === 'relation' ? 'relation' : prop.type;

  return `
    <div class="property-row" data-name="${escapeHtml(prop.name)}" data-type="${prop.type}">
      <div class="property-header">
        <span class="property-icon" title="${prop.type}">${typeIcon(prop.type)}</span>
        <span class="property-name">${escapeHtml(prop.name)}</span>
        <span class="property-type-label">${typeLabel}</span>
      </div>
      <div class="property-controls">
        <select class="source-select">
          <option value="skip" ${mode === 'skip' ? 'selected' : ''}>Leave empty</option>
          ${autoOpt ? `<option value="auto" ${mode === 'auto' ? 'selected' : ''}>${autoOpt.label}</option>` : ''}
          <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixed value</option>
        </select>
        <div class="value-editor ${mode === 'fixed' ? '' : 'hidden'}">
          ${renderValueEditor(prop, config)}
        </div>
      </div>
    </div>
  `;
}

function renderValueEditor(prop, config) {
  const v = config.value;

  switch (prop.type) {
    case 'select':
    case 'status':
      return `<select class="fixed-value">
        <option value="">— Pick one —</option>
        ${(prop.options || []).map(o =>
          `<option value="${escapeHtml(o.name)}" ${o.name === v ? 'selected' : ''}>${escapeHtml(o.name)}</option>`
        ).join('')}
      </select>`;

    case 'multi_select': {
      const selected = Array.isArray(v) ? v : (v ? [v] : []);
      return `<div class="chip-picker">
        ${(prop.options || []).map(o =>
          `<label class="chip ${selected.includes(o.name) ? 'selected' : ''}">
             <input type="checkbox" value="${escapeHtml(o.name)}" ${selected.includes(o.name) ? 'checked' : ''} />
             ${escapeHtml(o.name)}
           </label>`
        ).join('')}
      </div>`;
    }

    case 'relation':
      return `<div class="relation-picker" data-relation-db="${prop.relationDatabaseId || ''}">
        <div class="loading-small">Loading options…</div>
      </div>`;

    case 'checkbox':
      return `<label class="toggle-label">
        <input type="checkbox" class="fixed-value" ${v ? 'checked' : ''} /> Checked
      </label>`;

    case 'date':
      return `<input type="date" class="fixed-value" value="${escapeHtml(v || '')}" />`;

    case 'number':
      return `<input type="number" class="fixed-value" value="${v ?? ''}" placeholder="e.g. 42" />`;

    default: // title, rich_text, url, email, phone_number, and others
      return `<input type="text" class="fixed-value" value="${escapeHtml(v ?? '')}" placeholder="Value" />`;
  }
}

function onSourceChange(propName) {
  const row = document.querySelector(`.property-row[data-name="${cssEscape(propName)}"]`);
  if (!row) return;

  const sourceSelect = row.querySelector('.source-select');
  const mode = sourceSelect.value;
  const prop = state.currentSchema.properties.find(p => p.name === propName);

  const editor = row.querySelector('.value-editor');
  editor.classList.toggle('hidden', mode !== 'fixed');

  state.editing.properties[propName] = state.editing.properties[propName] || {};
  state.editing.properties[propName].mode = mode;

  if (mode === 'auto') {
    state.editing.properties[propName].autoField = defaultAutoFieldFor(prop.type);
  }

  if (mode === 'fixed' && prop.type === 'relation') {
    hydrateRelationOptions(row, prop);
  }
}

async function hydrateRelationOptions(row, prop) {
  const picker = row.querySelector('.relation-picker');
  if (!picker) return;

  const dbId = prop.relationDatabaseId;
  if (!dbId) {
    picker.innerHTML = '<div class="hint small">Could not determine the related database.</div>';
    return;
  }

  // Use cache if available
  let options = state.relationOptionsCache[dbId];
  if (!options) {
    const res = await msg('GET_RELATION_OPTIONS', { databaseId: dbId });
    if (res.error) {
      picker.innerHTML = `<div class="hint small error">Failed to load: ${escapeHtml(res.error)}</div>`;
      return;
    }
    options = res;
    state.relationOptionsCache[dbId] = options;
  }

  // Also allow multi-selecting relations (relation type is always multi in Notion)
  const currentValue = state.editing.properties[prop.name]?.value || [];
  const selected = Array.isArray(currentValue) ? currentValue : [currentValue];

  if (!options.length) {
    picker.innerHTML = '<div class="hint small">The related database is empty or not shared with this integration.</div>';
    return;
  }

  picker.innerHTML = `
    <input type="text" class="relation-filter" placeholder="Filter…" />
    <div class="relation-options">
      ${options.map(o => `
        <label class="chip ${selected.includes(o.id) ? 'selected' : ''}">
          <input type="checkbox" value="${o.id}" ${selected.includes(o.id) ? 'checked' : ''} />
          ${escapeHtml(o.title)}
        </label>
      `).join('')}
    </div>
  `;
}

function wireValueEditor(row, prop) {
  const propName = prop.name;

  // Text, date, number, url, email, phone, fixed-value single input
  row.querySelectorAll('.value-editor input.fixed-value, .value-editor select.fixed-value').forEach(el => {
    el.addEventListener('change', () => {
      const cfg = state.editing.properties[propName];
      if (el.type === 'checkbox') cfg.value = el.checked;
      else cfg.value = el.value;
    });
    el.addEventListener('input', () => {
      const cfg = state.editing.properties[propName];
      if (el.type === 'checkbox') cfg.value = el.checked;
      else cfg.value = el.value;
    });
  });

  // Multi-select chip pickers
  row.querySelectorAll('.chip-picker input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const picked = [...row.querySelectorAll('.chip-picker input[type="checkbox"]:checked')].map(i => i.value);
      state.editing.properties[propName].value = picked;
      cb.closest('.chip').classList.toggle('selected', cb.checked);
    });
  });

  // Relation picker (delegated since it hydrates async)
  row.addEventListener('change', (e) => {
    if (!e.target.matches('.relation-options input[type="checkbox"]')) return;
    const picked = [...row.querySelectorAll('.relation-options input[type="checkbox"]:checked')].map(i => i.value);
    state.editing.properties[propName].value = picked;
    e.target.closest('.chip').classList.toggle('selected', e.target.checked);
  });

  // Relation filter
  row.addEventListener('input', (e) => {
    if (!e.target.matches('.relation-filter')) return;
    const q = e.target.value.toLowerCase();
    row.querySelectorAll('.relation-options .chip').forEach(chip => {
      const label = chip.textContent.trim().toLowerCase();
      chip.classList.toggle('hidden', q && !label.includes(q));
    });
  });
}

async function saveTemplate() {
  const tpl = {
    id: state.editing.id,
    name: $('tpl-name').value.trim(),
    databaseId: $('tpl-db').value,
    databaseTitle: state.editing.databaseTitle,
    properties: state.editing.properties,
    includeScreenshot: $('map-screenshot').checked,
  };

  if (!tpl.name) return showEditorError('Give the template a name.');
  if (!tpl.databaseId) return showEditorError('Pick a database.');

  // Ensure at least one property configured beyond "skip"
  const active = Object.values(tpl.properties || {}).some(c => c.mode !== 'skip');
  if (!active) return showEditorError('Configure at least one property.');

  const idx = state.templates.findIndex(t => t.id === tpl.id);
  if (idx >= 0) state.templates[idx] = tpl;
  else state.templates.push(tpl);

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
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssEscape(s) { return (CSS?.escape?.(s)) ?? String(s).replace(/"/g, '\\"'); }

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
  state.editing.properties = {}; // reset when database changes
  await loadSchemaAndRenderEditor(e.target.value);
});

$('btn-refresh-dbs').addEventListener('click', async (e) => {
  e.preventDefault();
  const link = e.target;
  const originalText = link.textContent;
  link.textContent = 'Refreshing…';

  const selectedId = $('tpl-db').value;

  if (selectedId) {
    state.relationOptionsCache = {}; // invalidate so related DBs reload too
    await loadSchemaAndRenderEditor(selectedId);
  } else {
    await chrome.storage.sync.remove('databases');
    state.databases = [];
    await ensureDatabasesLoaded();
    renderDatabaseSelect();
  }

  link.textContent = originalText;
});

$('tpl-name').addEventListener('input', (e) => {
  if (state.editing) state.editing.name = e.target.value;
});

$('map-screenshot').addEventListener('change', (e) => {
  if (state.editing) state.editing.includeScreenshot = e.target.checked;
});

init();
