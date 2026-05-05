# Snaption

A Chrome extension for saving web pages into Notion — URL, screenshot, and metadata — with per-database templates, schema-aware property mapping, and light/dark/auto theme.

**No backend. No OAuth. No third-party services.** Fully client-side, Manifest V3.

---

## What it does

Click the Snaption icon on any page and it captures:
- The page URL
- A screenshot of the visible viewport
- Any metadata fields you've mapped (title, tags, description, etc.)

Everything is saved directly to a Notion database of your choice, using Notion's official API.

## How auth works

Snaption uses **Notion internal integration tokens** — you create a private integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), copy the secret, and paste it into Snaption's Options page. The token is stored in `chrome.storage.sync` (encrypted by Chrome, never touches a server you don't own).

This is intentional: Notion's OAuth requires a backend to keep the `client_secret` safe. Snaption avoids that entirely.

> **Consequence:** you need to manually share each target database with your integration in Notion (`···` → Connections → add integration).

## Setup

1. Install the extension from the Chrome Web Store *(or load unpacked from this repo)*.
2. Open **Options** → paste your Notion integration token.
3. Add a template: pick a database, map its properties to page metadata fields.
4. Set it as the default and start bookmarking.

## Development

No build step required — vanilla ES modules, loaded directly by Chrome's MV3 service worker.

```bash
git clone git@github.com-personal:daniambrosio/snaption.git
# Open chrome://extensions → Enable Developer Mode → Load unpacked → select this folder
```

## Design principles

- **Ship and forget** — no server to operate, no domain to renew
- **Schema-aware** — reads each database's property schema before letting you map fields
- **Type-aware** — emits the correct Notion JSON shape per property type at save time
- **No dependencies** — no React, no bundler, no `node_modules`
