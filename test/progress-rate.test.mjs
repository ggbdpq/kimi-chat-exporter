// The task page's "Rate" reading is a transfer average: it keeps moving while
// data is moving and then freezes, so the archiving phase cannot drag the number
// down as time passes.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { JobEngine } from "../lib/job-engine.js";

function bareEngine() {
  const events = [];
  const engine = new JobEngine({
    db: { updateJob: async (id) => ({ id }) },
    raw: {},
    job: { id: "j1", targets: [] },
    runId: "r1",
    api: {},
    signal: new AbortController().signal,
    emit: (event) => events.push(event.progress),
    canAccessHost: async () => true,
    fetchBinary: async () => {},
  });
  return { engine, events };
}

test("the rate moves during transfer and freezes once packing starts", async () => {
  const { engine, events } = bareEngine();
  engine.doneBytes = 4096;
  // Pretend the run has been transferring for a while; the denominator is
  // clamped to one second, so the two readings need room to differ.
  engine.progress.startedAt = Date.now() - 10_000;
  engine.progress.phase = "downloading";
  engine.progressEvent({}, true);
  await sleep(20);
  engine.progressEvent({}, true);

  const [first, second] = events;
  assert.ok(first.rate > 0);
  assert.ok(second.rate < first.rate, "a later reading averages over a longer window");

  engine.progress.phase = "packing";
  engine.progressEvent({ packedBytes: 512 }, true);
  const frozen = events.at(-1).rate;
  assert.equal(frozen, second.rate, "packing keeps the last transfer rate");
  await sleep(20);
  engine.progressEvent({ packedBytes: 4096 }, true);
  engine.progress.phase = "ready";
  engine.progressEvent({}, true);
  assert.equal(events.at(-1).rate, frozen, "the rate never moves again");
});

test("phases that move no data leave the rate alone", async () => {
  const { engine, events } = bareEngine();
  engine.progress.phase = "listing";
  engine.progressEvent({ listingDone: 10 }, true);
  engine.progressEvent({ phase: "validating" }, true);
  await sleep(20);
  engine.progressEvent({}, true);
  assert.deepEqual(new Set(events.map((p) => p.rate)), new Set([0]));
});
