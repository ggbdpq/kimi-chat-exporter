// Packaging modes: per-chat ZIPs and volume splitting by bytes.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { runFullExport, inspectZip, EXPORT_ROOT as R } from "./harness.mjs";

const per = await runFullExport({ options: { package: "per-chat" } });

test("per-chat packaging emits one ZIP per chat", () => {
  assert.equal(per.blobs.length, 4);
});

test("per-chat ZIP names carry the chat title", () => {
  assert.ok(
    per.blobs.some((b) => b.name.includes("演示话题乙")),
    per.blobs.map((b) => b.name).join(","),
  );
});

test("per-chat ZIP carries only that chat's outputs", () => {
  const z = inspectZip(per.blobs[0].buf, R + "report.md");
  const raws = z.entries.filter((e) => e.startsWith(R + "raw/"));
  assert.equal(raws.length, 1);
  const id = raws[0].split("/").pop().replace(".json", "");
  assert.deepEqual(per.archives[0].chats, [id]);
  assert.equal(z.entries.filter((e) => e.startsWith(R + "markdown/")).length, 1);
  assert.ok(!z.has(R + "index.html"));
});

const vols = await runFullExport({ volumeBytes: 1 });

test("tiny byte cap splits into one volume per chat", () => {
  assert.equal(vols.blobs.length, 4);
  assert.ok(vols.blobs.every((b, i) => b.name.includes("part" + (i + 1))));
  assert.equal(
    vols.archives.reduce((a, x) => a + x.chats.length, 0),
    4,
  );
});

test("every volume is scoped to its chats and all chats are covered", () => {
  const seen = new Set();
  for (let i = 0; i < vols.blobs.length; i++) {
    const zz = inspectZip(vols.blobs[i].buf);
    assert.ok(zz.has(R + "report.md"), "vol" + i + " report");
    const ids = zz.entries
      .filter((e) => e.includes("/raw/"))
      .map((e) => e.split("/").pop().replace(".json", ""));
    assert.ok(
      ids.every((id) => vols.archives[i].chats.includes(id)),
      "vol" + i + " scope: " + ids.join(","),
    );
    ids.forEach((id) => seen.add(id));
  }
  assert.equal(seen.size, 4);
});

test("ZIP names are all lowercase in both packaging modes", () => {
  for (const blob of [...per.blobs, ...vols.blobs])
    assert.equal(blob.name, blob.name.toLowerCase(), blob.name);
});
