# AGENTS.md

Firefox-only WebExtension (Manifest V2, Firefox 142+) that replaces the new tab page with a local screen-time widget, to-do list, and calendar.

## Commands

No build step, no `package.json`, no dependencies. Files load directly.

```bash
npx web-ext run                    # launch Firefox with the extension
npx web-ext lint                   # validate manifest/sources
npx web-ext build --overwrite-dest # package to web-ext-artifacts/ (gitignored)
```

Manual load: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json`.

There is no test suite. Verify changes with `npx web-ext lint` plus a manual `web-ext run`.

## Architecture

- `background.js` is the source of truth: tracking, storage, stats, retention. It is a **persistent** background page, not an event page.
- `newtab.js` is UI only. It never tracks directly; it reads data via `browser.runtime.sendMessage` and renders. Add new message types to the listener in `background.js:429` and call them from `newtab.js`.
- Message contract: `screentime:get-stats`, `screentime:clear`, `screentime:export`.
- `newtab.html`/`newtab.css` are plain static assets; no bundler or framework.

## Data and privacy invariants

- Storage keys: `screentime:data` (`{ version: 1, days: { "YYYY-MM-DD": { host: seconds } } }`) and `screentime:todos`.
- Store **seconds**, keyed by **local** date. Date keys use noon-local anchoring (`background.js:47`) to stay stable across DST; reuse `dateKey()` rather than `toISOString()`.
- Only hostnames are stored — never full URLs or page titles. Hosts are lowercased, `www.` stripped, ports preserved (`hostFromUrl`, `background.js:153`).
- The extension must make **no network requests** and must not fetch favicons. Site colors are generated locally (`buildColorMap` in `newtab.js:143`). Preserve this.
- Retention is 90 days; pruning happens on flush (`pruneIfNeeded`, `background.js:104`).

## Gotchas

- Do **not** migrate to MV2 event pages or MV3 without rethinking tracking: the periodic flush relies on `setInterval` in a persistent page (`background.js:516`).
- All time accounting is guarded by `session` + `flush()`; keep the flush-on-change pattern when touching tracking.
- CSP forbids inline scripts (`manifest.json:34`) — all JS must be external files.
- `newtab.js` has a deliberate fallback for standalone preview (no extension APIs): `localStorage` for todos. Don't remove it.
- Site color arrays in `newtab.js` (`LIGHT_COLORS`/`DARK_COLORS`) mirror the CSS theme vars in `newtab.css`; keep both in sync.
- The manifest intentionally omits custom icons so Firefox supplies its default extension icon; do not add a favicon or icon files.
