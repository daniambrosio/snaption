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

### 8.1 Popup: auto vs fixed vs preview

The popup treats the template's configured properties in three buckets:

- **`auto` properties** render as editable inputs prefilled with the captured page value. The user can edit these before saving — their edits flow to `SAVE_BOOKMARK.overrides` and take precedence over the auto value.
- **`fixed` properties** render in a compact "This template also sets:" preview at the bottom (name → value). Not editable in the popup — edit the template in Options to change them.
- **`skip`-mode or omitted properties** are invisible — the database's default applies.

Each field's label is the actual Notion property name from the template (e.g. "Task" not "Title", "Notes" not "Description"). There are no hardcoded Snaption field labels anywhere in the popup.

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

Relation pickers lazy-load — when the user switches to "Fixed value" on a relation property, the extension calls `GET_RELATION_OPTIONS` on the related database to populate the chip picker. Results are cached in-memory per session, keyed by relation database ID.

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

---

## 11. Things NOT to do

- Do not add a backend proxy (violates ship-and-forget).
- Do not add OAuth support (requires the above).
- Do not upload screenshots to a third-party host.
- Do not use `content_scripts: [{ matches: ["<all_urls>"] }]` — run scripts on demand via `chrome.scripting`.
- Do not request the `debugger` permission without user discussion.
- Do not introduce a build tool / bundler unless the app genuinely outgrows vanilla JS (right now it doesn't).
- Do not commit the user's actual Notion token (it lives in `chrome.storage.sync`, never in the repo).
