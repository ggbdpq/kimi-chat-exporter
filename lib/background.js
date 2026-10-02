// MV3 service worker only handles short extension calls. The task page owns work.
import { KimiApi, AuthError, readTokensFromTab } from "./api.js";
import { openJobDb, newJob } from "./job-db.js";
import { optionsWithDefaults } from "./pipeline.js";
import { accountKeyFromToken, createChatSync } from "./chat-cache.js";
import { readStoredLocale, resolveLocale, setLocale, t } from "./i18n.js";

// The service worker is short-lived, so it resolves the locale once per wake-up
// and re-reads it whenever the popup's switch writes a new one.
const localeReady = readStoredLocale(chrome.storage.local).then((locale) => setLocale(locale));

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
  if (message.type === "startJob" || message.type === "start") {
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
