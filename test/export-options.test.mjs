// The option matrix: media off, latest-branch only, thinking/tools/citations off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFullExport, inspectZip, EXPORT_ROOT as R } from "./harness.mjs";

const MD1 = R + "markdown/2026-09-02-示例话题甲_c1.md";

test("media off: nothing is fetched, chat still exports, files keep their names", async () => {
  const a = await runFullExport({ options: { downloadMedia: false }, chatIds: ["c1"] });
  assert.equal(a.fetcher.requested.length, 0);
  assert.ok(a.exported.totals.messages > 0);
  assert.equal(a.exported.chatEntries[0].assets, 0);
  const z = inspectZip(a.blobs[0].buf, MD1);
  assert.ok(!z.entries.some((e) => e.includes("/assets/c1/")));
  assert.ok(z.text(MD1).includes("示例照片.jpg"));
  assert.ok(!z.text(MD1).includes("](../assets/c1/"));
});

test("branches=latest drops regeneration branches", async () => {
  const b = await runFullExport({ options: { branches: "latest" }, chatIds: ["c1"] });
  assert.equal(b.exported.totals.messages, 4);
  assert.equal(b.exported.chatEntries[0].branches, 0);
});

test("thinking/tools/citations off hides them from markdown but not from raw", async () => {
  const c = await runFullExport({
    options: { thinking: false, tools: false, citations: false },
    chatIds: ["c1"],
  });
  const z = inspectZip(c.blobs[0].buf, MD1, R + "raw/c1.json");
  const md = z.text(MD1);
  assert.ok(!md.includes("示例思考内容"));
  assert.ok(!md.includes("搜索网页"));
  assert.ok(!md.includes("示例来源"));
  assert.ok(z.text(R + "raw/c1.json").includes("示例思考内容"));
});

test("citations/tools off also skips their enrichment RPCs", async () => {
  const c = await runFullExport({
    options: { thinking: false, tools: false, citations: false },
    chatIds: ["c1"],
  });
  assert.ok(!c.api.calls.some((x) => x.method.endsWith("GetSearchCitation")));
  assert.ok(!c.api.calls.some((x) => x.method.endsWith("GetToolBlock")));
});
