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
