# Snaption — Chrome extension spec

> A Chrome extension for saving web pages (URL + screenshot + metadata) into Notion databases, with per-database templates, schema-aware property editing, and light/dark/auto theme. Manifest V3. No backend, no OAuth, no third-party services.

This document is the canonical reference for LLMs and humans working on this codebase. Read it before making changes.

**Current version:** v1.0.0 (tagged). First shipped release, fully functional for authors who want a Notion bookmarker for their own workspaces.

---

## 1. Design philosophy (non-negotiable)

- **Ship and forget.** No backend, no OAuth proxy, no domain, no server to operate forever. The extension is fully client-side.
- **No third-party services.** Screenshots upload directly to Notion via their file_uploads API. No imgBB / Cloudinary / S3.
- **Schema-aware.** The extension reads each Notion database's property schema before letting users map fields to it. No guesswork about whether a "Description" property exists.
- **Type-aware.** Each mapped property carries its Notion type (`title` / `rich_text` / `url` / `multi_select` / etc.), so the correct JSON shape is emitted at save time.
- **Keep the UI tight.** Popup is ~340px wide. Options is a single page with an inline modal for template editing. No React, no build step.

If a proposed change violates any of these, stop and confirm with the user before proceeding.

---

## 2. Auth model: internal integration tokens

**Users create their own Notion integration** at https://www.notion.so/my-integrations, copy the "Internal Integration Secret" token, and paste it into Snaption's Options page. The token is:

- Validated on paste by calling `GET /v1/users/me`
- Stored in `chrome.storage.sync` (encrypted by Chrome, synced across the user's own devices via their Google account — never transits a server we own)
- Used as `Authorization: Bearer <token>` for all Notion API calls

**Why not OAuth?** Notion's OAuth flow requires a `client_secret` that must not be embedded in a distributed extension, which forces a backend proxy (Cloudflare Worker or similar) to do token exchange. That violates ship-and-forget. Notion does not support PKCE, so there is no way to do OAuth purely client-side.

**Consequence:** Users must manually share each target database with their integration in Notion (`...` → Connections → add integration). The extension cannot list a database unless it's been shared.

---

## 3. File structure

```
.
├── manifest.json                 Manifest V3 config
├── background/
│   └── service-worker.js         All API calls, screenshot capture, message routing
├── popup/
│   ├── popup.html                Quick-save UI (opened by clicking the toolbar icon)
│   ├── popup.js                  Reads current tab, shows form, dispatches SAVE_BOOKMARK
│   └── popup.css
├── options/
│   ├── options.html              Settings page (token + templates + appearance)
│   ├── options.js                Template CRUD, schema-aware property editor
│   └── options.css
├── shared/
│   └── theme.js                  Theme management module (imported by popup + options)
├── icons/
│   ├── icon-source.png           Master (1254×1254) — source of truth for resizes
│   ├── icon16.png                Toolbar icon (stepped downscale for legibility)
│   ├── icon48.png                Extensions page
│   └── icon128.png               Chrome Web Store + install dialog
├── SPEC.md                       This file
└── .gitignore
```

**No bundler, no package.json, no dependencies.** Vanilla ES modules, loaded by Chrome's MV3 service worker with `"type": "module"`.

**Icons** are generated once from `icon-source.png` via `sips` on macOS — no runtime generator. For the 16 px size specifically, use a stepped downscale (`1100×1100 crop → 512 → 128 → 32 → 16`) to preserve the S glyph's legibility; a one-shot 1254→16 produces a muddy result.

---

## 4. Core data model

All persistent state lives in `chrome.storage.sync`:

| Key | Shape | Purpose |
|-----|-------|---------|
| `notionToken` | string | User's internal integration secret |
| `notionWorkspace` | string | Display name (derived from `/users/me` response) |
| `databases` | `[{ id, title, icon }]` | Cached list of accessible databases |
| `templates` | `Template[]` | User's saved templates (see below) |
| `defaultTemplateId` | string | Which template is pre-selected in the popup |
| `theme` | `'light' \| 'dark' \| 'system'` | UI theme preference (default `system`) |

Additionally, `localStorage` mirrors `theme` under the key `snaption-theme` to allow a synchronous zero-flash theme bootstrap in the HTML `<head>` (see §9).

### Template shape

```js
{
  id: "<uuid>",
  name: "Tarefa Meli",
  databaseId: "<notion-db-id>",
  databaseTitle: "DB GTD Tasks",     // cached for display without another API call
  properties: {
    // Keyed by the actual Notion property name in the database
    "Task":   { mode: "auto",  autoField: "title"       },  // captured from page
    "URL":    { mode: "auto",  autoField: "url"         },  // captured from page
    "Notes":  { mode: "auto",  autoField: "description" },  // captured from og:description
    "Created":{ mode: "auto",  autoField: "now"         },  // today's date (YYYY-MM-DD)
    "Area":   { mode: "fixed", value: ["<page-id>"]     },  // relation — IDs of target pages
    "Status": { mode: "fixed", value: "To Do"           },  // select — option name
    "Tags":   { mode: "fixed", value: ["inbox"]         },  // multi_select — option names
    "Done":   { mode: "fixed", value: false             },  // checkbox
    // Properties with mode: "skip" (or omitted entirely) are left at the database default
  },
  includeScreenshot: true,
}
```

**The `properties` object is keyed by the Notion property name** — NOT by Snaption-defined slots. This lets users target any database, with any schema, and pre-set values for Relation, Select, Multi-select, Date, Checkbox, etc.

**`mode` values:**
- `"skip"` — leave this property unset (database default applies)
- `"auto"` — capture from the browsed page. `autoField` picks which captured value to use:
  - `"title"` — page's `<title>` or `og:title`
  - `"url"` — current URL
  - `"description"` — `og:description` or `<meta name="description">`
  - `"now"` — today's date as `YYYY-MM-DD`
- `"fixed"` — use `value` verbatim (type determined by the property's Notion type)

**`value` shape depends on the property's Notion type:**
| Notion type | value shape |
|-------------|-------------|
| `title`, `rich_text`, `url`, `email`, `phone_number` | string |
| `number` | number |
| `checkbox` | boolean |
| `date` | `"YYYY-MM-DD"` string |
| `select`, `status` | option name (string) |
| `multi_select` | array of option names (string[]) |
| `relation` | array of Notion page IDs (string[]) |

Read-only properties (`formula`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`, `unique_id`, `button`) are flagged `readonly` in the schema and hidden from the editor entirely.

---

## 5. Flow: saving a bookmark

```
[popup loads]
  ↓ GET_AUTH_STATUS → service-worker → { authenticated, workspace }
  ↓ if not authed → show "Open Settings"
  ↓ read templates from chrome.storage.sync
  ↓ if no templates → show "Create a template"
  ↓ GET_TAB_INFO → service-worker:
      - chrome.tabs.get(tabId)                   (URL, title)
      - chrome.scripting.executeScript(…)        (og:title, og:description)
      - chrome.tabs.captureVisibleTab(…)         (PNG data URL)
  ↓ applyTemplate():
      - For each 'auto' property → render an editable input prefilled
        with the captured value (user can override)
      - For each 'fixed' property → render a compact preview row
        (applied silently at save time)
[user clicks Save]
  ↓ SAVE_BOOKMARK { databaseId, template, tabInfo, overrides, screenshot }
  ↓ service-worker:
      - GET /v1/databases/{id}                     Fresh schema (catches renames)
      - buildPropertiesFromTemplate(template, tabInfo, schema, overrides)
          For each configured property:
            overrides[propName] ?? resolveTemplateValue(cfg, tabInfo)
          Emit via formatValue(schemaProp.type, value)
      - POST /v1/pages                             Create the page
      - if screenshot:
          - POST /v1/file_uploads                  Create upload slot
          - POST /v1/file_uploads/{id}/send        Send binary as multipart
          - PATCH /v1/blocks/{pageId}/children     Append image block
  ↓ success screen with "Open in Notion" link
```

**Why a fresh schema at save time:** If a user renames/deletes a property in Notion between template creation and save, we don't want to fail silently. The schema fetch lets us skip properties that no longer exist and emit the correct JSON shape based on the *current* property type (e.g. a user could convert a `select` to `multi_select`).

Screenshot upload is **best-effort**: if it fails, the page is still saved and the success screen shows `"Saved, but screenshot failed: <reason>"`. We never lose the page over a screenshot.

---

## 6. Notion API specifics (HARD-WON — read before modifying)

### 6.1 Property emission by type

`formatValue(type, value)` in `service-worker.js` dispatches on the mapped property's `type`. Each Notion type wants a different JSON shape:

| Type | Emitted shape |
|------|---------------|
| `title` | `{ title: [{ text: { content } }] }` |
| `rich_text` | `{ rich_text: [{ text: { content } }] }` |
| `url` | `{ url: "..." }` |
| `email` | `{ email: "..." }` |
| `phone_number` | `{ phone_number: "..." }` |
| `multi_select` | `{ multi_select: [{ name }, ...] }` |
| `select` | `{ select: { name } }` |
| `status` | `{ status: { name } }` |
| `checkbox` | `{ checkbox: true|false }` |
| `number` | `{ number: 42 }` |
| `date` | `{ date: { start: "YYYY-MM-DD" } }` |
| `relation` | `{ relation: [{ id: "<page-id>" }, ...] }` |

Using the wrong shape returns a `validation_error` from Notion and rejects the entire page create.

**Defensive schema parsing:** `getDatabaseSchema()` wraps each property in try/catch. A single malformed property (e.g. `prop.relation` unexpectedly null for some relation configurations) would otherwise abort the whole schema read. Properties that fail parsing are returned with `parseError` set — they still appear in the editor, just as an `unknown` type with a warning, so the user can see them rather than silently missing them.

### 6.2 File uploads — three bugs to not repeat

The file_uploads API has sharp edges. Here are the mistakes the initial implementation made and the corrections:

| Wrong | Right |
|-------|-------|
| `body: { file: { filename } }` | `body: { mode: "single_part", filename, content_type: "image/png" }` |
| `POST <upload_url from response>` | `POST /v1/file_uploads/{id}/send` |
| `image: { type: "file", file: { file_upload_id } }` | `image: { type: "file_upload", file_upload: { id } }` |

**Required header:** `Notion-Version: 2026-03-11` for all `/file_uploads` and `/blocks` requests involving uploaded files. (`2022-06-28` is used for every other endpoint — pages, databases, search, users.)

**Free workspace cap:** 5 MB per file. Enforced client-side with a size check before attempting the upload — saves a round-trip and gives a clear error.

**Multipart send:** Build a `FormData`, append the Blob, and POST it. **Do NOT set `Content-Type` manually** — the browser sets `multipart/form-data; boundary=...` for you. Setting it manually breaks the boundary.

### 6.3 Notion-Version header variance

Two different values are in play:
- `2022-06-28` — the stable, long-standing version for most endpoints
- `2026-03-11` — required for `/file_uploads` and any `image` block that references a `file_upload` id

The service worker defaults to `2022-06-28` and explicitly overrides to `2026-03-11` where needed. Changing the default could silently break production users — don't.

---

## 7. Chrome extension specifics (MV3)

### 7.1 Message router pattern

The service worker uses a single `chrome.runtime.onMessage` listener with a switch statement. `return true` keeps the async channel open so `sendResponse` works after `await`.

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});
```

All handlers return plain objects; errors become `{ error: "message" }`. The popup/options check `result.error` before treating a response as success.

### 7.2 `<select>` does not fire `change` on programmatic mutation

When JS re-renders a `<select>`'s options via `innerHTML = ...`, the native `change` event does NOT fire. Any downstream logic (schema fetch, mapping render, hiding sections) must be called explicitly.

This was the cause of the "Refresh clears selection silently" bug — the rewrite wiped the select but nothing hid the now-stale mapping section. Fix: the refresh handler now distinguishes "database selected" (refresh its schema) from "no selection" (refresh the list of databases), and in both paths explicitly calls the downstream render.

### 7.3 Screenshot capture

`chrome.tabs.captureVisibleTab(windowId, { format: 'png' })` returns a data URL (`"data:image/png;base64,..."`). Only works for the active tab in the window at the time of the call. Fails silently on some pages (PDFs, `chrome://` internal pages, some DRM'd content) — handled with a try/catch and the screenshot simply isn't offered.

### 7.4 Page metadata extraction

Injected via `chrome.scripting.executeScript` at popup open time (not via `content_scripts` in the manifest — that would run on every page load and waste cycles). The injected function reads `og:title`, `og:description`, `og:image` and falls back to `document.title`.

### 7.5 Permissions used

| Permission | Why |
|------------|-----|
| `tabs` | Read active tab URL/title |
| `activeTab` | Screenshot current tab |
| `scripting` | Inject metadata extractor into current tab |
| `storage` | `chrome.storage.sync` for token + templates |
| `host_permissions: ["https://api.notion.com/*"]` | CORS for all Notion API calls from the service worker |

**NOT used:** `identity` (was removed when we abandoned OAuth), `<all_urls>` content scripts, `webRequest`.

---

## 8. UI behaviors worth knowing

### 8.1 Popup: auto vs fixed vs preview

The popup treats the template's configured properties in three buckets:

- **`auto` properties** render as editable inputs prefilled with the captured page value. The user can edit these before saving — their edits flow to `SAVE_BOOKMARK.overrides` and take precedence over the auto value. Each auto field also has a subtle **✕** button (visible on hover) that one-click-flips that property to `mode: 'skip'` and persists to storage — the fastest way for a user to stop seeing a noisy auto field.
- **`fixed` properties** render in a compact "This template also sets:" preview at the bottom (name → value). Not editable in the popup — edit the template in Options to change them.
- **`skip`-mode or omitted properties** are invisible — the database's default applies.

Each field's label is the actual Notion property name from the template (e.g. "Task" not "Title", "Notes" not "Description"). There are no hardcoded Snaption field labels anywhere in the popup.

**Schema filter at popup open:** The popup fetches the target database's current schema in parallel with tab info. Any template property whose name no longer exists in the schema is silently dropped from rendering, so a renamed/deleted property doesn't surface as a phantom field.

### 8.2 Options: property-centric template editor

The template editor does NOT ask "which property maps to which Snaption slot?" It iterates over the database's actual writable properties and lets the user configure each one independently:

- Each property row shows: name, type icon, type label, source dropdown, value editor
- Source dropdown options depend on the property's type:
  - `title`: Leave empty / Auto (page title) / Fixed value
  - `url`: Leave empty / Auto (page URL) / Fixed value
  - `rich_text`: Leave empty / Auto (page description) / Fixed value
  - `date`: Leave empty / Auto (today) / Fixed value
  - `select` / `status`: Leave empty / Fixed value (dropdown of options)
  - `multi_select`: Leave empty / Fixed value (multi-chip picker)
  - `relation`: Leave empty / Fixed value (multi-chip picker — related DB pages lazy-loaded)
  - `checkbox`: Leave empty / Fixed value (toggle)
  - `number`: Leave empty / Fixed value (number input)
  - `email`, `phone_number`: Leave empty / Fixed value (text input)
- Read-only property types (`formula`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`, `unique_id`, `button`) are filtered out entirely
- A visible `Loaded N properties from this database (M read-only hidden)` line above the rows lets users verify the load matches what they see in Notion. The raw schema is also logged to DevTools console for debugging.

Relation pickers lazy-load — when the user switches to "Fixed value" on a relation property, the extension calls `GET_RELATION_OPTIONS` on the related database to populate the chip picker. Results are cached in-memory per session, keyed by relation database ID.

### 8.3 Options: context-aware Refresh button

The `↻ Refresh` link in the template editor does different things based on whether a database is selected:
- DB selected → re-fetches *that DB's schema* (for when the user added/removed a property in Notion)
- No DB selected → re-fetches the *list of databases* (for when the user shared a new DB with the integration)

### 8.4 Keyboard shortcuts

- **⌘+Enter (macOS) / Ctrl+Enter (Windows/Linux)** in the popup triggers Save to Notion from anywhere — including while typing in any input or textarea. Implemented as a `keydown` listener on `document` that checks `key === 'Enter' && (metaKey || ctrlKey)`. Three safety guards:
  1. `btn-save.disabled` — don't fire while a save is in flight
  2. `btn-save.offsetParent === null` — don't fire when the save view is hidden (setup screen or success screen)
  3. `e.preventDefault()` — stop any native newline-insert behaviour
- A subtle `⌘↵` hint chip on the Save button surfaces this for discoverability; full tooltip (`⌘/Ctrl + Enter`) shows on hover.

### 8.5 Theme picker (Light / Auto / Dark)

Both the popup header and the Options page expose a segmented theme picker (☀ / ◐ / ☾). Preference is persisted in `chrome.storage.sync.theme` and mirrored to `localStorage` for zero-flash bootstrap. See §9 for the full mechanism.

---

## 9. Theme management (dark mode)

### 9.1 Three states

| State | Behaviour |
|-------|-----------|
| `light` | Force light, ignore OS |
| `dark` | Force dark, ignore OS |
| `system` (default) | Follow `prefers-color-scheme` (OS setting), updating live on OS changes |

### 9.2 Canonical source and mirror

- `chrome.storage.sync.theme` is canonical and syncs across the user's devices via their Google account.
- `localStorage.snaption-theme` is a local cache used only for the synchronous zero-flash bootstrap in the HTML `<head>`.
- `shared/theme.js` handles loading, applying, and persisting — both popup and options import from it.

### 9.3 CSS model

- Light values are defined on `:root` (the default state).
- Dark values are defined on `html.theme-dark` — the class is applied by JS based on resolved theme.
- `color-scheme: light | dark` is set on the same selectors so native form controls (dropdowns, scrollbars, autofill highlights) match the chosen mode.
- **No `@media (prefers-color-scheme: dark)`** anywhere in CSS — JS is always the authority on which class is present.

### 9.4 Zero-flash bootstrap

Each `*.html` has an inline `<script>` in `<head>` that runs synchronously **before** the stylesheet is applied:

```html
<script>
  (function () {
    try {
      var pref = localStorage.getItem('snaption-theme') || 'system';
      var resolved = pref === 'system'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : pref;
      if (resolved === 'dark') document.documentElement.classList.add('theme-dark');
    } catch (e) {}
  })();
</script>
```

This ensures a dark-preference user never sees a white flash on popup open. `chrome.storage.sync` is async and would be too slow for this; localStorage is the trick that bridges the gap.

### 9.5 Cross-context sync

`chrome.storage.onChanged` listeners in `shared/theme.js` re-apply the theme whenever any extension context changes it, so changing the theme in the popup instantly reflects in an already-open Options page, and vice versa.

### 9.6 Icons and dark mode

**Single icon set works for both modes.** The icon is a stylized S on a rounded white frame — the white frame gives it its own contrast against any browser chrome color. Chrome MV3 has no manifest field for per-theme icons anyway (that's a Firefox feature: `theme_icons`). The `chrome.action.setIcon()` API could swap at runtime based on a `matchMedia` listener, but adds a two-icon-set maintenance burden we have not judged necessary.

---

## 10. Lessons learned (don't make these mistakes again)

1. **Don't assume Notion's API shape — verify before implementing.** The file_uploads bugs came from half-remembered docs. When in doubt, hit the actual endpoint against a scratch database.
2. **"Associated workspace" in Notion's public integration settings is just a developer admin field.** It does NOT restrict who can authenticate — users OAuth to *their own* workspaces. We briefly thought this was a blocker for distribution. It wasn't.
3. **Don't propose third-party image hosts as the "solution" for Notion screenshots.** Notion has native file upload (`/v1/file_uploads`). Using imgBB/Cloudinary introduces an unnecessary dependency and a second place for credentials to leak.
4. **The "client_secret in the extension" issue only matters for OAuth.** For internal integration tokens, there's no secret that belongs to *us* — the user pastes their *own* token. We never hold, proxy, or store anyone else's credentials.
5. **`<select>.change` is user-only.** If you rebuild a select programmatically, call the next step explicitly.
6. **Don't let one malformed property break the whole schema parse.** A single map over `Object.entries(db.properties)` with no per-entry try/catch will abort the entire schema read if any property has an unexpected sub-object shape — silently dropping *all* properties from the editor. Always parse defensively and surface unknown-type properties instead of hiding them.
7. **Always surface the actual error text from upstream APIs.** A generic "Failed to upload" hid three distinct bugs for a full iteration. The error now includes status code + first 200 chars of the response body.
8. **Migrations must live in the service worker, not a UI surface.** The first template migration ran only in `options.js`; the popup read storage directly and saw an unmigrated shape, silently sending zero properties. Now `LOAD_TEMPLATES` is the canonical message that hits the service worker, where `migrateTemplate()` runs before returning. `saveBookmark` also has an on-the-fly migration as a safety net.
9. **`prefers-color-scheme` media queries alone give users no control.** Providing a Light/Auto/Dark picker lets users override OS-level preference inside the extension. Drop the passive `@media` rule when you adopt a stored preference — having both creates specificity tangles.
10. **sips one-shot downscaling to 16 px is muddy.** For toolbar icons, do a stepped downscale (crop tight → 512 → 128 → 32 → 16) to preserve the glyph.

---

## 11. How to extend

### Adding a new "auto" capture source (e.g. reading time, word count)

1. In `service-worker.js` → `extractPageMetadata()`: compute the value and return it on the tab info object.
2. In `service-worker.js` → `resolveTemplateValue()`: add a case for the new `autoField` key.
3. In `options.js` → `autoOptionFor(type)`: add the auto option for whichever property types are compatible (typically `rich_text` or `number`).
4. In `popup.js` → `autoValueFromTab()`: add the case so the popup can preview/edit the captured value.

### Supporting a new Notion property type (e.g. `people`)

1. In `service-worker.js` → `getDatabaseSchema()`: if the type needs extra metadata (like `select` needs its options), return it.
2. In `service-worker.js` → `formatValue()`: add a case that returns the correct Notion JSON shape for that type.
3. In `options.js` → `renderValueEditor()`: add a case for the input UI (e.g. a searchable user picker for `people`).
4. In `options.js` → `typeIcon()`: add an icon character.
5. In `options.js` → `wireValueEditor()`: wire up the input change event to update `state.editing.properties[propName].value`.

### Adding a screenshot option (e.g. "full page" vs. "visible area")

Current implementation only captures the visible viewport (`chrome.tabs.captureVisibleTab`). Full-page requires scrolling + stitching or using the DevTools protocol (`chrome.debugger`), both significantly more complex. Before adding, evaluate whether the added permission (`debugger`) is acceptable — users are generally wary of that prompt.

### Changing the theme token palette

Edit the two CSS files (`popup.css`, `options.css`). Each has a `:root { ... }` block for light values and an `html.theme-dark { ... }` block for dark values. Don't reintroduce `@media (prefers-color-scheme: dark)` — it would fight the JS-driven class system.

### Per-theme icons at runtime (if ever needed)

1. Add a dark-specific icon set (`icon16-dark.png`, etc).
2. In `popup/popup.js` or a dedicated module, listen to `matchMedia('(prefers-color-scheme: dark)')` and the storage change.
3. Call `chrome.action.setIcon({ path: { '16': 'icons/icon16-dark.png', ... } })` on change.
4. Run once on popup open to set initial state (service worker has no `matchMedia`).

---

## 12. Things NOT to do

- Do not add a backend proxy (violates ship-and-forget).
- Do not add OAuth support (requires the above).
- Do not upload screenshots to a third-party host.
- Do not use `content_scripts: [{ matches: ["<all_urls>"] }]` — run scripts on demand via `chrome.scripting`.
- Do not request the `debugger` permission without user discussion.
- Do not introduce a build tool / bundler unless the app genuinely outgrows vanilla JS (right now it doesn't).
- Do not commit the user's actual Notion token (it lives in `chrome.storage.sync`, never in the repo).
- Do not reintroduce `@media (prefers-color-scheme: dark)` in CSS — the theme picker is now JS-driven and the class system is authoritative.
- Do not read templates directly from `chrome.storage.sync` in the popup or options — always go through the `LOAD_TEMPLATES` service worker message so migrations run.
- Do not hardcode Snaption field slots (`title` / `url` / `description` / `tags`) back into the template model. Templates are property-centric; the previous slot-based approach is a resolved dead end (see Lesson 8).
