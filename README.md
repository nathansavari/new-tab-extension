# Screentime for Firefox

A private, local dashboard that replaces Firefox's new tab page and homepage. It combines screen time per website, a to-do list, and a month calendar.

No accounts, no sync, and no analytics. The extension makes no network requests of its own. Domain names and durations are stored in `storage.local`, and full URLs or page titles are never recorded.

## What it does

- Tracks time per website while Firefox is focused and you're active.
- Shows today's total, a donut chart of your top sites, and a seven-day bar chart.
- Shows a month calendar with today highlighted and one-click month navigation.
- Keeps a lightweight to-do list on the new tab page, saved locally. Drag tasks to reorder them, or focus a task's grip and use ↑/↓.
- Switches between **Today** and **7 days** with one click.
- Opens any site from the list.
- Ignores idle time after 5 minutes, unfocused windows, background tabs, and private windows.
- Keeps 90 days of screen-time history and includes JSON export plus one-click deletion.

## Install (temporary, for development)

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from this folder.
5. Open a new tab. The dashboard should appear.

Temporary add-ons are removed when Firefox restarts. For a permanent install, package and sign the extension (see below).

### Run with web-ext

```bash
cd screentime
npx web-ext run
```

### Lint and package

```bash
cd screentime
npx web-ext lint
npx web-ext build --overwrite-dest
```

The unsigned `.zip` is written to `web-ext-artifacts/`. To install permanently, submit it to [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing, or sign it with `web-ext sign`.

## How tracking works

The background page records an interval only when all of these are true:

- Firefox has a focused, normal window.
- The active tab has an `http:` or `https:` URL.
- The tab is not in a private window.
- The user has not been idle for more than 5 minutes. Audible tabs keep counting while audio plays.

That means background tabs, minimized windows, locked screens, and private browsing do not contribute. Time is flushed to disk every 10 seconds and whenever the active tab changes, so a crash loses at most a few seconds.

Domains are normalized by removing `www.` and lowercasing. Subdomains are kept separate (`mail.google.com` is distinct from `google.com`). Ports are preserved for local development sites.

Data shape in `storage.local`:

```json
{
  "screentime:data": {
    "version": 1,
    "days": {
      "2026-11-10": {
        "youtube.com": 4520,
        "github.com": 2610
      }
    }
  },
  "screentime:todos": [
    { "id": "…", "text": "Read the release notes", "done": false, "createdAt": 1762819200000 }
  ]
}
```

Screen-time history and tasks use separate keys. The export and delete actions in settings apply to screen-time history only.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `tabs` | Read the active tab's URL so time can be attributed to a domain. |
| `storage` | Keep daily totals locally. |
| `idle` | Pause tracking after 5 minutes of inactivity. |

The manifest declares `data_collection_permissions.required: ["none"]` because nothing is transmitted off the device.

## Notes and limits

- This measures **browser screen time**, not system-wide app usage. Music playing in a background tab does not count.
- Firefox's built-in Home page cannot be modified by extensions, so this extension supplies its own homepage/new-tab page instead. The manifest uses `chrome_settings_overrides.homepage` and `chrome_url_overrides.newtab` for that. If you use a custom new-tab URL in Firefox settings, set **New tabs** back to **Firefox Home** so the override can take effect.
- Private windows are disabled for this extension by design.
- Site colors are generated locally; the extension never fetches favicons from third-party services.
- Clearing browser extension data or uninstalling the add-on removes screen-time history and to-dos.
- Requires Firefox 142 or newer on desktop.
# new-tab-extension
