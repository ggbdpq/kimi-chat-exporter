// End-to-end over the mock API: pagination, lazy enrichment RPCs, asset counts.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport } from "./harness.mjs";

const run = await runFullExport({});

test("all four chats export", () => {
  assert.equal(run.exported.chatEntries.length, 4);
});

test("produces exactly one archive", () => {
  assert.equal(run.blobs.length, 1);
});

test("follows ListChats pagination", () => {
  assert.equal(run.api.calls.filter((c) => c.method.endsWith("ListChats")).length, 2);
});

test("follows per-chat ListMessages pagination", () => {
  assert.ok(run.api.calls.some((c) => c.body.pageToken === "p2c2"));
});

test("lazily enriches tool blocks, files, and citations", () => {
  assert.ok(
    run.api.calls.some((c) => c.method.endsWith("GetToolBlock") && c.body.toolCallId === "call-1"),
  );
  assert.ok(run.api.calls.some((c) => c.method.endsWith("GetFile") && c.body.fileId === "file-2"));
  assert.ok(run.api.calls.some((c) => c.method.endsWith("GetSearchCitation")));
});

test("counts 11 assets (8 fetched + 1 inline artifact + 2 chat files)", () => {
  assert.equal(run.exported.report.assetCount, 11);
});

test("fetches 10 remote media", () => {
  assert.equal(run.fetcher.requested.length, 10);
});

test("chat file with a signed url downloads directly", () => {
  assert.ok(run.fetcher.requested.includes("https://cdn.example.com/chatdata/dataset.csv"));
});

test("chat file without a url goes through GetFile first", () => {
  assert.ok(run.api.calls.some((c) => c.method.endsWith("GetFile") && c.body.fileId === "file-10"));
  assert.ok(run.fetcher.requested.includes("https://cdn.example.com/chatdata/long.pdf"));
});

test("reports the listing phase before exporting everything", async () => {
  const events = [];
  await runFullExport({ onProgress: (event) => events.push(event) });
  const progress = events.filter((e) => e.type === "progress").map((e) => e.progress);
  assert.equal(progress[0].phase, "listing");
  assert.equal(progress[0].message, "读取对话列表…");
  assert.equal(progress[0].listingDone, 0);
  assert.ok(progress.some((p) => p.phase === "packing"));
});
