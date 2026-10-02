import { checkAbort } from "../lib/control.js";
// In-memory store adapter used by the offline test harness. Mirrors the OPFS one.
export function memoryStore(name = "memory") {
  const files = new Map();
  const dirs = new Set();
  const pathOk = (p) => !p.startsWith("/") && !p.includes("../");
  const touchParents = (p) => {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  return {
    name,
    kind: "memory",
    async openWriter(p, { signal, onBytes } = {}) {
      const chunks = [];
      let bytes = 0;
      return {
        async write(chunk) {
          checkAbort(signal);
          chunks.push(chunk);
          bytes += chunk.byteLength ?? chunk.size;
          onBytes?.(bytes);
        },
        async close() {
          checkAbort(signal);
          files.set(p, { blob: new Blob(chunks) });
          return bytes;
        },
        async abort() {
          chunks.length = 0;
        },
      };
    },
    async writeStream(p, stream, options = {}) {
      const writer = await this.openWriter(p, options);
      const reader = stream.getReader();
      try {
        for (;;) {
          checkAbort(options.signal);
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        return await writer.close();
      } catch (e) {
        await writer.abort();
        throw e;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    async writeText(p, text) {
      if (!pathOk(p)) throw new Error("bad path " + p);
      touchParents(p);
      files.set(p, { text, blob: new Blob([text]) });
      return true;
    },
    async writeBlob(p, blob) {
      if (!pathOk(p)) throw new Error("bad path " + p);
      touchParents(p);
      files.set(p, { blob });
      return true;
    },
    async append(p, chunk) {
      const prev = files.get(p);
      const parts = [];
      if (prev) parts.push(prev.blob);
      parts.push(chunk instanceof Blob ? chunk : new Blob([chunk]));
      touchParents(p);
      files.set(p, { blob: new Blob(parts) });
      return (await files.get(p).blob).size;
    },
    async exists(p) {
      return files.has(p);
    },
    async size(p) {
      return files.has(p) ? (await files.get(p).blob).size : 0;
    },
    async remove(p) {
      files.delete(p);
    },
    async list() {
      return [...files.keys()].sort();
    },
    async getBlob(p) {
      if (!files.has(p)) throw new Error("missing " + p);
      return files.get(p).blob;
    },
    async totalBytes() {
      let n = 0;
      for (const k of files.keys()) n += (await files.get(k).blob).size;
      return n;
    },
    async dispose() {
      files.clear();
      dirs.clear();
    },
  };
}
