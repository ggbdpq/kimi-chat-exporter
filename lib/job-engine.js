import { SERVICES, ApiError, AuthError, listAllChats } from "./api.js";
import { checkAbort, fatal, pool, SkipError, StorageError } from "./control.js";
import { checkpointStore } from "./checkpoints.js";
import {
  newReport,
  optionsWithDefaults,
  enrichChat,
  enrichChatFiles,
  collectAssets,
  chatFileAssets,
  mergeChatFileAssets,
  propagateLocalPaths,
  writeChatOutputs,
  buildReportMarkdown,
  buildErrorLog,
} from "./pipeline.js";
import { normalizeChat, clean } from "./model.js";
import { assetKey, safeFileName } from "./render.js";
import { packChats, planVolumes, SHELL_ENTRIES } from "./pack.js";
import { ZIP_MAX_ENTRIES, ZIP_MAX_OFFSET, ZipLimitError } from "./zip.js";
import { digest, stableAssetKey, mediaScheduler, downloadMedia } from "./media.js";
import { setLocale, t } from "./i18n.js";
const FAILED = new Set(["failed", "skipped"]);
const msg = (err) => String(err?.message || err);
const now = () => Date.now();

export class JobEngine {
  constructor({
    db,
    raw,
    job,
    runId,
    api,
    signal,
    emit = () => {},
    canAccessHost,
    fetchBinary,
    requireSpace = async () => {},
    retry = null,
    volumeBytes = 800 * 1024 * 1024,
  }) {
    Object.assign(this, {
      db,
      raw,
      job,
      runId,
      api,
      signal,
      emit,
      canAccessHost,
      fetchBinary,
      requireSpace,
      retry,
      volumeBytes,
    });
    this.store = checkpointStore(raw, db, job.id, runId, signal);
    this.media = mediaScheduler();
    this.active = new Map();
    this.skipRequests = new Set();
    this.progress = {
      phase: "listing",
      chatsDone: 0,
      chatsTotal: job.targets.length,
      bytes: 0,
      rate: 0,
      assetsDone: 0,
      startedAt: now(),
    };
    // Media pulled from the network by this run, plus the parts already folded
    // into finished-chat totals, so the counter never double counts a chat.
    this.networkBytes = 0;
    this.doneNetwork = 0;
    this.doneBytes = 0;
    this.chatNetwork = new Map();
    this.lastEmit = 0;
    this.lastPhase = "";
    this.fileNames = new Map();
    this.retryKeys = new Set();
    this.dirtyChats = new Set();
    this.refreshedMessages = new Map();
  }
  get(key) {
    return this.db.getItem(this.job.id, key);
  }
  put(item) {
    return this.db.putItem(this.job.id, this.runId, item);
  }
  async update(patch) {
    this.job = await this.db.updateJob(this.job.id, patch, this.runId);
    return this.job;
  }
  progressEvent(patch, force = false) {
    Object.assign(this.progress, patch);
    // The "transferred" figure counts what this run has accounted for: the
    // finished chat (its markdown/raw and its media, reused checkpoints
    // included) plus whatever the chats still downloading have pulled so far.
    // A text-only or fully-resumed export therefore still reports a real size.
    this.progress.bytes = this.doneBytes + Math.max(0, this.networkBytes - this.doneNetwork);
    this.progress.rate =
      this.progress.bytes / Math.max(1, (now() - this.progress.startedAt) / 1000);
    const phaseChanged = this.progress.phase !== this.lastPhase;
    if (!(force || phaseChanged || now() - this.lastEmit >= 250)) return;
    this.lastEmit = now();
    this.lastPhase = this.progress.phase;
    this.emit({
      type: "progress",
      jobId: this.job.id,
      runId: this.runId,
      progress: { ...this.progress, active: [...this.active.values()].map((x) => x.info) },
    });
    // The worker dies with its page, so persist at phase boundaries: a reload
    // then restores the last counters and the average rate instead of blanks.
    if (phaseChanged) void this.update({ progress: { ...this.progress } }).catch(() => {});
  }
  skipItem(key) {
    this.skipRequests.add(key);
    this.active.get(key)?.controller.abort(new SkipError());
  }
  async itemTask(key, info, parent, work) {
    const controller = new AbortController();
    const cancel = () => controller.abort(parent.reason);
    if (parent?.aborted) cancel();
    else parent?.addEventListener("abort", cancel, { once: true });
    this.active.set(key, { controller, info: { key, ...info } });
    if (this.skipRequests.has(key)) controller.abort(new SkipError());
    try {
      checkAbort(controller.signal);
      return await work(controller.signal);
    } finally {
      parent?.removeEventListener("abort", cancel);
      this.active.delete(key);
    }
  }
  async validateFiles(entry) {
    for (const p of [...entry.files.map((f) => f.storePath), ...entry.assetPaths])
      if (!(await this.store.exists(p))) return false;
    return true;
  }
  async loadMessages(chat, signal, refresh = false) {
    const metaKey = `pages:${chat.id}`;
    let meta = await this.get(metaKey);
    let epoch = meta?.epoch || crypto.randomUUID();
    if (refresh) epoch = crypto.randomUUID();
    await this.put({ key: metaKey, kind: "pages", chatId: chat.id, epoch, state: "running" });
    const messages = new Map(),
      seen = new Set();
    let token = "",
      invalidated = false;
    for (let i = 0; i < 500; i++) {
      checkAbort(signal);
      const key = `page:${chat.id}:${i}`,
        old = await this.get(key);
      let res;
      if (old?.epoch === epoch && old.token === token && (await this.store.exists(old.file))) {
        res = JSON.parse(await (await this.store.getBlob(old.file)).text());
      } else {
        const body = {
          chatId: chat.id,
          pageSize: 200,
          direction: "DIRECTION_FORWARD",
          ...(token ? { pageToken: token } : {}),
        };
        try {
          try {
            res = await this.api.rpc(SERVICES.listMessages, body, { signal });
          } catch (e) {
            if (e instanceof ApiError && e.status === 400)
              res = await this.api.rpc(
                SERVICES.listMessages,
                { ...body, direction: 1 },
                { signal },
              );
            else throw e;
          }
        } catch (e) {
          // One invalid cursor reset per invocation, never silent truncation.
          if (token && e instanceof ApiError && e.status === 400 && !invalidated) {
            invalidated = true;
            epoch = crypto.randomUUID();
            await this.put({
              key: metaKey,
              kind: "pages",
              chatId: chat.id,
              epoch,
              state: "running",
            });
            messages.clear();
            seen.clear();
            token = "";
            i = -1;
            continue;
          }
          throw e;
        }
        const file = `.pages/${encodeURIComponent(chat.id)}/${epoch}/${i}.json`;
        await this.store.writeText(file, JSON.stringify(res), { signal });
        checkAbort(signal);
        await this.put({
          key,
          kind: "page",
          chatId: chat.id,
          epoch,
          token,
          next: res.nextPageToken || "",
          file,
          state: "done",
        });
      }
      for (const m of res.messages || []) if (m?.id && !messages.has(m.id)) messages.set(m.id, m);
      this.progressEvent({
        phase: "fetching",
        message: t("progress.fetching", {
          name: chat.name || chat.id,
          count: messages.size,
        }),
      });
      const next = res.nextPageToken || "";
      if (!next) {
        await this.put({ key: metaKey, kind: "pages", chatId: chat.id, epoch, state: "done" });
        return [...messages.values()];
      }
      if (seen.has(next) || i === 499) throw new Error(t("error.pagesLoop"));
      seen.add(next);
      token = next;
    }
  }
  cachedApi(chatId) {
    return {
      rpc: async (method, body, { signal } = {}) => {
        const key = `rpc:${chatId}:${await digest(method + JSON.stringify(body))}`;
        const old = await this.get(key);
        if (old?.state === "done" && (await this.store.exists(old.file)))
          return JSON.parse(await (await this.store.getBlob(old.file)).text());
        const res = await this.api.rpc(method, body, { signal });
        const file = `.rpc/${await digest(key)}.json`;
        await this.store.writeText(file, JSON.stringify(res), { signal });
        await this.put({ key, kind: "rpc", chatId, file, state: "done" });
        return res;
      },
    };
  }
  async refreshUrl(chat, asset, signal) {
    if (asset.fileId) {
      try {
        const res = await this.api.rpc(SERVICES.getFile, { fileId: asset.fileId }, { signal });
        const f = res.file || res,
          blob = f.blob || {};
        if (blob.signUrl || blob.previewUrl) return blob.signUrl || blob.previewUrl;
      } catch (err) {
        if (fatal(err)) throw err;
      }
    }
    // Share a fresh message snapshot for concurrent expired links in one chat.
    if (!this.refreshedMessages.has(chat.id))
      this.refreshedMessages.set(chat.id, this.loadMessages(chat, this.signal, true));
    const messages = await this.refreshedMessages.get(chat.id);
    const thread = normalizeChat(chat, messages, this.job.options);
    const candidates = collectAssets(thread.nodes, chat.id);
    const baseUrl = (value) => {
      try {
        const u = new URL(value);
        return u.origin + u.pathname;
      } catch {
        return value;
      }
    };
    return candidates.find(
      (a) =>
        stableAssetKey(a) === stableAssetKey(asset) ||
        (a.kind === asset.kind && a.name === asset.name && baseUrl(a.url) === baseUrl(asset.url)),
    )?.url;
  }
  async processAsset(chat, asset, signal) {
    const id = await digest(stableAssetKey(asset)),
      key = `asset:${chat.id}:${id}`;
    const old = await this.get(key),
      retry = this.shouldRetry(key, chat.id);
    if (old?.state === "done" && (await this.store.exists(old.file))) {
      asset.localPath = old.file;
      asset.localSize = old.bytes;
      return;
    }
    if (FAILED.has(old?.state) && !retry) return;
    // Inline artifacts carry no file name; fall back to their title/path so the
    // export keeps something meaningful instead of a bare "artifact".
    const label = asset.synthetic
      ? `${asset.title || asset.path || `artifact-${asset.artifactId || "x"}`}.txt`
      : asset.name || asset.kind || "resource";
    const suffix = safeFileName(label, "resource", 70);
    const displayName = asset.name || asset.title || asset.path || asset.kind || "resource";
    const file = `assets/${chat.id}/${id.slice(0, 16)}-${suffix}`;
    try {
      await this.itemTask(
        key,
        { kind: "asset", chatId: chat.id, label: displayName },
        signal,
        async (itemSignal) => {
          await this.put({
            key,
            kind: "asset",
            chatId: chat.id,
            state: "running",
            file,
            name: displayName,
            url: asset.url || asset.uri || "",
          });
          if (asset.synthetic)
            await this.store.writeText(file, String(asset.content || ""), { signal: itemSignal });
          else {
            let previous = 0;
            await downloadMedia({
              asset,
              path: file,
              store: this.store,
              signal: itemSignal,
              scheduler: this.media,
              canAccessHost: this.canAccessHost,
              fetchBinary: this.fetchBinary,
              refreshUrl: (a, s) => this.refreshUrl(chat, a, s),
              onRetry: (n) => {
                previous = 0;
                this.progressEvent({
                  phase: "downloading",
                  message: t("progress.retry", {
                    name: asset.name || t("export.resource"),
                    count: n,
                  }),
                });
              },
              onBytes: (n) => {
                const delta = Math.max(0, n - previous);
                this.networkBytes += delta;
                this.chatNetwork.set(chat.id, (this.chatNetwork.get(chat.id) || 0) + delta);
                previous = n;
                this.progressEvent({ phase: "downloading" });
              },
            });
          }
          checkAbort(itemSignal);
          const bytes = await this.store.size(file);
          await this.put({
            key,
            kind: "asset",
            chatId: chat.id,
            state: "done",
            file,
            bytes,
            name: displayName,
          });
          asset.localPath = file;
          asset.localSize = bytes;
          this.progress.assetsDone++;
          this.progressEvent({ phase: "downloading" });
        },
      );
    } catch (err) {
      if (fatal(err) && err.name !== "SkipError") throw err;
      await this.put({
        key,
        kind: "asset",
        chatId: chat.id,
        state: err.name === "SkipError" || err.name === "PermissionError" ? "skipped" : "failed",
        file,
        name: displayName,
        url: asset.url || asset.uri || "",
        error: msg(err),
      });
    }
  }
  shouldRetry(key, chatId) {
    return this.retryKeys.has(key) || (key.startsWith("chat:") && this.dirtyChats.has(chatId));
  }
  async prepareRetry() {
    if (!this.retry) return;
    for (const item of await this.db.listItems(this.job.id)) {
      const hasError =
        FAILED.has(item.state) ||
        (item.kind === "chat" &&
          ["toolFailures", "fileFailures", "citationFailures"].some(
            (k) => item.report?.[k]?.length,
          ));
      if (
        hasError &&
        (this.retry.all || this.retry.key === item.key || this.retry.chatId === item.chatId)
      ) {
        this.retryKeys.add(item.key);
        if (item.chatId) this.dirtyChats.add(item.chatId);
      }
    }
  }
  async processChat(chat) {
    const key = `chat:${chat.id}`,
      old = await this.get(key);
    if (
      old?.state === "done" &&
      !this.shouldRetry(key, chat.id) &&
      (await this.validateFiles(old.entry))
    ) {
      this.progress.chatsDone++;
      this.doneBytes += old.entry?.bytes || 0;
      this.progressEvent({});
      return old.entry;
    }
    if (FAILED.has(old?.state) && !this.shouldRetry(key, chat.id)) {
      this.progress.chatsDone++;
      this.doneBytes += old.entry?.bytes || 0;
      this.progressEvent({});
      return old.entry;
    }
    const entry = {
      id: chat.id,
      title: clean(chat.name) || chat.id,
      created: chat.createTime,
      updated: chat.updateTime,
      model: chat.model || "",
      project: chat.projectName || "",
      pinned: !!chat.pinned,
      messages: 0,
      branches: 0,
      assets: 0,
      files: [],
      assetPaths: [],
      warnings: [],
      bytes: 0,
      hasContent: false,
      failed: false,
    };
    const report = newReport();
    try {
      await this.itemTask(
        key,
        { kind: "chat", chatId: chat.id, label: entry.title },
        this.signal,
        async (signal) => {
          await this.put({ key, kind: "chat", chatId: chat.id, state: "running", entry, report });
          const messages = await this.loadMessages(chat, signal);
          this.progressEvent({
            phase: "enriching",
            message: t("progress.enriching", { title: entry.title }),
          });
          const api = this.cachedApi(chat.id);
          await enrichChat(api, chat.id, messages, this.job.options, report, signal);
          if (this.job.options.downloadMedia) await enrichChatFiles(api, chat, report, signal);
          checkAbort(signal);
          const thread = normalizeChat(chat, messages, this.job.options);
          for (const n of thread.nodes) if (n.kind === "message") n.raw = n.message.raw;
          const assets = collectAssets(thread.nodes, chat.id);
          mergeChatFileAssets(assets, chatFileAssets(chat, chat.id));
          if (this.job.options.downloadMedia) {
            this.progressEvent({
              phase: "downloading",
              message: t("progress.downloading", { title: entry.title }),
            });
            const ordered = [...assets].sort(
              (a, b) =>
                Number(!a.sizeBytes || Number(a.sizeBytes) > 64 * 1024 * 1024) -
                Number(!b.sizeBytes || Number(b.sizeBytes) > 64 * 1024 * 1024),
            );
            await pool(ordered, 8, (asset) => this.processAsset(chat, asset, signal), signal);
            propagateLocalPaths(thread.nodes, assets);
          }
          checkAbort(signal);
          const assetIndex = new Map(
            assets.filter((a) => a.localPath).map((a) => [assetKey(a), a.localPath]),
          );
          const outputStore = { writeText: (p, t) => this.store.writeText(p, t, { signal }) };
          const written = await writeChatOutputs(outputStore, thread, {
            options: this.job.options,
            assetIndex,
            exportDate: this.job.exportDate,
            rootDir: this.rootDir,
            usedNames: new Set(),
            mdName: this.fileNames.get(chat.id),
            mdPrefix: "../",
          });
          Object.assign(entry, {
            ...written,
            assets: assets.filter((a) => a.localPath).length,
            assetPaths: assets.filter((a) => a.localPath).map((a) => a.localPath),
            messages: thread.stats.messages,
            branches: thread.stats.branches,
            warnings: thread.warnings || [],
            hasContent: thread.stats.messages > 0,
          });
          if (!entry.hasContent)
            entry.warnings = entry.warnings.concat([t("export.warn.noMessages")]);
          for (const p of [...entry.files.map((f) => f.storePath), ...entry.assetPaths])
            entry.bytes += await this.store.size(p);
          this.doneBytes += entry.bytes;
          this.doneNetwork += this.chatNetwork.get(chat.id) || 0;
          this.chatNetwork.delete(chat.id);
          this.progressEvent({});
          checkAbort(signal);
          await this.put({
            key,
            kind: "chat",
            chatId: chat.id,
            state: "done",
            entry,
            report,
            revision: crypto.randomUUID(),
          });
        },
      );
    } catch (err) {
      if (fatal(err) && err.name !== "SkipError") throw err;
      entry.failed = true;
      entry.warnings.push(msg(err));
      report.chatFailures.push({ chatId: chat.id, name: entry.title, error: msg(err) });
      await this.put({
        key,
        kind: "chat",
        chatId: chat.id,
        state: err.name === "SkipError" ? "skipped" : "failed",
        entry,
        report,
        error: msg(err),
        revision: crypto.randomUUID(),
      });
    }
    this.refreshedMessages.delete(chat.id);
    this.progress.chatsDone++;
    this.progressEvent({});
    return entry;
  }
  async reports(entries) {
    const items = await this.db.listItems(this.job.id),
      report = newReport();
    for (const item of items.filter((x) => x.kind === "chat")) {
      for (const field of ["chatFailures", "toolFailures", "fileFailures", "citationFailures"])
        for (const failure of item.report?.[field] || [])
          report[field].push({ ...failure, at: item.updatedAt });
    }
    for (const item of items.filter((x) => x.kind === "asset")) {
      if (item.state === "done") {
        report.assetCount++;
        report.assetBytes += item.bytes;
      }
      if (FAILED.has(item.state))
        report[item.state === "skipped" ? "assetSkips" : "assetFailures"].push({
          chatId: item.chatId,
          name: item.name,
          reason: item.error,
          url: item.url,
          at: item.updatedAt,
        });
    }
    const totalMessages = entries.reduce((n, e) => n + e.messages, 0);
    const reportMd = buildReportMarkdown({
      chatEntries: entries,
      report,
      options: this.job.options,
      exportDate: this.job.exportDate,
      totalMessages,
    });
    const errorLog = buildErrorLog({ report, exportDate: this.job.exportDate });
    await this.store.writeText("report.md", reportMd);
    await this.store.writeText("error.log", errorLog);
    const errorCount = [
      "chatFailures",
      "toolFailures",
      "fileFailures",
      "citationFailures",
      "assetFailures",
      "assetSkips",
    ].reduce((n, k) => n + report[k].length, 0);
    return {
      report,
      reportMd,
      errorLog,
      errorCount,
      totals: {
        chats: entries.length,
        messages: totalMessages,
        assets: report.assetCount,
        bytes: report.assetBytes,
        ok: entries.filter((e) => !e.failed).length,
        failed: report.chatFailures.length,
      },
    };
  }
  async pack(entries, reportMd, report) {
    const options = this.job.options,
      stamp = this.job.exportDate.slice(0, 10),
      artifacts = [],
      packErrors = [];
    const checkpointItems = await this.db.listItems(this.job.id);
    const chatRecords = new Map(
      checkpointItems.filter((x) => x.kind === "chat").map((x) => [x.chatId, x]),
    );
    for (const item of checkpointItems)
      if (item.kind === "pack-error") await this.put({ ...item, state: "resolved" });
    const safeEntries = [];
    for (const entry of entries) {
      if (
        entry.bytes >= ZIP_MAX_OFFSET - 1024 * 1024 ||
        entry.files.length + entry.assetPaths.length + 6 >= ZIP_MAX_ENTRIES
      ) {
        const error = t("error.zipLimit", { title: entry.title });
        packErrors.push(error);
        await this.put({
          key: `pack-error:${entry.id}`,
          kind: "pack-error",
          chatId: entry.id,
          state: "failed",
          error,
        });
      } else safeEntries.push(entry);
    }
    const volumes =
      options.package === "per-chat"
        ? safeEntries.map((e) => [e])
        : planVolumes(safeEntries, this.volumeBytes, ZIP_MAX_ENTRIES - 16);
    if (!volumes.length && !entries.length) volumes.push([]);
    for (let i = 0; i < volumes.length; i++) {
      checkAbort(this.signal);
      const subset = volumes[i],
        key = `archive:${i}`;
      const revisions = [];
      for (const e of subset) revisions.push(chatRecords.get(e.id)?.revision || e.id);
      const ids = new Set(subset.map((e) => e.id));
      const scopedReport = {
        ...newReport(),
        assetCount: subset.reduce((n, e) => n + e.assets, 0),
        assetBytes: 0,
      };
      for (const field of [
        "chatFailures",
        "toolFailures",
        "fileFailures",
        "citationFailures",
        "assetFailures",
        "assetSkips",
      ])
        scopedReport[field] = report[field].filter((x) => ids.has(x.chatId));
      for (const item of checkpointItems)
        if (item.kind === "asset" && item.state === "done" && ids.has(item.chatId))
          scopedReport.assetBytes += item.bytes;
      const scopedMd = buildReportMarkdown({
        chatEntries: subset,
        report: scopedReport,
        options,
        exportDate: this.job.exportDate,
        totalMessages: subset.reduce((n, e) => n + e.messages, 0),
      });
      // A volume documents its own chats, so its log carries the scoped
      // failures plus any pack error hit before this volume was written.
      const scopedLog = buildErrorLog({
        report: scopedReport,
        exportDate: this.job.exportDate,
        packErrors,
      });
      await this.store.writeText("error.log", scopedLog);
      // The fingerprint must cover the log too: the report only counts
      // failures, so two runs with the same counts but different messages
      // would otherwise reuse a stale archive.
      const fingerprint = await digest(
        JSON.stringify([revisions, scopedMd, scopedLog, options]),
      );
      const old = await this.get(key);
      if (
        old?.fingerprint === fingerprint &&
        old.state === "done" &&
        (await this.raw.exists(old.path)) &&
        (await this.raw.size(old.path)) === old.bytes
      ) {
        artifacts.push(old);
        continue;
      }
      // Archives download with an all-lowercase name so the same file lands the
      // same way on case-insensitive filesystems and in name-keyed scripts.
      const name = (
        options.package === "per-chat"
          ? `Kimi-${safeFileName(subset[0].title, "chat", 60)}-${safeFileName(subset[0].id, "id", 60)}-${stamp}.zip`
          : `Kimi-export-${stamp}${volumes.length > 1 ? `-part${i + 1}` : ""}.zip`
      ).toLowerCase();
      this.progressEvent(
        {
          phase: "packing",
          message: t("progress.packing", { done: i + 1, total: volumes.length }),
          volume: i + 1,
          volumes: volumes.length,
          filesDone: 0,
          filesTotal:
            subset.reduce((n, e) => n + e.files.length + e.assetPaths.length, 0) +
            SHELL_ENTRIES,
          packedBytes: 0,
        },
        true,
      );
      await this.requireSpace(subset.reduce((n, e) => n + e.bytes, 0));
      const path = `.archives/${crypto.randomUUID()}.zip`;
      const sink = await this.raw.openWriter(path, { signal: this.signal });
      try {
        const result = await packChats({
          store: this.store,
          rootDir: this.rootDir,
          entries: subset,
          exportDate: this.job.exportDate,
          reportMd:
            scopedMd +
            (packErrors.length
              ? t("export.report.packFailures", {
                  items: packErrors.map((e) => `- ${e}`).join("\n"),
                })
              : ""),
          signal: this.signal,
          sink,
          onBytes: (bytes) => this.progressEvent({ packedBytes: bytes }),
          onFile: () => this.progressEvent({ filesDone: this.progress.filesDone + 1 }),
        });
        checkAbort(this.signal);
        const artifact = {
          key,
          kind: "archive",
          state: "done",
          path,
          name,
          bytes: result.bytes,
          chats: subset.map((e) => e.id),
          fingerprint,
        };
        await this.put(artifact);
        artifacts.push(artifact);
        // Publish each completed volume immediately; previous complete files remain on disk.
        await this.update({
          artifacts: [
            ...artifacts,
            ...(this.job.artifacts || []).filter((a) => !artifacts.some((b) => b.key === a.key)),
          ],
        });
      } catch (err) {
        await sink.abort();
        await this.raw.remove(path).catch(() => {});
        if (!(err instanceof ZipLimitError)) throw err;
        packErrors.push(err.message);
        await this.put({
          key: `pack-error:volume-${i}`,
          kind: "pack-error",
          state: "failed",
          error: err.message,
        });
      }
    }
    return { artifacts, packErrors };
  }
  async run({ resume = false } = {}) {
    this.rootDir = `kimi-export-${this.job.exportDate.slice(0, 10)}`;
    // The job carries the language it was created in; without one (older jobs)
    // the caller's locale stands.
    if (this.job.locale) setLocale(this.job.locale);
    try {
      await this.update({ state: "running", error: null });
      await this.prepareRetry();
      if (resume) {
        this.progressEvent({ phase: "validating", message: t("progress.validating") }, true);
        for (const chat of this.job.targets) {
          checkAbort(this.signal);
          try {
            await this.api.rpc(
              SERVICES.listMessages,
              { chatId: chat.id, pageSize: 1, direction: "DIRECTION_FORWARD" },
              { signal: this.signal },
            );
          } catch (err) {
            if (fatal(err)) throw err;
            throw new Error(t("error.resumeCheck", { name: chat.name || chat.id }));
          }
        }
      }
      if (!this.job.targets.length && this.job.allChats) {
        this.progressEvent({ phase: "listing", message: t("progress.listing"), listingDone: 0 }, true);
        const { chats } = await listAllChats(this.api, {
          signal: this.signal,
          onProgress: (count) => this.progressEvent({ phase: "listing", listingDone: count }),
        });
        await this.update({ targets: chats });
        if (!chats.length) throw new Error(t("error.noChats"));
      }
      this.progress.chatsTotal = this.job.targets.length;
      for (const chat of this.job.targets)
        this.fileNames.set(
          chat.id,
          `${String(chat.createTime || this.job.exportDate).slice(0, 10)}-${safeFileName(chat.name || chat.id, "chat", 60)}_${safeFileName(chat.id, "id", 60)}.md`,
        );
      const entries = new Array(this.job.targets.length);
      await pool(
        this.job.targets,
        2,
        async (chat, i) => {
          entries[i] = await this.processChat(chat);
        },
        this.signal,
      );
      checkAbort(this.signal);
      const { report, reportMd, errorLog, errorCount, totals } = await this.reports(entries);
      // Kept on the instance so callers (task page, tests) can read the run's
      // outcome without re-deriving it from the work items.
      this.entries = entries;
      this.summary = { report, reportMd, errorLog, errorCount, totals };
      const { artifacts, packErrors } = await this.pack(entries, reportMd, report);
      checkAbort(this.signal);
      const state = errorCount || packErrors.length ? "completed-with-errors" : "completed";
      await this.update({
        state,
        artifacts,
        totals,
        errorCount: errorCount + packErrors.length,
        progress: { ...this.progress, phase: "ready" },
      });
      this.progressEvent(
        {
          phase: "ready",
          message: t(state === "completed" ? "progress.ready" : "progress.readyWithErrors"),
        },
        true,
      );
    } catch (err) {
      const state =
        err.name === "AbortError"
          ? "paused"
          : err instanceof AuthError
            ? "waiting-login"
            : err instanceof StorageError || err.name === "QuotaExceededError"
              ? "blocked-storage"
              : "failed";
      await this.update({ state, error: msg(err), progress: this.progress });
    }
    this.emit({ type: "settled", jobId: this.job.id, runId: this.runId, snapshot: this.job });
    return this.job;
  }
}
