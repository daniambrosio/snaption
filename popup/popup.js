const msg = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const $ = (id) => document.getElementById(id);

let state = {
  tabInfo: null,
  templates: [],
  selectedTemplateId: null,
};

async function init() {
  showView('loading');

  const authStatus = await msg('GET_AUTH_STATUS');
  if (!authStatus.authenticated) {
    $('setup-message').textContent = 'Set up Notch to start saving bookmarks.';
    showView('setup');
    return;
  }

  const stored = await chrome.storage.sync.get(['templates', 'defaultTemplateId']);
  state.templates = stored.templates || [];

  if (!state.templates.length) {
    $('setup-message').textContent = 'No templates yet. Create one to start saving.';
    showView('setup');
    return;
  }

  state.selectedTemplateId = stored.defaultTemplateId || state.templates[0].id;

  $('workspace-name').textContent = authStatus.workspace || 'Notion';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabInfo = await msg('GET_TAB_INFO', { tabId: tab.id });

  renderTemplatePicker();
  applyTemplate();
  populateForm();
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

function applyTemplate() {
  const tpl = currentTemplate();
  if (!tpl) return;

  // Show/hide description + tags based on whether template maps them
  $('field-description-wrap').classList.toggle('hidden', !tpl.mapping.description);
  $('field-tags-wrap').classList.toggle('hidden', !tpl.mapping.tags);

  // Screenshot default from template
  $('include-screenshot').checked = tpl.includeScreenshot !== false;
}

function populateForm() {
  $('field-title').value = state.tabInfo.title || '';
  $('field-url').value = state.tabInfo.url || '';
  $('field-description').value = state.tabInfo.description || '';
  $('field-tags').value = '';

  if (state.tabInfo.screenshot) {
    $('screenshot-img').src = state.tabInfo.screenshot;
    $('screenshot-wrap').classList.remove('hidden');
  } else {
    $('screenshot-wrap').classList.add('hidden');
  }
}

function currentTemplate() {
  return state.templates.find(t => t.id === state.selectedTemplateId);
}

async function handleSave() {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  hideStatus();

  const tpl = currentTemplate();
  if (!tpl) { showStatus('No template selected', 'error'); return; }

  const includeScreenshot = $('include-screenshot').checked && state.tabInfo.screenshot;

  const payload = {
    databaseId: tpl.databaseId,
    fieldMapping: tpl.mapping,
    screenshot: includeScreenshot ? state.tabInfo.screenshot : null,
    fields: {
      title: $('field-title').value.trim(),
      url: $('field-url').value.trim(),
      description: $('field-description').value.trim(),
      tags: $('field-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    },
  };

  const result = await msg('SAVE_BOOKMARK', { payload });

  if (result.error) {
    showStatus(result.error, 'error');
    btn.disabled = false;
    btn.textContent = 'Save to Notion';
    return;
  }

  $('open-notion-link').href = result.pageUrl;
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
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Events ──────────────────────────────────────────────────────────────────
$('btn-open-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btn-save')?.addEventListener('click', handleSave);

$('template-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.template-pill');
  if (!btn) return;
  state.selectedTemplateId = btn.dataset.id;
  renderTemplatePicker();
  applyTemplate();
});

$('open-notion-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.href });
});

init();
