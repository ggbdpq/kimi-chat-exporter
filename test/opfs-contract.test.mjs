import { test } from "node:test";
import assert from "node:assert/strict";
import { workspace } from "../lib/opfs.js";
test("OPFS awaits real asynchronous directory and writable stream contracts", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const files = new Map();
  let aborted = false;
  const dir = {
    async getDirectoryHandle() {
      await Promise.resolve();
      return dir;
    },
    async getFileHandle(name) {
      return {
        async createWritable() {
          await Promise.resolve();
          const parts = [];
          return {
            async write(chunk) {
              parts.push(chunk);
            },
            async close() {
              files.set(name, new Blob(parts));
            },
            async abort() {
              aborted = true;
            },
          };
        },
        async getFile() {
          return files.get(name) || new Blob();
        },
      };
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      storage: {
        getDirectory: async () => dir,
        estimate: async () => ({ quota: 2 ** 30, usage: 0 }),
      },
    },
    configurable: true,
  });
  try {
    const ws = await workspace("job-test");
    await ws.writeText("note", "text 😀");
    assert.equal(await files.get("note").text(), "text 😀");
    const ac = new AbortController();
    const w = await ws.openWriter("aborted", { signal: ac.signal });
    await w.write(new Uint8Array([1]));
    ac.abort();
    await assert.rejects(w.close(), { name: "AbortError" });
    await w.abort();
    assert.ok(aborted);
    assert.ok(!files.has("aborted"));
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});
