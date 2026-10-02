// Renderer for the normalized thread: Markdown plus the JSON helper used for
// the raw-response archive.

import { clean, isBlankSystemMessage } from "./model.js";
import { t, tn } from "./i18n.js";

// Role headings stay English in both catalogs: the archive is meant to read the
// same whoever exported it. The labels still live in the catalogs so a future
// locale can translate them without touching this file.
const ROLE_KEYS = {
  user: "export.role.user",
  assistant: "export.role.assistant",
  system: "export.role.system",
  unspecified: "export.role.unspecified",
};
const STATUS_KEYS = {
  generating: "export.status.generating",
  completed: "export.status.completed",
  cancelled: "export.status.cancelled",
  truncated: "export.status.truncated",
  error: "export.status.error",
  pending: "export.status.pending",
  unspecified: "",
};

function roleLabel(role) {
  return ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : role;
}
function statusLabel(status) {
  return STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : "";
}

/** Stable key for de-duplicating an asset across a chat. */
export function assetKey(a) {
  return [
    a.fileId || "",
    a.imageId || "",
    a.artifactId || "",
    a.uri || "",
    a.url || "",
    a.kind || "",
    a.name || "",
  ].join("|");
}

function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function code(text, lang) {
  const f = fence(text);
  return `${f}${lang || ""}\n${String(text).replace(/\s+$/, "")}\n${f}`;
}

export function formatDate(iso, withTime = true) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

/** Sanitize a display name for use as a file name. */
export function safeFileName(name, fallback = "untitled", max = 90) {
  let s = clean(String(name || ""))
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!s) s = fallback;
  if (s.length > max) s = s.slice(0, max).replace(/[-.\s]+$/, "");
  return s;
}

function localRef(asset) {
  return asset && asset.localPath ? asset.localPath : "";
}

// Markdown lives one directory below the archive root, so local asset paths
// need ctx.mdPrefix ("../") to resolve against the sibling assets/ directory.
function urlOrLocal(asset, ctx) {
  const local = localRef(asset);
  if (local) return encodeURI(((ctx && ctx.mdPrefix) || "") + local);
  return asset.url || asset.uri || "";
}

/** ISO-8601 UTC with milliseconds, e.g. 2026-10-02T05:44:49.335Z. */
export function isoTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString();
}

/** A YAML scalar: numbers stay bare, everything else is quoted/escaped. */
function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

/**
 * YAML frontmatter carrying the chat metadata. Timestamps use the standard
 * ISO-8601 UTC form instead of the older localized bullet list.
 */
function frontmatterBlock(chat, stats, exportDate) {
  const lines = ["---"];
  lines.push(`chat_id: ${yamlScalar(chat.id)}`);
  const title = clean(chat.name);
  if (title) lines.push(`title: ${yamlScalar(title)}`);
  const created = isoTimestamp(chat.createTime);
  if (created) lines.push(`created_at: ${created}`);
  const updated = isoTimestamp(chat.updateTime);
  if (updated) lines.push(`updated_at: ${updated}`);
  if (chat.projectName) lines.push(`project: ${yamlScalar(clean(chat.projectName))}`);
  if (chat.model) lines.push(`model: ${yamlScalar(chat.model)}`);
  if (chat.kimiPlus && chat.kimiPlus.name)
    lines.push(`agent: ${yamlScalar(clean(chat.kimiPlus.name))}`);
  lines.push(`messages: ${Number(stats.messages) || 0}`);
  const exported = isoTimestamp(exportDate);
  if (exported) lines.push(`exported_at: ${exported}`);
  lines.push("---", "");
  return lines;
}

/**
 * @param {{chat: any, nodes: any[], stats: object, warnings: string[]}} thread
 * @param {{options: object, assetIndex: Map<string,string>, exportDate: string}} ctx
 */
export function renderMarkdown(thread, ctx) {
  const { chat, nodes, stats, warnings } = thread;
  const options = ctx.options || {};
  const out = [];
  const title = clean(chat.name) || chat.id;
  out.push(...frontmatterBlock(chat, stats || {}, ctx.exportDate));
  out.push(`# ${title}`);
  out.push("");
  if (chat.files && chat.files.length) {
    out.push(t("export.chatFiles"));
    out.push("");
    for (const f of chat.files) {
      const a = ctx.assetIndex.get(
        assetKey({ fileId: f.id, url: f.signUrl, kind: "file", name: f.name }),
      );
      out.push(
        `- ${a ? `📎 [${f.name || f.id}](${encodeURI(((ctx && ctx.mdPrefix) || "") + a)})` : `📎 ${f.name || f.id}`}${f.sizeBytes ? ` · ${formatBytes(f.sizeBytes)}` : ""}`,
      );
    }
    out.push("");
  }
  if (warnings && warnings.length) {
    out.push(`> ⚠️ ${warnings.join("\n> ⚠️ ")}`);
    out.push("");
  }
  out.push("---");
  out.push("");

  for (const node of nodes) {
    if (node.kind === "cycle") {
      out.push(t("export.cycle", { id: node.message.id }));
      out.push("");
      continue;
    }
    const m = node.message;
    // Kimi's content-free system stub has no body; rendering it would only add
    // an empty system section. It still ships in raw/<id>.json.
    if (isBlankSystemMessage(m)) continue;
    const head = [roleLabel(m.role)];
    // Same ISO-8601 UTC form as the frontmatter, so a message timestamp can
    // be compared with created_at/exported_at at a glance.
    const stamp = isoTimestamp(m.createTime);
    if (stamp) head.push(stamp);
    out.push(`## ${head.join(" · ")}`);
    out.push("");
    // A regenerated turn is a group of sibling replies: every member states
    // its position, so the archive reads 1/N, 2/N, … even though only one of
    // them is what the Kimi UI shows.
    if (m.role === "assistant" && node.branchTotal > 1) {
      out.push(`> 🔄 Branch ${node.branchIndex}/${node.branchTotal}`);
      out.push("");
    }
    if (m.status && m.status !== "completed" && m.status !== "unspecified") {
      out.push(t("export.statusLine", { status: statusLabel(m.status) || m.status }));
      out.push("");
    }
    if (m.vote && m.vote !== "unspecified")
      out.push(`${t("export.vote", { emoji: m.vote === "up" ? "👍" : "👎" })}\n`);
    if (m.isGoal) out.push(`${t("export.goal")}\n`);

    let wrote = 0;
    for (const part of m.parts) {
      const block = renderPartMarkdown(part, m, ctx);
      if (block) {
        out.push(block);
        wrote++;
      }
    }
    if (!wrote) {
      out.push(t("export.emptyMessage"));
      out.push("");
    }

    const msgAssets = (m.assets || []).filter(
      (a) =>
        a.localPath &&
        (a.kind === "image" || a.kind === "file" || a.kind === "resource" || a.kind === "sandbox"),
    );
    const shown = new Set();
    const extras = [];
    for (const a of msgAssets) {
      if (a.rendered) continue;
      a.rendered = true;
      const key = a.localPath;
      if (shown.has(key)) continue;
      shown.add(key);
      if (a.kind === "image")
        extras.push(`![${a.name || t("export.imageFallback")}](${urlOrLocal(a, ctx)})`);
      else
        extras.push(
          `- 📎 [${a.name || t("export.fileFallback")}](${urlOrLocal(a, ctx)})${a.sizeBytes ? ` · ${formatBytes(a.sizeBytes)}` : ""}`,
        );
    }
    if (extras.length) {
      out.push(t("export.messageAssets"));
      out.push("");
      out.push(...extras);
      out.push("");
    }

    if (m.citations && m.citations.length) {
      out.push(tn("export.citations", m.citations.length));
      out.push("");
      const seen = new Set();
      for (const c of m.citations) {
        const line = c.url
          ? `- [${c.title || c.url}](${c.url})${c.refIndex ? ` \`${c.refIndex}\`` : ""}`
          : `- 📎 ${c.title || c.kind || t("export.citationFallback")}`;
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
    for (const note of m.notes || []) {
      out.push(`> ℹ️ ${note}`);
      out.push("");
    }
    out.push("---");
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function renderPartMarkdown(part, message, ctx) {
  switch (part.type) {
    case "text": {
      const body = part.text.trim();
      return body + (part.tips ? `\n\n> ${part.tips}` : "");
    }
    case "notice":
      return `> ℹ️ ${part.text}`;
    case "thinking": {
      const inner = part.text.trim();
      if (!inner && !part.summary) return "";
      const label = part.summary
        ? t("export.thinking.withSummary", { summary: part.summary })
        : t("export.thinking");
      return `<details><summary>${label}</summary>\n\n${inner || t("export.thinking.empty")}\n\n</details>`;
    }
    case "thinking-summary":
      return `> 💭 ${part.text}`;
    case "search": {
      const lines = [];
      if (part.keywords && part.keywords.length)
        lines.push(
          t("export.search.keywords", {
            keywords: part.keywords.map((k) => `\`${k}\``).join(" · "),
          }),
        );
      for (const r of part.results || []) {
        lines.push(
          `- [${r.title || r.url}](${r.url})${r.siteName ? ` — ${r.siteName}` : ""}${r.snippet ? `\n  ${r.snippet.replace(/\s+/g, " ")}` : ""}`,
        );
      }
      if (!lines.length) return "";
      return `${tn("export.search", (part.results || []).length)}\n\n${lines.join("\n")}\n\n</details>`;
    }
    case "attachment": {
      const key = assetKey({ fileId: part.fileId, kind: "file", name: part.name });
      const local = findLocalAsset(
        message,
        (a) => a.fileId === part.fileId || (a.kind === "file" && a.name === part.name),
      );
      const size = part.sizeBytes ? ` · ${formatBytes(part.sizeBytes)}` : "";
      const statusNote =
        part.status && part.status !== "success"
          ? t("export.attachment.parseStatus", { status: part.status })
          : "";
      const fail = part.failReason
        ? t("export.attachment.failReason", { reason: part.failReason })
        : "";
      if (local && local.localPath) {
        markRendered(local);
        if (
          (local.type === "image" || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(part.name || "")) &&
          !/\.(pdf|docx?|xlsx?|pptx?|zip|txt|md|csv|json|py|js|ts|ipynb)$/i.test(part.name || "")
        ) {
          return `![${part.name}](${urlOrLocal(local, ctx)})`;
        }
        return `📎 [${part.name || t("export.attachment.fallback")}](${urlOrLocal(local, ctx)})${size}${statusNote}${fail}`;
      }
      if (key && local) markRendered(local);
      return `📎 ${part.name || part.fileId || t("export.attachment.fallback")}${size}${statusNote}${fail}${part.hasUrl ? "" : t("export.attachment.noUrl")}`;
    }
    case "tool": {
      if (part.paywall && part.paywall.needUpgrade)
        return t("export.paywall", { source: part.paywall.source || t("export.unknown") });
      const head = part.mcp
        ? t("export.tool.mcp", { name: part.name, mcp: part.mcp })
        : part.plugin
          ? t("export.tool.plugin", { name: part.name, plugin: part.plugin })
          : `🔧 ${part.name || t("export.tool.fallback")}`;
      const bits = [];
      if (part.task && part.task.name) bits.push(t("export.tool.task", { name: part.task.name }));
      if (part.subagent && part.subagent.agentName)
        bits.push(t("export.tool.subagent", { name: part.subagent.agentName }));
      if (part.slidesGenerator && part.slidesGenerator.slidesId)
        bits.push(`slides_id：${part.slidesGenerator.slidesId}`);
      if (part.cronJob && part.cronJob.cronJobId)
        bits.push(`cron_job_id：${part.cronJob.cronJobId}`);
      if (bits.length) bits.unshift("");
      const body = [];
      if (part.args && part.args !== "null") {
        let pretty = part.args;
        try {
          pretty = JSON.stringify(JSON.parse(part.args), null, 2);
        } catch {
          /* keep as-is */
        }
        body.push(code(pretty, "json"));
        body.push("");
      }
      for (const c of part.contents || []) {
        if (c.type === "text") {
          if (c.text.trim()) body.push(c.text.trim());
        } else if (c.type === "image") {
          const local = findLocalAsset(
            message,
            (a) => a.kind === "image" && (a.imageId === c.ref.id || a.url === c.ref.url),
          );
          if (local) {
            markRendered(local);
            body.push(
              `![${c.ref.caption || t("export.tool.generatedImage")}](${urlOrLocal(local, ctx)})`,
            );
          } else if (c.ref.url) body.push(`![${t("export.tool.image")}](${c.ref.url})`);
        } else if (c.type === "resource")
          body.push(`- 📦 ${c.name || c.uri || t("export.resource")}`);
        else if (c.type === "cite") body.push(`- 🔗 [${c.title || c.url}](${c.url})`);
        else if (c.type === "slides")
          body.push(
            `- 📊 ${t("export.tool.slides", { name: c.name || c.slidesId || t("export.untitled") })}`,
          );
        else if (c.type === "memory") body.push(`- 🧠 ${t("export.memory", { text: c.text })}`);
        else if (c.type === "url") body.push(`- 🌐 [${c.title || c.url}](${c.url})`);
        else if (c.type === "goods") body.push(`- 🛒 ${c.text || t("export.goods")}`);
        else if (c.type === "raw") body.push(code(JSON.stringify(c.raw, null, 2), "json"));
      }
      if (part.isError)
        body.push(
          `${t("export.tool.error")}${part.errorCode ? t("export.tool.errorCode", { code: part.errorCode }) : ""}`,
        );
      if (!body.length) {
        const note = part.needsFetch ? t("export.tool.needsFetch") : t("export.tool.noOutput");
        return `<details><summary>${head}</summary>\n\n${note}\n\n</details>`;
      }
      return `<details><summary>${head}</summary>\n\n${body.join("\n")}\n\n</details>`;
    }
    case "artifact": {
      const label = part.title || part.path || part.artifactId || t("export.artifact");
      if (!part.content)
        return t("export.artifact.empty", { label, type: part.artifactType });
      const local = findLocalAsset(
        message,
        (a) => a.kind === "artifact" && a.artifactId === part.artifactId,
      );
      if (local) {
        markRendered(local);
        return t("export.artifact.link", { label, url: urlOrLocal(local, ctx) });
      }
      const lang =
        part.artifactType === "code"
          ? guessLang(part.path || part.title || "")
          : part.artifactType === "markdown"
            ? "markdown"
            : "";
      const body =
        part.content.length > 20000
          ? part.content.slice(0, 20000) +
            t("export.artifact.truncated", { count: part.content.length - 20000 })
          : part.content;
      return `${t("export.artifact.heading", { label })}\n\n${code(body, lang)}`;
    }
    case "slides": {
      const bits = [t("export.slides.name", { name: part.name || t("export.slides.untitledPpt") })];
      if (part.slidesId) bits.push(`slides_id：${part.slidesId}`);
      if (part.status) bits.push(t("export.slides.status", { status: part.status }));
      const local = findLocalAsset(
        message,
        (a) => a.kind === "slides" || a.kind === "slides-payload" || a.kind === "slides-cover",
      );
      if (local && local.localPath) {
        markRendered(local);
        bits.push(t("export.slides.local", { name: local.name, url: urlOrLocal(local, ctx) }));
      }
      return `> 📊 ${bits.join(" · ")}`;
    }
    case "aippt": {
      const bits = [
        t("export.aippt.title", { title: part.title || t("export.aippt.fallback") }),
      ];
      if (part.status) bits.push(t("export.slides.status", { status: part.status }));
      if (part.pptSizeByte) bits.push(`PPT ${formatBytes(part.pptSizeByte)}`);
      if (part.pdfSizeByte) bits.push(`PDF ${formatBytes(part.pdfSizeByte)}`);
      const files = (message.assets || []).filter(
        (a) => a.kind === "ppt" || a.kind === "pdf" || a.kind === "ppt-cover",
      );
      for (const f of files) {
        markRendered(f);
        if (f.localPath) bits.push(`[${f.name}](${urlOrLocal(f, ctx)})`);
      }
      return `> 🎞️ ${bits.join(" · ")}`;
    }
    case "stages": {
      const lines = (part.stages || []).map((s) => {
        const label = s.rawName || s.name || t("export.stages.label");
        const extras = [];
        if (s.durationSeconds) extras.push(`${s.durationSeconds}s`);
        if (s.description) extras.push(s.description);
        return `- ${label}${
          extras.length
            ? t("export.stages.extras", { items: extras.join(t("common.comma")) })
            : ""
        }`;
      });
      if (!lines.length) return "";
      return `${tn("export.stages", lines.length)}\n\n${lines.join("\n")}\n\n</details>`;
    }
    case "research": {
      const lines = [];
      for (const st of part.steps || []) {
        const pages = (st.pages || [])
          .map((p) => `[${p.title || p.url}](${p.url})`)
          .join(t("common.listSep"));
        lines.push(
          `- ${st.title || t("export.research.step")}${
            st.keywords && st.keywords.length
              ? t("export.research.keywords", {
                  keywords: st.keywords.join(t("common.listSep")),
                })
              : ""
          }${pages ? `\n  ${t("export.research.hits", { pages })}` : ""}`,
        );
      }
      if (!lines.length) return "";
      return `${tn("export.research", lines.length)}\n\n${lines.join("\n")}\n\n</details>`;
    }
    case "research-reanswer":
      return t("export.research.reanswer", {
        targets: part.usedTargetCount,
        urls: part.usedUrlCount,
        pages: part.readUrlCount,
      });
    case "resource": {
      const local = findLocalAsset(message, (a) => a.uri === part.uri || a.name === part.name);
      if (local && local.localPath) {
        markRendered(local);
        return `📦 [${part.name || part.uri}](${urlOrLocal(local, ctx)})`;
      }
      return `📦 ${part.name || part.uri || t("export.resource")}${part.sizeBytes ? ` · ${formatBytes(part.sizeBytes)}` : ""}`;
    }
    case "memory": {
      const bits = [];
      if ((part.created || []).length)
        bits.push(t("export.memory.added", { count: part.created.length }));
      if ((part.updated || []).length)
        bits.push(t("export.memory.updated", { count: part.updated.length }));
      if ((part.deleted || []).length)
        bits.push(t("export.memory.deleted", { count: part.deleted.length }));
      const items = [
        ...(part.created || []),
        ...(part.updated || []),
        ...(part.deleted || []),
      ].filter(Boolean);
      const body = items.length ? `\n\n${items.map((line) => `- ${line}`).join("\n")}` : "";
      return `${t("export.memory.heading")}${
        bits.length ? t("export.memory.details", { items: bits.join(t("common.listSep")) }) : ""
      }${body}`;
    }
    case "error": {
      const bits = [];
      if (part.reason) bits.push(part.reason);
      if (part.severity && part.severity !== "unspecified") bits.push(`severity=${part.severity}`);
      return `> ❌ ${[...bits, part.message].filter(Boolean).join(" — ") || t("export.error.fallback")}`;
    }
    case "annotation": {
      const items = (part.annotations || []).filter(Boolean);
      if (!items.length) return "";
      const where = part.filePath
        ? t("export.annotation.where", { name: part.fileName || part.filePath })
        : "";
      return tn("export.annotation.heading", items.length, {
        where,
        items: items.map((line) => `> - ${line.replace(/\n/g, " ")}`).join("\n"),
      });
    }
    case "card": {
      const summary = summarizeCard(part.cardKind, part.raw);
      return `<details><summary>🃏 ${summary.title}</summary>\n\n${code(JSON.stringify(part.raw, null, 2), "json")}\n\n</details>`;
    }
    case "agent-message":
      return `**🤖 ${part.agentName || t("export.agent.fallback")}**\n\n${part.content}`;
    case "im-message":
      return `**💬 ${part.sender || t("export.im.member")}**${
        part.hint ? t("export.im.hint", { hint: part.hint }) : ""
      }\n\n${part.content}`;
    default:
      return code(JSON.stringify(part, null, 2), "json");
  }
}

function summarizeCard(kind, raw) {
  const title = clean((raw && (raw.title || raw.name || raw.query)) || "") || kind;
  return { title: t("export.card.title", { title, kind }) };
}

function guessLang(nameOrTitle) {
  const m = String(nameOrTitle).match(/\.([a-z0-9]+)$/i);
  if (!m) return "";
  const map = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    sh: "bash",
    css: "css",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sql: "sql",
    md: "markdown",
  };
  return map[m[1].toLowerCase()] || m[1].toLowerCase();
}

function findLocalAsset(message, pred) {
  return (message.assets || []).find(pred);
}

function markRendered(asset) {
  if (asset) asset.rendered = true;
}

export function jsStringify(value) {
  // Escape characters that could terminate the enclosing <script> tag, plus the
  // line/paragraph separators that are legal in JSON but break JS string literals.
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Markdown file names come from title + creation day; two chats can
// share both, so append a short chat-id suffix rather than overwriting.
export function uniqueMdName(day, slug, chatId, used) {
  let name = day + "-" + slug + ".md";
  // Separator before the id suffix is "_" so the chat's own "-" characters
  // stay readable in the file name.
  if (used && used.has(name)) name = day + "-" + slug + "_" + String(chatId).slice(-6) + ".md";
  if (used) used.add(name);
  return name;
}
