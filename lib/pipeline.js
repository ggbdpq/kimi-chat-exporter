import { fatal, pool as runPool, checkAbort } from "./control.js";
// Content stage of the export: enrich -> collect assets -> render -> write.
// Fetching/pagination, media downloads and packaging live in job-engine.js,
// media.js and pack.js; this module only knows about injected stores and RPCs,
// so it runs unchanged in a plain Node harness with mocks.
//
// Store paths are export-root-relative (e.g. "assets/<chatId>/x.png"). The
// "kimi-export-<date>/" prefix is added only when the ZIP is assembled.

import { SERVICES, asInt } from "./api.js";
import { clean } from "./model.js";
import { t } from "./i18n.js";
import {
  renderMarkdown,
  jsStringify,
  safeFileName,
  formatDate,
  formatBytes,
  assetKey,
  uniqueMdName,
} from "./render.js";

const DEFAULT_OPTIONS = {
  thinking: true,
  tools: true,
  citations: true,
  downloadMedia: true,
  branches: "all",
  package: "single",
};



export function optionsWithDefaults(opts) {
  return { ...DEFAULT_OPTIONS, ...(opts || {}) };
}

export function newReport() {
  return {
    chatFailures: [],
    toolFailures: [],
    fileFailures: [],
    citationFailures: [],
    assetFailures: [],
    assetSkips: [],
    assetBytes: 0,
    assetCount: 0,
  };
}

function errText(err) {
  return String((err && err.message) || err || "unknown error");
}

/** Bounded-concurrency worker pool; stops taking new work once aborted. */
async function pool(items, limit, worker, signal) {
  return runPool(items, limit, worker, signal);
}

/**
 * Fill lazy tool blocks, missing file links, and citation details in place.
 * Best-effort: failures are recorded on the report, never fatal.
 */
export async function enrichChat(api, chatId, messages, options, report, signal) {
  const toolTasks = [];
  const fileTasks = [];
  const citeTasks = [];

  for (const m of messages || []) {
    for (const block of m.blocks || []) {
      if (!block || typeof block !== "object") continue;
      const tool = block.tool;
      if (tool && options.tools && tool.toolCallId && !(tool.contents || []).length) {
        const external =
          typeof tool.loadType === "number"
            ? tool.loadType === 1
            : String(tool.loadType || "").includes("EXTERNAL");
        if (asInt(tool.contentCount) > 0 || external)
          toolTasks.push({ block, toolCallId: tool.toolCallId });
      }
      const f = block.file;
      if (f && f.id && !(f.blob && (f.blob.signUrl || f.blob.previewUrl)))
        fileTasks.push({ block, fileId: f.id });
    }
    if (options.citations) {
      for (const sc of (m.refs || {}).searchChunks || []) {
        if (sc && !sc.base && (sc.id || sc.refIndex)) citeTasks.push({ message: m, chunk: sc });
      }
    }
  }

  await pool(
    toolTasks,
    3,
    async (task) => {
      try {
        const res = await api.rpc(
          SERVICES.getToolBlock,
          { chatId, toolCallId: task.toolCallId },
          { signal },
        );
        const payload = res && (res.block || res.toolBlock || res.tool || res);
        const fetched = payload && payload.tool ? payload.tool : payload;
        if (fetched && typeof fetched === "object" && fetched !== task.block) {
          task.block.tool = { ...task.block.tool, ...fetched };
        }
      } catch (err) {
        if (fatal(err)) throw err;
        report.toolFailures.push({ chatId, toolCallId: task.toolCallId, error: errText(err) });
      }
    },
    signal,
  );

  await pool(
    fileTasks,
    3,
    async (task) => {
      try {
        const res = await api.rpc(SERVICES.getFile, { fileId: task.fileId }, { signal });
        const f = res && (res.file || res);
        if (f && typeof f === "object" && f.meta) task.block.file = { ...task.block.file, ...f };
      } catch (err) {
        if (fatal(err)) throw err;
        report.fileFailures.push({ chatId, fileId: task.fileId, error: errText(err) });
      }
    },
    signal,
  );

  await pool(
    citeTasks,
    3,
    async (task) => {
      try {
        const res = await api.rpc(
          SERVICES.getSearchCitation,
          {
            chatId,
            messageId: task.message.id,
            refIndex: task.chunk.refIndex,
            blockId: task.chunk.blockId || "",
          },
          { signal },
        );
        const base = res && (res.base || res.searchResult || res.citation || res.searchChunk);
        if (base) task.chunk.base = base.base || base;
      } catch (err) {
        if (fatal(err)) throw err;
        report.citationFailures ||= [];
        report.citationFailures.push({ chatId, messageId: task.message.id, error: errText(err) });
      }
    },
    signal,
  );
}

/** Deduplicated asset list for a thread; every asset tagged with its chatId. */
export function collectAssets(nodes, chatId) {
  const byKey = new Map();
  for (const n of nodes) {
    if (n.kind !== "message") continue;
    for (const a of n.message.assets || []) {
      if (a.nonDownload) continue;
      a.chatId = chatId;
      const key = assetKey(a);
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, a);
      else if (prev.localPath && !a.localPath) a.localPath = prev.localPath;
    }
  }
  return [...byKey.values()];
}

/**
 * Chat-level files (uploaded to the conversation, not attached to one message)
 * become exportable assets too. Keys are shaped exactly like the assetIndex
 * lookup in render.js so the markdown section links to the local copy.
 */
export function chatFileAssets(chat, chatId) {
  const out = [];
  for (const f of chat.files || []) {
    if (!f || !f.id) continue;
    out.push({
      kind: "file",
      fileId: f.id,
      name: f.name || f.id,
      url: f.signUrl || f.previewUrl || "",
      contentType: f.contentType || "",
      sizeBytes: Number(f.sizeBytes) || 0,
      chatId,
      origin: "chat.files",
    });
  }
  return out;
}

/** Append chat-file assets that are not already covered by message assets. */
export function mergeChatFileAssets(assets, chatAssets) {
  const seen = new Set(assets.map(assetKey));
  let added = 0;
  for (const a of chatAssets)
    if (!seen.has(assetKey(a))) {
      assets.push(a);
      added++;
    }
  return added;
}

/**
 * Fill missing download URLs for chat-level files via GetFile. Best-effort:
 * failures land on the report; the file then degrades to a link-less entry.
 */
export async function enrichChatFiles(api, chat, report, signal) {
  const pending = (chat.files || []).filter((f) => f && f.id && !(f.signUrl || f.previewUrl));
  if (!pending.length) return;
  await pool(
    pending,
    3,
    async (f) => {
      try {
        const res = await api.rpc(SERVICES.getFile, { fileId: f.id }, { signal });
        const file = res && (res.file || res);
        const blob = file && file.blob;
        if (blob && (blob.signUrl || blob.previewUrl)) {
          f.signUrl = blob.signUrl || "";
          f.previewUrl = blob.previewUrl || "";
        }
      } catch (err) {
        if (fatal(err)) throw err;
        report.fileFailures.push({ chatId: chat.id, fileId: f.id, error: errText(err) });
      }
    },
    signal,
  );
}

/** Share resolved local paths with duplicate assets elsewhere in the thread. */
export function propagateLocalPaths(nodes, assets) {
  const byKey = new Map();
  for (const a of assets) if (a.localPath) byKey.set(assetKey(a), a.localPath);
  let fixed = 0;
  for (const n of nodes) {
    if (n.kind !== "message") continue;
    for (const a of n.message.assets) {
      if (!a.localPath && byKey.has(assetKey(a))) {
        a.localPath = byKey.get(assetKey(a));
        fixed++;
      }
    }
  }
  return fixed;
}

/** Write the Markdown and raw JSON outputs for one prepared chat. */
export async function writeChatOutputs(store, thread, ctx) {
  const { chat } = thread;
  const slug = safeFileName(clean(chat.name) || chat.id, chat.id, 80);
  const day = String(chat.createTime || ctx.exportDate || "").slice(0, 10) || "unknown-date";
  let mdName = ctx.mdName || uniqueMdName(day, slug, chat.id, ctx.usedNames);
  const files = [];

  const mdPath = `markdown/${mdName}`;
  await store.writeText(mdPath, renderMarkdown(thread, ctx));
  files.push({ storePath: mdPath, kind: "md" });

  const rawPath = `raw/${chat.id}.json`;
  await store.writeText(
    rawPath,
    jsStringify({
      schema: "kimi-raw/1",
      chatId: chat.id,
      chat: chat.raw || null,
      fetchedAt: ctx.exportDate,
      warnings: thread.warnings || [],
      messages: thread.nodes.filter((n) => n.kind === "message").map((n) => n.raw),
    }),
  );
  files.push({ storePath: rawPath, kind: "raw" });

  return { files, mdName };
}

// Every failure the export can carry, together with the log category and level
// its record gets in error.log. The Markdown report only counts these; the
// details live in the log so neither file becomes a wall of text.
const FAILURE_KINDS = [
  {
    field: "chatFailures",
    labelKey: "export.failure.chat",
    category: "chat",
    level: "ERROR",
    target: (f) => f.name || f.chatId,
    message: (f) => f.error,
  },
  {
    field: "toolFailures",
    labelKey: "export.failure.tool",
    category: "tool",
    level: "ERROR",
    target: (f) => f.toolCallId,
    message: (f) => f.error,
  },
  {
    field: "citationFailures",
    labelKey: "export.failure.citation",
    category: "citation",
    level: "ERROR",
    target: (f) => f.messageId,
    message: (f) => f.error,
  },
  {
    field: "fileFailures",
    labelKey: "export.failure.file",
    category: "file",
    level: "ERROR",
    target: (f) => f.fileId,
    message: (f) => f.error,
  },
  {
    field: "assetFailures",
    labelKey: "export.failure.asset",
    category: "media",
    level: "ERROR",
    target: (f) => f.name,
    message: (f) => f.reason,
    url: (f) => f.url,
  },
  {
    field: "assetSkips",
    labelKey: "export.failure.assetSkip",
    category: "media",
    level: "WARN",
    target: (f) => f.name,
    message: (f) => f.reason,
    url: (f) => f.url,
  },
];

export function failureCounts(report) {
  const count = (field) => (report?.[field] || []).length;
  return {
    errors: FAILURE_KINDS.filter((k) => k.level === "ERROR").reduce(
      (n, k) => n + count(k.field),
      0,
    ),
    skipped: count("assetSkips"),
  };
}

/** `k=v` pairs, quoted only when the value is not a bare token. */
function logPairs(fields) {
  const write = (value) =>
    /^[\w./:@+-]+$/.test(String(value)) ? String(value) : JSON.stringify(String(value));
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}=${write(value)}`)
    .join("");
}

function logLine(at, level, category, fields) {
  const date = at ? new Date(at) : new Date();
  const stamp = (Number.isNaN(date.getTime()) ? new Date() : date).toISOString();
  return `${stamp} ${level.padEnd(5)} ${category.padEnd(8)}${logPairs(fields)}`;
}

/**
 * The complete error record: a summary line plus one line per failed or skipped
 * item, so `grep -E "ERROR|WARN" error.log` tells the whole story in a format
 * ordinary log tooling can read.
 */
export function buildErrorLog({ report, exportDate, packErrors = [] }) {
  const { errors, skipped } = failureCounts(report);
  const totalErrors = errors + packErrors.length;
  // Nothing failed and nothing was skipped -> an empty file, so a non-empty
  // error.log unambiguously means "look here".
  if (!totalErrors && !skipped) return "";
  const lines = [logLine(exportDate, "INFO", "export", { errors: totalErrors, skipped })];
  for (const kind of FAILURE_KINDS)
    for (const failure of report?.[kind.field] || [])
      lines.push(
        logLine(failure.at || exportDate, kind.level, kind.category, {
          chat: failure.chatId,
          target: kind.target(failure),
          message: kind.message(failure),
          url: kind.url?.(failure),
        }),
      );
  for (const error of packErrors)
    lines.push(logLine(exportDate, "ERROR", "pack", { message: error }));
  return lines.join("\n") + "\n";
}

/** Human-facing Markdown summary; the failure details live in error.log. */
export function buildReportMarkdown({
  chatEntries,
  report,
  options,
  exportDate,
  totalMessages,
}) {
  const { errors, skipped } = failureCounts(report);
  const out = [];
  const table = (head, rows) => {
    out.push(`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
    for (const row of rows) out.push(`| ${row.join(" | ")} |`);
    out.push("");
  };
  out.push(t("export.report.title"), "");
  table([t("export.report.colItem"), t("export.report.colValue")], [
    [t("export.report.exportedAt"), formatDate(exportDate)],
    [
      t("export.report.chats"),
      t("export.report.chatsValue", {
        count: chatEntries.length,
        ok: chatEntries.filter((c) => !c.failed).length,
        failed: report.chatFailures.length,
      }),
    ],
    [t("export.report.messages"), t("export.report.messagesValue", { count: totalMessages })],
    [
      t("export.report.media"),
      t("export.report.mediaValue", {
        count: report.assetCount,
        bytes: formatBytes(report.assetBytes),
      }),
    ],
  ]);
  out.push(t("export.report.options"), "");
  const onOff = (on) => t(on ? "opt.include" : "opt.exclude");
  table([t("export.report.colOption"), t("export.report.colSetting")], [
    [t("opt.thinking"), onOff(options.thinking)],
    [t("opt.tools"), onOff(options.tools)],
    [t("opt.citations"), onOff(options.citations)],
    [
      t("opt.media"),
      t(options.downloadMedia ? "opt.media.download" : "opt.media.linkOnly"),
    ],
    [
      t("opt.branches"),
      t(options.branches === "all" ? "opt.branches.all" : "opt.branches.latest"),
    ],
    [
      t("opt.package"),
      t(options.package === "per-chat" ? "opt.package.perChatZip" : "opt.package.single"),
    ],
  ]);
  out.push(t("export.report.errors"), "");
  if (errors || skipped) {
    table(
      [t("export.report.colKind"), t("export.report.colCount")],
      FAILURE_KINDS.map((k) => [t(k.labelKey), String((report[k.field] || []).length)]),
    );
    out.push(t("export.report.errorsNote"), "");
  } else {
    out.push(t("export.report.clean"), "");
  }
  const warnings = chatEntries
    .filter((c) => !c.failed)
    .flatMap((c) =>
      (c.warnings || []).map((w) =>
        t("export.report.warningLine", { title: c.title, warning: w }),
      ),
    );
  if (warnings.length) {
    out.push(t("export.report.warnings", { count: warnings.length }), "");
    for (const warning of warnings.slice(0, 800)) out.push(`- ${warning}`);
    if (warnings.length > 800)
      out.push("", t("export.report.moreWarnings", { count: warnings.length - 800 }));
    out.push("");
  }
  out.push("---", "", t("export.report.rawNote"));
  return out.join("\n") + "\n";
}
