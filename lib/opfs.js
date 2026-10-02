// OPFS files are committed only when their writable stream closes.
import { checkAbort, StorageError } from "./control.js";
import { t } from "./i18n.js";
const ROOT = "kimi-export";
const MIN_FREE_BYTES = 150 * 1024 * 1024;
async function root(create = false) {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
}
export async function requireSpace(bytes = 0) {
  const { quota, usage } = await navigator.storage.estimate();
  if (quota && quota - usage < bytes + MIN_FREE_BYTES) throw new StorageError();
}
function pathParts(name) {
  const parts = name.split("/");
  if (!name || parts.some((p) => !p || p === "." || p === "..") || name.includes("\\"))
    throw new Error(t("error.store.path"));
  return parts;
}
export async function workspace(sub = "") {
  const dir = sub
    ? await (await root(true)).getDirectoryHandle(sub, { create: true })
    : await root(true);
  const ws = {
    dir,
    sub,
    async handle(name, mode) {
      const parts = pathParts(name),
        file = parts.pop();
      let parent = dir;
      for (const part of parts)
        parent = await parent.getDirectoryHandle(part, { create: mode === "create" });
      const fh = await parent.getFileHandle(file, { create: mode === "create" });
      return mode === "read" ? { fh, file: await fh.getFile() } : { fh };
    },
    async openWriter(name, { signal, expectedBytes = 0, onBytes } = {}) {
      checkAbort(signal);
      await requireSpace(expectedBytes);
      const { fh } = await ws.handle(name, "create");
      const stream = await fh.createWritable();
      let bytes = 0,
        checked = 0,
        closed = false;
      return {
        async write(chunk) {
          checkAbort(signal);
          try {
            await stream.write(chunk);
            bytes += chunk.byteLength ?? chunk.size ?? 0;
            onBytes?.(bytes);
            if (bytes - checked >= 32 * 1024 * 1024) {
              await requireSpace();
              checked = bytes;
            }
          } catch (err) {
            if (err.name === "QuotaExceededError") throw new StorageError();
            throw err;
          }
          checkAbort(signal);
        },
        async close() {
          checkAbort(signal);
          await stream.close();
          closed = true;
          return bytes;
        },
        async abort() {
          if (!closed) await stream.abort().catch(() => {});
        },
      };
    },
    async writeText(name, text, options = {}) {
      // Blob encodes the string correctly even across surrogate-pair boundaries.
      return ws.writeBlob(name, new Blob([text]), options);
    },
    async writeBlob(name, blob, options = {}) {
      return ws.writeStream(name, blob.stream(), { ...options, expectedBytes: blob.size });
    },
    async writeStream(name, source, options = {}) {
      const writer = await ws.openWriter(name, options);
      const reader = source.getReader();
      const cancel = () => {
        void reader.cancel(options.signal.reason).catch(() => {});
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          checkAbort(options.signal);
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        return await writer.close();
      } catch (err) {
        await writer.abort();
        await reader.cancel().catch(() => {});
        throw err;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    },
    async exists(name) {
      try {
        await ws.handle(name, "read");
        return true;
      } catch (e) {
        if (e.name === "NotFoundError") return false;
        throw e;
      }
    },
    async size(name) {
      try {
        return (await ws.handle(name, "read")).file.size;
      } catch (e) {
        if (e.name === "NotFoundError") return 0;
        throw e;
      }
    },
    async remove(name) {
      const parts = pathParts(name),
        file = parts.pop();
      let parent = dir;
      for (const p of parts) parent = await parent.getDirectoryHandle(p);
      await parent.removeEntry(file);
    },
    async append(name, chunk) {
      const { fh } = await ws.handle(name, "create");
      const current = await fh.getFile();
      const w = await fh.createWritable({ keepExistingData: true });
      try {
        await w.seek(current.size);
        await w.write(chunk);
        await w.close();
      } catch (e) {
        await w.abort().catch(() => {});
        throw e;
      }
      return (await fh.getFile()).size;
    },
  };
  return ws;
}
export async function clearWorkspace(sub) {
  try {
    await (await root()).removeEntry(sub, { recursive: true });
    return true;
  } catch (e) {
    if (e.name === "NotFoundError") return false;
    throw e;
  }
}
export async function opfsStore(name) {
  const ws = await workspace(name);
  return {
    name,
    kind: "opfs",
    writeText: (...args) => ws.writeText(...args),
    writeBlob: (...args) => ws.writeBlob(...args),
    writeStream: (...args) => ws.writeStream(...args),
    openWriter: (...args) => ws.openWriter(...args),
    append: (...args) => ws.append(...args),
    exists: (p) => ws.exists(p),
    size: (p) => ws.size(p),
    remove: (p) => ws.remove(p),
    async list() {
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const [key, handle] of dir.entries()) {
          const p = prefix ? `${prefix}/${key}` : key;
          if (handle.kind === "directory") await walk(handle, p);
          else out.push(p);
        }
      };
      await walk(ws.dir, "");
      return out.sort();
    },
    async getBlob(p) {
      return (await ws.handle(p, "read")).file;
    },
    async totalBytes() {
      let size = 0;
      for (const p of await this.list()) size += await this.size(p);
      return size;
    },
    async dispose() {
      await clearWorkspace(name);
    },
  };
}
