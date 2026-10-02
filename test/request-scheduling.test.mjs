import { test } from "node:test";
import assert from "node:assert/strict";
import { KimiApi, AuthError } from "../lib/api.js";
import { Semaphore, sleep, retryAfter } from "../lib/control.js";
import { streamMedia } from "../lib/media.js";
import { memoryStore } from "./store-memory.js";
test("API start times obey one shared minimum interval", async () => {
  const starts = [],
    api = new KimiApi({
      throttleMs: 25,
      getTokens: async () => ({ accessToken: "mock" }),
      fetch: async () => {
        starts.push(Date.now());
        return Response.json({});
      },
    });
  await Promise.all(Array.from({ length: 8 }, () => api.rpc("test", {})));
  assert.equal(starts.length, 8);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 23, starts.join(","));
});
test("default platform fetch keeps its WorkerGlobalScope receiver", async () => {
  const original = globalThis.fetch;
  let receiver;
  globalThis.fetch = function (...args) {
    receiver = this;
    return Promise.resolve(Response.json({ ok: true, args }));
  };
  try {
    const api = new KimiApi({ throttleMs: 0, getTokens: async () => ({ accessToken: "mock" }) });
    await api.rpc("receiver-check", { ok: true });
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = original;
  }
});
test("authentication refresh replaces rejected token once for concurrent callers", async () => {
  let reads = 0;
  const headers = [];
  const api = new KimiApi({
    throttleMs: 0,
    getTokens: async () => ({ accessToken: ++reads === 1 ? "old" : "new" }),
    fetch: async (_, opts) => {
      headers.push(opts.headers.Authorization);
      return opts.headers.Authorization === "Bearer old"
        ? new Response("", { status: 401 })
        : Response.json({});
    },
  });
  await Promise.all([api.rpc("a", {}), api.rpc("b", {})]);
  assert.equal(reads, 2);
  assert.ok(headers.includes("Bearer new"));
});
test("queued semaphore wait is cancellable and does not leak a permit", async () => {
  const semaphore = new Semaphore(1),
    release = await semaphore.acquire(),
    ac = new AbortController();
  const waiting = semaphore.acquire(ac.signal);
  ac.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  release();
  const next = await semaphore.acquire();
  assert.equal(semaphore.active, 1);
  next();
  assert.equal(semaphore.active, 0);
});
test("network failures retry and release permits during backoff", async () => {
  let failed = false;
  const api = new KimiApi({
    throttleMs: 0,
    getTokens: async () => ({ accessToken: "mock" }),
    fetch: async () => {
      if (!failed) {
        failed = true;
        throw new TypeError("offline");
      }
      return Response.json({ ok: true });
    },
  });
  const pending = api.rpc("a", {});
  await sleep(20);
  assert.equal(api.slots.active, 0);
  assert.deepEqual(await pending, { ok: true });
});
test("Retry-After handles HTTP dates and numeric seconds", () => {
  assert.equal(retryAfter("3"), 3000);
  assert.equal(
    retryAfter("Wed, 01 Jan 2025 00:00:04 GMT", Date.parse("2025-01-01T00:00:00Z")),
    4000,
  );
});
test("API timeout is bounded and parent cancellation is not retried", async () => {
  let calls = 0;
  const api = new KimiApi({
    throttleMs: 0,
    timeoutMs: 10,
    getTokens: async () => ({ accessToken: "mock" }),
    fetch: (_, { signal }) => {
      calls++;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  });
  await assert.rejects(api.rpc("test", {}, { retries: 0 }), { name: "TimeoutError" });
  const ac = new AbortController(),
    request = api.rpc("test", {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 2);
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls, 2);
});
test("media writes chunks before the response completes; pause cancels partial output", async () => {
  const store = memoryStore(),
    ac = new AbortController();
  let controller,
    writes = 0;
  const original = store.openWriter.bind(store);
  store.openWriter = async (...args) => {
    const w = await original(...args),
      write = w.write;
    w.write = async (chunk) => {
      writes++;
      await write(chunk);
      ac.abort();
    };
    return w;
  };
  const fetchBinary = async (_, { signal }) =>
    new Response(
      new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue(new Uint8Array(32));
          signal.addEventListener("abort", () => {
            try {
              c.error(signal.reason);
            } catch {}
          });
        },
      }),
    );
  await assert.rejects(
    streamMedia({
      url: "https://example.com/mock",
      store,
      path: "x",
      signal: ac.signal,
      fetchBinary,
    }),
    { name: "AbortError" },
  );
  assert.equal(writes, 1);
  assert.equal(await store.exists("x"), false);
});

test("the request interval shrinks while the API stays healthy", async () => {
  const api = new KimiApi({
    getTokens: async () => ({ accessToken: "mock" }),
    fetch: async () => Response.json({}),
  });
  assert.equal(api.throttleMs, 150);
  for (let i = 0; i < 12; i++) await api.rpc("probe", {});
  assert.equal(api.throttleMs, api.minThrottleMs);
  assert.ok(api.throttleMs >= 60 && api.throttleMs <= 70, String(api.throttleMs));
});

test("an explicit throttle is never undercut", async () => {
  const api = new KimiApi({
    throttleMs: 25,
    getTokens: async () => ({ accessToken: "mock" }),
    fetch: async () => Response.json({}),
  });
  for (let i = 0; i < 10; i++) await api.rpc("probe", {});
  assert.equal(api.throttleMs, 25);
});

test("a 429 widens the interval and it creeps back afterwards", async () => {
  let failing = true;
  const api = new KimiApi({
    throttleMs: 60,
    minThrottleMs: 60,
    getTokens: async () => ({ accessToken: "mock" }),
    fetch: async () => {
      if (!failing) return Response.json({});
      failing = false;
      return new Response("", { status: 429 });
    },
  });
  const startedAt = Date.now();
  await api.rpc("probe", {});
  // Doubled by the 429, decayed once by the retry that succeeded.
  assert.equal(api.throttleMs, 108);
  assert.ok(api.cooldownUntil > 0, "a cooldown was armed");
  assert.ok(Date.now() - startedAt >= 350, "the retry waited the backoff out");
  for (let i = 0; i < 20; i++) await api.rpc("probe", {});
  assert.equal(api.throttleMs, 60);
});
