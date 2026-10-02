// Markdown/raw fidelity: thinking, tools, citations, branches, PUA chars.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport, inspectZip, jsonOf, EXPORT_ROOT as R } from "./harness.mjs";
import { normalizeChat } from "../lib/model.js";
import { renderMarkdown } from "../lib/render.js";
import { optionsWithDefaults } from "../lib/pipeline.js";
const EXPORT_DATE = "2026-09-30T04:00:00.000Z";

const run = await runFullExport({});
const MD1 = R + "markdown/2026-09-02-示例话题甲_c1.md";
const MD2 = R + "markdown/2026-09-02-演示话题乙_c2.md";
const MD4 = R + "markdown/2026-09-02-深度研究引用_c4.md";
const z = inspectZip(run.blobs[0].buf, MD1, MD2, MD4, R + "raw/c1.json", R + "raw/c2.json");
const md1 = z.text(MD1);

test("markdown opens with YAML frontmatter carrying the chat metadata", () => {
  assert.ok(md1.startsWith("---\n"));
  assert.match(md1, /^chat_id: "c1"$/m);
  assert.match(md1, /^title: "示例话题甲"$/m);
  assert.match(md1, /^created_at: 2026-09-02T03:30:00\.000Z$/m);
  assert.match(md1, /^updated_at: 2026-09-21T03:30:00\.000Z$/m);
  assert.match(md1, /^model: "kimi-k2"$/m);
  assert.match(md1, /^messages: \d+$/m);
  // Per-role counts are gone; only the total stays.
  assert.ok(!/^user_messages:/m.test(md1));
  assert.ok(!/^assistant_messages:/m.test(md1));
  assert.match(md1, /^exported_at: 2026-09-30T04:00:00\.000Z$/m);
  assert.ok(!/^regenerated_branches:/m.test(md1));
  // The old metadata block and the tool-name suffix are gone.
  assert.ok(!md1.includes("对话 ID："));
  assert.ok(!md1.includes("Kimi History Exporter"));
  assert.ok(md1.includes("\n---\n\n# 示例话题甲\n"));
});

test("role headings are English and stamp times in ISO-8601 UTC", () => {
  assert.match(md1, /^## 👤 User · 2026-09-04T03:30:00\.000Z$/m);
  assert.match(md1, /^## 🤖 Kimi · 2026-09-04T03:30:00\.000Z$/m);
  assert.match(md1, /^## 🤖 Kimi · 2026-09-07T03:30:00\.000Z$/m);
  // Emoji role prefixes are back; the turn label stays gone.
  assert.ok(!md1.includes("Turn"));
  assert.ok(!md1.includes("轮"));
});

test("PUA control characters are stripped from markdown", () => {
  assert.ok(!/[\ue000-\uf8ff]/.test(md1));
});

test("the content-free system stub is skipped, but kept in raw JSON", () => {
  assert.ok(!md1.includes("系统"));
  assert.ok(!md1.includes("没有可导出的正文内容"));
  assert.equal(jsonOf(z.text(R + "raw/c1.json")).messages[0].role, "system");
});

test("thinking content is kept", () => {
  assert.ok(md1.includes("示例思考内容"));
});

test("enriched tool output is rendered", () => {
  assert.ok(md1.includes("已找到 45 个结果"));
});

test("every reply of a regenerated turn states its branch position", () => {
  assert.ok(md1.includes("> 🔄 Branch 1/2"));
  assert.ok(md1.includes("> 🔄 Branch 2/2"));
  // English wording with the regenerate emoji, no leftover Chinese text.
  assert.ok(!md1.includes("重新生成 分支"));
});

test("cancelled message keeps its status", () => {
  assert.ok(md1.includes("已取消"));
});

test("markdown asset links go through ../assets", () => {
  assert.ok(md1.includes("../assets/c1/"));
});

test("enriched citation is rendered", () => {
  assert.ok(md1.includes("示例引用详情"));
});

test("sandbox file and attachment images are referenced", () => {
  assert.ok(md1.includes("分析报告.pdf"));
  assert.ok(md1.includes("示例照片.jpg"));
});

test("a regenerated turn renders in branch order", () => {
  const first = md1.indexOf("> 🔄 Branch 1/2");
  const second = md1.indexOf("> 🔄 Branch 2/2");
  assert.ok(first !== -1 && first < second, "1/2 must come before 2/2");
  assert.ok(md1.indexOf("示例思考内容") < second);
});

// The fixture's regeneration is the second child; this locks the other order,
// where the visible reply sits last and branch 1 is the older answer.
test("branch numbering follows the API child order, visible reply included", () => {
  const NIL = "00000000-0000-0000-0000-000000000000";
  const m = (id, role, children, text, t) => ({
    id,
    parentId: "u1",
    childrenMessageIds: children,
    role,
    status: "MESSAGE_STATUS_COMPLETED",
    createTime: t,
    blocks: [{ id: id + "-b", text: { content: text } }],
  });
  const messages = [
    { ...m("u1", "user", ["a1", "a2"], "示例提问", "2026-09-01T01:00:00Z"), parentId: NIL },
    m("a1", "assistant", [], "第一版回答", "2026-09-01T01:01:00Z"),
    m("a2", "assistant", [], "第二版回答", "2026-09-01T01:02:00Z"),
  ];
  const thread = normalizeChat(
    { id: "c9", name: "分支示例", createTime: "2026-09-01T00:00:00Z" },
    messages,
    optionsWithDefaults({}),
  );
  const md = renderMarkdown(thread, {
    options: {},
    assetIndex: new Map(),
    exportDate: EXPORT_DATE,
  });
  assert.deepEqual(
    [...md.matchAll(/^> 🔄 Branch .*$/gm)].map((x) => x[0]),
    ["> 🔄 Branch 1/2", "> 🔄 Branch 2/2"],
  );
  // Child order decides the order: the older answer is emitted first even
  // though the last child is the one the UI shows.
  assert.ok(md.indexOf("第一版回答") < md.indexOf("第二版回答"));
  assert.ok(!md.includes("regenerated_branches"));
});

test("raw JSON preserves unknown block types", () => {
  assert.ok(JSON.stringify(jsonOf(z.text(R + "raw/c2.json"))).includes("someBrandNewBlock"));
});

test("raw JSON records the enriched file url", () => {
  assert.ok(JSON.stringify(jsonOf(z.text(R + "raw/c2.json"))).includes("doc-2.pdf"));
});

test("raw JSON has every message of the paginated chat", () => {
  assert.equal(jsonOf(z.text(R + "raw/c2.json")).messages.length, 3);
});

test("inline artifact gets a text asset", () => {
  assert.ok(z.entries.some((e) => /assets\/c2\/.*demo\.sh/.test(e)));
});

test("memory and research-stage blocks render", () => {
  assert.ok(z.text(MD2).includes("记忆变更"));
  assert.ok(z.text(MD2).includes("research"));
});

test("error block and research steps render in the deep-research chat", () => {
  const md4 = z.text(MD4);
  assert.ok(md4.includes("token_length_too_long") || md4.includes("上下文过长"));
  assert.ok(md4.includes("第一步"));
});
