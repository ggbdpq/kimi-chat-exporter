// Chat-list cache: the popup paints the history from disk immediately, then the
// walk below fetches only what changed since the last one. Nothing here touches
// chrome.* — the storage adapter is injected, so the whole sync runs in Node.
import {
  SERVICES,
  listChatsBody,
  readChatPage,
  LIST_PAGE_SIZE,
  LIST_PAGE_SIZE_MIN,
  LIST_PAGE_SIZE_MAX,
} from "./api.js";
import { t, tn } from "./i18n.js";

export const CHAT_CACHE_KEY = "chatListCache";
export const CACHE_VERSION = 1;
// Below this age we do not touch the network at all.
export const FRESH_MS = 5 * 60_000;
// A half-finished walk keeps its page token for this long.
export const RESUME_MS = 2 * 60_000;
// At most one full walk per window; everything in between stops early.
export const FULL_WALK_MS = 30 * 60_000;
export const MAX_CACHE_BYTES = 4 * 1024 * 1024;
// If even that is too small for the history, keep this much of the newest end
// so the popup still paints instantly.
export const MIN_CACHE_CHATS = 200;

export function emptyCache(accountKey = "") {
  return {
    version: CACHE_VERSION,
    accountKey,
    chats: [],
    fetchedAt: 0,
    walkedAt: 0,
    complete: false,
    order: "",
    pageSize: LIST_PAGE_SIZE,
    resume: null,
  };
}

export function normalizeCache(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== CACHE_VERSION) return null;
  if (!Array.isArray(raw.chats)) return null;
  return {
    version: CACHE_VERSION,
    accountKey: typeof raw.accountKey === "string" ? raw.accountKey : "",
    chats: raw.chats.filter((c) => c && c.id),
    fetchedAt: Number(raw.fetchedAt) || 0,
    walkedAt: Number(raw.walkedAt) || 0,
    complete: Boolean(raw.complete),
    order: typeof raw.order === "string" ? raw.order : "",
    pageSize: clampPageSize(raw.pageSize),
    resume:
      raw.resume && typeof raw.resume.pageToken === "string" && raw.resume.pageToken
        ? {
            pageToken: raw.resume.pageToken,
            pages: Number(raw.resume.pages) || 0,
            at: Number(raw.resume.at) || 0,
            walked: Number(raw.resume.walked) || 0,
          }
        : null,
  };
}

export function clampPageSize(size) {
  const n = Number(size) || 0;
  if (!n) return 0;
  return Math.min(LIST_PAGE_SIZE_MAX, Math.max(LIST_PAGE_SIZE_MIN, Math.round(n)));
}

/**
 * A list being rebuilt from pages: `walked` is what the pages returned so far
 * (in API order) and `tail` is everything the cache still holds below them.
 */
export function walkList({ walked, tail }) {
  return [...walked, ...tail];
}

/**
 * Fold one more page in. Pages arrive newest-first, so each one appends to the
 * walked part, and any chat it repeats is removed from the tail — which is what
 * makes the union identical to a full walk while one is still in flight.
 */
export function mergeWalk({ walked, tail }, pageChats) {
  if (!pageChats.length) return { walked, tail };
  const seen = new Set(walked.map((c) => c.id));
  const fresh = pageChats.filter((c) => !seen.has(c.id));
  for (const chat of fresh) seen.add(chat.id);
  return { walked: [...walked, ...fresh], tail: tail.filter((c) => !seen.has(c.id)) };
}

/**
 * Has the browser switched accounts? With a token fingerprint we can answer
 * exactly; without one, two lists that share no chat at all are treated as
 * different accounts (ids are globally unique, so overlap is a strong signal).
 */
export function sameAccount(cache, accountKey, pageChats) {
  if (!cache || !cache.chats.length) return true;
  if (cache.accountKey && accountKey) return cache.accountKey === accountKey;
  const known = new Set(cache.chats.map((c) => c.id));
  return pageChats.some((c) => known.has(c.id));
}

export function timeValue(value) {
  let v = value;
  if (v && typeof v === "object") v = v.seconds;
  if (typeof v === "number") return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : 0;
  const text = String(v ?? "");
  if (/^\d+$/.test(text)) return timeValue(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Which timestamp the endpoint sorts by, or "" when neither is monotonic. */
export function verifyOrder(items) {
  if (!items || items.length < 2) return "";
  for (const key of ["updateTime", "createTime"]) {
    let previous = Infinity;
    let ordered = true;
    for (const item of items) {
      const at = timeValue(item?.[key]);
      if (!at || at > previous) {
        ordered = false;
        break;
      }
      previous = at;
    }
    if (ordered) return key;
  }
  return "";
}

export function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return tn("time.minutes", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tn("time.hours", hours);
  return tn("time.days", Math.floor(hours / 24));
}

/**
 * A pseudonymous, non-reversible account fingerprint. Only a short id claim is
 * hashed — the token itself is never stored or logged.
 */
export async function accountKeyFromToken(token) {
  const part = String(token || "").split(".")[1];
  if (!part || !globalThis.crypto?.subtle) return "";
  let claims = null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    claims = JSON.parse(atob(padded));
  } catch {
    return "";
  }
  const id = claims?.sub || claims?.uid || claims?.userId || claims?.user_id || claims?.account_id;
  if (!id) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id)));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Incremental ListChats walk backed by one storage entry.
 * Call `next()` until it reports `done`; every call persists its progress, so a
 * service worker that dies mid-walk resumes from the last page token.
 */
export function createChatSync({
  storage,
  api,
  accountKey = "",
  now = () => Date.now(),
  maxPages = 2000,
  maxCacheBytes = MAX_CACHE_BYTES,
  log = () => {},
}) {
  let run = null;

  async function readCache() {
    try {
      return normalizeCache((await storage.get(CHAT_CACHE_KEY))[CHAT_CACHE_KEY]);
    } catch (err) {
      log(`chat cache read failed: ${err?.message || err}`);
      return null;
    }
  }

  async function write(entry) {
    try {
      await storage.set({ [CHAT_CACHE_KEY]: entry });
      return true;
    } catch (err) {
      // A full disk must never break listing; the cache is only an accelerator.
      log(`chat cache write failed: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Store the cache, shrinking it if the history does not fit. A partial cache
   * still gives the instant first paint, but it is marked incomplete (and drops
   * its resume token) so the next refresh rebuilds the whole list.
   */
  async function persist(entry) {
    if (JSON.stringify(entry).length <= maxCacheBytes) return write(entry);
    let keep = entry.chats.length;
    while (keep > MIN_CACHE_CHATS) {
      keep = Math.max(MIN_CACHE_CHATS, Math.floor(keep / 2));
      const trimmed = { ...entry, chats: entry.chats.slice(0, keep), complete: false, resume: null };
      if (JSON.stringify(trimmed).length <= maxCacheBytes) {
        log(`chat cache trimmed to the newest ${keep} chats`);
        return write(trimmed);
      }
    }
    log("chat cache exceeds the size budget, keeping it in memory only");
    return false;
  }

  function start(cache, force) {
    const resumable =
      Boolean(cache?.resume) &&
      cache.accountKey === accountKey &&
      now() - cache.resume.at < RESUME_MS &&
      !force;
    // On a resume the first `resume.walked` entries came from the pages this
    // walk already fetched; everything after them is the untouched tail.
    const merged = resumable ? Math.min(cache.resume.walked, cache?.chats?.length || 0) : 0;
    const walked = cache?.chats ? cache.chats.slice(0, merged) : [];
    const tail = cache?.chats ? cache.chats.slice(merged) : [];
    const known = new Set([...walked, ...tail].map((c) => c.id));
    // `force` only bypasses the freshness shortcut and a stale resume token; an
    // up-to-date cache still stops at the first already-known page, so the
    // refresh button never has to walk the whole history. Rebuilding the list
    // from scratch (which is what drops deleted chats) stays on the periodic
    // FULL_WALK_MS cadence.
    const incremental =
      !resumable &&
      Boolean(cache?.complete && cache.order) &&
      now() - cache.walkedAt < FULL_WALK_MS;
    return {
      resumable,
      fetched: 0,
      pages: resumable ? cache.resume.pages : 0,
      pageToken: resumable ? cache.resume.pageToken : "",
      pageSize: clampPageSize(cache?.pageSize) || LIST_PAGE_SIZE,
      chats: walkList({ walked, tail }),
      known,
      tail,
      // Snapshot of what the cache already had: page ids are added to `known`
      // as we go, so the early-stop test must not look at the live set.
      cached: new Set(known),
      incremental,
      verifyOrder: !resumable,
      orderItems: [],
      walked,
      walkedAt: cache?.walkedAt || 0,
      complete: Boolean(cache?.complete),
      order: cache?.order || "",
      accountChanged: false,
    };
  }

  return {
    /** What we can show before touching the network. */
    async peek() {
      const cache = await readCache();
      return {
        chats: cache?.chats || [],
        count: cache?.chats?.length || 0,
        complete: Boolean(cache?.complete),
        ageMs: cache ? now() - cache.fetchedAt : 0,
        fresh: Boolean(cache?.complete) && now() - cache.fetchedAt < FRESH_MS,
        pageSize: cache?.pageSize || LIST_PAGE_SIZE,
      };
    },

    reset() {
      run = null;
    },

    /** Fetch (or resume) one page and merge it into the cache. */
    async next({ force = false, signal } = {}) {
      const cache = run ? null : await readCache();
      if (!run) run = start(cache, force);

      const page = await api.rpc(
        SERVICES.listChats,
        listChatsBody({ pageSize: run.pageSize, pageToken: run.pageToken }),
        { signal },
      );
      const pageChats = readChatPage(page);
      const pageIds = pageChats.map((c) => c.id);

      if (run.fetched === 0 && !run.resumable && !sameAccount(cache, accountKey, pageChats)) {
        log("chat list belongs to a different account, dropping the cache");
        run.accountChanged = true;
        run.chats = [];
        run.walked = [];
        run.tail = [];
        run.known = new Set();
        run.cached = new Set();
        run.incremental = false;
        run.complete = false;
        run.order = "";
        run.orderItems = [];
      }

      run.fetched++;
      run.pages++;
      const added = pageChats.filter((c) => !run.known.has(c.id));
      // The union keeps the untouched tail visible while a walk is in flight;
      // a walk that reaches the end is authoritative and replaces it.
      const mergedPage = mergeWalk({ walked: run.walked, tail: run.tail }, pageChats);
      run.walked = mergedPage.walked;
      run.tail = mergedPage.tail;
      run.chats = walkList(mergedPage);
      for (const id of pageIds) run.known.add(id);
      if (!run.incremental) run.orderItems.push(...(page?.chats || []));

      const nextToken = page?.nextPageToken || "";
      if (nextToken && pageChats.length >= LIST_PAGE_SIZE_MIN)
        run.pageSize = Math.min(
          LIST_PAGE_SIZE_MAX,
          Math.max(LIST_PAGE_SIZE_MIN, pageChats.length),
        );

      // Stop as soon as a whole page is already cached: with a verified sort
      // order that means nothing above the boundary changed.
      const knownOnly =
        run.incremental && pageIds.length > 0 && pageIds.every((id) => run.cached.has(id));
      const overBudget = Boolean(nextToken) && !knownOnly && run.pages >= maxPages;
      const done = !nextToken || knownOnly || overBudget;

      if (!nextToken) {
        // Reaching the end makes this walk authoritative: anything the server
        // no longer returns is dropped instead of lingering from the cache.
        run.tail = [];
        run.chats = run.walked;
        run.complete = true;
        run.walkedAt = now();
        if (run.verifyOrder) run.order = verifyOrder(run.orderItems);
      } else if (overBudget) {
        run.complete = false;
      }

      const entry = {
        version: CACHE_VERSION,
        accountKey,
        chats: run.chats,
        fetchedAt: now(),
        walkedAt: run.walkedAt,
        complete: run.complete,
        order: run.order,
        pageSize: run.pageSize,
        resume: done
          ? null
          : { pageToken: nextToken, pages: run.pages, at: now(), walked: run.walked.length },
      };
      await persist(entry);

      const result = {
        // A finished walk hands back the authoritative list so the caller can
        // drop anything the server no longer returns; a page in flight hands
        // back the page itself so the caller folds it in the same way.
        chats: done ? run.chats : pageChats,
        replace: done,
        added: added.length,
        total: run.chats.length,
        pages: run.pages,
        pageSize: run.pageSize,
        done,
        complete: run.complete,
        order: run.order,
        accountChanged: run.accountChanged,
      };
      if (done) run = null;
      else run.pageToken = nextToken;
      return result;
    },
  };
}
