# Snaption — Chrome extension spec

> A Chrome extension for saving web pages (URL + screenshot + metadata) into Notion databases, with per-database templates and schema-aware field mapping. Manifest V3. No backend, no OAuth, no third-party services.

This document is the canonical reference for LLMs and humans working on this codebase. Read it before making changes.

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
│   ├── options.html              Settings page (token + templates)
│   ├── options.js                Template CRUD, schema-aware mapping UI
│   └── options.css
├── icons/
│   ├── icon{16,48,128}.png       Generated procedurally (see make-icons.mjs)
│   ├── make-icons.mjs            Node script to regenerate icons
│   └── generate-icons.html       Fallback: open in Chrome, save canvases as PNG
└── SPEC.md                       This file
```

**No bundler, no package.json, no dependencies.** Vanilla ES modules, loaded by Chrome's MV3 service worker with `"type": "module"`.

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

### Template shape

```js
{
  id: "<uuid>",
  name: "Quick bookmark",
  databaseId: "<notion-db-id>",
  databaseTitle: "Bookmarks",        // cached for display without another API call
  mapping: {
    title:       { name: "Name",        type: "title"        },
    url:         { name: "URL",         type: "url"          },
    description: { name: "Notes",       type: "rich_text"    },  // optional
    tags:        { name: "Tags",        type: "multi_select" },  // optional
  },
  includeScreenshot: true,
}
```

The four `mapping` slots are fixed (`title`, `url`, `description`, `tags`) — these are Snaption's *bookmark fields*. The `name` is the Notion property name; the `type` is its Notion property type. Required slots: `title`, `url`. Optional: `description`, `tags`.

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
  ↓ populate form, render template picker pills
[user clicks Save]
  ↓ SAVE_BOOKMARK { databaseId, fieldMapping, screenshot, fields }
  ↓ service-worker:
      - buildProperties(fields, mapping)         Type-aware emission
      - POST /v1/pages                           Creates the page
      - if screenshot:
          - POST /v1/file_uploads                Create upload slot
          - POST /v1/file_uploads/{id}/send      Send binary as multipart
          - PATCH /v1/blocks/{pageId}/children   Append image block
  ↓ success screen with "Open in Notion" link
```

Screenshot upload is **best-effort**: if it fails, the page is still saved and the success screen shows `"Saved, but screenshot failed: <reason>"`. We never lose the page over a screenshot.

---

## 6. Notion API specifics (HARD-WON — read before modifying)

### 6.1 Property emission by type

`buildProperties()` in `service-worker.js` dispatches on the mapped property's `type`. Each Notion type wants a different JSON shape:

| Type | Emitted shape |
|------|---------------|
| `title` | `{ title: [{ text: { content } }] }` |
| `rich_text` | `{ rich_text: [{ text: { content } }] }` |
| `url` | `{ url: "..." }` |
| `email` | `{ email: "..." }` |
| `multi_select` | `{ multi_select: [{ name }, ...] }` |
| `select` | `{ select: { name } }` |
| `checkbox` | `{ checkbox: true|false }` |
| `number` | `{ number: 42 }` |
| `date` | `{ date: { start: "ISO-8601" } }` |

Using the wrong shape returns a `validation_error` from Notion and rejects the entire page create.

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

### 8.1 Popup: label-as-property-name

The popup relabels each bookmark-field input using the *actual* Notion property name from the template's mapping. If the user mapped `description → "Notes"`, the popup label reads "Notes", not "Description". Slots not mapped by the template are hidden entirely.

This avoids the UX confusion where a hardcoded "Description" label makes users think the extension is assuming a property they don't have.

### 8.2 Options: schema-aware mapping dropdowns

When a user picks a database in the template editor, the schema is fetched and each mapping slot's dropdown is populated with ONLY properties whose Notion type is compatible:

```js
const COMPATIBLE_TYPES = {
  title:       ['title'],                   // Exactly one per DB
  url:         ['url', 'rich_text'],        // URL property preferred, rich_text fallback
  description: ['rich_text'],
  tags:        ['multi_select', 'select'],
};
```

Optional rows with no compatible property in the chosen DB are **hidden entirely** (not shown with an empty dropdown). Required rows with no compatible property show a disabled explanatory option: "— no title property in this database —".

### 8.3 Options: context-aware Refresh button

The `↻ Refresh` link in the template editor does different things based on whether a database is selected:
- DB selected → re-fetches *that DB's schema* (for when the user added/removed a property in Notion)
- No DB selected → re-fetches the *list of databases* (for when the user shared a new DB with the integration)

---

## 9. Lessons learned (don't make these mistakes again)

1. **Don't assume Notion's API shape — verify before implementing.** The file_uploads bugs came from half-remembered docs. When in doubt, hit the actual endpoint against a scratch database.
2. **"Associated workspace" in Notion's public integration settings is just a developer admin field.** It does NOT restrict who can authenticate — users OAuth to *their own* workspaces. We briefly thought this was a blocker for distribution. It wasn't.
3. **Don't propose third-party image hosts as the "solution" for Notion screenshots.** Notion has native file upload (`/v1/file_uploads`). Using imgBB/Cloudinary introduces an unnecessary dependency and a second place for credentials to leak.
4. **The "client_secret in the extension" issue only matters for OAuth.** For internal integration tokens, there's no secret that belongs to *us* — the user pastes their *own* token. We never hold, proxy, or store anyone else's credentials.
5. **`<select>.change` is user-only.** If you rebuild a select programmatically, call the next step explicitly.
6. **Template schema should carry property types.** Storing just property names forces lookups at save time and can't handle users renaming properties gracefully. Storing `{ name, type }` makes save-time emission unambiguous.
7. **Always surface the actual error text from upstream APIs.** A generic "Failed to upload" hid three distinct bugs for a full iteration. The error now includes status code + first 200 chars of the response body.

---

## 10. How to extend

### Adding a new bookmark field (e.g. "highlight quote")

1. Add the slot to `COMPATIBLE_TYPES` in `options.js` with the compatible Notion types.
2. Add a row to the mapping table in `options.html`.
3. Add a field input to the popup form + a corresponding entry in `applyTemplate()`.
4. Extend `payload.fields` in `handleSave()` (popup.js) and `buildProperties()` (service-worker.js).

### Supporting a new Notion property type (e.g. `people`)

1. Add the type to the relevant entries in `COMPATIBLE_TYPES`.
2. Add a case to `formatValue()` in `service-worker.js` that returns the correct JSON shape.
3. Consider whether the user-facing input should change (e.g. a user picker vs. a text field).

### Adding a screenshot option (e.g. "full page" vs. "visible area")

Current implementation only captures the visible viewport (`chrome.tabs.captureVisibleTab`). Full-page requires scrolling + stitching or using the DevTools protocol (`chrome.debugger`), both significantly more complex. Before adding, evaluate whether the added permission (`debugger`) is acceptable — users are generally wary of that prompt.

---

## 11. Things NOT to do

- Do not add a backend proxy (violates ship-and-forget).
- Do not add OAuth support (requires the above).
- Do not upload screenshots to a third-party host.
- Do not use `content_scripts: [{ matches: ["<all_urls>"] }]` — run scripts on demand via `chrome.scripting`.
- Do not request the `debugger` permission without user discussion.
- Do not introduce a build tool / bundler unless the app genuinely outgrows vanilla JS (right now it doesn't).
- Do not commit the user's actual Notion token (it lives in `chrome.storage.sync`, never in the repo).
