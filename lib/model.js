// Content model: turn the raw proto-JSON message tree into a linear, renderable
// structure while collecting every asset URL that should be downloaded.

import {
  ROLE,
  MESSAGE_STATUS,
  MESSAGE_STATUS_NAMES,
  VOTE,
  VOTE_NAMES,
  FILE_TYPE,
  FILE_TYPE_NAMES,
  PROCESS_STATUS,
  PROCESS_STATUS_NAMES,
  ARTIFACT_TYPE,
  ARTIFACT_TYPE_NAMES,
  LOAD_TYPE,
  SEVERITY,
  REASON,
  STAGE_NAME,
  STAGE_STATUS,
  REFERENCE_TYPE,
  IMAGE_STATE,
  IMAGE_SOURCE,
  URL_REF_STATUS,
  BLOCK_KINDS,
  decodeEnum,
} from "./enums.js";
import { asInt, ts } from "./api.js";
import { t, tn } from "./i18n.js";

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const PUA = /[\ue000-\uf8ff]/g;

export function clean(s) {
  if (typeof s !== "string") return "";
  return s.replace(PUA, "");
}

function roleOf(m) {
  const r = decodeEnum(m.role, ROLE, ROLE) || "unspecified";
  if (
    r === "unspecified" &&
    typeof m.role === "string" &&
    ["user", "assistant", "system"].includes(m.role)
  )
    return m.role;
  return r;
}

function statusOf(m) {
  return decodeEnum(m.status, MESSAGE_STATUS, MESSAGE_STATUS_NAMES);
}

function voteOf(v) {
  return decodeEnum(v, VOTE, VOTE_NAMES);
}

/**
 * Rebuild the message tree and flatten it into render order.
 *
 * Kimi stores each turn as a DAG of regenerations: a node's childrenMessageIds are
 * its branches, and the UI's visible thread is the last child at every step.
 * @param {any[]} messages
 * @param {{branches: 'all'|'latest'}} opts
 */
function buildThread(messages, opts = { branches: "all" }) {
  const byId = new Map();
  for (const m of messages || []) if (m && m.id) byId.set(m.id, m);

  const childIds = (m) => {
    const declared = Array.isArray(m.childrenMessageIds)
      ? m.childrenMessageIds.filter((id) => byId.has(id))
      : [];
    if (declared.length) return declared;
    // Fall back to parent links when childrenMessageIds is missing or stale.
    return [...byId.values()].filter((c) => c.parentId === m.id).map((c) => c.id);
  };

  const roots = [];
  const linked = new Set();
  for (const m of byId.values()) {
    const p = m.parentId;
    if (p && p !== NIL_ID && byId.has(p)) linked.add(m.id);
  }
  for (const m of byId.values()) {
    if (linked.has(m.id)) continue;
    roots.push(m.id);
  }
  if (!roots.length && byId.size) roots.push([...byId.keys()][0]);

  // Kimi appends regenerations, so the last child is what the UI shows. Prefer a
  // child that itself continues when the newest one is a dead end (a cancelled
  // regeneration), which matches the visible thread.
  const mainlineChild = (kids) => {
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = byId.get(kids[i]);
      if (!kid) continue;
      const continues =
        (kid.childrenMessageIds || []).some((c) => byId.has(c)) ||
        [...byId.values()].some((c) => c.parentId === kid.id);
      if (continues) return kids[i];
    }
    return kids[kids.length - 1];
  };

  const nodes = [];
  const visited = new Set();
  const emit = (m, depth, isMainline, branchIndex, branchTotal) => {
    if (!m) return false;
    if (visited.has(m.id)) {
      nodes.push({ message: m, depth, kind: "cycle", isMainline, branchIndex, branchTotal });
      return false;
    }
    visited.add(m.id);
    nodes.push({ message: m, depth, kind: "message", isMainline, branchIndex, branchTotal });
    return true;
  };
  // Full subtree for one alternative branch (its own regenerations included).
  const emitBranch = (id, depth, branchIndex, branchTotal) => {
    const m = byId.get(id);
    if (!emit(m, depth, false, branchIndex, branchTotal)) return;
    for (const kid of childIds(m)) {
      emitBranch(kid, depth + 1, childIds(m).indexOf(kid) + 1, childIds(m).length);
    }
  };

  // Iterative mainline walk: emit node, then its visible reply, then that
  // reply's sibling regenerations (alternatives to the same turn), then keep
  // descending the visible reply. This matches how the UI groups turns.
  const stack = roots.map((id) => ({ id, depth: 0, index: 1, total: roots.length }));
  while (stack.length) {
    const start = stack.shift();
    let current = byId.get(start.id);
    if (!emit(current, start.depth, true, start.index, start.total)) continue;
    for (;;) {
      const kids = childIds(current);
      if (!kids.length) break;
      const main = mainlineChild(kids);
      const mainIndex = kids.indexOf(main);
      // Emit the sibling group in child order, so the archive's "Branch M/N"
      // labels read 1/N, 2/N, … The visible reply is only one member of the
      // group, so it is no longer forced to the front.
      let descended = false;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (kid === main) {
          if (!emit(byId.get(main), start.depth + 1, true, mainIndex + 1, kids.length)) break;
          descended = true;
        } else if (opts.branches === "all") {
          emitBranch(kid, start.depth + 1, i + 1, kids.length);
        }
      }
      if (!descended) break;
      current = byId.get(main);
    }
  }

  return { nodes, byId, childIds, unlinked: byId.size - visited.size };
}

/** Collect every downloadable reference inside one message. */
function collectAssets(message, push) {
  const mid = message.id;
  for (const block of message.blocks || []) {
    if (!block || typeof block !== "object") continue;
    const kind = blockKind(block);
    const bid = block.id || "";
    if (kind === "file") {
      const f = block.file || {};
      push(assetFrom(f, { message: mid, block: bid, origin: "block.file" }));
    }
    if (kind === "tool") {
      for (const c of (block.tool || {}).contents || []) {
        if (c.image)
          push(imageAsset(c.image, { message: mid, block: bid, origin: "tool.contents.image" }));
        if (c.resourceLink)
          push(
            linkAsset(c.resourceLink, {
              message: mid,
              block: bid,
              origin: "tool.contents.resource_link",
            }),
          );
        if (c.slides)
          push(
            urlAsset(c.slides.payloadUrl || c.slides.coverUrl, {
              message: mid,
              block: bid,
              kind: "slides",
              name: c.slides.name || "slides",
              origin: "tool.contents.slides",
            }),
          );
      }
    }
    if (kind === "slidesView") {
      const s = block.slidesView || {};
      push(
        urlAsset(s.payloadUrl, {
          message: mid,
          block: bid,
          kind: "slides-payload",
          name: s.name || "slides",
          origin: "slides_view.payload_url",
        }),
      );
      push(
        urlAsset(s.coverUrl, {
          message: mid,
          block: bid,
          kind: "slides-cover",
          name: (s.name || "slides") + "-cover",
          origin: "slides_view.cover_url",
        }),
      );
    }
    if (kind === "aippt") {
      const p = block.aippt || {};
      push(
        urlAsset(p.pptDownloadUrl, {
          message: mid,
          block: bid,
          kind: "ppt",
          name: (p.title || "ai-ppt") + ".pptx",
          origin: "aippt.ppt_download_url",
        }),
      );
      push(
        urlAsset(p.pdfDownloadUrl, {
          message: mid,
          block: bid,
          kind: "pdf",
          name: (p.title || "ai-ppt") + ".pdf",
          origin: "aippt.pdf_download_url",
        }),
      );
      push(
        urlAsset(p.coverUrl, {
          message: mid,
          block: bid,
          kind: "ppt-cover",
          name: (p.title || "ai-ppt") + "-cover",
          origin: "aippt.cover_url",
        }),
      );
    }
    if (kind === "resourceLink") {
      push(
        linkAsset(block.resourceLink || {}, { message: mid, block: bid, origin: "resource_link" }),
      );
    }
    if (kind === "videoCards") {
      for (const card of (block.videoCards || {}).cards || []) {
        push(
          urlAsset(card.coverUrl || card.coverThumbnailUrl, {
            message: mid,
            block: bid,
            kind: "video-cover",
            name: card.title || "video-cover",
            origin: "video_card.cover_url",
          }),
        );
      }
    }
    if (kind === "websitesTemplate") {
      push(
        urlAsset((block.websitesTemplate || {}).coverUrl, {
          message: mid,
          block: bid,
          kind: "template-cover",
          name: "template",
          origin: "websites_template.cover_url",
        }),
      );
    }
    if (kind === "inspirationTemplate") {
      push(
        urlAsset((block.inspirationTemplate || {}).coverUrl, {
          message: mid,
          block: bid,
          kind: "inspiration-cover",
          name: "inspiration",
          origin: "inspiration_template.cover_url",
        }),
      );
    }
    if (kind === "artifact") {
      const a = block.artifact || {};
      if (a.content)
        push({
          synthetic: true,
          kind: "artifact",
          message: mid,
          block: bid,
          artifactId: a.artifactId,
          type: decodeEnum(a.type, ARTIFACT_TYPE, ARTIFACT_TYPE_NAMES),
          path: a.path || "",
          title: a.title || "",
          content: a.content,
          version: a.version || "",
        });
    }
  }
  const refs = message.refs || {};
  for (const img of refs.images || [])
    push(imageAsset(img, { message: mid, origin: "refs.images" }));
  for (const sf of refs.sandboxFiles || []) {
    push(
      urlAsset(sf.downloadUrl, {
        message: mid,
        kind: "sandbox",
        name: sf.fileName || sf.uri || "sandbox-file",
        fileId: sf.externalId || sf.uri,
        origin: "refs.sandbox_files",
      }),
    );
  }
  for (const u of refs.urls || []) {
    push({
      nonDownload: true,
      kind: "url",
      url: u.url,
      title: u.title,
      status: decodeEnum(u.status, URL_REF_STATUS),
      wordCount: asInt(u.wordCount),
      origin: "refs.urls",
    });
  }
  for (const f of refs.files || []) push(assetFrom(f, { message: mid, origin: "refs.files" }));
  for (const r of message.references || []) {
    for (const item of r.items || []) {
      if (item.image) push(imageAsset(item.image, { message: mid, origin: "references.image" }));
      if (item.file) push(assetFrom(item.file, { message: mid, origin: "references.file" }));
      if (item.search && item.search.base) {
        push({
          nonDownload: true,
          kind: "cite",
          url: item.search.base.url,
          title: item.search.base.title,
          snippet: item.search.base.snippet,
          origin: "references.search",
        });
      }
    }
  }
  for (const sc of refs.searchChunks || []) {
    if (sc.base)
      push({
        nonDownload: true,
        kind: "cite",
        url: sc.base.url,
        title: sc.base.title,
        snippet: sc.base.snippet,
        refIndex: sc.refIndex,
        chunk: sc.chunk,
        origin: "refs.search_chunks",
      });
  }
}

function assetFrom(f, meta) {
  if (!f || !f.id) return null;
  const m = f.meta || {};
  const blob = f.blob || {};
  const parse = f.parseResult || {};
  const url = blob.signUrl || blob.previewUrl || "";
  if (!url)
    return {
      ...meta,
      kind: "file",
      fileId: f.id,
      name: m.name || f.id,
      contentType: m.contentType || "",
      sizeBytes: asInt(m.sizeBytes),
      needsFetch: true,
      type: decodeEnum(m.type, FILE_TYPE, FILE_TYPE_NAMES),
    };
  return {
    ...meta,
    kind: "file",
    fileId: f.id,
    url,
    name: m.name || f.id,
    contentType: m.contentType || "",
    sizeBytes: asInt(m.sizeBytes),
    ext: m.ext || "",
    type: decodeEnum(m.type, FILE_TYPE, FILE_TYPE_NAMES),
    status: decodeEnum(f.status, PROCESS_STATUS, PROCESS_STATUS_NAMES),
    thumbnail: parse.thumbnail ? parse.thumbnail.url || "" : "",
    parsedUrl: parse.url ? parse.url.url || parse.url.value || "" : "",
    needsFetch: false,
  };
}

function imageAsset(img, meta) {
  if (!img) return null;
  const url = img.fullSizeUrl || img.url || img.originUrl || img.thumbnailUrl || "";
  if (!url) return null;
  return {
    ...meta,
    kind: "image",
    url,
    fileId: img.fileId || "",
    imageId: img.id || "",
    name: img.caption || img.id || "image",
    caption: img.caption || "",
    width: asInt(img.width),
    height: asInt(img.height),
    state: decodeEnum(img.state, IMAGE_STATE),
    source: decodeEnum(img.source, IMAGE_SOURCE),
    originUrl: img.originUrl || "",
    thumbnailUrl: img.thumbnailUrl || "",
    displaySource: img.displaySource || "",
    sourceSiteUrl: img.sourceSiteUrl || "",
    refIndex: img.refIndex || "",
  };
}

function linkAsset(rl, meta) {
  const url = rl.downloadUrl || rl.uri || "";
  if (!url) return null;
  return {
    ...meta,
    kind: "resource",
    url,
    name: rl.title || rl.uri || "resource",
    uri: rl.uri || "",
    etag: rl.etag || "",
    sizeBytes: asInt(rl.sizeBytes),
  };
}

function urlAsset(url, meta) {
  if (!url) return null;
  return { ...meta, url };
}

/** Which member of the Block.content oneof is set. */
function blockKind(block) {
  if (!block || typeof block !== "object") return "";
  for (const key of BLOCK_KINDS) {
    if (block[key] !== undefined && block[key] !== null) return key;
  }
  // snake_case fallback in case the gateway ever emits raw proto field names
  const snake = {
    explorer_research: "explorerResearch",
    slides_view: "slidesView",
    resource_link: "resourceLink",
    aippt: "aippt",
  };
  for (const [s, camel] of Object.entries(snake)) {
    if (block[s] !== undefined && block[s] !== null) return camel;
  }
  return "";
}

/**
 * Normalise one message into renderable parts.
 * @param {any} m raw ChatMessage
 * @param {{thinking: boolean, tools: boolean, citations: boolean, downloadMedia: boolean, raw: any[]}} ctx
 */
function normalizeMessage(m, ctx) {
  const assets = [];
  const parts = [];
  const unknown = [];
  const notes = [];

  collectAssets(m, (a) => {
    if (a) assets.push(a);
  });

  for (const block of m.blocks || []) {
    const kind = blockKind(block);
    const bid = block.id || "";
    switch (kind) {
      case "text": {
        const text = block.text || {};
        const content = clean(text.content || "");
        if (content) parts.push({ type: "text", text: content, tips: clean(text.tips || "") });
        else if (text.tips) parts.push({ type: "notice", text: clean(text.tips) });
        break;
      }
      case "think": {
        const th = block.think || {};
        const content = clean(th.content || "");
        const summary = clean(th.summary || "");
        if (ctx.thinking) {
          if (content || summary) parts.push({ type: "thinking", text: content, summary });
        } else if (summary) {
          parts.push({ type: "thinking-summary", text: summary });
        }
        break;
      }
      case "search": {
        if (!ctx.citations) break;
        const s = block.search || {};
        parts.push({
          type: "search",
          keywords: (s.keywords || []).map(clean),
          results: (s.webPages || []).map((p) => ({
            title: clean(p.title || ""),
            url: p.url || "",
            siteName: clean(p.siteName || ""),
            snippet: clean(p.snippet || ""),
            publishTime: ts(p.publishTime),
            keyword: clean(p.keyword || ""),
            highlight: clean(p.highlight || ""),
            fileId: p.fileId || "",
            downloadUrl: p.downloadUrl || "",
          })),
        });
        break;
      }
      case "file": {
        const f = block.file || {};
        const meta = f.meta || {};
        parts.push({
          type: "attachment",
          fileId: f.id || "",
          name: clean(meta.name || f.id || ""),
          contentType: meta.contentType || "",
          sizeBytes: asInt(meta.sizeBytes),
          status: decodeEnum(f.status, PROCESS_STATUS, PROCESS_STATUS_NAMES),
          failReason: clean(f.failReason || ""),
          hasUrl: Boolean((f.blob || {}).signUrl || (f.blob || {}).previewUrl),
        });
        break;
      }
      case "tool": {
        if (!ctx.tools) break;
        const tool = block.tool || {};
        const contents = [];
        for (const c of tool.contents || []) {
          if (c.text !== undefined && c.text !== "")
            contents.push({ type: "text", text: clean(c.text) });
          else if (c.mutableText)
            contents.push({
              type: "text",
              text: clean(c.mutableText.content || c.mutableText.text || ""),
            });
          else if (c.image) contents.push({ type: "image", ref: imageRef(c.image) });
          else if (c.resourceLink)
            contents.push({
              type: "resource",
              name: clean(c.resourceLink.title || ""),
              uri: c.resourceLink.uri || "",
            });
          else if (c.searchResult && c.searchResult.base)
            contents.push({
              type: "cite",
              title: clean(c.searchResult.base.title || ""),
              url: c.searchResult.base.url || "",
            });
          else if (c.slides)
            contents.push({
              type: "slides",
              name: clean(c.slides.name || ""),
              slidesId: c.slides.slidesId || "",
            });
          else if (c.memory)
            contents.push({
              type: "memory",
              text: clean(c.memory.content || JSON.stringify(c.memory)),
            });
          else if (c.goods)
            contents.push({ type: "goods", text: clean(c.goods.title || ""), raw: c.goods });
          else if (c.webOpenUrl)
            contents.push({
              type: "url",
              url: c.webOpenUrl.url || "",
              title: clean(c.webOpenUrl.title || ""),
            });
          else contents.push({ type: "raw", raw: c });
        }
        parts.push({
          type: "tool",
          toolCallId: tool.toolCallId || "",
          name: clean(tool.name || ""),
          args: typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args ?? null),
          isError: Boolean(tool.isError),
          errorCode: asInt(tool.errorCode),
          status: decodeEnum(tool.status),
          loadType: decodeEnum(tool.loadType, LOAD_TYPE),
          contentCount: asInt(tool.contentCount),
          mcp: tool.mcp ? clean(tool.mcp.name || "") : "",
          plugin: tool.plugin ? clean(tool.plugin.displayName || tool.plugin.id || "") : "",
          task: tool.task
            ? {
                name: clean(tool.task.name || ""),
                todoList: tool.task.todoList || "",
                msgId: tool.task.msgId || "",
              }
            : null,
          subagent: tool.subagent
            ? {
                agentName: clean(tool.subagent.agentName || ""),
                agentType: tool.subagent.agentType || "",
              }
            : null,
          createSubagent: tool.createSubagent
            ? {
                name: clean(tool.createSubagent.name || ""),
                workers: (tool.createSubagent.workers || []).map((w) => clean(w.name || "")),
              }
            : null,
          slidesGenerator: tool.slidesGenerator
            ? { slidesId: tool.slidesGenerator.slidesId || "" }
            : null,
          cronJob: tool.cronJob ? { cronJobId: tool.cronJob.cronJobId || "" } : null,
          paywall: tool.paywall
            ? { needUpgrade: Boolean(tool.paywall.needUpgrade), source: tool.paywall.source || "" }
            : null,
          contents,
          needsFetch:
            !contents.length &&
            (asInt(tool.contentCount) > 0 || decodeEnum(tool.loadType, LOAD_TYPE) === "external"),
        });
        break;
      }
      case "artifact": {
        const a = block.artifact || {};
        parts.push({
          type: "artifact",
          artifactId: a.artifactId || "",
          artifactType: decodeEnum(a.type, ARTIFACT_TYPE, ARTIFACT_TYPE_NAMES),
          version: a.version || "",
          path: a.path || "",
          title: clean(a.title || ""),
          content: a.content !== undefined ? String(a.content) : "",
        });
        break;
      }
      case "slidesView": {
        const s = block.slidesView || {};
        parts.push({
          type: "slides",
          name: clean(s.name || ""),
          slidesId: s.slidesId || "",
          templateId: s.templateId || "",
          status: decodeEnum(s.status),
          payloadUrl: s.payloadUrl || "",
          coverUrl: s.coverUrl || "",
          createTime: ts(s.createTime),
          updateTime: ts(s.updateTime),
        });
        break;
      }
      case "aippt": {
        const p = block.aippt || {};
        parts.push({
          type: "aippt",
          title: clean(p.title || ""),
          status: p.status || "",
          pptTaskId: p.pptTaskId || "",
          designId: asInt(p.designId),
          pptDownloadUrl: p.pptDownloadUrl || "",
          pdfDownloadUrl: p.pdfDownloadUrl || "",
          coverUrl: p.coverUrl || "",
          pptSizeByte: asInt(p.pptSizeByte),
          pdfSizeByte: asInt(p.pdfSizeByte),
        });
        break;
      }
      case "stage":
      case "multiStage": {
        const stages = kind === "stage" ? [block.stage] : (block.multiStage || {}).stages || [];
        parts.push({
          type: "stages",
          stages: stages.map((s) => ({
            name: decodeEnum(s && s.name, STAGE_NAME),
            description: clean((s && s.description) || ""),
            status: decodeEnum(s && s.status, STAGE_STATUS),
            index: asInt(s && s.index),
            durationSeconds: asInt(s && s.durationSeconds),
            createTime: ts(s && s.createTime),
          })),
        });
        break;
      }
      case "explorerResearch": {
        const r = block.explorerResearch || {};
        parts.push({
          type: "research",
          status: decodeEnum(r.status),
          steps: (r.steps || []).map((st) => ({
            title: clean(st.title || ""),
            status: decodeEnum(st.status),
            keywords: (st.keywords || []).map(clean),
            pages: (st.webPages || []).map((p) => ({
              title: clean(p.title || ""),
              url: p.url || "",
              siteName: clean(p.siteName || ""),
            })),
          })),
        });
        break;
      }
      case "explorerResearchReanswer": {
        const r = block.explorerResearchReanswer || {};
        parts.push({
          type: "research-reanswer",
          usedTargetCount: asInt(r.usedTargetCount),
          usedUrlCount: asInt(r.usedUrlCount),
          readUrlCount: asInt(r.readUrlCount),
        });
        break;
      }
      case "resourceLink": {
        const rl = block.resourceLink || {};
        parts.push({
          type: "resource",
          name: clean(rl.title || ""),
          uri: rl.uri || "",
          etag: rl.etag || "",
          sizeBytes: asInt(rl.sizeBytes),
        });
        break;
      }
      case "memory": {
        const me = block.memory || {};
        parts.push({
          type: "memory",
          created: (me.created || []).map(clean),
          updated: (me.updated || []).map(clean),
          deleted: (me.deleted || []).map(clean),
          currentMemoryCount: asInt(me.currentMemoryCount),
          maxMemoryCount: asInt(me.maxMemoryCount),
        });
        break;
      }
      case "exception":
      case "error": {
        const e = (kind === "exception" ? block.exception : block.error) || {};
        const err = e.error || e;
        parts.push({
          type: "error",
          reason: decodeEnum(err.reason, REASON),
          severity: decodeEnum(err.severity, SEVERITY),
          message: clean(
            (err.localizedMessage &&
              (err.localizedMessage.message || err.localizedMessage.content)) ||
              err.message ||
              "",
          ),
          paywall: err.paywall
            ? {
                needUpgrade: Boolean(err.paywall.needUpgrade),
                upgradeTo: decodeEnum(err.paywall.upgradeTo),
              }
            : null,
        });
        break;
      }
      case "slidesAnnotation":
      case "fileAnnotation":
      case "model3dAnnotation": {
        const holder =
          kind === "slidesAnnotation"
            ? block.slidesAnnotation
            : kind === "fileAnnotation"
              ? block.fileAnnotation
              : block.model3dAnnotation;
        parts.push({
          type: "annotation",
          annotationKind: kind,
          annotations: (holder.annotations || []).map((an) =>
            clean(an.annotation || an.comment || JSON.stringify(an)),
          ),
          currentPage: holder.currentPage || "",
          filePath: holder.filePath || "",
          fileName: holder.fileName || "",
        });
        break;
      }
      case "videoCards":
      case "elemeMenuCard":
      case "elemeOrderCard":
      case "contentViewZhidemaiCard":
      case "websitesTemplate":
      case "inspirationTemplate":
      case "visualEdit":
      case "websiteSelector":
      case "make3dTypeSelection":
      case "editorContext":
      case "contractReview":
      case "imRoomSystem": {
        parts.push({
          type: "card",
          cardKind: kind,
          raw: block[kind === "contractReview" ? "contractReview" : kind] || {},
        });
        break;
      }
      case "agentMessage": {
        const a = block.agentMessage || {};
        parts.push({
          type: "agent-message",
          agentName: clean(a.agentName || ""),
          agentId: a.agentId || "",
          content: clean(a.content || ""),
          icon: a.agentIcon || "",
        });
        break;
      }
      case "imMessage": {
        const im = block.imMessage || {};
        parts.push({
          type: "im-message",
          sender: clean(im.senderName || ""),
          content: clean(im.content || ""),
          hint: clean(im.hint || ""),
          avatar: im.senderAvatar || "",
        });
        break;
      }
      default: {
        const extras = Object.keys(block).filter(
          (k) => !["id", "parentId", "messageId", "createTime"].includes(k),
        );
        unknown.push({ keys: extras, raw: block });
        notes.push(
          t("export.note.unknownBlock", {
            fields: extras.join(", ") || t("export.note.emptyFields"),
          }),
        );
      }
    }
  }

  const refs = m.refs || {};
  const citations = [];
  for (const sc of refs.usedSearchChunks || refs.searchChunks || []) {
    if (!sc || !sc.base) continue;
    citations.push({
      title: clean(sc.base.title || ""),
      url: sc.base.url || "",
      siteName: clean(sc.base.siteName || ""),
      refIndex: sc.refIndex || "",
      chunk: clean(sc.chunk || ""),
      blockId: sc.blockId || "",
      id: sc.id || "",
      source: refs.usedSearchChunks ? "used" : "available",
    });
  }
  for (const r of m.references || []) {
    for (const item of r.items || []) {
      if (item.search && item.search.base) {
        citations.push({
          title: clean(item.search.base.title || ""),
          url: item.search.base.url || "",
          siteName: clean(item.search.base.siteName || ""),
          refIndex: item.search.refIndex || "",
          matched: clean(r.matchedText || ""),
          type: decodeEnum(r.type, REFERENCE_TYPE),
        });
      }
      if (item.urlRef)
        citations.push({
          title: clean(item.urlRef.title || ""),
          url: item.urlRef.url || "",
          refIndex: item.urlRef.refIndex || "",
        });
      if (item.file)
        citations.push({
          title: clean((item.file.meta || {}).name || item.file.id || ""),
          kind: "file",
          fileId: item.file.id || "",
        });
      if (item.image)
        citations.push({
          title: clean(item.image.caption || ""),
          url: item.image.fullSizeUrl || item.image.url || "",
          kind: "image",
        });
      if (item.extension)
        citations.push({
          title: clean(item.extension.name || item.extension.id || ""),
          kind: "extension",
        });
      if (item.vaultPage)
        citations.push({
          title: clean(item.vaultPage.title || item.vaultPage.id || ""),
          kind: "vault_page",
        });
    }
  }
  if (citations.length && !ctx.citations) {
    notes.push(tn("export.note.citationsOff", citations.length));
  }

  return {
    id: m.id,
    parentId: m.parentId === NIL_ID ? "" : m.parentId || "",
    role: roleOf(m),
    status: statusOf(m),
    createTime: ts(m.createTime),
    vote: voteOf(m.vote),
    labels: (m.labels || []).map((l) => decodeEnum(l) || String(l)),
    parts,
    citations: ctx.citations ? citations : [],
    assets,
    unknownBlocks: unknown,
    notes,
    isGoal: Boolean(m.isGoal),
    kimiPlus: m.kimiPlus ? { id: m.kimiPlus.id, name: clean(m.kimiPlus.name || "") } : null,
    scenario: m.scenario ? { raw: m.scenario } : null,
    childCount: (m.childrenMessageIds || []).length,
    raw: m,
  };
}

function imageRef(img) {
  return {
    id: img.id || "",
    url: img.fullSizeUrl || img.url || "",
    caption: clean(img.caption || ""),
    fileId: img.fileId || "",
    thumbnail: img.thumbnailUrl || "",
  };
}

/**
 * Kimi stores a content-free system message at the head of every conversation.
 * It has nothing to render, so the rendered thread skips it — but raw output
 * keeps it (see writeChatOutputs), because the archive mirrors the API response.
 * Anything that would actually show up (text, media, notes, feedback, …) keeps
 * the message, so a real system prompt is never dropped.
 */
export function isBlankSystemMessage(m) {
  return Boolean(
    m &&
      m.role === "system" &&
      !m.parts.length &&
      !m.assets.length &&
      !m.citations.length &&
      !m.notes.length &&
      !m.isGoal &&
      !(m.labels || []).length &&
      !m.kimiPlus &&
      (!m.vote || m.vote === "unspecified") &&
      (!m.status || m.status === "unspecified" || m.status === "completed"),
  );
}

/**
 * Full normalisation pass for one chat.
 * @returns {{chat: any, nodes: any[], stats: object, warnings: string[]}}
 */
export function normalizeChat(chat, messages, options) {
  const warnings = [];
  const { nodes, unlinked } = buildThread(messages, { branches: options.branches });
  const ctx = {
    thinking: options.thinking,
    tools: options.tools,
    citations: options.citations,
    downloadMedia: options.downloadMedia,
  };
  const rendered = [];
  for (const node of nodes) {
    const n = normalizeMessage(node.message, ctx);
    rendered.push({ ...node, message: n });
  }
  if (unlinked > 0) warnings.push(tn("export.warn.unlinked", unlinked));
  const unknownTotal = rendered.reduce((a, r) => a + (r.message.unknownBlocks || []).length, 0);
  if (unknownTotal) warnings.push(tn("export.warn.unknownBlocks", unknownTotal));
  const nonChat =
    (chat.source &&
      chat.source.type &&
      !/CHAT_SOURCE_TYPE_CHAT|CHAT_SOURCE_TYPE_PROJECT|UNSPECIFIED/.test(
        String(chat.source.type),
      )) ||
    "";
  if (nonChat)
    warnings.push(t("export.warn.sourceType", { type: nonChat }));

  // Count only what the Markdown actually contains: the blank system stub is
  // skipped there, so it must not inflate the reported totals either.
  const shown = rendered.filter((r) => r.kind === "message" && !isBlankSystemMessage(r.message));
  const stats = {
    messages: shown.length,
    user: shown.filter((r) => r.message.role === "user").length,
    assistant: shown.filter((r) => r.message.role === "assistant").length,
    branches: shown.filter((r) => !r.isMainline).length,
    assets: shown.reduce((a, r) => a + r.message.assets.length, 0),
    unknownBlocks: unknownTotal,
  };
  return { chat, nodes: rendered, stats, warnings };
}
