const NOTION_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';

// ─── Message router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_AUTH_STATUS':  return getAuthStatus();
    case 'SAVE_TOKEN':       return saveToken(msg.token);
    case 'CLEAR_TOKEN':      return clearToken();
    case 'GET_TAB_INFO':     return getTabInfo(msg.tabId);
    case 'GET_DATABASES':    return getDatabases();
    case 'GET_DB_SCHEMA':    return getDatabaseSchema(msg.databaseId);
    case 'SAVE_BOOKMARK':    return saveBookmark(msg.payload);
    default: throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ─── Auth (internal integration token) ──────────────────────────────────────
async function getAuthStatus() {
  const { notionToken, notionWorkspace } = await chrome.storage.sync.get(['notionToken', 'notionWorkspace']);
  return { authenticated: !!notionToken, workspace: notionWorkspace || null };
}

async function saveToken(token) {
  if (!token?.startsWith('ntn_') && !token?.startsWith('secret_')) {
    throw new Error('Invalid token format. Notion tokens start with "ntn_" or "secret_".');
  }

  // Validate token by calling /users/me
  const res = await fetch(`${NOTION_API_BASE}/users/me`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Token rejected by Notion. Double-check it.');
  }

  const user = await res.json();
  const workspaceName = user?.bot?.workspace_name || user?.name || 'Notion';

  await chrome.storage.sync.set({
    notionToken: token,
    notionWorkspace: workspaceName,
  });

  return { success: true, workspace: workspaceName };
}

async function clearToken() {
  await chrome.storage.sync.remove([
    'notionToken', 'notionWorkspace',
    'databases', 'templates', 'defaultTemplateId',
    'defaultDatabase', 'fieldMappings', // legacy
  ]);
  return { success: true };
}

// ─── Tab info + screenshot ───────────────────────────────────────────────────
async function getTabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);

  let metadata = {};
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageMetadata,
    });
    metadata = result?.result || {};
  } catch {
    // scripting may fail on chrome:// pages
  }

  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    // screenshot may be unavailable on special pages
  }

  return {
    url: tab.url,
    title: metadata.title || tab.title || '',
    description: metadata.description || '',
    ogImage: metadata.ogImage || null,
    screenshot,
  };
}

function extractPageMetadata() {
  const getMeta = (name) =>
    document.querySelector(`meta[name="${name}"]`)?.content ||
    document.querySelector(`meta[property="${name}"]`)?.content || '';

  return {
    title: getMeta('og:title') || document.title,
    description: getMeta('og:description') || getMeta('description'),
    ogImage: getMeta('og:image'),
  };
}

// ─── Notion API helpers ──────────────────────────────────────────────────────
async function notionFetch(path, options = {}) {
  const { notionToken } = await chrome.storage.sync.get('notionToken');
  if (!notionToken) throw new Error('Not authenticated');

  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Notion API error ${res.status}`);
  }
  return res.json();
}

async function getDatabases() {
  const data = await notionFetch('/search', {
    method: 'POST',
    body: JSON.stringify({ filter: { value: 'database', property: 'object' }, page_size: 50 }),
  });

  return data.results.map(db => ({
    id: db.id,
    title: db.title?.[0]?.plain_text || 'Untitled',
    icon: db.icon?.emoji || null,
  }));
}

async function getDatabaseSchema(databaseId) {
  const db = await notionFetch(`/databases/${databaseId}`);
  const properties = Object.entries(db.properties).map(([name, prop]) => ({
    name,
    type: prop.type,
  }));
  return { id: databaseId, title: db.title?.[0]?.plain_text || 'Untitled', properties };
}

// ─── Screenshot upload to Notion ─────────────────────────────────────────────
async function uploadScreenshot(base64DataUrl) {
  const { notionToken } = await chrome.storage.sync.get('notionToken');

  const base64 = base64DataUrl.replace(/^data:image\/png;base64,/, '');
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });

  const createRes = await fetch(`${NOTION_API_BASE}/file_uploads`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { filename: `screenshot-${Date.now()}.png` } }),
  });

  if (!createRes.ok) throw new Error('Failed to create file upload slot');
  const { id: fileUploadId, upload_url: uploadUrl } = await createRes.json();

  const formData = new FormData();
  formData.append('file', blob, `screenshot-${Date.now()}.png`);

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${notionToken}` },
    body: formData,
  });

  if (!uploadRes.ok) throw new Error('Failed to upload screenshot');
  return fileUploadId;
}

// ─── Save bookmark ────────────────────────────────────────────────────────────
async function saveBookmark({ databaseId, fields, screenshot, fieldMapping }) {
  const properties = buildProperties(fields, fieldMapping);

  const page = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });

  if (screenshot) {
    const fileUploadId = await uploadScreenshot(screenshot);
    await notionFetch(`/blocks/${page.id}/children`, {
      method: 'PATCH',
      headers: { 'Notion-Version': '2026-03-11' },
      body: JSON.stringify({
        children: [{
          object: 'block',
          type: 'image',
          image: { type: 'file', file: { file_upload_id: fileUploadId } },
        }],
      }),
    });
  }

  return { success: true, pageId: page.id, pageUrl: page.url };
}

function buildProperties(fields, mapping) {
  const props = {};

  // Each mapping slot is { name, type }
  // Each field is emitted according to the target property's actual Notion type
  const emit = (slot, value) => {
    if (!slot?.name || value === undefined || value === null || value === '') return;
    props[slot.name] = formatValue(slot.type, value);
  };

  emit(mapping.title, fields.title);
  emit(mapping.url, fields.url);
  emit(mapping.description, fields.description);
  if (fields.tags?.length) emit(mapping.tags, fields.tags);

  return props;
}

function formatValue(type, value) {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value) } }] };
    case 'rich_text':
      return { rich_text: [{ text: { content: Array.isArray(value) ? value.join(', ') : String(value) } }] };
    case 'url':
      return { url: String(value) };
    case 'email':
      return { email: String(value) };
    case 'multi_select':
      return { multi_select: (Array.isArray(value) ? value : [value]).map(name => ({ name: String(name) })) };
    case 'select':
      return { select: { name: String(Array.isArray(value) ? value[0] : value) } };
    case 'checkbox':
      return { checkbox: !!value };
    case 'number':
      return { number: Number(value) };
    case 'date':
      return { date: { start: String(value) } };
    default:
      // Fallback: stringify into rich_text if type is unexpected
      return { rich_text: [{ text: { content: Array.isArray(value) ? value.join(', ') : String(value) } }] };
  }
}
