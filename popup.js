// Popup: choose the export scope, then hand the job over to the task page.
// Options live in chrome.storage.local; tokens never pass through this page.
import { openJobDb } from "./lib/job-db.js";
import { CHAT_CACHE_KEY, describeAge, mergeWalk, normalizeCache, walkList } from "./lib/chat-cache.js";
import { getLocale, t, tn } from "./lib/i18n.js";
import { bindLocaleSwitch, initPageI18n } from "./lib/i18n-dom.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  thinking: true,
  tools: true,
  citations: true,
  downloadMedia: true,
  branches: "all",
  package: "single",
};
const CHECK_IDS = {
  "opt-thinking": "thinking",
  "opt-tools": "tools",
  "opt-citations": "citations",
  "opt-media": "downloadMedia",
};
const RUNNING = new Set(["running", "pausing"]);
const UNFINISHED = new Set(["queued", "paused", "waiting-login", "blocked-storage"]);
const INCOMPLETE = new Set(["failed", "completed-with-errors"]);

let options = { ...DEFAULTS };
let chats = [];
let visible = [];
let selected = new Set();
let currentChatId = "";
let currentChatName = "";
let tabId = null;
let busy = false;
let syncing = false;
let syncedAt = 0;
let listComplete = false;
let syncHint = "";
// The list being rebuilt from pages: { walked, tail } while a walk is running.
let walking = null;
// Only the newest load may touch the list: a refresh started while another
// walk is in flight must win outright instead of interleaving pages.
let loadToken = 0;

function show(el, on) {
  el.hidden = !on;
}
function setError(text) {
  const el = $("error");
  if (!text) return show(el, false);
  el.textContent = text;
  show(el, true);
}

// Both segmented controls are radio groups, so they expose real radio state
// (aria-checked + roving tabindex) and answer arrow keys, not just a class.
// Space/Enter already activate a <button>, so only arrows need code.
function seg(id, value, onChange) {
  const buttons = [...$(id).querySelectorAll("button")];
  const select = (next, { focus = false, notify = true } = {}) => {
    buttons.forEach((b) => {
      const on = b === next;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (focus) next.focus();
    if (notify) onChange(next.dataset.v);
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => select(b));
    b.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      select(buttons[(i + step + buttons.length) % buttons.length], { focus: true });
    });
  });
  select(buttons.find((b) => b.dataset.v === value) || buttons[0], { notify: false });
}

async function send(payload) {
  const res = await chrome.runtime.sendMessage(payload);
  if (res && res.ok === false && res.error) throw new Error(res.error);
  return res;
}

async function loadOptions() {
  // Older versions stored a "formats" choice; the reader (and with it the
  // format switch) is gone, so drop the stale key instead of leaving it behind.
  chrome.storage.local.remove("formats").catch(() => {});
  options = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("opt-thinking").checked = options.thinking;
  $("opt-tools").checked = options.tools;
  $("opt-citations").checked = options.citations;
  $("opt-media").checked = options.downloadMedia;
  seg("seg-branches", options.branches, (v) => {
    options.branches = v;
    save();
  });
  seg("seg-package", options.package, (v) => {
    options.package = v;
    save();
  });
}
function save() {
  chrome.storage.local.set(options).catch(() => {});
}
function bindChecks() {
  for (const [id, key] of Object.entries(CHECK_IDS))
    $(id).addEventListener("change", (e) => {
      options[key] = e.target.checked;
      save();
    });
}

function tag_(text, modifier = "") {
  const tag = document.createElement("span");
  tag.className = modifier ? `chat__tag ${modifier}` : "chat__tag";
  tag.textContent = text;
  return tag;
}

function chatRow(c) {
  const li = document.createElement("li");
  li.className = "chat";
  li.dataset.id = c.id;
  li.dataset.picked = String(selected.has(c.id));
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(c.id);
  box.setAttribute("aria-label", c.name);
  const body = document.createElement("div");
  body.className = "chat__body";
  const name = document.createElement("span");
  name.className = "chat__name";
  name.textContent = c.name;
  const meta = document.createElement("span");
  meta.className = "chat__meta";
  const date = document.createElement("span");
  date.className = "chat__date";
  date.textContent = String(c.createTime || "").slice(0, 10);
  meta.append(date);
  if (c.pinned) meta.append(tag_(t("popup.chat.pinned"), "chat__tag--pin"));
  if (c.projectName) meta.append(tag_(c.projectName));
  if (c.model) {
    const model = document.createElement("span");
    model.className = "chat__model";
    model.textContent = c.model;
    meta.append(model);
  }
  body.append(name, meta);
  li.append(box, body);
  return li;
}

/** The chat row a click landed in, or null when it hit the container itself. */
function rowOf(target) {
  return target instanceof Element ? target.closest(".chat") : null;
}

// Row picking is delegated to the list container. The walk re-renders rows as
// pages stream in, and a handler bound to a row would be rebuilt with it — a
// click whose row was just replaced had no handler left to run, which is what
// made picking chats mid-load feel impossible. The id lives on the row.
function bindChatList() {
  $("chats").addEventListener("click", (e) => {
    const row = rowOf(e.target);
    const box = row?.querySelector('input[type="checkbox"]');
    // Clicking the checkbox itself is the native toggle plus its change event.
    if (!row || !box || e.target === box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  $("chats").addEventListener("change", (e) => {
    const row = rowOf(e.target);
    const id = row?.dataset.id;
    if (!row || !id || e.target.type !== "checkbox") return;
    if (e.target.checked) selected.add(id);
    else selected.delete(id);
    row.dataset.picked = String(e.target.checked);
    syncActions();
  });
}
function renderSkeleton() {
  const rows = Array.from({ length: 4 }, () => {
    const li = document.createElement("li");
    li.className = "chat chat--skeleton";
    li.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "skel";
    li.append(bar);
    return li;
  });
  $("chats").replaceChildren(...rows);
  $("chats").setAttribute("aria-busy", "true");
  $("count").textContent = t("popup.list.loading");
  show($("liststate"), false);
}
function renderChatList() {
  const query = $("q").value.trim().toLowerCase();
  visible = query ? chats.filter((c) => String(c.name).toLowerCase().includes(query)) : chats;
  // The walk streams pages in, so this runs once per page. Rebuilding every row
  // each time detaches the row under the pointer, and a click whose mousedown
  // target is gone never fires — which is why picking chats mid-load felt
  // impossible. Keep the rows already on screen and only append the new ones;
  // a genuine change (filter, authoritative end-of-walk list) still rebuilds.
  const list = $("chats");
  const rows = [...list.children];
  // Only the rows already on screen are ours to compare: while a page streams
  // in, they are a prefix of the new list, so walking "visible" instead would
  // read past the last row and throw.
  const keepsRows =
    rows.length <= visible.length && rows.every((row, i) => row.dataset.id === visible[i].id);
  if (keepsRows) for (const c of visible.slice(rows.length)) list.append(chatRow(c));
  else list.replaceChildren(...visible.map(chatRow));
  list.removeAttribute("aria-busy");
  const scope = query
    ? t("popup.list.countFiltered", { visible: visible.length, total: chats.length })
    : tn("popup.list.count", chats.length);
  // One slot reports both "still streaming" and "served from cache, N ago".
  const hint = syncHint || (syncedAt ? describeAge(Date.now() - syncedAt) : "");
  $("count").textContent = hint ? t("popup.list.countHint", { scope, hint }) : scope;
  const state = $("liststate");
  if (!chats.length) {
    state.replaceChildren(t("popup.list.empty"), retryButton());
    show(state, true);
  } else if (!visible.length) {
    state.replaceChildren(t("popup.list.noMatch", { query: $("q").value.trim() }));
    show(state, true);
  } else show(state, false);
  syncActions();
}
function retryButton() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn";
  b.textContent = t("popup.list.retry");
  b.addEventListener("click", () => loadChats());
  return b;
}

// Every action's label, availability and count is derived here, so busy state
// and selection can never drift apart from what the buttons say.
function syncActions() {
  const picked = selected.size;
  $("btn-export-current").disabled = busy || !currentChatId;
  $("btn-goto-all").disabled = busy;
  // "Back" only makes sense when there is a current chat to return to; on the
  // kimi.com home page the list is the only view.
  $("btn-back").hidden = !currentChatId;
  $("btn-back").disabled = busy;
  const chosen = $("btn-export-selected");
  chosen.textContent = picked
    ? t("popup.exportSelectedCount", { count: picked })
    : t("popup.exportSelected");
  chosen.disabled = busy || !picked;
  const everything = $("btn-export-all");
  // "Export everything" no longer depends on the list, and the count is only
  // honest once we know we hold the whole list.
  everything.textContent =
    listComplete && chats.length
      ? t("popup.exportAllCount", { count: chats.length })
      : t("popup.exportAll");
  everything.disabled = busy;
  // Select all only once the walk reached the end: picking a half-loaded list would
  // silently cover just the pages that happened to arrive.
  const selectAll = $("btn-select-all");
  selectAll.disabled = busy || syncing || !listComplete || !visible.length;
  selectAll.title = listComplete ? "" : t("popup.selectAll.hint");
  $("btn-select-none").disabled = busy || !picked;
  $("btn-refresh").disabled = busy || syncing;
}

function setBusy(on, text = "") {
  busy = on;
  $("dock-note").textContent = on ? text : "";
  show($("dock-note"), Boolean(on && text));
  syncActions();
}

function setView(next) {
  show($("view-single"), next === "single");
  show($("view-batch"), next === "batch");
  show($("dock-single"), next === "single");
  show($("dock-batch"), next === "batch");
  if (next === "batch") renderChatList();
  syncActions();
}

function syncStatus(text = "") {
  syncHint = text;
}

// The background keeps the walk; this page only ever holds the pages it has
// seen. Cached chats paint instantly, then each page is merged in as it lands.
async function loadChats({ force = false } = {}) {
  const token = ++loadToken;
  setError("");
  syncing = true;
  syncActions();
  try {
    const begin = await send({ type: "listChatsBegin", tabId, force });
    if (token !== loadToken) return;
    chats = begin.chats || [];
    walking = { walked: [], tail: chats };
    syncedAt = begin.ageMs ? Date.now() - begin.ageMs : 0;
    listComplete = Boolean(begin.complete);
    if (chats.length) renderChatList();
    else renderSkeleton();
    if (begin.fresh && !force) {
      syncing = false;
      syncActions();
      return;
    }
    syncStatus(t("popup.syncing"));
    let page = null;
    for (let guard = 0; guard < 5000; guard++) {
      page = await send({ type: "listChatsNext", tabId, force });
      if (token !== loadToken) return;
      if (page.accountChanged) {
        selected.clear();
        setError(t("popup.accountChanged"));
      }
      if (page.replace) {
        chats = page.chats;
        walking = null;
      } else {
        walking = mergeWalk(walking, page.chats);
        chats = walkList(walking);
      }
      listComplete = Boolean(page.complete);
      renderChatList();
      if (page.done !== false) break;
    }
    syncedAt = Date.now();
    syncStatus("");
  } catch (err) {
    // Keep whatever pages already landed: a half-loaded list beats an empty one.
    if (token !== loadToken) return;
    setError(String(err.message || err));
  }
  if (token !== loadToken) return;
  syncing = false;
  syncStatus("");
  renderChatList();
  syncActions();
}

// The single view never lists chats, so a current-chat export would otherwise
// reach the engine without any title (and the task page would show the raw
// uuid). Look the target up in what we hold, preferring the loaded list over
// the persisted cache — the cache entry also carries the creation date and the
// raw ListChats payload the archive expects.
async function resolveTargets(ids) {
  const byId = new Map(chats.map((c) => [c.id, c]));
  if (ids.some((id) => !byId.has(id))) {
    const cache = normalizeCache((await chrome.storage.local.get(CHAT_CACHE_KEY))[CHAT_CACHE_KEY]);
    for (const chat of cache?.chats || []) if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return ids.map(
    (id) =>
      byId.get(id) || { id, name: id === currentChatId ? currentChatName : "", files: [] },
  );
}

async function exportChats(ids, { allChats = false } = {}) {
  if (busy) return;
  setBusy(true, t("popup.openingTasks"));
  setError("");
  try {
    if (options.downloadMedia) await ensureMediaPermission();
    await send({
      type: "startJob",
      chatIds: ids,
      chats: allChats ? [] : await resolveTargets(ids),
      allChats,
      tabId,
      options,
      // Snapshotted on the job so the archive keeps one language even if the
      // switch is flipped while it runs.
      locale: getLocale(),
    });
    window.close();
  } catch (err) {
    setError(String(err.message || err));
  } finally {
    setBusy(false);
  }
}

// Media lives on signed CDN/OSS URLs whose hosts cannot be enumerated, and
// chrome.permissions.request must be called from the popup (a user-gesture
// context) — it never works from the service worker. Ask once, up front; a
// refusal degrades gracefully: assets keep their remote URL and land in
// error.log instead of aborting the export. The job itself only
// checks grants with chrome.permissions.contains.
async function ensureMediaPermission() {
  if (await chrome.permissions.contains({ origins: ["<all_urls>"] })) return true;
  const note = t("popup.perm.note");
  if (!confirm(note)) {
    setError(t("popup.perm.denied"));
    return false;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch {
    granted = false;
  }
  if (!granted) setError(t("popup.perm.deniedExpiring"));
  return granted;
}

// The task page owns the work, but the popup is where people land, so surface
// one line about anything already running or left unfinished. Read-only, and
// any failure just leaves the strip hidden.
async function renderJobStrip() {
  let db;
  try {
    db = await openJobDb();
    const jobs = await db.listJobs();
    if (!jobs.length) return;
    const byRecency = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const running = jobs.filter((j) => RUNNING.has(j.state)).sort(byRecency)[0];
    const unfinished = jobs.filter((j) => UNFINISHED.has(j.state)).sort(byRecency)[0];
    const incomplete = jobs.filter((j) => INCOMPLETE.has(j.state)).sort(byRecency)[0];
    let state = "";
    let text = "";
    if (running) {
      state = "live";
      const p = running.progress || {};
      const total = p.chatsTotal || running.targets?.length || 0;
      text = total
        ? t("popup.strip.exporting", { done: p.chatsDone || 0, total })
        : t("popup.strip.exportingNoTotal");
    } else if (unfinished) {
      state = "attention";
      text =
        unfinished.state === "queued" ? t("popup.strip.queued") : t("popup.strip.unfinished");
    } else if (incomplete) {
      state = "attention";
      text = t("popup.strip.incomplete");
    } else {
      return;
    }
    $("jobs-text").textContent = text;
    $("jobs-dot").dataset.state = state;
    show($("jobs"), true);
  } catch {
    /* A missing or blocked database simply means no strip. */
  } finally {
    db?.close?.();
  }
}

function chatTitleFromTab(tab) {
  const raw = String(tab?.title || "").trim();
  const stripped = raw.replace(/\s*[-–—|·]\s*(Kimi|kimi\.com)\s*$/i, "").trim();
  if (!stripped || /^(kimi|kimi\.com)$/i.test(stripped)) return "";
  return stripped;
}

let syncLangControl = null;

/** The header carries only the title; the card below names the open chat. */
function paintChatTitle() {
  if (!currentChatId) return;
  $("cur-title").textContent = currentChatName || t("popup.hero.currentChat");
}

/** Header chip: the version of the build that is actually running. */
function paintVersion() {
  $("app-version").textContent = t("common.version", {
    version: chrome.runtime.getManifest().version,
  });
}

/** Repaints everything whose text comes from the catalog. */
function refreshLocaleText() {
  paintVersion();
  paintChatTitle();
  renderChatList();
  void renderJobStrip();
}

function bindLang() {
  syncLangControl = bindLocaleSwitch({
    storage: chrome.storage.local,
    titleKey: "popup.title",
    onChange: () => refreshLocaleText(),
  });
}

async function main() {
  await initPageI18n({
    storage: chrome.storage.local,
    onChanged: chrome.storage.onChanged,
    titleKey: "popup.title",
    onChange: () => {
      syncLangControl?.();
      refreshLocaleText();
    },
  });
  paintVersion();
  bindLang();
  await loadOptions();
  bindChecks();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  const url = (tab && tab.url) || "";
  const onKimi = /kimi\.com/.test(url);
  const match = url.match(/\/chat\/([0-9a-fA-F-]{16,40})/);
  currentChatId = match ? match[1] : "";
  // The popup can be opened from the task page itself, where this entry is
  // redundant because the current page already shows the tasks.
  if (url.startsWith(chrome.runtime.getURL("tasks.html"))) show($("btn-tasks"), false);

  $("btn-tasks").addEventListener("click", () => {
    send({ type: "openTasks" }).catch((e) => setError(String(e.message || e)));
  });
  $("jobs").addEventListener("click", () => {
    send({ type: "openTasks" }).catch((e) => setError(String(e.message || e)));
  });
  $("btn-open-kimi").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.kimi.com/" }).catch((e) => setError(String(e.message || e)));
  });

  $("btn-goto-all").addEventListener("click", () => {
    setView("batch");
    if (!chats.length || !syncing) loadChats();
  });
  $("btn-refresh").addEventListener("click", () => loadChats({ force: true }));
  $("btn-back").addEventListener("click", () => setView("single"));
  bindChatList();
  $("btn-select-all").addEventListener("click", () => {
    visible.forEach((c) => selected.add(c.id));
    renderChatList();
  });
  $("btn-select-none").addEventListener("click", () => {
    selected.clear();
    renderChatList();
  });
  // Typing re-renders the whole list; coalesce keystrokes instead of paying for
  // one full rebuild per character.
  let filterTimer;
  $("q").addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderChatList, 120);
  });

  $("btn-export-current").addEventListener("click", () => {
    if (!currentChatId) return setError(t("popup.error.notAChat"));
    exportChats([currentChatId]);
  });
  $("btn-export-selected").addEventListener("click", () => {
    const ids = [...selected];
    if (!ids.length) return setError(t("popup.error.noneSelected"));
    exportChats(ids);
  });
  $("btn-export-all").addEventListener("click", () => exportChats([], { allChats: true }));

  if (!onKimi) {
    show($("view-single"), false);
    show($("view-batch"), false);
    show($("dock-single"), false);
    show($("dock-batch"), false);
    show($("offsite"), true);
    $("cur-id").textContent = "";
  } else if (currentChatId) {
    const title = chatTitleFromTab(tab);
    currentChatName = title;
    paintChatTitle();
    $("cur-id").textContent = `#${currentChatId.slice(0, 8)}`;
    $("cur-id").title = currentChatId;
    setView("single");
  } else {
    setView("batch");
    loadChats();
  }

  const pending = (await chrome.storage.local.get("pendingMenu")).pendingMenu;
  if (pending) {
    await chrome.storage.local.remove("pendingMenu");
    // Only a right-click that just happened may steer this popup: if the popup
    // failed to open, a stale flag must not hijack the next visit.
    if (pending.action === "kimi-export-all" && Date.now() - (pending.at || 0) < 15000) {
      setView("batch");
      if (!chats.length) loadChats();
    }
  }
  void renderJobStrip();
}

main().catch((err) => setError(String((err && err.message) || err)));
