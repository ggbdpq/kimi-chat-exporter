import { openJobDb } from "./job-db.js";
import { opfsStore, requireSpace } from "./opfs.js";
import { KimiApi, AuthError, withTokenRetry } from "./api.js";
import { sleep, checkAbort } from "./control.js";
import { JobEngine } from "./job-engine.js";
import { DEFAULT_LOCALE, setLocale, t } from "./i18n.js";
let current = null,
  serial = 0;
const pending = new Map();
function bridge(action, payload, signal) {
  checkAbort(signal);
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      pending.delete(id);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    pending.set(id, {
      resolve,
      reject,
      dispose: () => signal?.removeEventListener("abort", cancel),
    });
    postMessage({
      type: "bridge",
      id,
      action,
      payload,
      jobId: current.jobId,
      runId: current.runId,
    });
  });
}
self.onmessage = async ({ data }) => {
  if (data.type === "bridgeResult") {
    if (!current || data.jobId !== current.jobId || data.runId !== current.runId) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    p.dispose();
    if (data.error) {
      const e = data.name === "AuthError" ? new AuthError(data.error) : new Error(data.error);
      p.reject(e);
    } else p.resolve(data.value);
    return;
  }
  if (data.type === "pauseJob" && current?.jobId === data.jobId && current.runId === data.runId) {
    // An explicit reason keeps "signal is aborted without reason" out of any
    // message that outlives the pause.
    current.controller.abort(new DOMException("Paused", "AbortError"));
    return;
  }
  if (data.type === "skipItem" && current?.jobId === data.jobId && current.runId === data.runId) {
    current.engine?.skipItem(data.key);
    return;
  }
  if (data.type !== "run" || current) return;
  const controller = new AbortController();
  current = { jobId: data.jobId, runId: data.runId, controller };
  let db;
  try {
    db = await openJobDb();
    const job = await db.getJob(data.jobId);
    // This worker has no chrome.* (see the header), so the task page's choice
    // drives the strings emitted before the job is read.
    setLocale(data.locale || DEFAULT_LOCALE);
    if (!job || job.runId !== data.runId) throw new Error(t("error.db.staleRun"));
    // The job's own snapshot wins over the page's current choice.
    if (job.locale) setLocale(job.locale);
    const signal = controller.signal;
    const api = new KimiApi({
      getTokens: () =>
        withTokenRetry({
          read: () => bridge("readTokens", { tabId: job.tabId }, signal),
          waitsMs: [5000, 10000, 20000, 40000, 60000],
          sleep: (ms) => sleep(ms, signal),
          onWait: (info) => {
            const message = t("error.auth.waitLogin", {
              seconds: info.waitMs / 1000,
              attempt: info.attempt,
            });
            // Report through the engine so the page receives a complete snapshot:
            // a partial object would blank the ledger and the active list while
            // the run waits for the user to log back in.
            if (current?.engine) current.engine.progressEvent({ phase: "waiting-login", message }, true);
            else
              postMessage({
                type: "progress",
                jobId: job.id,
                runId: data.runId,
                progress: { phase: "waiting-login", message },
              });
          },
        }),
    });
    const raw = await opfsStore(job.id),
      hosts = new Map();
    const engine = new JobEngine({
      db,
      raw,
      job,
      runId: data.runId,
      api,
      signal,
      retry: data.retry,
      requireSpace,
      emit: (message) => postMessage(message),
      canAccessHost: async (host) => {
        if (!hosts.has(host)) hosts.set(host, await bridge("canAccessHost", { host }, signal));
        return hosts.get(host);
      },
    });
    current.engine = engine;
    await engine.run({ resume: data.resume });
  } catch (err) {
    const paused = controller.signal.aborted;
    if (db)
      await db
        .updateJob(
          data.jobId,
          {
            state: paused ? "paused" : "failed",
            error: paused ? null : String(err.message || err),
          },
          data.runId,
        )
        .catch(() => {});
    postMessage({
      type: "settled",
      jobId: data.jobId,
      runId: data.runId,
      error: paused ? "" : String(err.message || err),
    });
  } finally {
    db?.close();
    for (const p of pending.values()) {
      p.dispose();
      p.reject(new DOMException("Aborted", "AbortError"));
    }
    pending.clear();
    current = null;
  }
};
