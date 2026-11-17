"use strict";

const api = typeof browser !== "undefined" ? browser : null;
const uiLocale = "en-US";

const DATA_KEY = "screentime:data";
const TODO_KEY = "screentime:todos";
const TODO_FALLBACK_KEY = "screentime:todos:fallback";
const COLLAPSED_SITE_COUNT = 6;

const LIGHT_COLORS = [
  "#d9480f",
  "#1971c2",
  "#2b8a3e",
  "#9c36b5",
  "#c2255c",
  "#b35c00",
  "#0b7285",
  "#5f3dc4",
  "#a61e4d",
  "#495057",
];

const DARK_COLORS = [
  "#ff7a45",
  "#4dabf7",
  "#51cf66",
  "#da77f2",
  "#f06595",
  "#ffd43b",
  "#3bc9db",
  "#9775fa",
  "#ff8787",
  "#ced4da",
];

const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let colors = darkModeQuery.matches ? DARK_COLORS : LIGHT_COLORS;

const elements = {
  total: document.querySelector("#total"),
  summaryLabel: document.querySelector("#summary-label"),
  summaryCaption: document.querySelector("#summary-caption"),
  donutSegments: document.querySelector("#donut-segments"),
  donutPercent: document.querySelector("#donut-percent"),
  weekTotal: document.querySelector("#week-total"),
  weekStrip: document.querySelector("#week-strip"),
  siteList: document.querySelector("#site-list"),
  sitesTitle: document.querySelector("#sites-title"),
  empty: document.querySelector("#empty"),
  showAll: document.querySelector("#show-all"),
  trackingText: document.querySelector("#tracking-text"),
  settingsButton: document.querySelector("#settings-button"),
  settingsDialog: document.querySelector("#settings-dialog"),
  closeSettings: document.querySelector("#close-settings"),
  clearButton: document.querySelector("#clear-button"),
  exportButton: document.querySelector("#export-button"),
  dialogStatus: document.querySelector("#dialog-status"),
  version: document.querySelector("#version"),
  tabs: [
    document.querySelector("#tab-today"),
    document.querySelector("#tab-week"),
  ],
  panel: document.querySelector("#widget-panel"),
  todoForm: document.querySelector("#todo-form"),
  todoInput: document.querySelector("#todo-input"),
  todoList: document.querySelector("#todo-list"),
  todoEmpty: document.querySelector("#todo-empty"),
  todoCount: document.querySelector("#todo-count"),
  todoClear: document.querySelector("#todo-clear"),
  todoFoot: document.querySelector("#todo-foot"),
  calendarTitle: document.querySelector("#calendar-title"),
  calendarNavToday: document.querySelector("#calendar-today"),
  calendarPrev: document.querySelector("#calendar-prev"),
  calendarNext: document.querySelector("#calendar-next"),
  calendarWeekdays: document.querySelector("#calendar-weekdays"),
  calendarGrid: document.querySelector("#calendar-grid"),
};

let stats = null;
let todos = [];
let activeRange = "today";
let showAllSites = false;
let refreshGeneration = 0;
let clearArmed = false;
let clearArmedTimer = null;

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) {
    return "0m";
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function formatPercent(seconds, total) {
  if (!total || !seconds) {
    return "0%";
  }

  const percent = (seconds / total) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hashHost(host) {
  let hash = 0;
  for (let index = 0; index < host.length; index += 1) {
    hash = (hash * 31 + host.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function buildColorMap(sites) {
  const used = new Set();
  const map = new Map();

  for (const site of sites) {
    let index = hashHost(site.host) % colors.length;

    for (let attempt = 0; attempt < colors.length; attempt += 1) {
      if (!used.has(colors[index])) {
        break;
      }
      index = (index + 1) % colors.length;
    }

    const color = colors[index];
    map.set(site.host, color);
    used.add(color);
  }

  return map;
}

function urlForHost(host) {
  const bare = host.replace(/:\d+$/, "");
  const isLocal =
    bare === "localhost" ||
    bare === "[::1]" ||
    /^127\./.test(bare) ||
    /^10\./.test(bare) ||
    /^192\.168\./.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare);

  return `${isLocal ? "http" : "https"}://${host}`;
}

function syncCalendarDay() {
  const dayKey = todayKey();
  if (dayKey !== calendarDayKey) {
    calendarDayKey = dayKey;
    renderCalendar();
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function datasetForRange() {
  return activeRange === "week" ? stats?.week : stats?.today;
}

function renderWeekStrip() {
  elements.weekStrip.replaceChildren();

  const daily = stats?.daily || [];
  if (daily.length === 0) {
    return;
  }

  const maxSeconds = Math.max(1, ...daily.map((day) => day.seconds));
  const currentKey = stats?.today?.date || todayKey();

  for (const day of daily) {
    const date = dateFromKey(day.date);
    const isToday = day.date === currentKey;
    const isEmpty = day.seconds <= 0;
    const height = isEmpty ? 0 : Math.max(5, (day.seconds / maxSeconds) * 100);

    const wrapper = document.createElement("div");
    wrapper.className = `week-day${isToday ? " is-today" : ""}${isEmpty ? " is-empty" : ""}`;
    wrapper.setAttribute("role", "img");
    wrapper.title = `${new Intl.DateTimeFormat(uiLocale, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(date)} · ${formatDuration(day.seconds)}`;
    wrapper.setAttribute(
      "aria-label",
      `${new Intl.DateTimeFormat(uiLocale, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(date)}: ${formatDuration(day.seconds)}`
    );

    const track = document.createElement("div");
    track.className = "week-track";

    const fill = document.createElement("div");
    fill.className = "week-fill";
    fill.style.height = `${height}%`;

    const label = document.createElement("span");
    label.className = "week-label";
    label.textContent = new Intl.DateTimeFormat(uiLocale, {
      weekday: "narrow",
    }).format(date);
    label.setAttribute("aria-hidden", "true");

    track.append(fill);
    wrapper.append(track, label);
    elements.weekStrip.append(wrapper);
  }

  elements.weekTotal.textContent = formatDuration(
    daily.reduce((sum, day) => sum + day.seconds, 0)
  );
}

function renderDonut(sites, total, colorMap) {
  elements.donutSegments.replaceChildren();

  if (!total || sites.length === 0) {
    elements.donutPercent.textContent = "—";
    return;
  }

  const visible = sites.slice(0, 4);
  const otherSeconds = sites
    .slice(4)
    .reduce((sum, site) => sum + site.seconds, 0);

  const segments = visible.map((site) => ({
    seconds: site.seconds,
    color: colorMap.get(site.host) || colors[0],
  }));

  if (otherSeconds > 0) {
    segments.push({ seconds: otherSeconds, color: "var(--faint)" });
  }

  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const gap = segments.length > 1 ? 4 : 0;
  let offset = 0;

  for (const segment of segments) {
    const length = (segment.seconds / total) * circumference;
    const drawLength = Math.max(0.5, length - gap);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "donut-segment");
    circle.setAttribute("cx", "60");
    circle.setAttribute("cy", "60");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("stroke", segment.color);
    circle.style.strokeDasharray = `${drawLength} ${circumference - drawLength}`;
    circle.style.strokeDashoffset = String(-offset);

    elements.donutSegments.append(circle);
    offset += length;
  }

  const top = sites[0];
  elements.donutPercent.textContent = formatPercent(top.seconds, total);
}

function renderSiteList(sites, total, colorMap) {
  elements.siteList.replaceChildren();
  elements.siteList.classList.toggle("is-expanded", showAllSites);

  if (sites.length === 0) {
    elements.siteList.hidden = true;
    elements.empty.hidden = false;
    elements.showAll.hidden = true;
    return;
  }

  elements.siteList.hidden = false;
  elements.empty.hidden = true;

  const limit = showAllSites ? sites.length : COLLAPSED_SITE_COUNT;
  const visible = sites.slice(0, limit);

  for (const site of visible) {
    const color = colorMap.get(site.host) || colors[0];

    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "site-row";
    link.href = urlForHost(site.host);
    link.style.setProperty("--site-color", color);
    link.setAttribute(
      "aria-label",
      `${site.host}: ${formatDuration(site.seconds)}, ${formatPercent(
        site.seconds,
        total
      )} of screen time`
    );

    const dot = document.createElement("span");
    dot.className = "site-dot";
    dot.setAttribute("aria-hidden", "true");

    const info = document.createElement("span");
    info.className = "site-info";

    const nameRow = document.createElement("span");
    nameRow.className = "site-name-row";

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.host;
    name.title = site.host;

    const time = document.createElement("span");
    time.className = "site-time";
    time.textContent = formatDuration(site.seconds);

    const meter = document.createElement("span");
    meter.className = "site-meter";
    meter.setAttribute("aria-hidden", "true");

    const fill = document.createElement("span");
    const width = total > 0 ? Math.max(1.5, (site.seconds / total) * 100) : 0;
    fill.style.width = `${Math.min(100, width)}%`;
    meter.append(fill);

    nameRow.append(name, time);
    info.append(nameRow, meter);
    link.append(dot, info);
    item.append(link);
    elements.siteList.append(item);
  }

  const canExpand = sites.length > COLLAPSED_SITE_COUNT;
  elements.showAll.hidden = !canExpand;
  elements.showAll.textContent = showAllSites
    ? "Show fewer"
    : `Show all ${sites.length} sites`;
}

function renderTrackingState() {
  elements.trackingText.textContent = stats?.current?.host
    ? `Tracking ${stats.current.host}`
    : "Tracking on";
}

function render() {
  const dataset = datasetForRange();
  const sites = dataset?.sites || [];
  const total = dataset?.total || 0;

  elements.total.textContent = formatDuration(total);
  elements.summaryLabel.textContent =
    activeRange === "week" ? "Last 7 days" : "Today";
  elements.summaryCaption.textContent = `across ${pluralize(
    sites.length,
    "site"
  )}${activeRange === "week" ? " this week" : ""}`;

  elements.sitesTitle.textContent =
    activeRange === "week" ? "Top sites this week" : "Top sites today";

  const colorMap = buildColorMap(sites);
  renderDonut(sites, total, colorMap);
  renderSiteList(sites, total, colorMap);
  renderWeekStrip();
  renderTrackingState();
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

async function fetchStats() {
  if (!api?.runtime?.sendMessage) {
    return null;
  }

  try {
    return await api.runtime.sendMessage({ type: "screentime:get-stats" });
  } catch (error) {
    console.error("Screentime: could not load stats", error);
    return null;
  }
}

async function refresh() {
  const generation = (refreshGeneration += 1);

  if (!api) {
    syncCalendarDay();
    render();
    return;
  }

  const nextStats = await fetchStats();
  if (generation !== refreshGeneration) {
    return;
  }

  if (nextStats) {
    stats = nextStats;
  }

  syncCalendarDay();
  render();
}

/* -------------------------------------------------------------------------- */
/* Range tabs                                                                 */
/* -------------------------------------------------------------------------- */

function setRange(range, focusTab = false) {
  if (range !== "today" && range !== "week") {
    return;
  }

  if (activeRange !== range) {
    activeRange = range;
    showAllSites = false;
  }

  for (const tab of elements.tabs) {
    const isActive = tab.dataset.range === range;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;

    if (isActive) {
      elements.panel.setAttribute("aria-labelledby", tab.id);
      if (focusTab) {
        tab.focus();
      }
    }
  }

  render();
}

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => setRange(tab.dataset.range));

  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const currentIndex = elements.tabs.indexOf(tab);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % elements.tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + elements.tabs.length) % elements.tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = elements.tabs.length - 1;
    }

    setRange(elements.tabs[nextIndex].dataset.range, true);
  });
}

elements.showAll.addEventListener("click", () => {
  showAllSites = !showAllSites;
  if (stats) {
    render();
  }
});

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

let calendarMonthOffset = 0;
let calendarDayKey = "";

function firstDayOfWeek() {
  try {
    const locale = new Intl.Locale(uiLocale);
    const info =
      typeof locale.getWeekInfo === "function"
        ? locale.getWeekInfo()
        : locale.weekInfo;
    if (info && Number.isFinite(info.firstDay)) {
      return info.firstDay % 7;
    }
  } catch {
    // Fall through to the Monday-first default.
  }
  return 1;
}

function renderCalendarWeekdays() {
  const start = firstDayOfWeek();
  const reference = new Date(2024, 0, 7); // A Sunday.
  const formatter = new Intl.DateTimeFormat(uiLocale, { weekday: "narrow" });
  const nodes = [];

  for (let index = 0; index < 7; index += 1) {
    const date = new Date(reference);
    date.setDate(reference.getDate() + ((start + index) % 7));

    const node = document.createElement("span");
    node.textContent = formatter.format(date);
    nodes.push(node);
  }

  elements.calendarWeekdays.replaceChildren(...nodes);
}

function renderCalendar() {
  const today = new Date();
  const view = new Date(
    today.getFullYear(),
    today.getMonth() + calendarMonthOffset,
    1
  );
  const isCurrentMonth =
    view.getFullYear() === today.getFullYear() &&
    view.getMonth() === today.getMonth();

  elements.calendarTitle.textContent = new Intl.DateTimeFormat(uiLocale, {
    month: "long",
    year: "numeric",
  }).format(view);

  const start = firstDayOfWeek();
  const leading = (view.getDay() - start + 7) % 7;
  const daysInMonth = new Date(
    view.getFullYear(),
    view.getMonth() + 1,
    0
  ).getDate();
  const dateFormatter = new Intl.DateTimeFormat(uiLocale, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < 42; index += 1) {
    const dayNumber = index - leading + 1;
    const cell = document.createElement("span");
    cell.className = "calendar-day";

    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cell.classList.add("is-blank");
      cell.setAttribute("aria-hidden", "true");
      fragment.append(cell);
      continue;
    }

    const date = new Date(view.getFullYear(), view.getMonth(), dayNumber);
    cell.textContent = String(dayNumber);
    cell.setAttribute("aria-label", dateFormatter.format(date));

    if (isCurrentMonth && dayNumber === today.getDate()) {
      cell.classList.add("is-today");
      cell.setAttribute("aria-current", "date");
    }

    fragment.append(cell);
  }

  elements.calendarGrid.replaceChildren(fragment);
  elements.calendarNavToday.hidden = isCurrentMonth;
}

elements.calendarPrev.addEventListener("click", () => {
  calendarMonthOffset -= 1;
  renderCalendar();
});

elements.calendarNext.addEventListener("click", () => {
  calendarMonthOffset += 1;
  renderCalendar();
});

elements.calendarNavToday.addEventListener("click", () => {
  calendarMonthOffset = 0;
  renderCalendar();
});

renderCalendarWeekdays();

/* -------------------------------------------------------------------------- */
/* To do                                                                      */
/* -------------------------------------------------------------------------- */

let todoWriteChain = Promise.resolve();
let draggedTodoId = null;

function createTodoId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeTodos(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set();
  const clean = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const text =
      typeof item.text === "string" ? item.text.trim().slice(0, 200) : "";
    if (!text) {
      continue;
    }

    let id = typeof item.id === "string" && item.id ? item.id : createTodoId();
    if (seen.has(id)) {
      id = createTodoId();
    }
    seen.add(id);

    clean.push({
      id,
      text,
      done: item.done === true,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    });
  }

  return clean;
}

function persistTodos() {
  const snapshot = todos.map(({ id, text, done, createdAt }) => ({
    id,
    text,
    done,
    createdAt,
  }));

  const write = todoWriteChain
    .catch(() => undefined)
    .then(async () => {
      if (api?.storage?.local) {
        await api.storage.local.set({ [TODO_KEY]: snapshot });
      } else {
        localStorage.setItem(TODO_FALLBACK_KEY, JSON.stringify(snapshot));
      }
    });

  todoWriteChain = write.catch(() => undefined);
  return write;
}

function updateTodoSummary() {
  const openCount = todos.filter((todo) => !todo.done).length;
  const doneCount = todos.length - openCount;

  elements.todoCount.textContent =
    todos.length === 0
      ? "No tasks"
      : `${openCount} open${doneCount > 0 ? ` · ${doneCount} done` : ""}`;
  elements.todoClear.hidden = doneCount === 0;
  elements.todoFoot.hidden = doneCount === 0;
}

function renderTodos() {
  elements.todoList.replaceChildren();
  elements.todoList.hidden = todos.length === 0;
  elements.todoEmpty.hidden = todos.length !== 0;

  for (const todo of todos) {
    const item = document.createElement("li");
    item.className = "todo-item";
    item.dataset.id = todo.id;
    item.draggable = true;

    const grip = document.createElement("span");
    grip.className = "todo-grip";
    grip.tabIndex = 0;
    grip.setAttribute("aria-label", `Reorder ${todo.text}`);
    grip.title = "Drag to reorder · ↑ ↓";

    const label = document.createElement("label");
    label.className = "todo-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-check";
    checkbox.checked = todo.done;
    checkbox.setAttribute("aria-label", todo.text);

    const box = document.createElement("span");
    box.className = "todo-box";
    box.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = todo.text;

    label.append(checkbox, box, text);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "todo-delete";
    remove.setAttribute("aria-label", `Delete ${todo.text}`);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("width", "13");
    icon.setAttribute("height", "13");
    icon.setAttribute("aria-hidden", "true");

    const cross = document.createElementNS("http://www.w3.org/2000/svg", "path");
    cross.setAttribute("d", "m4 4 8 8M12 4l-8 8");
    cross.setAttribute("fill", "none");
    cross.setAttribute("stroke", "currentColor");
    cross.setAttribute("stroke-width", "1.5");
    cross.setAttribute("stroke-linecap", "round");

    icon.append(cross);
    remove.append(icon);

    item.append(grip, label, remove);
    elements.todoList.append(item);
  }

  updateTodoSummary();
}

function reportTodoError(error) {
  console.error("Screentime: could not save todos", error);
}

function focusTodoGrip(id) {
  const item = [...elements.todoList.children].find(
    (node) => node.dataset.id === id
  );
  item?.querySelector(".todo-grip")?.focus();
}

function clearTodoDropMarkers() {
  for (const node of elements.todoList.querySelectorAll(
    ".is-drop-before, .is-drop-after"
  )) {
    node.classList.remove("is-drop-before", "is-drop-after");
  }
}

function reorderTodo(id, targetId, after) {
  const fromIndex = todos.findIndex((todo) => todo.id === id);
  if (fromIndex === -1) {
    return;
  }

  const [moved] = todos.splice(fromIndex, 1);

  let toIndex = targetId
    ? todos.findIndex((todo) => todo.id === targetId)
    : todos.length;

  if (toIndex === -1) {
    toIndex = todos.length;
  } else if (after) {
    toIndex += 1;
  }

  todos.splice(toIndex, 0, moved);
  renderTodos();
  focusTodoGrip(id);
  persistTodos().catch(reportTodoError);
}

elements.todoForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = elements.todoInput.value.trim();
  if (!text) {
    elements.todoInput.focus();
    return;
  }

  todos.push({
    id: createTodoId(),
    text: text.slice(0, 200),
    done: false,
    createdAt: Date.now(),
  });

  elements.todoInput.value = "";
  renderTodos();
  elements.todoList.scrollTop = elements.todoList.scrollHeight;
  elements.todoInput.focus();
  persistTodos().catch(reportTodoError);
});

elements.todoList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".todo-check");
  if (!checkbox) {
    return;
  }

  const item = checkbox.closest(".todo-item");
  const todo = todos.find((entry) => entry.id === item?.dataset.id);
  if (!todo) {
    return;
  }

  todo.done = checkbox.checked;
  updateTodoSummary();
  persistTodos().catch(reportTodoError);
});

elements.todoList.addEventListener("click", (event) => {
  const button = event.target.closest(".todo-delete");
  if (!button) {
    return;
  }

  const item = button.closest(".todo-item");
  const index = todos.findIndex((entry) => entry.id === item?.dataset.id);
  if (index === -1) {
    return;
  }

  todos.splice(index, 1);
  renderTodos();
  persistTodos().catch(reportTodoError);
});

elements.todoClear.addEventListener("click", () => {
  todos = todos.filter((todo) => !todo.done);
  renderTodos();
  elements.todoInput.focus();
  persistTodos().catch(reportTodoError);
});

elements.todoList.addEventListener("dragstart", (event) => {
  const item = event.target.closest(".todo-item");
  if (!item || !event.dataTransfer) {
    return;
  }

  draggedTodoId = item.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedTodoId);
  event.dataTransfer.setDragImage(item, 16, item.offsetHeight / 2);
  item.classList.add("is-dragging");
});

elements.todoList.addEventListener("dragover", (event) => {
  if (!draggedTodoId) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  clearTodoDropMarkers();

  const item = event.target.closest(".todo-item");
  if (!item || item.dataset.id === draggedTodoId) {
    return;
  }

  const rect = item.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  item.classList.add(after ? "is-drop-after" : "is-drop-before");
});

elements.todoList.addEventListener("drop", (event) => {
  if (!draggedTodoId) {
    return;
  }

  event.preventDefault();

  const id = draggedTodoId;
  draggedTodoId = null;

  const item = event.target.closest(".todo-item");
  const after = item?.classList.contains("is-drop-after") || false;
  clearTodoDropMarkers();

  if (item && item.dataset.id === id) {
    return;
  }

  reorderTodo(id, item?.dataset.id ?? null, after);
});

elements.todoList.addEventListener("dragend", () => {
  draggedTodoId = null;
  clearTodoDropMarkers();
  elements.todoList
    .querySelector(".is-dragging")
    ?.classList.remove("is-dragging");
});

elements.todoList.addEventListener("keydown", (event) => {
  if (!event.target.closest(".todo-grip")) {
    return;
  }

  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }

  event.preventDefault();

  const item = event.target.closest(".todo-item");
  const index = todos.findIndex((todo) => todo.id === item?.dataset.id);
  if (index === -1) {
    return;
  }

  const neighbor = todos[index + (event.key === "ArrowUp" ? -1 : 1)];
  if (!neighbor) {
    return;
  }

  reorderTodo(item.dataset.id, neighbor.id, event.key === "ArrowDown");
});

async function loadTodos() {
  try {
    if (api?.storage?.local) {
      const result = await api.storage.local.get(TODO_KEY);
      todos = sanitizeTodos(result[TODO_KEY]);
    } else {
      const saved = localStorage.getItem(TODO_FALLBACK_KEY);
      todos = sanitizeTodos(saved ? JSON.parse(saved) : []);
    }
  } catch (error) {
    console.error("Screentime: could not load todos", error);
    todos = [];
  }

  renderTodos();
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function setStatus(message, kind = "success") {
  elements.dialogStatus.textContent = message;
  elements.dialogStatus.dataset.kind = kind;
}

function resetClearButton() {
  clearArmed = false;
  clearTimeout(clearArmedTimer);
  clearArmedTimer = null;
  elements.clearButton.classList.remove("is-armed");
  elements.clearButton.disabled = false;
  elements.clearButton.textContent = "Delete screen time";
}

function openSettings() {
  setStatus("");
  resetClearButton();
  elements.settingsDialog.showModal();
}

function closeSettings() {
  resetClearButton();
  elements.settingsDialog.close();
}

elements.settingsButton.addEventListener("click", openSettings);
elements.closeSettings.addEventListener("click", closeSettings);

elements.settingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.settingsDialog) {
    closeSettings();
  }
});

elements.clearButton.addEventListener("click", async () => {
  if (!api?.runtime?.sendMessage) {
    setStatus("Open this page from the installed extension.", "error");
    return;
  }

  if (!clearArmed) {
    clearArmed = true;
    elements.clearButton.classList.add("is-armed");
    elements.clearButton.textContent = "Click again to delete";
    clearArmedTimer = setTimeout(resetClearButton, 4000);
    return;
  }

  resetClearButton();
  elements.clearButton.disabled = true;
  elements.clearButton.textContent = "Deleting…";

  try {
    const response = await api.runtime.sendMessage({ type: "screentime:clear" });
    if (response?.ok) {
      setStatus("All screen-time data deleted.");
      stats = null;
      await refresh();
    } else {
      setStatus("Could not delete data.", "error");
    }
  } catch (error) {
    console.error("Screentime: clear failed", error);
    setStatus("Could not delete data.", "error");
  } finally {
    resetClearButton();
  }
});

elements.exportButton.addEventListener("click", async () => {
  if (!api?.runtime?.sendMessage) {
    setStatus("Open this page from the installed extension.", "error");
    return;
  }

  elements.exportButton.disabled = true;

  try {
    const response = await api.runtime.sendMessage({
      type: "screentime:export",
    });

    if (!response?.ok) {
      throw new Error("Export failed");
    }

    const blob = new Blob([JSON.stringify(response.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `screentime-${todayKey()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    setStatus("Export downloaded.");
  } catch (error) {
    console.error("Screentime: export failed", error);
    setStatus("Could not export data.", "error");
  } finally {
    elements.exportButton.disabled = false;
  }
});

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

if (api?.runtime?.getManifest) {
  elements.version.textContent = `v${api.runtime.getManifest().version}`;
}

darkModeQuery.addEventListener("change", (event) => {
  colors = event.matches ? DARK_COLORS : LIGHT_COLORS;
  if (stats) {
    render();
  }
});

if (api?.storage?.onChanged) {
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[DATA_KEY]) {
      refresh();
    }
  });
}

window.addEventListener("focus", () => refresh());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refresh();
  }
});

setInterval(() => {
  if (!document.hidden) {
    refresh();
  }
}, 30_000);

syncCalendarDay();
render();
refresh();
loadTodos();
