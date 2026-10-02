// No credentials belong in this database. Work items are independently committed.
import { t } from "./i18n.js";

const DB_NAME = "kimi-export-jobs";
export const EXECUTOR_LOCK = "kimi-export-executor";
const SCHEMA_VERSION = 1;
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function openJobDb() {
  const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("jobs", { keyPath: "id" });
    const items = db.createObjectStore("items", { keyPath: ["jobId", "key"] });
    items.createIndex("jobId", "jobId");
  };
  const db = await requestResult(request);
  db.onversionchange = () => db.close();
  // The transaction is `txn`, not `t`: `t` is the translator imported above.
  async function tx(stores, mode, work) {
    const txn = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
      txn.oncomplete = resolve;
      txn.onerror = txn.onabort = () => reject(txn.error || new Error(t("error.db.tx")));
    });
    let result;
    try {
      result = await work(txn);
    } catch (err) {
      txn.abort();
      await done.catch(() => {});
      throw err;
    }
    await done;
    return result;
  }
  return {
    close: () => db.close(),
    getJob: (id) =>
      tx(["jobs"], "readonly", (txn) => requestResult(txn.objectStore("jobs").get(id))),
    listJobs: () =>
      tx(["jobs"], "readonly", (txn) => requestResult(txn.objectStore("jobs").getAll())),
    createJob: (job) =>
      tx(["jobs"], "readwrite", (txn) => requestResult(txn.objectStore("jobs").add(job))),
    async updateJob(id, patch, runId) {
      return tx(["jobs"], "readwrite", async (txn) => {
        const s = txn.objectStore("jobs"),
          job = await requestResult(s.get(id));
        if (!job || (runId !== undefined && job.runId !== runId))
          throw new Error(t("error.db.staleRun"));
        Object.assign(job, typeof patch === "function" ? patch(job) : patch, {
          updatedAt: Date.now(),
        });
        s.put(job);
        return job;
      });
    },
    getItem: (jobId, key) =>
      tx(["items"], "readonly", (txn) =>
        requestResult(txn.objectStore("items").get([jobId, key])),
      ),
    listItems: (jobId) =>
      tx(["items"], "readonly", (txn) =>
        requestResult(txn.objectStore("items").index("jobId").getAll(jobId)),
      ),
    async putItem(jobId, runId, item) {
      return tx(["jobs", "items"], "readwrite", async (txn) => {
        const job = await requestResult(txn.objectStore("jobs").get(jobId));
        if (!job || job.runId !== runId) throw new Error(t("error.db.staleRun"));
        const value = { ...item, jobId, updatedAt: Date.now() };
        txn.objectStore("items").put(value);
        return value;
      });
    },
    deleteJob: (id) =>
      tx(["jobs", "items"], "readwrite", async (txn) => {
        txn.objectStore("jobs").delete(id);
        const keys = await requestResult(txn.objectStore("items").index("jobId").getAllKeys(id));
        for (const key of keys) txn.objectStore("items").delete(key);
      }),
  };
}
export function newJob({
  chatIds = [],
  chats = [],
  allChats = false,
  options,
  tabId,
  locale = "",
}) {
  const id = `job-${crypto.randomUUID()}`;
  const targets = [...new Set(chatIds)].map(
    // A missing entry must not masquerade as a name: the task page would show
    // the raw uuid. An empty name makes it fall back to a generic label.
    (chatId) => chats.find((c) => c.id === chatId) || { id: chatId, name: "", files: [] },
  );
  return {
    id,
    version: SCHEMA_VERSION,
    state: "queued",
    runId: "",
    options: { ...options },
    targets,
    // Set when the user asked for the whole history: the engine lists the
    // chats itself so the popup never has to wait for the complete list.
    allChats,
    tabId,
    // The language the export renders in, snapshotted at creation so a resumed
    // run keeps producing the same Markdown/report it started with.
    locale,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    exportDate: new Date().toISOString(),
    artifacts: [],
    progress: null,
    error: null,
  };
}
