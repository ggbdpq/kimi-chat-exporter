import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { ZipWriter } from "../lib/zip.js";
import { readArchive } from "./tools/zip_check.mjs";
import { packChats } from "../lib/pack.js";
import { memoryStore } from "./store-memory.js";
test("streaming ZIP uses descriptors and does not retain archive bodies", async () => {
  const chunks = [];
  let closed = false;
  const zip = new ZipWriter({
    sink: {
      write: async (c) => chunks.push(c),
      close: async () => {
        closed = true;
      },
    },
  });
  await zip.add("unicode.txt", "字符 😀");
  await zip.add("binary.bin", new Uint8Array([0, 1, 2]), { store: true });
  const result = await zip.finalize();
  assert.equal(zip.chunks.length, 0);
  assert.ok(closed);
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  assert.equal(result.bytes, buffer.length);
  assert.ok(buffer.readUInt16LE(6) & 8);
  const archive = readArchive(buffer);
  assert.equal(archive.text("unicode.txt"), "字符 😀");
  assert.equal(archive.names.length, 2);
});
test("abort inside a large entry stops streaming before finalization", async () => {
  const ac = new AbortController();
  let wrote = 0;
  const zip = new ZipWriter({
    signal: ac.signal,
    sink: {
      write: async (c) => {
        wrote += c.length;
        if (wrote > 1024 * 1024) ac.abort();
      },
      close: async () => assert.fail("must not finalize"),
    },
  });
  async function* chunks() {
    for (let i = 0; i < 100; i++) yield new Uint8Array(65536);
  }
  await assert.rejects(zip.add("large.bin", chunks(), { store: true }), { name: "AbortError" });
  assert.ok(wrote < 2 * 1024 * 1024);
});
test("missing referenced output fails packing instead of silently omitting content", async () => {
  await assert.rejects(
    packChats({
      store: memoryStore(),
      rootDir: "x",
      entries: [{ files: [{ storePath: "missing" }], assetPaths: [], messages: 1 }],
      exportDate: "2026-10-01",
    }),
    /缺失/,
  );
});
