const msg = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const $ = (id) => document.getElementById(id);

let state = {
  tabInfo: null,
  templates: [],
  selectedTemplateId: null,
  overrides: {}, // { [propName]: value } — user edits to auto fields
};

async function init() {
  showView('loading');

  const authStatus = await msg('GET_AUTH_STATUS');
  if (!authStatus.authenticated) {
    $('setup-message').textContent = 'Set up Snaption to start saving bookmarks.';
    showView('setup');
    return;
  }

  const { templates, defaultTemplateId } = await msg('LOAD_TEMPLATES');
  state.templates = templates || [];

  if (!state.templates.length) {
    $('setup-message').textContent = 'No templates yet. Create one to start saving.';
    showView('setup');
    return;
  }

  state.selectedTemplateId = defaultTemplateId || state.templates[0].id;
  $('workspace-name').textContent = authStatus.workspace || 'Notion';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Fetch tab info and the selected template's DB schema in parallel
  const tpl = currentTemplate();
  const [tabInfo, schema] = await Promise.all([
    msg('GET_TAB_INFO', { tabId: tab.id }),
    tpl ? msg('GET_DB_SCHEMA', { databaseId: tpl.databaseId }) : Promise.resolve(null),
  ]);
  state.tabInfo = tabInfo;
  state.schema = schema && !schema.error ? schema : null;

  renderTemplatePicker();
  await applyTemplate();
  showView('save');
}

function renderTemplatePicker() {
  if (state.templates.length <= 1) {
    $('template-picker').classList.add('hidden');
    return;
  }

  $('template-picker').innerHTML = state.templates.map(tpl => `
    <button class="template-pill ${tpl.id === state.selectedTemplateId ? 'active' : ''}" data-id="${tpl.id}">
      ${escapeHtml(tpl.name)}
    </button>
  `).join('');
  $('template-picker').classList.remove('hidden');
}

function currentTemplate() {
  return state.templates.find(t => t.id === state.selectedTemplateId);
}

// Render editable inputs for 'auto' properties (user can override the captured value)
// and a compact preview of 'fixed' properties (silently applied)
async function applyTemplate() {
  const tpl = currentTemplate();
  if (!tpl) return;

  // If the user switched templates to a different database, refetch schema
  if (state.schema?.id !== tpl.databaseId) {
    const fresh = await msg('GET_DB_SCHEMA', { databaseId: tpl.databaseId });
    state.schema = fresh && !fresh.error ? fresh : null;
  }

  state.overrides = {};

  const autoForm = $('auto-form');
  const preview = $('template-preview');
  autoForm.innerHTML = '';
  preview.innerHTML = '';

  const validNames = new Set((state.schema?.properties || []).map(p => p.name));
  const hasSchema = !!state.schema;

  const autoEntries = [];
  const fixedEntries = [];

  for (const [propName, cfg] of Object.entries(tpl.properties || {})) {
    // Drop stale references to properties no longer in the DB
    if (hasSchema && !validNames.has(propName)) continue;
    if (cfg.mode === 'auto') autoEntries.push([propName, cfg]);
    else if (cfg.mode === 'fixed') fixedEntries.push([propName, cfg]);
  }

  // Editable auto fields, each with a skip-this-field (×) button
  for (const [propName, cfg] of autoEntries) {
    const value = autoValueFromTab(cfg.autoField, state.tabInfo);
    const readonly = cfg.autoField === 'url';
    const multiline = cfg.autoField === 'description';

    autoForm.insertAdjacentHTML('beforeend', `
      <div class="field" data-prop="${escapeHtml(propName)}">
        <div class="field-header">
          <label>${escapeHtml(propName)}</label>
          <button class="skip-field" data-skip="${escapeHtml(propName)}" title="Don't include this field — saved to template">✕</button>
        </div>
        ${multiline
          ? `<textarea rows="2" data-override="${escapeHtml(propName)}">${escapeHtml(value || '')}</textarea>`
          : `<input type="text" ${readonly ? 'readonly' : ''} value="${escapeHtml(value || '')}" data-override="${escapeHtml(propName)}" />`
        }
      </div>
    `);
  }

  // Wire up overrides
  autoForm.querySelectorAll('[data-override]').forEach(el => {
    el.addEventListener('input', () => {
      state.overrides[el.dataset.override] = el.value;
    });
    state.overrides[el.dataset.override] = el.value;
  });

  // Wire up skip-field buttons
  autoForm.querySelectorAll('[data-skip]').forEach(btn => {
    btn.addEventListener('click', () => skipField(btn.dataset.skip));
  });

  // Fixed value preview (non-editable summary)
  if (fixedEntries.length) {
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div class="preview-label">This template also sets:</div>
      <div class="preview-list">
        ${fixedEntries.map(([name, cfg]) => `
          <div class="preview-item">
            <span class="preview-name">${escapeHtml(name)}</span>
            <span class="preview-value">${formatPreviewValue(cfg.value)}</span>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    preview.classList.add('hidden');
  }

  $('include-screenshot').checked = tpl.includeScreenshot !== false;

  if (state.tabInfo?.screenshot) {
    $('screenshot-img').src = state.tabInfo.screenshot;
    $('screenshot-wrap').classList.remove('hidden');
  } else {
    $('screenshot-wrap').classList.add('hidden');
  }
}

// Flip a property's mode to 'skip' in the template, persist, and re-render
async function skipField(propName) {
  const tpl = currentTemplate();
  if (!tpl) return;

  tpl.properties = tpl.properties || {};
  tpl.properties[propName] = { ...(tpl.properties[propName] || {}), mode: 'skip' };

  // Persist the updated templates list
  await chrome.storage.sync.set({ templates: state.templates });

  await applyTemplate();
}

function autoValueFromTab(field, tabInfo) {
  switch (field) {
    case 'title':       return tabInfo?.title || '';
    case 'url':         return tabInfo?.url || '';
    case 'description': return tabInfo?.description || '';
    case 'now':         return new Date().toISOString().slice(0, 10);
    default:            return '';
  }
}

function formatPreviewValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.length === 1 && v[0].length === 36 && v[0].includes('-')) return '(1 relation)';
    if (v.every(x => typeof x === 'string' && x.length === 36 && x.includes('-'))) return `(${v.length} relations)`;
    return v.map(escapeHtml).join(', ');
  }
  if (typeof v === 'boolean') return v ? '✓' : '☐';
  return escapeHtml(String(v));
}

async function handleSave() {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  hideStatus();

  const tpl = currentTemplate();
  if (!tpl) { showStatus('No template selected', 'error'); return; }

  const includeScreenshot = $('include-screenshot').checked && state.tabInfo?.screenshot;

  const payload = {
    databaseId: tpl.databaseId,
    template: tpl,
    tabInfo: state.tabInfo,
    overrides: state.overrides,
    screenshot: includeScreenshot ? state.tabInfo.screenshot : null,
  };

  const result = await msg('SAVE_BOOKMARK', { payload });

  if (result.error) {
    showStatus(result.error, 'error');
    btn.disabled = false;
    btn.textContent = 'Save to Notion';
    return;
  }

  $('open-notion-link').href = result.pageUrl;
  $('success-msg').textContent = result.screenshotWarning
    ? `Saved, but screenshot failed: ${result.screenshotWarning}`
    : 'Saved to Notion!';
  showView('success');
}

function showView(name) {
  ['setup', 'loading', 'save', 'success'].forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
}

function showStatus(text, type) {
  const el = $('save-status');
  el.textContent = text;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}
function hideStatus() { $('save-status').classList.add('hidden'); }

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Events ──────────────────────────────────────────────────────────────────
$('btn-open-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-save')?.addEventListener('click', handleSave);

$('template-picker').addEventListener('click', async (e) => {
  const btn = e.target.closest('.template-pill');
  if (!btn) return;
  state.selectedTemplateId = btn.dataset.id;
  renderTemplatePicker();
  await applyTemplate();
});

$('open-notion-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.href });
});

// Cmd+Enter (macOS) or Ctrl+Enter triggers Save to Notion from anywhere in the popup
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  const saveBtn = $('btn-save');
  if (!saveBtn || saveBtn.disabled || saveBtn.offsetParent === null) return;
  e.preventDefault();
  saveBtn.click();
});

init();
