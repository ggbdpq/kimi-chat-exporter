// The language layer: catalog parity, locale resolution, lookup, and the two
// catalogs actually rendering. The rest of the suite asserts Chinese copy and
// pins it explicitly (see test/locale.mjs); this file is where the English
// output and the switching itself are covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE,
  LOCALES,
  detectLocale,
  getLocale,
  matchLocale,
  resolveLocale,
  setLocale,
  t,
  tn,
} from "../lib/i18n.js";
import en from "../lib/locales/en-US.js";
import zhCN from "../lib/locales/zh-CN.js";
import { describeAge } from "../lib/chat-cache.js";
import { bindLocaleSwitch, initPageI18n, storeLocale } from "../lib/i18n-dom.js";
import { normalizeChat } from "../lib/model.js";
import { normalizeChat as normalizeListChat } from "../lib/api.js";
import { buildErrorLog, buildReportMarkdown, optionsWithDefaults } from "../lib/pipeline.js";
import { renderMarkdown } from "../lib/render.js";
import { EXPORT_ROOT, inspectZip, runFullExport } from "./harness.mjs";
import { LIST_CHATS_PAGES, MESSAGES_C1 } from "./make-fixtures.mjs";

const EXPORT_DATE = "2026-09-30T04:00:00.000Z";
const AT = Date.UTC(2026, 8, 30, 3, 30, 0);

const placeholders = (text) =>
  [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const ctx = () => ({
  options: optionsWithDefaults({}),
  assetIndex: new Map(),
  exportDate: EXPORT_DATE,
  mdPrefix: "../",
});

/** A normalized thread built from the shared fixtures (no network, no ZIP). */
function fixtureThread() {
  const chat = normalizeListChat(LIST_CHATS_PAGES[0].chats[0]);
  return normalizeChat(chat, MESSAGES_C1.page1.messages, optionsWithDefaults({}));
}

/** A system message with a body, so the role heading is actually rendered. */
function systemThread() {
  const message = {
    id: "sys1",
    role: "system",
    status: "MESSAGE_STATUS_COMPLETED",
    createTime: "2026-09-02T03:00:00Z",
    blocks: [{ id: "sys1-b", text: { content: "系统说明" } }],
  };
  return normalizeChat({ id: "c-sys", name: "系统示例" }, [message], optionsWithDefaults({}));
}

function reportFixture() {
  return {
    chatFailures: [],
    toolFailures: [],
    citationFailures: [],
    fileFailures: [],
    assetFailures: [],
    assetSkips: [],
    assetCount: 2,
    assetBytes: 2048,
  };
}

/** Overrides the globals a page relies on (chrome / navigator / document). */
async function withSources(sources = {}, fn) {
  const names = ["chrome", "navigator", "document"];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names)
    if (sources[name] !== undefined)
      Object.defineProperty(globalThis, name, {
        value: sources[name],
        configurable: true,
        writable: true,
      });
  try {
    return await fn();
  } finally {
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i]);
      else delete globalThis[name];
    });
  }
}

test("every catalog carries the same keys, placeholders and no empty value", () => {
  const keys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(zhCN).sort(), keys);
  assert.ok(keys.length > 150, `expected a full catalog, got ${keys.length} keys`);
  for (const key of keys) {
    assert.equal(typeof en[key], "string", `${key} (en)`);
    assert.equal(typeof zhCN[key], "string", `${key} (zh-CN)`);
    assert.ok(en[key].length, `${key} has no English text`);
    assert.ok(zhCN[key].length, `${key} has no Chinese text`);
    assert.deepEqual(placeholders(zhCN[key]), placeholders(en[key]), `${key} placeholders differ`);
  }
});

test("browser language tags map onto the two catalogs", () => {
  assert.deepEqual(LOCALES, ["zh-CN", "en-US"]);
  assert.equal(matchLocale("zh-CN"), "zh-CN");
  assert.equal(matchLocale("zh"), "zh-CN");
  assert.equal(matchLocale("zh-TW"), "zh-CN");
  assert.equal(matchLocale("zh_Hant"), "zh-CN");
  assert.equal(matchLocale("en-US"), "en-US");
  assert.equal(matchLocale("EN"), "en-US");
  assert.equal(matchLocale("ja-JP"), "");
  assert.equal(matchLocale(""), "");
  assert.equal(matchLocale(undefined), "");
  assert.equal(matchLocale(null), "");
});

test("the stored preference wins, the browser language is the fallback", async () => {
  // chrome.i18n is what an extension context reports; the popup and the worker
  // both go through this order.
  await withSources({ chrome: { i18n: { getUILanguage: () => "zh-TW" } } }, () => {
    assert.equal(detectLocale(), "zh-CN");
    // A stored value from before the catalog was renamed to en-US still lands.
    assert.equal(resolveLocale("en"), "en-US");
    assert.equal(resolveLocale(""), "zh-CN");
  });
  // A language with no catalog falls back to the default, not to Chinese.
  await withSources({ chrome: { i18n: { getUILanguage: () => "ja-JP" } } }, () => {
    assert.equal(detectLocale(), DEFAULT_LOCALE);
    assert.equal(DEFAULT_LOCALE, "en-US");
    assert.equal(resolveLocale(""), "en-US");
    assert.equal(resolveLocale("de-DE"), "en-US");
  });
  // Without chrome.* (a plain worker, Node) navigator.language is next.
  await withSources({ chrome: null, navigator: { language: "en-GB" } }, () => {
    assert.equal(detectLocale(), "en-US");
  });
});

test("setLocale rejects anything that is not a catalog", () => {
  setLocale("zh-CN");
  assert.equal(getLocale(), "zh-CN");
  assert.equal(setLocale("en-US"), "en-US");
  assert.equal(setLocale("fr-FR"), DEFAULT_LOCALE);
  assert.equal(setLocale(""), DEFAULT_LOCALE);
  setLocale("zh-CN");
});

test("t() interpolates placeholders and surfaces a missing key", () => {
  try {
    setLocale("en-US");
    assert.equal(t("popup.exportSelectedCount", { count: 3 }), "Export 3 selected");
    assert.equal(t("export.report.warningLine", { title: "a", warning: "b" }), "a: b");
    assert.equal(t("export.report.warningLine", { title: "a" }), "a: {warning}");
    assert.equal(t("no.such.key"), "no.such.key");
    setLocale("zh-CN");
    assert.equal(t("popup.exportSelectedCount", { count: 3 }), "导出所选 3 个");
    assert.equal(t("no.such.key"), "no.such.key");
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

// Every user-facing string must live in the catalogs, so a key that the code
// asks for but no catalog defines (or that nothing uses any more) is a bug the
// grep below can catch without a browser.
const KEY_PATTERN = /"((?:popup|tasks|bg|opt|common|time|export|progress|error)\.[A-Za-z0-9_.]+)"/g;
// data-i18n-attr="title:key,aria-label:key" carries its keys inside one value.
const ATTR_PATTERN = /data-i18n-attr="([^"]*)"/g;
const NAMESPACE = /^(?:popup|tasks|bg|opt|common|time|export|progress|error)\./;
// "error.log" is the report's sibling file, not a catalog key.
const FILE_NAME = /\.(html|css|js|json|png|md|zip|log)$/;

async function sourceFiles() {
  const root = new URL("../", import.meta.url);
  const lib = await readdir(fileURLToPath(new URL("lib", root)));
  return [
    "popup.js",
    "popup.html",
    "tasks.js",
    "tasks.html",
    ...lib.filter((name) => name.endsWith(".js")).map((name) => `lib/${name}`),
  ];
}

test("the catalogs and the code agree on which keys exist", async () => {
  const used = new Set();
  const missing = [];
  for (const file of await sourceFiles()) {
    if (file.startsWith("lib/locales/")) continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const keys = [...source.matchAll(KEY_PATTERN)].map((match) => match[1]);
    for (const [, value] of source.matchAll(ATTR_PATTERN))
      keys.push(...value.split(",").map((pair) => pair.split(":")[1]?.trim() || ""));
    for (const key of keys) {
      if (!NAMESPACE.test(key)) continue;
      if (FILE_NAME.test(key)) continue;
      used.add(key);
      if (en[key] || zhCN[key] || (en[`${key}_other`] && zhCN[`${key}_other`])) continue;
      missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
  const unused = Object.keys(en).filter(
    (key) => !used.has(key) && !used.has(key.replace(/_(one|other)$/, "")),
  );
  assert.deepEqual(unused, []);
});

// A minimal document + storage pair: the two extension pages are the only place
// where the catalog meets the DOM, and they are not covered by the export tests.
function fakeNode(dataset) {
  return {
    dataset,
    attrs: {},
    textContent: "",
    tabIndex: 0,
    focused: false,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    },
    dispatch(type, event = { preventDefault() {} }) {
      for (const listener of this.listeners[type] || []) listener(event);
    },
    focus() {
      this.focused = true;
    },
  };
}

const SELECTORS = {
  "[data-i18n]": "i18n",
  "[data-i18n-attr]": "i18nAttr",
  "[data-locale]": "locale",
};

function fakePage(...nodes) {
  return {
    documentElement: { lang: "" },
    title: "",
    querySelectorAll: (selector) =>
      nodes.filter((node) => SELECTORS[selector] && SELECTORS[selector] in node.dataset),
  };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(patch) {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      for (const listener of listeners) listener(changes, "local");
    },
    onChanged: { addListener: (listener) => listeners.push(listener) },
  };
}

test("a page paints the stored locale and follows a later switch", async () => {
  const title = fakeNode({ i18n: "tasks.title" });
  const label = fakeNode({ i18nAttr: "aria-label:popup.lang.label" });
  const page = fakePage(title, label);
  const storage = fakeStorage({ locale: "en-US" });
  let repaints = 0;
  try {
    setLocale("zh-CN");
    const locale = await initPageI18n({
      storage,
      doc: page,
      titleKey: "tasks.title",
      onChange: () => repaints++,
    });
    assert.equal(locale, "en-US");
    assert.equal(title.textContent, "Kimi Export Tasks");
    assert.equal(label.attrs["aria-label"], "Interface language");
    assert.equal(page.documentElement.lang, "en-US");
    assert.equal(page.title, "Kimi Export Tasks");
    assert.equal(repaints, 0, "the first paint is not a change");

    // Either page can write the preference; every open page repaints.
    await storeLocale(storage, "zh-CN");
    assert.equal(repaints, 1);
    assert.equal(title.textContent, "Kimi 导出任务");
    assert.equal(label.attrs["aria-label"], "界面语言");
    assert.equal(page.documentElement.lang, "zh-CN");
    assert.equal(getLocale(), "zh-CN");
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("a page without a stored preference follows the browser language", async () => {
  const title = fakeNode({ i18n: "tasks.title" });
  const page = fakePage(title);
  try {
    await withSources({ chrome: { i18n: { getUILanguage: () => "zh-TW" } } }, async () => {
      const locale = await initPageI18n({
        storage: fakeStorage(),
        doc: page,
        titleKey: "tasks.title",
      });
      assert.equal(locale, "zh-CN");
      assert.equal(title.textContent, "Kimi 导出任务");
      assert.equal(page.title, "Kimi 导出任务");
    });
    await withSources({ chrome: { i18n: { getUILanguage: () => "de-DE" } } }, async () => {
      const other = fakeNode({ i18n: "tasks.title" });
      const otherPage = fakePage(other);
      const locale = await initPageI18n({
        storage: fakeStorage(),
        doc: otherPage,
        titleKey: "tasks.title",
      });
      assert.equal(locale, "en-US");
      assert.equal(other.textContent, "Kimi Export Tasks");
    });
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("tn() picks the plural form of the active catalog", () => {
  try {
    setLocale("en-US");
    assert.equal(tn("popup.list.count", 1), "1 chat");
    assert.equal(tn("popup.list.count", 4), "4 chats");
    assert.equal(tn("time.minutes", 1), "updated 1 minute ago");
    assert.equal(tn("time.minutes", 9), "updated 9 minutes ago");
    setLocale("zh-CN");
    assert.equal(tn("popup.list.count", 1), "共 1 个对话");
    assert.equal(tn("popup.list.count", 4), "共 4 个对话");
    assert.equal(tn("time.minutes", 9), "9 分钟前更新");
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("describeAge follows the active catalog", () => {
  try {
    setLocale("en-US");
    assert.equal(describeAge(5_000), "updated just now");
    assert.equal(describeAge(60_000), "updated 1 minute ago");
    assert.equal(describeAge(3 * 60_000), "updated 3 minutes ago");
    assert.equal(describeAge(2 * 3_600_000), "updated 2 hours ago");
    assert.equal(describeAge(50 * 3_600_000), "updated 2 days ago");
    setLocale("zh-CN");
    assert.equal(describeAge(5_000), "刚刚更新");
    assert.equal(describeAge(3 * 60_000), "3 分钟前更新");
    assert.equal(describeAge(50 * 3_600_000), "2 天前更新");
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("the English catalog renders the markdown, the report and the log", () => {
  try {
    setLocale("en-US");
    const md = renderMarkdown(fixtureThread(), ctx());
    assert.match(md, /^## 👤 User · /m);
    assert.ok(md.includes("💭 Thinking"), md.slice(0, 400));
    assert.ok(md.includes("🔎 Web search"));
    assert.ok(!md.includes("思考过程"));
    assert.ok(!md.includes("引用来源"));
    // Role headings stay English in both catalogs; only the side labels differ.
    assert.match(renderMarkdown(systemThread(), ctx()), /^## ⚙️ System · /m);

    const report = buildReportMarkdown({
      chatEntries: [{ id: "c1", title: "示例对话", failed: false, warnings: [] }],
      report: reportFixture(),
      options: optionsWithDefaults({}),
      exportDate: EXPORT_DATE,
      totalMessages: 3,
    });
    assert.ok(report.startsWith("# Kimi Chat Export Report"));
    assert.match(report, /\| Chats \| 1 total \(1 ok, 0 failed\) \|/);
    assert.match(report, /\| Messages \| 3 \|/);
    assert.match(report, /## Export options/);
    assert.match(report, /\| Packaging \| Single ZIP \|/);
    assert.ok(report.includes("This export had no failures or skipped items."));

    const log = buildErrorLog({
      report: { chatFailures: [{ chatId: "c1", name: "示例对话", error: "boom", at: AT }] },
      exportDate: EXPORT_DATE,
    });
    assert.match(log, /ERROR chat {5}chat=c1 target="示例对话" message=boom/);
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("the Chinese catalog keeps rendering the previous copy", () => {
  try {
    setLocale("zh-CN");
    const md = renderMarkdown(fixtureThread(), ctx());
    assert.ok(md.includes("💭 思考过程"));
    assert.ok(md.includes("🔎 网页搜索"));
    assert.match(renderMarkdown(systemThread(), ctx()), /^## ⚙️ 系统 · /m);
    const report = buildReportMarkdown({
      chatEntries: [{ id: "c1", title: "示例对话", failed: false, warnings: [] }],
      report: reportFixture(),
      options: optionsWithDefaults({}),
      exportDate: EXPORT_DATE,
      totalMessages: 3,
    });
    assert.ok(report.startsWith("# Kimi 历史对话导出报告"));
    assert.match(report, /\| 对话 \| 1 个（成功 1，失败 0） \|/);
    assert.match(report, /\| 打包方式 \| 单个 ZIP \|/);
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("a job renders in the language it was created with", async () => {
  const events = [];
  try {
    setLocale("zh-CN");
    const run = await runFullExport({
      locale: "en-US",
      onProgress: (event) => events.push(event),
    });
    const z = inspectZip(run.blobs[0].buf, EXPORT_ROOT + "report.md");
    assert.ok(z.text(EXPORT_ROOT + "report.md").startsWith("# Kimi Chat Export Report"));
    // The engine's own progress lines follow the job as well.
    const progress = events.filter((e) => e.type === "progress").map((e) => e.progress);
    assert.equal(progress[0].message, "Listing chats…");
    assert.ok(progress.some((p) => p.phase === "packing"));
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("the shared language switch stores the choice and repaints the page", async () => {
  const title = fakeNode({ i18n: "tasks.title" });
  const zh = fakeNode({ locale: "zh-CN" });
  const en = fakeNode({ locale: "en-US" });
  const page = fakePage(title, zh, en);
  const storage = fakeStorage({});
  let changed = 0;
  try {
    await withSources({ chrome: { i18n: { getUILanguage: () => "en-US" } } }, async () => {
      await initPageI18n({ storage, doc: page, titleKey: "tasks.title" });
      const sync = bindLocaleSwitch({
        storage,
        doc: page,
        titleKey: "tasks.title",
        onChange: () => changed++,
      });
      // The control mirrors the resolved locale and exposes radio semantics.
      assert.equal(en.attrs["aria-checked"], "true");
      assert.equal(zh.attrs["aria-checked"], "false");
      assert.equal(en.tabIndex, 0);
      assert.equal(zh.tabIndex, -1);

      zh.dispatch("click");
      assert.equal(getLocale(), "zh-CN");
      assert.equal(storage.data.locale, "zh-CN");
      assert.equal(title.textContent, "Kimi 导出任务");
      assert.equal(page.documentElement.lang, "zh-CN");
      assert.equal(zh.attrs["aria-checked"], "true");
      assert.equal(changed, 1);

      // Arrow keys move the selection, exactly like the popup's option groups.
      zh.dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
      assert.equal(getLocale(), "en-US");
      assert.equal(storage.data.locale, "en-US");
      assert.equal(en.focused, true);
      assert.equal(en.attrs["aria-checked"], "true");
      assert.equal(title.textContent, "Kimi Export Tasks");

      // A change made elsewhere (the other page) only needs a re-mark.
      await storeLocale(storage, "zh-CN");
      assert.equal(getLocale(), "zh-CN");
      sync();
      assert.equal(zh.attrs["aria-checked"], "true");
      assert.equal(en.attrs["aria-checked"], "false");
    });
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("both pages bind their switch without passing a document explicitly", async () => {
  // The pages call bindLocaleSwitch({ storage, titleKey, onChange }); taking the
  // document from the global is what makes that work (and what once did not).
  const zh = fakeNode({ locale: "zh-CN" });
  const en = fakeNode({ locale: "en-US" });
  const page = fakePage(zh, en);
  const storage = fakeStorage({ locale: "en-US" });
  try {
    await withSources({ chrome: null, document: page }, async () => {
      const sync = bindLocaleSwitch({ storage, titleKey: "tasks.title" });
      assert.ok(sync, "the switch binds against the page document");
      assert.equal(en.attrs["aria-checked"], "true");
      zh.dispatch("click");
      assert.equal(getLocale(), "zh-CN");
      assert.equal(storage.data.locale, "zh-CN");
      assert.equal(page.documentElement.lang, "zh-CN");
      assert.equal(page.title, "Kimi 导出任务");
    });
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

test("a page follows local changes and ignores another storage area", async () => {
  const title = fakeNode({ i18n: "tasks.title" });
  const page = fakePage(title);
  const storage = fakeStorage({ locale: "en-US" });
  const listeners = [];
  try {
    await withSources({ chrome: null, document: page }, async () => {
      await initPageI18n({
        storage,
        // The global event passes the area name; the area-scoped one does not.
        onChanged: { addListener: (listener) => listeners.push(listener) },
        doc: page,
        titleKey: "tasks.title",
      });
      assert.equal(title.textContent, "Kimi Export Tasks");

      for (const listener of listeners) listener({ locale: { newValue: "zh-CN" } }, "sync");
      assert.equal(getLocale(), "en-US", "a sync-area change is ignored");

      for (const listener of listeners) listener({ locale: { newValue: "zh-CN" } }, "local");
      assert.equal(getLocale(), "zh-CN");
      assert.equal(title.textContent, "Kimi 导出任务");
      assert.equal(page.documentElement.lang, "zh-CN");
    });
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});
