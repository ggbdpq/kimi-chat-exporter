// Denied media hosts degrade to report entries; the export never crashes.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport, inspectZip } from "./harness.mjs";

const run = await runFullExport({ deniedHosts: ["sandbox.example.com"] });

test("denied host is skipped without crashing", () => {
  assert.ok(run.exported.report.assetSkips.length > 0);
});

test("skip reason names the host", () => {
  assert.ok(run.exported.report.assetSkips.some((s) => /sandbox\.example\.com/.test(s.reason)));
});

test("skip entry keeps the original url for the report", () => {
  assert.ok(run.exported.report.assetSkips.some((s) => /report\.pdf/.test(s.url || "")));
});

test("remaining assets still download", () => {
  assert.equal(run.exported.report.assetCount, 10);
});

test("the report keeps the skipped asset", () => {
  assert.ok(run.exported.report.assetSkips.length >= 1);
});

test("denied asset is absent from the archive", () => {
  const z = inspectZip(run.blobs[0].buf);
  assert.ok(!z.entries.some((e) => /sandbox/.test(e)));
});

test("report.md counts the skip and error.log records it in full", () => {
  assert.match(run.exported.reportMd, /\| 跳过的资源 \| [1-9]\d* \|/);
  assert.match(run.exported.reportMd, /error\.log/);
  assert.match(run.exported.errorLog, /WARN\s+media\s+.*message=/);
  assert.match(run.exported.errorLog, /sandbox\.example\.com/);
});
