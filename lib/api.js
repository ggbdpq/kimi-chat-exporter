import { checkAbort, sleep, Semaphore, timeoutSignal, retryAfter } from "./control.js";
import { t } from "./i18n.js";
export { sleep } from "./control.js";
// Kimi /apiv2 client (gRPC-Gateway + protobuf-es JSON wire format).
//
// Wire conventions observed in the site bundle's embedded proto descriptors:
//   - keys are camelCase
//   - int64/uint64 arrive as strings
//   - enums arrive as their proto value names (sometimes as numbers)
//   - google.protobuf.Timestamp arrives as an RFC3339 string
//   - unset proto3 fields are simply absent

const KIMI_ORIGIN = "https://www.kimi.com";
const RPC_BASE = KIMI_ORIGIN + "/apiv2";

export const SERVICES = {
  listChats: "kimi.chat.v1.ChatService/ListChats",
  listMessages: "kimi.gateway.chat.v1.ChatService/ListMessages",
  getChat: "kimi.gateway.chat.v1.ChatService/GetChat",
  getMessage: "kimi.chat.v1.ChatService/GetMessage",
  getToolBlock: "kimi.chat.v1.ChatService/GetToolBlock",
  getSearchCitation: "kimi.chat.v1.ChatService/GetSearchCitation",
  getFile: "kimi.gateway.chat.v1.FileService/GetFile",
  getAiPpt: "kimi.gateway.chat.v1.FileService/GetAIPPT",
};

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "connect-protocol-version": "1",
  "x-msh-platform": "web",
  "x-language": "zh-CN",
};

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}
export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Read the logged-in session from a Kimi tab. Returns {accessToken, refreshToken}.
 * Uses chrome.scripting against an existing tab so the token never lands on disk.
 */
export async function readTokensFromTab({ tabId } = {}) {
  const tabs = tabId
    ? [await chrome.tabs.get(tabId)]
    : await chrome.tabs.query({ url: "https://www.kimi.com/*" });
  if (!tabs.length) throw new AuthError(t("error.auth.noTab"));

  let lastError = null;
  for (const tab of tabs) {
    if (!tab.id || !/^https:\/\/(www\.)?kimi\.com\//.test(tab.url || "")) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          accessToken: localStorage.getItem("access_token") || "",
          refreshToken: localStorage.getItem("refresh_token") || "",
          loggedIn: Boolean(localStorage.getItem("access_token")),
        }),
      });
      const res = results && results[0] && results[0].result;
      if (res && res.accessToken) return res;
      lastError = new AuthError(t("error.auth.noSession"));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new AuthError(t("error.auth.unreadable"));
}

/**
 * Recover from a transiently missing login tab: read() throws AuthError when
 * no logged-in kimi.com tab answers. Instead of failing the whole export, wait
 * (abortable) and retry so the user can reopen the tab and the job continues.
 * waitsMs schedules the retry pauses; onWait lets the caller surface progress.
 */
export async function withTokenRetry(opts) {
  const { read, waitsMs, sleep, onWait } = opts;
  const total = waitsMs.reduce((a, b) => a + b, 0);
  let lastError;
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof AuthError) || !waitsMs.length) throw err;
    lastError = err;
  }
  for (let i = 0; i < waitsMs.length; i++) {
    if (onWait) onWait({ attempt: i + 1, waitMs: waitsMs[i], totalMs: total });
    await sleep(waitsMs[i]);
    try {
      return await read();
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      if (!(err instanceof AuthError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// The shared gate keeps one request start per interval. The interval adapts:
// consecutive successes shrink it towards THROTTLE_FLOOR_MS, any rate-limit or
// server error doubles it, so a healthy run converges on fast paging while a
// throttled one backs off on its own.
const THROTTLE_FLOOR_MS = 60;
const THROTTLE_DECAY = 0.9;
const THROTTLE_GROWTH = 2;

export class KimiApi {
  constructor(opts) {
    this.getTokens = opts.getTokens;
    // Keep the platform fetch receiver intact. Calling a detached
    // WorkerGlobalScope.fetch as `this.fetch(...)` binds `this` to the API
    // instance and Chrome rejects it with "Illegal invocation".
    this.fetch = opts.fetch
      ? (...args) => opts.fetch(...args)
      : (...args) => globalThis.fetch(...args);
    this.throttleMs = opts.throttleMs ?? 150;
    this.minThrottleMs = opts.minThrottleMs ?? Math.min(this.throttleMs, THROTTLE_FLOOR_MS);
    this.maxThrottleMs = opts.maxThrottleMs ?? Math.max(this.throttleMs * 8, 1200);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.log || (() => {});
    this.accessToken = null;
    this.tokensReadAt = 0;
    this.tokenTtlMs = 60_000;
    this.refreshing = null;
    this.slots = new Semaphore(3);
    this.gate = new Semaphore(1);
    this.nextAt = 0;
    this.cooldownUntil = 0;
  }
  invalidateToken() {
    this.accessToken = null;
    this.tokensReadAt = 0;
  }
  async _token(force, signal, rejectedToken) {
    // A concurrent request may already have refreshed the rejected token.
    if (force && this.accessToken === rejectedToken) this.invalidateToken();
    if (this.accessToken && Date.now() - this.tokensReadAt < this.tokenTtlMs)
      return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const tokens = await this.getTokens({ force, signal });
          if (!tokens.accessToken) throw new AuthError(t("error.auth.loginRequired"));
          this.accessToken = tokens.accessToken;
          this.tokensReadAt = Date.now();
          return tokens.accessToken;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }
  async rpc(serviceMethod, body, { signal, retries = 4 } = {}) {
    let attempt = 0,
      refreshed = false,
      rejectedToken;
    for (;;) {
      checkAbort(signal);
      const token = await this._token(refreshed, signal, rejectedToken);
      const release = await this.slots.acquire(signal);
      let delay = null;
      try {
        await this.gate.use(signal, async () => {
          while (Date.now() < Math.max(this.nextAt, this.cooldownUntil))
            await sleep(Math.max(this.nextAt, this.cooldownUntil) - Date.now(), signal);
          this.nextAt = Date.now() + this.throttleMs;
        });
        const timed = timeoutSignal(signal, this.timeoutMs);
        try {
          const res = await this.fetch(`${RPC_BASE}/${serviceMethod}`, {
            method: "POST",
            headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
            body: JSON.stringify(body ?? {}),
            credentials: "include",
            signal: timed.signal,
          });
          if (res.status === 401 || res.status === 403) {
            await res.body?.cancel();
            if (!refreshed) {
              refreshed = true;
              rejectedToken = token;
              continue;
            }
            throw new AuthError(t("error.auth.invalid"));
          }
          if (res.status === 429 || res.status >= 500) {
            this.throttleMs = Math.min(
              this.maxThrottleMs,
              Math.max(this.throttleMs * THROTTLE_GROWTH, this.throttleMs + 50),
            );
            delay =
              Math.max(retryAfter(res.headers.get("Retry-After")), 400 * 2 ** attempt) +
              Math.random() * 200;
            if (res.status === 429)
              this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
            await res.body?.cancel();
            if (attempt >= retries)
              throw new ApiError(`${serviceMethod} HTTP ${res.status}`, { status: res.status });
          } else if (!res.ok) {
            const text = (await res.text()).slice(0, 300);
            throw new ApiError(`${serviceMethod} HTTP ${res.status}: ${text}`, {
              status: res.status,
            });
          } else {
            const json = await res.json();
            this.throttleMs = Math.max(
              this.minThrottleMs,
              Math.round(this.throttleMs * THROTTLE_DECAY),
            );
            if (json?.code && !("chats" in json) && !("messages" in json))
              throw new ApiError(t("error.api.business", { method: serviceMethod, code: json.code }), {
                code: json.code,
              });
            return json;
          }
        } finally {
          timed.dispose();
        }
      } catch (err) {
        checkAbort(signal);
        if (
          err instanceof AuthError ||
          err instanceof ApiError ||
          attempt >= retries ||
          !["TypeError", "TimeoutError", "AbortError"].includes(err.name)
        )
          throw err;
        delay = 400 * 2 ** attempt + Math.random() * 200;
      } finally {
        release();
      }
      this.log(`${serviceMethod} retry ${attempt + 1}/${retries}`);
      attempt++;
      await sleep(delay, signal);
    }
  }
}

export const LIST_PAGE_SIZE = 100;
export const LIST_PAGE_SIZE_MIN = 50;
export const LIST_PAGE_SIZE_MAX = 200;

export function listChatsBody({ pageSize = LIST_PAGE_SIZE, pageToken = "", query = "" } = {}) {
  return { pageSize, query, includePinned: true, ...(pageToken ? { pageToken } : {}) };
}

/** One ListChats page as normalized chats: `chats` then `pinnedChats`, deduped. */
export function readChatPage(res) {
  const out = [];
  const seen = new Set();
  for (const key of ["chats", "pinnedChats"])
    for (const raw of res?.[key] || []) {
      if (!raw || !raw.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      out.push(normalizeChat(raw));
    }
  return out;
}

/**
 * Full chat list: pages of ListChats plus pinned_chats, de-duplicated by id.
 * The caller may stop the walk early through `onPage` (used by the incremental
 * cache, which knows that everything below the head is already stored).
 * @returns {Promise<{chats: any[], pages: number, pageSize: number, complete: boolean}>}
 */
export async function listAllChats(
  api,
  { pageSize = LIST_PAGE_SIZE, onProgress, onPage, signal, maxPages = 2000 } = {},
) {
  const chats = new Map();
  const seenTokens = new Set();
  let pageToken = "";
  let pages = 0;
  // Ask for the largest page we have seen the endpoint honour, so a server that
  // silently caps pageSize costs one probe instead of one probe per walk.
  let size = pageSize;
  for (;;) {
    const res = await api.rpc(
      SERVICES.listChats,
      listChatsBody({ pageSize: size, pageToken }),
      { signal },
    );
    pages++;
    const pageChats = readChatPage(res);
    for (const chat of pageChats) if (!chats.has(chat.id)) chats.set(chat.id, chat);
    onProgress?.(chats.size, pages, pageChats);
    const next = res?.nextPageToken || "";
    if (next && pageChats.length >= LIST_PAGE_SIZE_MIN)
      size = Math.min(LIST_PAGE_SIZE_MAX, Math.max(LIST_PAGE_SIZE_MIN, pageChats.length));
    if (!next) return { chats: [...chats.values()], pages, pageSize: size, complete: true };
    if (onPage?.(pageChats, { pages, total: chats.size })?.stop)
      return { chats: [...chats.values()], pages, pageSize: size, complete: false };
    if (seenTokens.has(next) || pages >= maxPages)
      throw new ApiError(t("error.api.pageLoop"));
    seenTokens.add(next);
    pageToken = next;
  }
}

export function normalizeChat(c) {
  return {
    id: c.id,
    name: c.name || "",
    projectId: c.projectId || (c.project && c.project.id) || "",
    projectName: c.project && c.project.name ? c.project.name : "",
    model: c.model || "",
    pinned: Boolean(c.pinned),
    createTime: ts(c.createTime),
    updateTime: ts(c.updateTime),
    messageCount: Number(asInt(c.messageCount) || 0) || 0,
    status: c.status || "",
    statusText: c.statusText || "",
    source: c.source || null,
    scenario: c.scenario || null,
    kimiPlus: c.kimiPlus ? { id: c.kimiPlus.id, name: c.kimiPlus.name } : null,
    files: (c.files || []).map(normalizeFile).filter(Boolean),
    raw: c,
  };
}

function normalizeFile(f) {
  if (!f || typeof f !== "object") return null;
  const meta = f.meta || {};
  const blob = f.blob || {};
  return {
    id: f.id || "",
    name: meta.name || "",
    contentType: meta.contentType || "",
    sizeBytes: asInt(meta.sizeBytes),
    ext: meta.ext || "",
    type: enumName(meta.type) || enumName(f.type) || "",
    createTime: ts(meta.createTime),
    signUrl: blob.signUrl || "",
    previewUrl: blob.previewUrl || "",
    parseUrl:
      f.parseResult && f.parseResult.url
        ? f.parseResult.url.url || f.parseResult.url.value || ""
        : "",
    thumbnail: f.parseResult && f.parseResult.thumbnail ? f.parseResult.thumbnail.url || "" : "",
    status: enumName(f.status) || "",
    failReason: f.failReason || "",
    raw: f,
  };
}

export function asInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return 0;
}

export function ts(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.seconds === "number") {
    return new Date(v.seconds * 1000).toISOString();
  }
  if (typeof v === "object" && typeof v.seconds === "string") {
    return new Date(Number(v.seconds) * 1000).toISOString();
  }
  return "";
}

function enumName(v) {
  if (typeof v === "string") return v;
  return "";
}
