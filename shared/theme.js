// Theme management — three states: 'light' | 'dark' | 'system'.
// Canonical source: chrome.storage.sync.theme
// Synced to localStorage so the zero-flash <head> bootstrap can read it synchronously.
// Reflected on <html> as `theme-light` / `theme-dark` class (no class = system + OS is light).

const STORAGE_KEY = 'theme';
const LOCAL_CACHE_KEY = 'snaption-theme';

export async function loadTheme() {
  const { [STORAGE_KEY]: stored } = await chrome.storage.sync.get(STORAGE_KEY);
  return stored || 'system';
}

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark');
  if (resolved === 'dark') html.classList.add('theme-dark');
  try { localStorage.setItem(LOCAL_CACHE_KEY, pref); } catch {}
}

export async function setTheme(pref) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: pref });
  applyTheme(pref);
}

// Wire the 3-button segmented picker: one call, persists + re-renders.
export function initThemePicker(pickerEl) {
  if (!pickerEl) return;

  const renderActive = (pref) => {
    pickerEl.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === pref);
    });
  };

  loadTheme().then(pref => {
    applyTheme(pref);
    renderActive(pref);
  });

  pickerEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    const pref = btn.dataset.theme;
    await setTheme(pref);
    renderActive(pref);
  });

  // React to system preference changes when user is on 'system'
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    const pref = await loadTheme();
    if (pref === 'system') applyTheme('system');
  });

  // Sync across extension contexts (popup ↔ options)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    const pref = changes[STORAGE_KEY].newValue || 'system';
    applyTheme(pref);
    renderActive(pref);
  });
}
