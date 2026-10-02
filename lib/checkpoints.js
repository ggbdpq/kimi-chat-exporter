import { checkAbort } from "./control.js";
import { t } from "./i18n.js";
// Physical paths are immutable versions. A database record publishes a closed file.
export function checkpointStore(raw, db, jobId, runId, signal) {
  const physical = () => `.work/${crypto.randomUUID()}`;
  const fileKey = (p) => `file:${p}`;
  async function record(p) {
    return db.getItem(jobId, fileKey(p));
  }
  async function valid(item) {
    return (
      item?.state === "done" &&
      (await raw.exists(item.path)) &&
      (await raw.size(item.path)) === item.bytes
    );
  }
  async function publish(p, path) {
    checkAbort(signal);
    const bytes = await raw.size(path),
      previous = await record(p);
    await db.putItem(jobId, runId, { key: fileKey(p), kind: "file", state: "done", path, bytes });
    if (previous?.path && previous.path !== path) await raw.remove(previous.path).catch(() => {});
    return bytes;
  }
  return {
    kind: "checkpoint",
    name: raw.name,
    raw,
    async openWriter(p, opts = {}) {
      checkAbort(signal);
      const path = physical();
      const w = await raw.openWriter(path, { ...opts, signal: opts.signal || signal });
      let bytes = 0;
      return {
        write: (chunk) => w.write(chunk),
        async close() {
          await w.close();
          bytes = await publish(p, path);
          return bytes;
        },
        async abort() {
          await w.abort();
          await raw.remove(path).catch(() => {});
        },
        get path() {
          return path;
        },
        get bytes() {
          return bytes;
        },
      };
    },
    async writeText(p, text, opts = {}) {
      return this.writeBlob(p, new Blob([text]), opts);
    },
    async writeBlob(p, blob, opts = {}) {
      return this.writeStream(p, blob.stream(), { ...opts, expectedBytes: blob.size });
    },
    async writeStream(p, source, opts = {}) {
      const localSignal = opts.signal || signal,
        path = physical();
      try {
        await raw.writeStream(path, source, { ...opts, signal: localSignal });
        checkAbort(localSignal);
        return await publish(p, path);
      } catch (err) {
        await raw.remove(path).catch(() => {});
        throw err;
      }
    },
    async exists(p) {
      return valid(await record(p));
    },
    async size(p) {
      const item = await record(p);
      return (await valid(item)) ? item.bytes : 0;
    },
    async getBlob(p) {
      const item = await record(p);
      if (!(await valid(item))) throw new Error(t("error.checkpoint.missing", { path: p }));
      return raw.getBlob(item.path);
    },
    async file(p) {
      const item = await record(p);
      return (await valid(item)) ? { path: item.path, bytes: item.bytes } : null;
    },
    async list() {
      return (await db.listItems(jobId))
        .filter((x) => x.kind === "file")
        .map((x) => x.key.slice(5));
    },
  };
}
