// Shared harness for the node:test suite. Every export test drives the real
// engine (JobEngine) over in-memory IndexedDB/OPFS stand-ins, so the suite
// covers the same code the extension runs. Archive contents are read with the
// pure-Node ZIP accessor in tools/zip_check.mjs.
import { JobEngine } from "../lib/job-engine.js";
import { newJob } from "../lib/job-db.js";
import { normalizeChat } from "../lib/api.js";
import { optionsWithDefaults } from "../lib/pipeline.js";
import { memoryStore } from "./store-memory.js";
import { memoryDb } from "./helpers-jobs.mjs";
import { LIST_CHATS_PAGES } from "./make-fixtures.mjs";
import { makeApi, makeFetch } from "./mock-api.mjs";
import { readArchive } from "./tools/zip_check.mjs";

export const EXPORT_ROOT = "kimi-export-2026-09-30/";
const EXPORT_DATE = "2026-09-30T04:00:00.000Z";

/** Every chat the mock ListChats returns, de-duplicated by id. */
function fixtureChats() {
  return [
    ...new Map(
      LIST_CHATS_PAGES.flatMap((p) => [...(p.chats || []), ...(p.pinnedChats || [])]).map((c) => [
        c.id,
        normalizeChat(c),
      ]),
    ).values(),
  ];
}

export async function runFullExport(opts = {}) {
  const db = memoryDb();
  const raw = memoryStore();
  const api = makeApi(opts.failChat || null);
  const fetcher = makeFetch();
  const chats = fixtureChats();
  const job = newJob({
    chatIds: opts.chatIds || [],
    chats: opts.chatIds ? chats.filter((c) => opts.chatIds.includes(c.id)) : [],
    options: optionsWithDefaults(opts.options),
    tabId: 7,
    locale: opts.locale || "",
  });
  // With no explicit selection the engine lists chats from the API, exactly
  // like the popup's "导出全部对话" path.
  if (!opts.chatIds) job.allChats = true;
  job.exportDate = EXPORT_DATE;
  job.runId = "run-1";
  await db.createJob(job);

  const engine = new JobEngine({
    db,
    raw,
    job,
    runId: job.runId,
    api,
    signal: opts.signal || new AbortController().signal,
    emit: opts.onProgress || (() => {}),
    canAccessHost: async (host) => !(opts.deniedHosts || []).includes(host),
    fetchBinary: fetcher.fetchBinary,
    volumeBytes: opts.volumeBytes ?? 800 * 1024 * 1024,
  });
  const result = await engine.run();

  const archives = result.artifacts || [];
  const blobs = [];
  for (const a of archives) {
    const blob = await raw.getBlob(a.path);
    blobs.push({ name: a.name, buf: Buffer.from(await blob.arrayBuffer()), bytes: a.bytes });
  }
  const { report, reportMd, errorLog, totals } = engine.summary || {};
  return {
    db,
    api,
    fetcher,
    archives,
    blobs,
    exported: {
      state: result.state,
      report,
      reportMd,
      errorLog,
      totals,
      chatEntries: engine.entries || [],
      options: result.options,
      exportDate: result.exportDate,
      rootDir: engine.rootDir,
    },
  };
}

/** Read an archive's entry list and the text of the requested entries. */
export function inspectZip(buf, ...textOf) {
  const a = readArchive(Buffer.from(buf));
  const texts = new Map();
  for (const name of textOf) texts.set(name, a.text(name));
  return {
    entries: a.names,
    has: (p) => a.names.includes(p),
    text: (p) => {
      if (!texts.has(p)) throw new Error("entry not requested: " + p);
      return texts.get(p);
    },
  };
}

/** Parse a JSON-P file like `window.KIMI_X={...};`. */
export function jsonOf(text) {
  const t = text.trim();
  if (t.charCodeAt(0) === 123) return JSON.parse(t.replace(/;+$/, ""));
  const i = t.lastIndexOf("={");
  return JSON.parse(t.slice(i + 1).replace(/;+$/, ""));
}
