// MV3 service worker only handles short extension calls. The task page owns work.
import { KimiApi, AuthError, readTokensFromTab } from "./api.js";
import { openJobDb, newJob } from "./job-db.js";
import { optionsWithDefaults } from "./pipeline.js";
import { accountKeyFromToken, createChatSync } from "./chat-cache.js";
import { readStoredLocale, resolveLocale, setLocale, t } from "./i18n.js";

// The service worker is short-lived, so it resolves the locale once per wake-up
// and re-reads it whenever the popup's switch writes a new one.
const localeReady = readStoredLocale(chrome.storage.local).then((locale) => setLocale(locale));

// An export the popup has already described but cannot start yet, because the
// optional media-host permission is still being asked for. Chrome can close the
// popup while it shows that dialog, so the intent is parked here first and the
// grant itself starts the export. Session storage is in-memory: it survives a
// service-worker restart during the dialog but never reaches disk.
const PENDING_EXPORT_KEY = "pendingExport";
// Long enough for a slow decision in the permission dialog, short enough that a
// forgotten intent cannot start a surprise export much later.
const PENDING_EXPORT_TTL_MS = 300000;
let pendingExport = null;
// One in-flight start per pending id: the popup and the permission listener can
// both ask, and only one job may be created.
const startingExports = new Map();

async function parkPendingExport(pending) {
  pendingExport = pending;
  await chrome.storage.session.set({ [PENDING_EXPORT_KEY]: pending });
}

/** Take (and forget) the parked export, unless it is stale or not the one asked for. */
async function takePendingExport(id = "") {
  if (!pendingExport)
    pendingExport = (await chrome.storage.session.get(PENDING_EXPORT_KEY))[PENDING_EXPORT_KEY] || null;
  const pending = pendingExport;
  if (!pending || (id && pending.id !== id)) return null;
  pendingExport = null;
  await chrome.storage.session.remove(PENDING_EXPORT_KEY);
  return Date.now() - (pending.at || 0) > PENDING_EXPORT_TTL_MS ? null : pending;
}

async function createJob(message) {
  const db = await openJobDb();
  try {
    const job = newJob({
      chatIds: message.chatIds || [],
      chats: message.chats || [],
      allChats: Boolean(message.allChats),
      options: optionsWithDefaults(message.options),
      tabId: message.tabId,
      locale: message.locale,
    });
    // "Everything" does not need the popup to finish listing: the engine
    // walks the list itself and reports progress while it does.
    if (!job.targets.length && !job.allChats) throw new Error(t("error.bg.noTargets"));
    await db.createJob(job);
    await openTasks(job.id, true);
    return { ok: true, jobId: job.id };
  } finally {
    db.close();
  }
}

/** Start the parked export once; a second ask (popup plus grant) starts nothing. */
async function startPendingExport(id = "") {
  const key = id || "pending";
  const running = startingExports.get(key);
  if (running) return running;
  const run = (async () => {
    const pending = await takePendingExport(id);
    if (!pending) return { ok: true, jobId: "" };
    return createJob(pending.intent);
  })();
  startingExports.set(key, run);
  try {
    return await run;
  } finally {
    startingExports.delete(key);
  }
}

async function readTokens(tabId) {
  const preferred = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const others = await chrome.tabs.query({ url: ["https://www.kimi.com/*", "https://kimi.com/*"] });
  const tabs = [
    ...(preferred && /^https:\/\/(www\.)?kimi\.com\//.test(preferred.url || "") ? [preferred] : []),
    ...others.filter((other) => other.id !== preferred?.id),
  ];
  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "kimi:readTokens" });
      if (result?.accessToken) return result;
    } catch {
      /* Content script unavailable; injection is the fallback. */
    }
    try {
      const result = await readTokensFromTab({ tabId: tab.id });
      if (result.accessToken) return result;
    } catch {
      /* try another tab */
    }
  }
  throw new AuthError(t("error.auth.loginTab"));
}
let opening;
async function openTasks(jobId = "", start = false) {
  if (opening) await opening;
  opening = (async () => {
    const url = chrome.runtime.getURL("tasks.html");
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    const hash = jobId
      ? `#${new URLSearchParams({ jobId, ...(start ? { start: "1" } : {}) })}`
      : "";
    if (tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true, ...(hash ? { url: url + hash } : {}) });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else await chrome.tabs.create({ url: url + hash });
  })();
  try {
    await opening;
  } finally {
    opening = null;
  }
}
// One listing session per Kimi tab: the API instance keeps its token cache and
// its adaptive request interval, and the sync keeps the page cursor.
let listing = null;
async function listingSession(tabId, { force = false } = {}) {
  if (listing && listing.tabId === tabId && !force) return listing;
  listing?.sync.reset();
  listing = null;
  const tokens = await readTokens(tabId);
  const api = new KimiApi({ getTokens: () => readTokens(tabId) });
  listing = {
    tabId,
    api,
    sync: createChatSync({
      storage: chrome.storage.local,
      api,
      accountKey: await accountKeyFromToken(tokens.accessToken).catch(() => ""),
      log: (line) => console.debug("[kimi-export]", line),
    }),
  };
  return listing;
}

async function handleMessage(message) {
  if (message.type === "readTokens") return { ok: true, ...(await readTokens(message.tabId)) };
  if (message.type === "listChatsBegin") {
    // Always start a clean session here: this is where the login token and the
    // account fingerprint are read, and the walk itself then reuses it.
    const { sync } = await listingSession(message.tabId, { force: true });
    const peek = await sync.peek();
    return { ok: true, ...peek };
  }
  if (message.type === "listChatsNext") {
    const session = await listingSession(message.tabId);
    return { ok: true, ...(await session.sync.next({ force: Boolean(message.force) })) };
  }
  if (message.type === "openTasks") {
    await openTasks();
    return { ok: true };
  }
  if (message.type === "startJob" || message.type === "start") return createJob(message);
  // Parked while the popup asks for the media-host permission (see above).
  if (message.type === "parkExport") {
    await parkPendingExport({
      id: message.pendingId,
      at: Date.now(),
      intent: message.intent || {},
    });
    return { ok: true };
  }
  if (message.type === "startExport") return startPendingExport(message.pendingId);
  if (message.type === "dropExport") {
    await takePendingExport(message.pendingId);
    return { ok: true };
  }
  throw new Error(t("error.bg.unknown"));
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  (async () => {
    try {
      await localeReady;
      respond(await handleMessage(message));
    } catch (err) {
      respond({ ok: false, error: String(err.message || err), name: err.name });
    }
  })();
  return true;
});
// The popup is usually gone by the time the user approves the media permission,
// so the parked export is started from the grant as well. Either path may win;
// `startPendingExport` makes sure only one job is created.
chrome.permissions.onAdded.addListener(() => {
  void (async () => {
    if (!(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) return;
    await startPendingExport();
  })().catch(() => {});
});
function registerMenus() {
  return localeReady.then(() => {
    chrome.contextMenus.removeAll(() => {
      for (const [id, title] of [
        ["kimi-export-current", t("bg.menu.exportCurrent")],
        ["kimi-export-all", t("bg.menu.exportAll")],
      ])
        chrome.contextMenus.create({
          id,
          title,
          contexts: ["page"],
          documentUrlPatterns: ["https://www.kimi.com/*"],
        });
    });
  });
}
chrome.runtime.onInstalled.addListener(() => void registerMenus());
chrome.runtime.onStartup.addListener(() => void registerMenus());
// The switch lives in the popup, so a live worker keeps its menu in step.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.locale) return;
  setLocale(resolveLocale(changes.locale.newValue));
  void registerMenus();
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Stamp the click: a popup only honours a flag it was opened by.
  await chrome.storage.local.set({
    pendingMenu: { action: info.menuItemId, tabId: tab.id, at: Date.now() },
  });
  await chrome.action.openPopup().catch(() => openTasks());
});
