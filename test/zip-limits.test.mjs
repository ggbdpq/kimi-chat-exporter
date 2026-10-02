// Hard caps of the classic ZIP format and the volume entry budget.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { ZipWriter, ZIP_MAX_ENTRIES } from "../lib/zip.js";
import { planVolumes, SHELL_ENTRIES } from "../lib/pack.js";

test("classic entry limit is 65535", () => {
  assert.equal(ZIP_MAX_ENTRIES, 65535);
});

test("ZipWriter refuses entries past the cap instead of corrupting the EOCD", async () => {
  const z = new ZipWriter();
  await assert.rejects(
    (async () => {
      for (let i = 0; i <= ZIP_MAX_ENTRIES; i++) {
        await z.add("x/" + i, new Uint8Array([65 + (i % 26)]));
      }
    })(),
    /上限/,
  );
});

test("ZipWriter accepts a small entry", async () => {
  const z = new ZipWriter();
  assert.equal((await z.add("a.txt", "hello")).uncompressed, 5);
});

test("planVolumes splits on the entry budget, keeping whole chats", () => {
  const mk = (id, n) => ({
    id,
    bytes: 10,
    files: Array.from({ length: 3 }, (_, i) => ({ storePath: `f${id}-${i}` })),
    assetPaths: Array.from({ length: n }, (_, i) => `a${id}-${i}`),
  });
  const chats = [mk("c1", 120), mk("c2", 120), mk("c3", 120)];
  const vols = planVolumes(chats, 1e12, 260);
  assert.equal(vols.length, 2);
  assert.equal(
    vols.reduce((a, v) => a + v.length, 0),
    3,
  );
  const cost = (v) =>
    v.reduce((a, e) => a + SHELL_ENTRIES + e.files.length + e.assetPaths.length, 0);
  assert.ok(
    vols.every((v) => cost(v) <= 260),
    vols.map(cost).join(","),
  );
});

test("a single oversized chat still gets its own volume (advisory cap)", () => {
  const mk = (id, n) => ({
    id,
    bytes: 10,
    files: Array.from({ length: 3 }, (_, i) => ({ storePath: `f${id}-${i}` })),
    assetPaths: Array.from({ length: n }, (_, i) => `a${id}-${i}`),
  });
  const vols = planVolumes([mk("big", 900)], 1e12, 260);
  assert.equal(vols.length, 1);
  assert.equal(vols[0].length, 1);
});
