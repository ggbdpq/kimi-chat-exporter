// Shared cancellation, bounded scheduling and failure classification.
import { t } from "./i18n.js";

const abortError = () => new DOMException("Aborted", "AbortError");
export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || abortError();
}
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || abortError());
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal.reason || abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
export class StorageError extends Error {
  constructor(message = t("error.control.noSpace")) {
    super(message);
    this.name = "StorageError";
  }
}
export class SkipError extends Error {
  constructor() {
    super(t("error.control.userSkip"));
    this.name = "SkipError";
  }
}
export function fatal(err) {
  return ["AbortError", "AuthError", "StorageError", "QuotaExceededError", "SkipError"].includes(
    err?.name,
  );
}
export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, (Date.parse(value) || now) - now);
}
export function timeoutSignal(parent, ms) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason || abortError());
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(t("error.control.timeout"), "TimeoutError")),
    ms,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}
export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  acquire(signal) {
    checkAbort(signal);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, cancel: null };
      item.cancel = () => {
        this.queue = this.queue.filter((x) => x !== item);
        reject(signal.reason || abortError());
      };
      signal?.addEventListener("abort", item.cancel, { once: true });
      this.queue.push(item);
    });
  }
  release() {
    const item = this.queue.shift();
    if (item) {
      item.signal?.removeEventListener("abort", item.cancel);
      item.resolve(this.release.bind(this));
    } else this.active--;
  }
  async use(signal, fn) {
    const release = await this.acquire(signal);
    try {
      checkAbort(signal);
      return await fn();
    } finally {
      release();
    }
  }
}
// Wait for every active worker to settle before propagating a failure.
export async function pool(items, limit, worker, signal) {
  let index = 0,
    firstError;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length && !firstError) {
        try {
          checkAbort(signal);
          const i = index++;
          await worker(items[i], i);
        } catch (err) {
          firstError ||= err;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  checkAbort(signal);
}
