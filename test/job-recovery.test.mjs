import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers-jobs.mjs";
import { memoryStore } from "./store-memory.js";
import { checkpointStore } from "../lib/checkpoints.js";
import { newJob } from "../lib/job-db.js";
import { JobEngine } from "../lib/job-engine.js";
import { optionsWithDefaults } from "../lib/pipeline.js";
import { makeApi } from "./mock-api.mjs";
import { LIST_CHATS_PAGES, MEDIA } from "./make-fixtures.mjs";
import { normalizeChat } from "../lib/api.js";
import { readArchive } from "./tools/zip_check.mjs";
async function fixture() {
  const db = memoryDb(),
    raw = memoryStore(),
    api = makeApi();
  const rpc = api.rpc.bind(api);
  api.rpc = async (method, body, opts) => {
    if (method.endsWith("ListMessages") && body.chatId === "c1" && body.pageSize !== 1) {
      const result = await rpc(method, { ...body, pageToken: "" }, opts);
      api.calls.at(-1).body = body;
      if (body.pageToken) return { messages: result.messages.slice(3), nextPageToken: "" };
      return { messages: result.messages.slice(0, 3), nextPageToken: "second" };
    }
    return rpc(method, body, opts);
  };
  const chat = normalizeChat(LIST_CHATS_PAGES[0].chats.find((c) => c.id === "c1"));
  const job = newJob({ chatIds: ["c1"], chats: [chat], options: optionsWithDefaults() });
  job.runId = "run1";
  await db.createJob(job);
  const fetched = [];
  const deps = {
    db,
    raw,
    job,
    runId: job.runId,
    api,
    signal: new AbortController().signal,
    canAccessHost: async () => true,
    fetchBinary: async (url) => {
      fetched.push(url);
      const m = MEDIA[url];
      return m
        ? new Response(new Uint8Array(m.bytes), { headers: { "Content-Type": m.type } })
        : new Response("", { status: 403 });
    },
  };
  return { db, raw, api, job, fetched, deps };
}
test("closed files publish atomically; uncommitted files are never reused", async () => {
  const f = await fixture(),
    store = checkpointStore(f.raw, f.db, f.job.id, "run1", f.deps.signal);
  const w = await store.openWriter("sample");
  await w.write(new Uint8Array([1, 2]));
  assert.equal(await store.exists("sample"), false);
  await w.close();
  assert.equal(await store.size("sample"), 2);
  const item = await store.file("sample");
  await f.raw.remove(item.path);
  assert.equal(await store.exists("sample"), false);
});
test("a completed run uses real checkpoints and emits a readable streamed ZIP", async () => {
  const f = await fixture(),
    progress = [];
  const result = await new JobEngine({ ...f.deps, emit: (e) => progress.push(e) }).run();
  assert.ok(["completed", "completed-with-errors"].includes(result.state), result.error);
  assert.equal(result.artifacts.length, 1);
  const a = readArchive(
    Buffer.from(await (await f.raw.getBlob(result.artifacts[0].path)).arrayBuffer()),
  );
  assert.ok(a.names.some((n) => n.endsWith("/raw/c1.json")));
  assert.ok(!f.api.calls.some((c) => c.method.endsWith("ListChats")));
  assert.equal(progress.filter((e) => e.type === "progress").at(-1).progress.phase, "ready");
  assert.equal((await f.db.listItems(f.job.id)).filter((i) => i.kind === "page").length, 2);
});
test("resume reuses completed messages, resources and archive without refetching", async () => {
  const f = await fixture();
  await new JobEngine(f.deps).run();
  const calls = f.api.calls.length,
    media = f.fetched.length;
  const job = await f.db.updateJob(f.job.id, { runId: "run2" });
  const result = await new JobEngine({ ...f.deps, job, runId: "run2" }).run({ resume: true });
  assert.ok(result.state.startsWith("completed"), result.error);
  assert.equal(f.api.calls.length - calls, 1); // access preflight only
  assert.equal(f.fetched.length, media);
});
test("missing completed asset is requeued, while healthy assets are reused", async () => {
  const f = await fixture();
  await new JobEngine(f.deps).run();
  const items = await f.db.listItems(f.job.id),
    asset = items.find((i) => i.kind === "asset" && i.state === "done");
  const file = items.find((i) => i.key === `file:${asset.file}`);
  await f.raw.remove(file.path);
  const media = f.fetched.length,
    job = await f.db.updateJob(f.job.id, { runId: "run2" });
  const result = await new JobEngine({ ...f.deps, job, runId: "run2" }).run({ resume: true });
  assert.ok(result.state.startsWith("completed"), result.error);
  assert.equal(f.fetched.length, media + 1);
});
test("resuming continues the ledger instead of flashing back to zero", async () => {
  const N = 6;
  const targets = Array.from({ length: N }, (_, i) => ({
    id: `ledger-${i}`,
    name: `示例 ${i}`,
    files: [],
  }));
  const setup = async () => {
    const db = memoryDb(),
      raw = memoryStore(),
      api = makeApi();
    const job = newJob({
      chatIds: targets.map((c) => c.id),
      chats: targets,
      options: optionsWithDefaults(),
    });
    job.runId = "run1";
    await db.createJob(job);
    return {
      db,
      raw,
      job,
      deps: {
        db,
        raw,
        job,
        runId: job.runId,
        api,
        signal: new AbortController().signal,
        canAccessHost: async () => true,
      },
    };
  };
  // Control: one uninterrupted run, for the finished byte total.
  const control = await setup();
  const full = await new JobEngine(control.deps).run();
  assert.ok(full.state.startsWith("completed"), full.error);

  const f = await setup();
  const ac = new AbortController();
  const original = f.db.putItem;
  let published = 0;
  f.db.putItem = async (...args) => {
    const result = await original(...args);
    if (args[2]?.kind === "chat" && args[2].state === "done" && ++published === 2) ac.abort();
    return result;
  };
  const paused = await new JobEngine({ ...f.deps, signal: ac.signal }).run();
  f.db.putItem = original;
  assert.equal(paused.state, "paused");
  assert.ok(paused.progress.chatsDone >= 2, "the pause must happen after real progress");
  assert.ok(paused.progress.chatsDone < N, "the paused run must be unfinished");
  assert.ok(paused.progress.bytes > 0);
  assert.ok(paused.progress.rate > 0, "the paused run must report a transfer rate");

  const job2 = await f.db.updateJob(f.job.id, { runId: "run2" });
  const seen = [];
  const resumed = await new JobEngine({
    ...f.deps,
    job: job2,
    runId: "run2",
    emit: (event) => {
      if (event.type === "progress" && event.progress) seen.push({ ...event.progress });
    },
  }).run({ resume: true });
  assert.ok(resumed.state.startsWith("completed"), resumed.error);
  assert.ok(seen.length, "the resumed run must report progress");
  assert.equal(seen[0].rate, paused.progress.rate, "the rate must continue, not reset");
  // Re-walking the finished chats must not replay the counters.
  for (const p of seen) {
    assert.ok(p.chatsDone >= paused.progress.chatsDone, `chatsDone fell back to ${p.chatsDone}`);
    assert.ok(p.bytes >= paused.progress.bytes, `bytes fell back to ${p.bytes}`);
  }
  assert.equal(resumed.progress.chatsDone, N, "every chat is counted exactly once");
  assert.equal(resumed.progress.bytes, full.progress.bytes, "the ledger ends at the real total");
});

test("resuming probes only a few targets before the real work starts", async () => {
  const db = memoryDb(),
    raw = memoryStore(),
    api = makeApi();
  const targets = Array.from({ length: 12 }, (_, i) => ({
    id: `probe-${i}`,
    name: `示例 ${i}`,
    files: [],
  }));
  const job = newJob({
    chatIds: targets.map((c) => c.id),
    chats: targets,
    options: optionsWithDefaults({ downloadMedia: false }),
  });
  job.runId = "run1";
  await db.createJob(job);
  const result = await new JobEngine({
    db,
    raw,
    job,
    runId: job.runId,
    api,
    signal: new AbortController().signal,
    canAccessHost: async () => true,
  }).run({ resume: true });
  assert.ok(result.state.startsWith("completed"), result.error);
  const listCalls = api.calls.filter((c) => c.method.endsWith("ListMessages"));
  // The resume pre-check reads one page (pageSize 1) of a few targets; probing
  // every target turns "validating" into one throttled request per chat.
  const probes = listCalls.filter((c) => c.body.pageSize === 1);
  assert.ok(probes.length <= 3, `resuming probed ${probes.length} of ${targets.length} chats`);
  // The export itself still walks every chat.
  assert.equal(listCalls.filter((c) => c.body.pageSize === 200).length, targets.length);
});

test("abort after one page commit resumes only the remaining pages", async () => {
  const f = await fixture(),
    ac = new AbortController(),
    original = f.db.putItem;
  f.db.putItem = async (...args) => {
    const r = await original(...args);
    if (args[2].kind === "page") ac.abort();
    return r;
  };
  const paused = await new JobEngine({ ...f.deps, signal: ac.signal }).run();
  assert.equal(paused.state, "paused");
  // Pausing is not a failure: the abort reason must not become the job's error,
  // or the task page shows a red alert for a deliberate stop.
  assert.equal(paused.error, null, `paused jobs must stay error-free, got "${paused.error}"`);
  f.db.putItem = original;
  const calls = f.api.calls.length,
    job = await f.db.updateJob(f.job.id, { runId: "run2" });
  const result = await new JobEngine({ ...f.deps, job, runId: "run2" }).run({ resume: true });
  assert.ok(result.state.startsWith("completed"), result.error);
  const newCalls = f.api.calls.slice(calls).filter((c) => c.method.endsWith("ListMessages"));
  assert.equal(newCalls.length, 2);
  assert.equal(newCalls[0].body.pageSize, 1);
  assert.ok(newCalls[1].body.pageToken);
});
/** Two chats that both carry media, so a retry can be told to leave one alone. */
async function twoChatFixture() {
  const db = memoryDb(),
    raw = memoryStore(),
    api = makeApi();
  const chats = ["c1", "c2"].map((id) =>
    normalizeChat(LIST_CHATS_PAGES[0].chats.find((c) => c.id === id)),
  );
  const job = newJob({ chatIds: chats.map((c) => c.id), chats, options: optionsWithDefaults() });
  job.runId = "run1";
  await db.createJob(job);
  const fetched = [];
  const fetchBinary = async (url) => {
    fetched.push(url);
    const media = MEDIA[url];
    return media
      ? new Response(new Uint8Array(media.bytes), { headers: { "Content-Type": media.type } })
      : new Response("", { status: 403 });
  };
  const deps = {
    db,
    raw,
    job,
    runId: job.runId,
    api,
    signal: new AbortController().signal,
    canAccessHost: async () => true,
    fetchBinary,
  };
  return { db, raw, api, job, fetched, fetchBinary, deps };
}
/**
 * Record the records a run looks up *while it works* (packing reads every chat's
 * files by design, so those are excluded). Pair the reads with the exact keys of
 * a chat (see `chatKeys`) — hex digests can contain "c2", so a plain substring
 * match would be flaky.
 */
function watchReads(db) {
  const reads = [],
    original = db.getItem.bind(db);
  let packing = false;
  db.getItem = async (jobId, key) => {
    if (!packing) reads.push(key);
    return original(jobId, key);
  };
  return {
    reads,
    onProgress: (event) => {
      if (event.type === "progress" && event.progress?.phase === "packing") packing = true;
    },
    restore: () => (db.getItem = original),
  };
}
/** Exact keys that only a walk of `chatId` would look up. */
function chatKeys(chatId, entry) {
  return new Set([
    `chat:${chatId}`,
    `pages:${chatId}`,
    ...(entry?.files || []).map((f) => `file:${f.storePath}`),
    ...(entry?.assetPaths || []).map((p) => `file:${p}`),
  ]);
}
function belongsTo(key, chatId, keys) {
  return (
    keys.has(key) ||
    key.startsWith(`page:${chatId}:`) ||
    key.startsWith(`rpc:${chatId}:`) ||
    key.startsWith(`asset:${chatId}:`)
  );
}
/** A c1 asset, failed on the first run so the retry target is deterministic. */
const C1_BROKEN = "https://cdn.example.com/img/table-full.png";
async function twoChatRetry({ retry = null } = {}) {
  const f = await twoChatFixture();
  const deps = {
    ...f.deps,
    fetchBinary: async (url) =>
      url === C1_BROKEN ? new Response("", { status: 404 }) : f.fetchBinary(url),
  };
  const first = await new JobEngine(deps).run();
  assert.equal(first.state, "completed-with-errors");
  const failed = (await f.db.listItems(f.job.id)).find((i) => i.kind === "asset" && i.state === "failed");
  assert.equal(failed?.chatId, "c1", "the broken asset must belong to c1");
  const baseline = f.fetched.length,
    c2Keys = chatKeys("c2", (await f.db.getItem(f.job.id, "chat:c2")).entry),
    watch = watchReads(f.db),
    job = await f.db.updateJob(f.job.id, { runId: "run2" });
  const second = await new JobEngine({
    ...deps,
    job,
    runId: "run2",
    fetchBinary: f.fetchBinary,
    retry: retry || { key: failed.key },
    emit: watch.onProgress,
  }).run({ resume: true });
  watch.restore();
  return { ...f, failed, second, reads: watch.reads, baseline, c2Keys };
}
test("retrying one asset only reprocesses the chat that carries it", async () => {
  const f = await twoChatRetry();
  assert.equal(f.fetched.length, f.baseline + 1, "only the retried asset downloads again");
  assert.equal(f.fetched.at(-1), C1_BROKEN);
  assert.equal((await f.db.getItem(f.job.id, f.failed.key)).state, "done");
  assert.equal(
    f.reads.filter((key) => belongsTo(key, "c2", f.c2Keys)).length,
    0,
    "the untouched chat must not be re-validated",
  );
  assert.equal(f.second.state, "completed");
  assert.equal(f.second.progress.chatsDone, 2, "both chats still count in the ledger");
  assert.equal(f.second.totals.chats, 2);
  const archive = readArchive(
    Buffer.from(await (await f.raw.getBlob(f.second.artifacts[0].path)).arrayBuffer()),
  );
  assert.equal(archive.names.filter((n) => /\/markdown\/.+\.md$/.test(n)).length, 2);
});
test("retrying all failures still adopts the chats without failures", async () => {
  const f = await twoChatRetry({ retry: { all: true } });
  assert.equal(f.second.state, "completed");
  assert.equal(f.second.progress.chatsDone, 2);
  assert.equal(f.reads.filter((key) => belongsTo(key, "c2", f.c2Keys)).length, 0);
});
test("a retry target that matches nothing falls back to walking every chat", async () => {
  const f = await twoChatFixture();
  const first = await new JobEngine(f.deps).run();
  assert.ok(first.state.startsWith("completed"), first.error);
  const c2Keys = chatKeys("c2", (await f.db.getItem(f.job.id, "chat:c2")).entry),
    watch = watchReads(f.db),
    job = await f.db.updateJob(f.job.id, { runId: "run2" });
  const second = await new JobEngine({
    ...f.deps,
    job,
    runId: "run2",
    retry: { key: "asset:gone:nothing" },
    emit: watch.onProgress,
  }).run({ resume: true });
  watch.restore();
  assert.ok(second.state.startsWith("completed"), second.error);
  assert.ok(
    watch.reads.some((key) => belongsTo(key, "c2", c2Keys)),
    "the full walk re-validates c2",
  );
  assert.equal(second.progress.chatsDone, 2);
});
test("single failed asset can be retried without downloading healthy assets", async () => {
  const f = await fixture(),
    original = f.deps.fetchBinary;
  let failedUrl;
  f.deps.fetchBinary = async (url) => {
    failedUrl ||= url;
    if (url === failedUrl) return new Response("", { status: 404 });
    return original(url);
  };
  const first = await new JobEngine(f.deps).run();
  assert.equal(first.state, "completed-with-errors");
  const failed = (await f.db.listItems(f.job.id)).find(
    (i) => i.kind === "asset" && i.state === "failed",
  );
  assert.ok(failed);
  const media = f.fetched.length,
    job = await f.db.updateJob(f.job.id, { runId: "run2" });
  await new JobEngine({
    ...f.deps,
    fetchBinary: original,
    job,
    runId: "run2",
    retry: { key: failed.key },
  }).run({ resume: true });
  assert.equal(f.fetched.length, media + 1);
  assert.equal((await f.db.getItem(f.job.id, failed.key)).state, "done");
});
test("stale run cannot publish a checkpoint", async () => {
  const f = await fixture();
  await f.db.updateJob(f.job.id, { runId: "run2" });
  await assert.rejects(f.db.putItem(f.job.id, "run1", { key: "sample" }), /stale/);
});
