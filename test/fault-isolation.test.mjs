// One failing chat cannot poison the batch; empty chats and abort behave.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport, inspectZip, EXPORT_ROOT as R } from "./harness.mjs";

const MD_EMPTY = R + "markdown/2026-09-02-空对话（无消息）_c3.md";
const failed = await runFullExport({ failChat: "c2" });
const healthy = await runFullExport({});

test("a failing chat is isolated and reported", () => {
  assert.equal(failed.exported.totals.chats, 4);
  assert.equal(failed.exported.totals.ok, 3);
  assert.equal(failed.exported.report.chatFailures.length, 1);
  assert.equal(failed.exported.report.chatFailures[0].chatId, "c2");
  assert.match(failed.exported.errorLog, /ERROR\s+chat\s+.*chat=c2/);
  assert.ok(failed.exported.errorLog.includes("mock chat failure"));
  assert.match(failed.exported.reportMd, /\| 对话级失败 \| 1 \|/);
});

test("failed chat ships no raw file; healthy chats still package", () => {
  const z = inspectZip(failed.blobs[0].buf);
  assert.equal(z.entries.filter((e) => e.includes("raw/c2.json")).length, 0);
  assert.ok(z.entries.some((e) => e.includes("raw/c1.json")));
});

test("empty chat exports a zero-message markdown and a report note", () => {
  const z = inspectZip(healthy.blobs[0].buf, MD_EMPTY);
  assert.ok(z.text(MD_EMPTY).includes("messages: 0"));
  assert.ok(healthy.exported.reportMd.includes("没有可导出的消息"));
});

test("a pre-aborted signal pauses the job instead of throwing", async () => {
  const ac = new AbortController();
  ac.abort();
  const run = await runFullExport({ signal: ac.signal });
  assert.equal(run.exported.state, "paused");
  assert.equal(run.archives.length, 0);
});

test("aborting at pack time pauses the job before any archive is written", async () => {
  const ac = new AbortController();
  let abortedAt = "";
  const run = await runFullExport({
    signal: ac.signal,
    onProgress: (event) => {
      if (event.type === "progress" && event.progress?.phase === "packing" && !abortedAt) {
        abortedAt = event.progress.phase;
        ac.abort();
      }
    },
  });
  assert.equal(abortedAt, "packing", "the run must reach the packaging phase");
  assert.equal(run.exported.state, "paused");
  assert.equal(run.archives.length, 0);
});
