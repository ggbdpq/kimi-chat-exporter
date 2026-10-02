// Waiting-retry for a transiently missing login tab (recovery, not resume).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, withTokenRetry } from "../lib/api.js";

const fakeSleep = async () => {};

test("returns immediately when the first read succeeds", async () => {
  let reads = 0;
  const got = await withTokenRetry({
    read: async () => {
      reads++;
      return { value: "tok" };
    },
    waitsMs: [1, 2],
    sleep: fakeSleep,
  });
  assert.deepEqual(got, { value: "tok" });
  assert.equal(reads, 1);
});

test("recovers when a later read succeeds (tab reopened)", async () => {
  const waits = [];
  let reads = 0;
  const got = await withTokenRetry({
    read: async () => {
      reads++;
      if (reads < 3) throw new AuthError("no tab");
      return { value: "tok" };
    },
    waitsMs: [100, 200, 300],
    sleep: fakeSleep,
    onWait: (info) => waits.push(info.attempt),
  });
  assert.deepEqual(got, { value: "tok" });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("gives up with the last AuthError after the full wait budget", async () => {
  let reads = 0;
  await assert.rejects(
    withTokenRetry({
      read: async () => {
        reads++;
        throw new AuthError("still no tab");
      },
      waitsMs: [1, 2, 3],
      sleep: fakeSleep,
    }),
    (err) => err instanceof AuthError && err.message === "still no tab",
  );
  assert.equal(reads, 4); // initial + one per wait
});

test("non-AuthError failures are not retried", async () => {
  let reads = 0;
  await assert.rejects(
    withTokenRetry({
      read: async () => {
        reads++;
        throw new Error("boom");
      },
      waitsMs: [1, 2],
      sleep: fakeSleep,
    }),
    /boom/,
  );
  assert.equal(reads, 1);
});

test("an abort during a wait surfaces as AbortError", async () => {
  await assert.rejects(
    withTokenRetry({
      read: async () => {
        throw new AuthError("no tab");
      },
      waitsMs: [1],
      sleep: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    }),
    (err) => err.name === "AbortError",
  );
});

test("empty waitsMs keeps the fail-fast path (browsing, not exporting)", async () => {
  await assert.rejects(
    withTokenRetry({
      read: async () => {
        throw new AuthError("no tab");
      },
      waitsMs: [],
      sleep: fakeSleep,
    }),
    (err) => err instanceof AuthError,
  );
});
