import { checkAbort, sleep, retryAfter, fatal, Semaphore, StorageError } from "./control.js";
import { t } from "./i18n.js";
export async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function stableAssetKey(asset) {
  const identity = asset.fileId || asset.imageId || asset.artifactId;
  return JSON.stringify([
    identity || asset.url || asset.uri || asset.path || "",
    asset.kind || "",
    asset.name || "",
  ]);
}
export function mediaScheduler() {
  return { slots: new Semaphore(4), large: new Semaphore(1) };
}
export async function streamMedia({
  url,
  store,
  path,
  signal,
  fetchBinary = (input, init) => globalThis.fetch(input, init),
  expectedBytes = 0,
  onBytes,
  headMs = 30000,
  idleMs = 60000,
}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  let timer = setTimeout(
    () => controller.abort(new DOMException(t("error.media.timeout"), "TimeoutError")),
    headMs,
  );
  let response;
  try {
    checkAbort(signal);
    response = await fetchBinary(url, {
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const err = new Error(t("error.media.http", { status: response.status }));
      err.status = response.status;
      err.delay = retryAfter(response.headers?.get("Retry-After"));
      throw err;
    }
    const expected = Number(response.headers?.get("Content-Length")) || expectedBytes;
    const reader = response.body.getReader();
    const source = new ReadableStream(
      {
        async pull(c) {
          timer = setTimeout(
            () => controller.abort(new DOMException(t("error.media.stalled"), "TimeoutError")),
            idleMs,
          );
          try {
            const { done, value } = await reader.read();
            clearTimeout(timer);
            if (done) c.close();
            else c.enqueue(value);
          } catch (e) {
            clearTimeout(timer);
            c.error(controller.signal.reason || e);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    const bytes = await store.writeStream(path, source, {
      signal: controller.signal,
      expectedBytes: expected,
      onBytes,
    });
    if (!bytes) throw new Error(t("error.media.empty"));
    return bytes;
  } catch (err) {
    checkAbort(signal);
    if (err.name === "QuotaExceededError") throw new StorageError();
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await response?.body?.cancel().catch(() => {});
  }
}
export async function downloadMedia(opts) {
  const { scheduler, asset, signal, canAccessHost, refreshUrl } = opts;
  const large = !asset.sizeBytes || Number(asset.sizeBytes) > 64 * 1024 * 1024;
  // Reserve the scarce large-file slot before a general slot so small files can proceed.
  const releaseLarge = large ? await scheduler.large.acquire(signal) : () => {};
  let url = asset.url || asset.uri,
    refreshed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      if (!url) throw new Error(t("error.media.noUrl"));
      // A URL that is not absolute http(s) has no host to ask permission for;
      // asking anyway would build an invalid origin pattern and throw.
      const host = fetchableHost(url);
      if (!host) throw new Error(t("error.media.unsupportedUrl", { url }));
      if (!(await canAccessHost(host))) {
        const e = new Error(t("error.media.hostDenied", { host: host || url }));
        e.name = "PermissionError";
        throw e;
      }
      try {
        return await scheduler.slots.use(signal, () =>
          streamMedia({ ...opts, url, expectedBytes: Number(asset.sizeBytes) || 0 }),
        );
      } catch (err) {
        if (fatal(err)) throw err;
        if ((err.status === 401 || err.status === 403) && !refreshed && refreshUrl) {
          refreshed = true;
          const next = await refreshUrl(asset, signal);
          if (next) {
            url = next;
            attempt--;
            continue;
          }
        }
        if (attempt >= 3 || (err.status && err.status !== 429 && err.status < 500)) throw err;
        opts.onRetry?.(attempt + 1);
        await sleep(Math.max(err.delay || 0, 400 * 2 ** attempt) + Math.random() * 200, signal);
      }
    }
  } finally {
    releaseLarge();
  }
}

/** The host of an absolute http(s) URL, or "" when it cannot be downloaded. */
function fetchableHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : "";
  } catch {
    return "";
  }
}
