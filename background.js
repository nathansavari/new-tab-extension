"use strict";

/*
 * Screentime — background tracker
 *
 * The extension only counts time when:
 *   - Firefox has a focused, normal window
 *   - the active tab is an http(s) page
 *   - the user has not been idle for 5 minutes (audible tabs keep counting)
 *   - the tab is not in a private window
 *
 * Time is kept in memory and flushed to storage.local every 10 seconds and
 * whenever the active tab or window changes. Nothing leaves the device.
 */

const DATA_KEY = "screentime:data";
const RETENTION_DAYS = 90;
const IDLE_THRESHOLD_SECONDS = 5 * 60;
const FLUSH_INTERVAL_MS = 10 * 1000;
const MIN_TRACKED_MS = 250;

const api = browser;

let store = { version: 1, days: {} };
let session = null;
let initPromise = null;
let lastPrunedKey = null;

let flushInFlight = null;
let writeChain = Promise.resolve();

let syncing = false;
let syncQueued = false;
let syncTimer = null;

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentDayKeys(count) {
  const base = new Date();
  base.setHours(12, 0, 0, 0);

  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = new Date(base);
    day.setDate(base.getDate() - offset);
    keys.push(dateKey(day));
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* Data helpers                                                               */
/* -------------------------------------------------------------------------- */

function sanitizeStore(raw) {
  const clean = { version: 1, days: {} };
  if (!raw || typeof raw !== "object" || !raw.days || typeof raw.days !== "object") {
    return clean;
  }

  for (const [key, hosts] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !hosts || typeof hosts !== "object") {
      continue;
    }

    const cleanHosts = {};
    for (const [host, seconds] of Object.entries(hosts)) {
      if (
        typeof host === "string" &&
        host.length > 0 &&
        Number.isFinite(seconds) &&
        seconds > 0
      ) {
        cleanHosts[host] = Math.round(seconds * 1000) / 1000;
      }
    }

    if (Object.keys(cleanHosts).length > 0) {
      clean.days[key] = cleanHosts;
    }
  }

  return clean;
}

function addTime(day, host, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return;
  }

  const bucket = (store.days[day] ||= {});
  bucket[host] = Math.round(((bucket[host] || 0) + seconds) * 1000) / 1000;
}

function pruneIfNeeded() {
  const today = dateKey();
  if (lastPrunedKey === today) {
    return false;
  }

  const cutoff = new Date();
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));
  const cutoffKey = dateKey(cutoff);

  let changed = false;
  for (const key of Object.keys(store.days)) {
    if (key < cutoffKey) {
      delete store.days[key];
      changed = true;
    }
  }

  lastPrunedKey = today;
  return changed;
}

function persist() {
  const snapshot = JSON.parse(JSON.stringify(store));

  const write = writeChain
    .catch(() => undefined)
    .then(() => api.storage.local.set({ [DATA_KEY]: snapshot }));

  // Keep the chain alive after an error, but let this caller see the failure.
  writeChain = write.catch(() => undefined);
  return write;
}

async function loadStore() {
  try {
    const result = await api.storage.local.get(DATA_KEY);
    store = sanitizeStore(result[DATA_KEY]);
  } catch (error) {
    console.error("Screentime: could not load stored data", error);
    store = { version: 1, days: {} };
  }
}

/* -------------------------------------------------------------------------- */
/* Tracking                                                                   */
/* -------------------------------------------------------------------------- */

function hostFromUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }
    if (!host) {
      return null;
    }

    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  try {
    const windows = await api.windows.getAll({ populate: true });
    const focused = windows.find(
      (window) => window.focused && window.type === "normal"
    );
    if (!focused || !Array.isArray(focused.tabs)) {
      return null;
    }

    return focused.tabs.find((tab) => tab.active) || null;
  } catch (error) {
    console.error("Screentime: could not read the active tab", error);
    return null;
  }
}

async function doFlush() {
  const now = Date.now();
  let changed = false;

  if (session) {
    const elapsedMs = now - session.startedAt;
    if (elapsedMs >= MIN_TRACKED_MS) {
      addTime(dateKey(new Date(now)), session.host, elapsedMs / 1000);
      session.startedAt = now;
      changed = true;
    }
  }

  if (pruneIfNeeded()) {
    changed = true;
  }

  if (changed) {
    await persist();
  }
}

function flush() {
  if (flushInFlight) {
    return flushInFlight;
  }

  flushInFlight = doFlush().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doSyncTracking() {
  await flush();

  const tab = await getActiveTab();
  let next = null;

  if (tab && !tab.incognito) {
    const host = hostFromUrl(tab.url);
    if (host) {
      let idleState = "active";
      try {
        idleState = await api.idle.queryState(IDLE_THRESHOLD_SECONDS);
      } catch {
        // If idle detection is unavailable, keep counting rather than losing
        // all data. The idle permission should normally make this succeed.
      }

      const isPlayingAudio = idleState === "idle" && tab.audible === true;
      if (idleState === "active" || isPlayingAudio) {
        next = {
          host,
          tabId: tab.id,
          windowId: tab.windowId,
          startedAt: Date.now(),
        };
      }
    }
  }

  if (!next) {
    session = null;
    return;
  }

  if (
    session &&
    session.tabId === next.tabId &&
    session.windowId === next.windowId &&
    session.host === next.host
  ) {
    // Same page, keep the existing start time.
    return;
  }

  session = next;
}

function syncTracking() {
  if (syncing) {
    syncQueued = true;
    return Promise.resolve();
  }

  syncing = true;
  return doSyncTracking()
    .catch((error) => {
      console.error("Screentime: tracking sync failed", error);
    })
    .finally(() => {
      syncing = false;
      if (syncQueued) {
        syncQueued = false;
        syncTracking();
      }
    });
}

function scheduleSync(delay = 50) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    init()
      .then(() => syncTracking())
      .catch((error) => {
        console.error("Screentime: tracking sync failed", error);
      });
  }, delay);
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

function emptySiteMap() {
  return new Map();
}

function sumSites(sites) {
  return sites.reduce((sum, site) => sum + site.seconds, 0);
}

function sitesFromMap(map) {
  return [...map.entries()]
    .filter(([, seconds]) => seconds > 0)
    .map(([host, seconds]) => ({ host, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

async function buildStats() {
  await flush();

  const keys = recentDayKeys(7);
  const today = keys[keys.length - 1];
  const pendingSeconds =
    session && dateKey(new Date(session.startedAt)) === today
      ? Math.max(0, (Date.now() - session.startedAt) / 1000)
      : 0;

  function addDay(map, key) {
    const day = store.days[key];
    if (!day) {
      return;
    }
    for (const [host, seconds] of Object.entries(day)) {
      map.set(host, (map.get(host) || 0) + seconds);
    }
  }

  const todayMap = emptySiteMap();
  addDay(todayMap, today);
  if (session && pendingSeconds > 0) {
    todayMap.set(session.host, (todayMap.get(session.host) || 0) + pendingSeconds);
  }

  const weekMap = emptySiteMap();
  for (const key of keys) {
    addDay(weekMap, key);
    if (key === today && session && pendingSeconds > 0) {
      weekMap.set(
        session.host,
        (weekMap.get(session.host) || 0) + pendingSeconds
      );
    }
  }

  const daily = keys.map((key) => {
    let seconds = 0;
    const day = store.days[key];
    if (day) {
      for (const value of Object.values(day)) {
        seconds += value;
      }
    }
    if (key === today) {
      seconds += pendingSeconds;
    }
    return { date: key, seconds };
  });

  const todaySites = sitesFromMap(todayMap);
  const weekSites = sitesFromMap(weekMap);

  return {
    generatedAt: Date.now(),
    retentionDays: RETENTION_DAYS,
    current: session
      ? {
          host: session.host,
          seconds: Math.max(0, (Date.now() - session.startedAt) / 1000),
        }
      : null,
    today: {
      date: today,
      total: sumSites(todaySites),
      sites: todaySites,
    },
    week: {
      start: keys[0],
      end: today,
      total: sumSites(weekSites),
      sites: weekSites,
    },
    daily,
  };
}

async function clearData() {
  session = null;

  if (flushInFlight) {
    await flushInFlight.catch(() => undefined);
  }

  store = { version: 1, days: {} };
  lastPrunedKey = dateKey();
  await persist();
}

async function exportData() {
  await flush();
  return {
    exportedAt: new Date().toISOString(),
    version: store.version,
    days: store.days,
  };
}

/* -------------------------------------------------------------------------- */
/* Messages and lifecycle                                                     */
/* -------------------------------------------------------------------------- */

api.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  if (message.type === "screentime:get-stats") {
    return init().then(() => buildStats());
  }

  if (message.type === "screentime:clear") {
    return init()
      .then(() => clearData())
      .then(() => ({ ok: true }));
  }

  if (message.type === "screentime:export") {
    return init()
      .then(() => exportData())
      .then((data) => ({ ok: true, data }));
  }

  return undefined;
});

api.tabs.onActivated.addListener(() => scheduleSync());
api.tabs.onRemoved.addListener(() => scheduleSync());
api.windows.onFocusChanged.addListener(() => scheduleSync());

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const relevantChange =
    Boolean(changeInfo.url) ||
    changeInfo.status === "complete" ||
    changeInfo.audible !== undefined;

  if (!relevantChange) {
    return;
  }

  if (tab.active || (session && session.tabId === tabId)) {
    scheduleSync();
  }
});

api.idle.onStateChanged.addListener(() => scheduleSync());

api.runtime.onStartup.addListener(() => {
  session = null;
  scheduleSync(0);
});

api.runtime.onInstalled.addListener(() => {
  session = null;
  scheduleSync(0);
});

api.runtime.onSuspend?.addListener(() => {
  if (session) {
    flush().catch(() => undefined);
  }
});

api.browserAction.onClicked.addListener(async () => {
  const url = api.runtime.getURL("newtab.html");

  try {
    const tabs = await api.tabs.query({});
    const existing = tabs.find((tab) => tab.url === url);
    if (existing) {
      await api.tabs.update(existing.id, { active: true });
      await api.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // Fall through and open a fresh dashboard.
  }

  await api.tabs.create({ url });
});

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await loadStore();
      await syncTracking();

      // A persistent background page keeps this timer alive. The event
      // listeners above still reconcile state immediately after every tab or
      // window change. The periodic sync also flushes pending time.
      setInterval(() => {
        syncTracking().catch((error) => {
          console.error("Screentime: periodic sync failed", error);
        });
      }, FLUSH_INTERVAL_MS);
    })();
  }

  return initPromise;
}

init().catch((error) => {
  console.error("Screentime: failed to start", error);
});
