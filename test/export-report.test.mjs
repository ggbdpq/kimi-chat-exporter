// report.md (human summary) and error.log (machine-readable record).
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { buildReportMarkdown, buildErrorLog, failureCounts } from "../lib/pipeline.js";
import { optionsWithDefaults } from "../lib/pipeline.js";

const EXPORT_DATE = "2026-09-30T04:00:00.000Z";
const AT = Date.UTC(2026, 8, 30, 3, 30, 0);
const report = {
  chatFailures: [{ chatId: "c1", name: "示例对话", error: "拉取失败", at: AT }],
  toolFailures: [{ chatId: "c1", toolCallId: "t1", error: "工具失败", at: AT }],
  citationFailures: [],
  fileFailures: [],
  assetFailures: [
    {
      chatId: "c1",
      name: "示例照片.png",
      reason: "HTTP 500",
      url: "https://cdn.example.com/a b.png",
      at: AT,
    },
  ],
  assetSkips: [{ chatId: "c2", name: "", reason: "站点未授权", url: "", at: AT }],
  assetCount: 3,
  assetBytes: 2048,
};
const entries = [
  { id: "c1", title: "示例对话", failed: false, messages: 4, warnings: ["来源类型未知"] },
  { id: "c2", title: "另一个对话", failed: true, messages: 0, warnings: [] },
];

test("failures are counted per category, skips kept apart from errors", () => {
  assert.deepEqual(failureCounts(report), { errors: 3, skipped: 1 });
  assert.deepEqual(failureCounts({}), { errors: 0, skipped: 0 });
});

test("error.log is one line per problem, stamped and greppable", () => {
  const lines = buildErrorLog({ report, exportDate: EXPORT_DATE }).trimEnd().split("\n");
  assert.equal(lines.length, 5); // summary + 3 failures + 1 skip
  assert.match(lines[0], /^2026-09-30T04:00:00\.000Z INFO {2}export {3}errors=3 skipped=1$/);
  for (const line of lines)
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (INFO|WARN|ERROR)\s+\S+\s+\S/);
});

test("error.log quotes values that are not bare tokens and keeps urls", () => {
  const log = buildErrorLog({ report, exportDate: EXPORT_DATE });
  assert.match(log, /ERROR chat {5}chat=c1 target="示例对话" message="拉取失败"/);
  assert.match(log, /ERROR tool {5}chat=c1 target=t1 message="工具失败"/);
  assert.match(log, /ERROR media {4}chat=c1 target="示例照片\.png" message="HTTP 500" url="https:\/\/cdn\.example\.com\/a b\.png"/);
  assert.match(log, /WARN {2}media {4}chat=c2 message="站点未授权"/);
});

test("error.log records pack errors, and stays empty when nothing failed", () => {
  const log = buildErrorLog({
    report: { assetSkips: [] },
    exportDate: EXPORT_DATE,
    packErrors: ["对话 X 超过经典 ZIP 上限"],
  });
  assert.match(log, /ERROR pack {5}message="对话 X 超过经典 ZIP 上限"/);
  assert.match(log, /errors=1 skipped=0/);
  assert.equal(buildErrorLog({ report: {}, exportDate: EXPORT_DATE }), "");
  assert.equal(buildErrorLog({ report: { chatFailures: [] }, exportDate: EXPORT_DATE }), "");
});

test("report.md is a markdown summary that points at the log", () => {
  const md = buildReportMarkdown({
    chatEntries: entries,
    report,
    options: optionsWithDefaults(),
    exportDate: EXPORT_DATE,
    totalMessages: 4,
  });
  assert.ok(md.startsWith("# Kimi 历史对话导出报告"));
  assert.match(md, /\| 对话 \| 2 个（成功 1，失败 1） \|/);
  assert.match(md, /\| 消息 \| 4 条 \|/);
  assert.match(md, /\| 对话级失败 \| 1 \|/);
  assert.match(md, /\| 跳过的资源 \| 1 \|/);
  assert.match(md, /\[\`error\.log\`\]\(\.\/error\.log\)/);
  assert.match(md, /## 解析提示（1）/);
  // The report counts problems; the detail stays in the log.
  assert.ok(!md.includes("拉取失败"));
  assert.ok(!md.includes("http"));
});

test("report.md states plainly when nothing failed", () => {
  const md = buildReportMarkdown({
    chatEntries: [{ id: "c1", title: "示例对话", failed: false, warnings: [] }],
    report: { chatFailures: [], assetCount: 0, assetBytes: 0 },
    options: optionsWithDefaults(),
    exportDate: EXPORT_DATE,
    totalMessages: 2,
  });
  assert.match(md, /本次导出没有失败或跳过的条目。/);
  assert.ok(!md.includes("error.log"));
});
