// The single-ZIP layout: markdown/raw per chat, assets, and the two reports.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport, inspectZip, EXPORT_ROOT as R } from "./harness.mjs";

const run = await runFullExport({});
const z = inspectZip(run.blobs[0].buf);

test("one markdown and one raw file per chat", () => {
  assert.equal(z.entries.filter((e) => e.startsWith(R + "markdown/")).length, 4);
  assert.equal(z.entries.filter((e) => e.startsWith(R + "raw/")).length, 4);
});

test("carries no offline reader remnants", () => {
  assert.ok(!z.has(R + "index.html"));
  assert.ok(!z.has(R + "manifest.js"));
  assert.ok(!z.has(R + "assets/reader.js"));
  assert.ok(!z.has(R + "assets/reader.css"));
  assert.equal(z.entries.filter((e) => e.startsWith(R + "data/")).length, 0);
});

test("reports are included", () => {
  assert.ok(z.has(R + "report.md"));
  assert.ok(z.has(R + "error.log"));
});

test("report.md is a markdown summary", () => {
  const texts = inspectZip(run.blobs[0].buf, R + "report.md");
  const report = texts.text(R + "report.md");
  assert.ok(report.startsWith("# Kimi 历史对话导出报告"));
  assert.match(report, /\| 项目 \| 数值 \|/);
  assert.match(report, /\| 打包方式 \| 单个 ZIP \|/);
});

test("error.log ships empty when nothing failed", () => {
  const texts = inspectZip(run.blobs[0].buf, R + "error.log");
  assert.equal(texts.text(R + "error.log"), "");
});

test("asset files are in the archive", () => {
  // 11 downloaded media files; the reader's two shell files used to pad this.
  assert.ok(z.entries.filter((e) => e.startsWith(R + "assets/")).length >= 11);
});

test("report asset count matches", () => {
  assert.equal(run.exported.report.assetCount, 11);
});

test("chat-level files land in per-chat asset dirs", () => {
  // Asset entries are named "<content hash>-<file name>" to stay unique.
  const assetsOf = (chat, name) =>
    z.entries.filter((e) => e.startsWith(R + "assets/" + chat + "/") && e.endsWith(name));
  assert.equal(assetsOf("c1", "数据表.csv").length, 1);
  assert.equal(assetsOf("c2", "附件长文.pdf").length, 1);
});

test("UTF-8 entry names survive the archive round trip", () => {
  assert.ok(z.entries.some((e) => e.includes("示例话题甲")));
});
