import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import {
  CHAT_CACHE_KEY,
  CACHE_VERSION,
  FRESH_MS,
  FULL_WALK_MS,
  accountKeyFromToken,
  clampPageSize,
  createChatSync,
  describeAge,
  emptyCache,
  mergeWalk,
  walkList,
  normalizeCache,
  sameAccount,
  timeValue,
  verifyOrder,
} from "../lib/chat-cache.js";

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    },
    async remove(key) {
      delete data[key];
    },
  };
}

const chat = (id, updateTime, extra = {}) => ({
  id,
  name: `对话 ${id}`,
  createTime: updateTime,
  updateTime,
  ...extra,
});

/** Serves `pages` as ListChats, recording every request body. */
function pagedApi(pages) {
  const calls = [];
  return {
    calls,
    async rpc(method, body) {
      calls.push({ method, body });
      const index = Number(body.pageToken || 0);
      return {
        chats: pages[index] || [],
        nextPageToken: index + 1 < pages.length ? String(index + 1) : "",
      };
    },
  };
}

/** `next()` walks one page at a time; this drives it to the end. */
async function walk(sync, options) {
  const results = [];
  for (let i = 0; i < 200; i++) {
    const result = await sync.next(options);
    results.push(result);
    if (result.done) return { calls: results.length, last: result, results };
  }
  throw new Error("walk never finished");
}

const times = (count, step = 60_000, from = Date.parse("2026-03-01T00:00:00Z")) =>
  Array.from({ length: count }, (_, i) => new Date(from - i * step).toISOString());

test("mergeWalk appends each page and lifts repeated chats out of the tail", () => {
  const cached = [chat("a", "2026-01-03"), chat("b", "2026-01-02"), chat("c", "2026-01-01")];
  let state = { walked: [], tail: cached };
  state = mergeWalk(state, [chat("b", "2026-01-04"), chat("a", "2026-01-03")]);
  assert.deepEqual(
    walkList(state).map((c) => c.id),
    ["b", "a", "c"],
  );
  assert.equal(walkList(state)[0].updateTime, "2026-01-04");
  state = mergeWalk(state, [chat("c", "2026-01-01")]);
  assert.deepEqual(
    walkList(state).map((c) => c.id),
    ["b", "a", "c"],
  );
  assert.equal(state.tail.length, 0);
  assert.deepEqual(mergeWalk(state, []), state);
});

test("pages stay in order when a walk spans several of them", () => {
  let state = { walked: [], tail: [chat("cached", "2025-01-01")] };
  for (const id of ["p1", "p2", "p3", "p4"]) state = mergeWalk(state, [chat(id, "2026-01-01")]);
  assert.deepEqual(
    walkList(state).map((c) => c.id),
    ["p1", "p2", "p3", "p4", "cached"],
  );
});

test("timeValue accepts ISO strings, int64 strings and protobuf timestamps", () => {
  const iso = "2026-03-01T00:00:00.000Z";
  assert.equal(timeValue(iso), Date.parse(iso));
  assert.equal(timeValue(String(Date.parse(iso))), Date.parse(iso));
  assert.equal(timeValue({ seconds: String(Date.parse(iso) / 1000) }), Date.parse(iso));
  assert.equal(timeValue(""), 0);
});

test("verifyOrder names the sorted field and refuses an unsorted list", () => {
  assert.equal(verifyOrder([chat("a", "2026-01-03"), chat("b", "2026-01-02")]), "updateTime");
  assert.equal(verifyOrder([chat("a", "2026-01-02"), chat("b", "2026-01-03")]), "");
  assert.equal(verifyOrder([{ id: "a", createTime: "2026-01-03" }, { id: "b", createTime: "2026-01-02" }]), "createTime");
  assert.equal(verifyOrder([chat("a", "2026-01-03")]), "");
});

test("sameAccount trusts the fingerprint, and falls back to id overlap", () => {
  const cache = { ...emptyCache("abc"), chats: [chat("a", "2026-01-01")] };
  assert.equal(sameAccount(cache, "abc", [chat("z", "2026-01-02")]), true);
  assert.equal(sameAccount(cache, "xyz", [chat("a", "2026-01-02")]), false);
  assert.equal(sameAccount(cache, "", [chat("a", "2026-01-02")]), true);
  assert.equal(sameAccount(cache, "", [chat("z", "2026-01-02")]), false);
  assert.equal(sameAccount(emptyCache(""), "", []), true);
});

test("accountKeyFromToken hashes an id claim, never the token", async () => {
  const jwt = (claims) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const first = await accountKeyFromToken(jwt({ sub: "user-1", exp: 1 }));
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(await accountKeyFromToken(jwt({ sub: "user-1" })), first);
  assert.notEqual(await accountKeyFromToken(jwt({ sub: "user-2" })), first);
  assert.equal(await accountKeyFromToken(jwt({ aud: "nobody" })), "");
  assert.equal(await accountKeyFromToken("not-a-jwt"), "");
  assert.equal(await accountKeyFromToken(""), "");
  assert.ok(!first.includes("user-1"));
});

test("normalizeCache rejects foreign versions and repairs loose fields", () => {
  assert.equal(normalizeCache({ version: 99, chats: [] }), null);
  assert.equal(normalizeCache(null), null);
  const repaired = normalizeCache({ version: CACHE_VERSION, chats: [{ id: "a" }, { nope: 1 }], pageSize: 99999 });
  assert.equal(repaired.chats.length, 1);
  assert.equal(repaired.pageSize, 200);
  assert.equal(repaired.complete, false);
  assert.equal(repaired.resume, null);
  assert.equal(clampPageSize(3), 50);
  assert.equal(clampPageSize(0), 0);
});

test("a full walk caches the list and reports it as complete and ordered", async () => {
  const storage = memoryStorage();
  const api = pagedApi([[chat("a", times(2)[0]), chat("b", times(2)[1])]]);
  const sync = createChatSync({ storage, api, accountKey: "acct" });
  const result = await sync.next();
  assert.equal(result.done, true);
  assert.equal(result.complete, true);
  assert.equal(result.order, "updateTime");
  assert.equal(result.replace, true);
  assert.equal(result.total, 2);
  const cache = storage.data[CHAT_CACHE_KEY];
  assert.equal(cache.version, CACHE_VERSION);
  assert.equal(cache.chats.length, 2);
  assert.equal(cache.complete, true);
  assert.equal(cache.resume, null);
  assert.equal(cache.accountKey, "acct");
});

test("an unchanged list costs one page and keeps the cached tail", async () => {
  const storage = memoryStorage();
  const page = [chat("a", times(3)[0]), chat("b", times(3)[1])];
  const first = createChatSync({ storage, api: pagedApi([page]) });
  await first.next();
  const api = pagedApi([[chat("a", times(3)[0]), chat("b", times(3)[1])], [chat("c", times(3)[2])]]);
  const sync = createChatSync({ storage, api });
  const result = await sync.next();
  assert.equal(api.calls.length, 1);
  assert.equal(result.done, true);
  assert.equal(result.added, 0);
  assert.equal(result.total, 2);
  assert.equal(result.complete, true);
});

test("a chat updated at the top is picked up, then the walk stops", async () => {
  const storage = memoryStorage();
  const base = times(3);
  await createChatSync({ storage, api: pagedApi([[chat("a", base[0]), chat("b", base[1])]]) }).next();
  const api = pagedApi([
    [chat("b", base[2]), chat("a", base[0])],
    [chat("c", base[1])],
  ]);
  const result = await createChatSync({ storage, api }).next();
  assert.equal(api.calls.length, 1);
  assert.equal(result.done, true);
  assert.equal(result.replace, true);
  assert.deepEqual(
    result.chats.map((c) => c.id),
    ["b", "a"],
  );
});

test("a brand new chat pushes the walk one page further", async () => {
  const storage = memoryStorage();
  const base = times(4);
  await createChatSync({ storage, api: pagedApi([[chat("a", base[0]), chat("b", base[1])]]) }).next();
  const api = pagedApi([
    [chat("new", base[3]), chat("a", base[0])],
    [chat("b", base[1])],
  ]);
  const { calls, last } = await walk(createChatSync({ storage, api }));
  assert.equal(calls, 2);
  assert.equal(last.total, 3);
  assert.deepEqual(
    last.chats.map((c) => c.id),
    ["new", "a", "b"],
  );
});

test("switching accounts drops the other account's history", async () => {
  const storage = memoryStorage();
  await createChatSync
    .call(null, { storage, api: pagedApi([[chat("a", times(1)[0])]]), accountKey: "acct-1" })
    .next();
  const api = pagedApi([[chat("z", times(1)[0])]]);
  const result = await createChatSync({ storage, api, accountKey: "acct-2" }).next();
  assert.equal(result.accountChanged, true);
  assert.equal(result.replace, true);
  assert.deepEqual(
    result.chats.map((c) => c.id),
    ["z"],
  );
  assert.equal(storage.data[CHAT_CACHE_KEY].accountKey, "acct-2");
});

test("account switching is caught without a fingerprint too", async () => {
  const storage = memoryStorage();
  await createChatSync({ storage, api: pagedApi([[chat("a", times(1)[0])]]) }).next();
  const result = await createChatSync({ storage, api: pagedApi([[chat("z", times(1)[0])]]) }).next();
  assert.equal(result.accountChanged, true);
  assert.equal(result.total, 1);
});

test("pageSize follows what the endpoint actually returns", async () => {
  const storage = memoryStorage();
  const first = Array.from({ length: 50 }, (_, i) => chat(`c${i}`, times(120)[i]));
  const api = pagedApi([first, [chat("last", times(120)[100])]]);
  const { last } = await walk(createChatSync({ storage, api }));
  assert.equal(api.calls[0].body.pageSize, 100);
  assert.equal(api.calls[1].body.pageSize, 50);
  assert.equal(last.pageSize, 50);
  assert.equal(storage.data[CHAT_CACHE_KEY].pageSize, 50);
  assert.equal(last.total, 51);
});

test("an interrupted walk resumes from the stored page token", async () => {
  const storage = memoryStorage();
  const pages = [
    Array.from({ length: 50 }, (_, i) => chat(`p1-${i}`, times(200)[i])),
    Array.from({ length: 50 }, (_, i) => chat(`p2-${i}`, times(200)[50 + i])),
    [chat("tail", times(200)[150])],
  ];
  const first = pagedApi(pages);
  const sync = createChatSync({ storage, api: first });
  await sync.next();
  assert.equal(storage.data[CHAT_CACHE_KEY].resume.pageToken, "1");
  assert.equal(storage.data[CHAT_CACHE_KEY].resume.walked, 50);
  assert.equal(storage.data[CHAT_CACHE_KEY].complete, false);

  const resumed = pagedApi(pages);
  const { last } = await walk(createChatSync({ storage, api: resumed }));
  assert.equal(resumed.calls.length, 2);
  assert.equal(resumed.calls[0].body.pageToken, "1");
  assert.equal(resumed.calls[0].body.pageSize, 50);
  assert.equal(last.complete, true);
  assert.equal(last.total, 101);
});

test("a stale page token restarts instead of resuming", async () => {
  const storage = memoryStorage();
  const pages = [
    Array.from({ length: 50 }, (_, i) => chat(`p1-${i}`, times(200)[i])),
    Array.from({ length: 50 }, (_, i) => chat(`p2-${i}`, times(200)[50 + i])),
  ];
  const sync = createChatSync({ storage, api: pagedApi(pages) });
  await sync.next();
  storage.data[CHAT_CACHE_KEY].resume.at = Date.now() - 10 * 60_000;
  const api = pagedApi(pages);
  await createChatSync({ storage, api }).next();
  assert.equal(api.calls[0].body.pageToken, undefined);
});

test("force refreshes past the freshness window", async () => {
  const storage = memoryStorage();
  await createChatSync({ storage, api: pagedApi([[chat("a", times(1)[0])]]) }).next();
  const fresh = createChatSync({ storage, api: pagedApi([]) });
  const peek = await fresh.peek();
  assert.equal(peek.fresh, true);
  assert.equal(peek.count, 1);
  assert.ok(peek.ageMs < FRESH_MS);

  const forced = pagedApi([[chat("a", times(1)[0])]]);
  await createChatSync({ storage, api: forced }).next({ force: true });
  assert.equal(forced.calls.length, 1);
});

test("a cache older than the full-walk window is rebuilt in full", async () => {
  const storage = memoryStorage();
  const base = times(3);
  await createChatSync({ storage, api: pagedApi([[chat("a", base[0]), chat("b", base[1])]]) }).next();
  storage.data[CHAT_CACHE_KEY].walkedAt = Date.now() - FULL_WALK_MS - 1000;
  const api = pagedApi([[chat("a", base[0]), chat("b", base[1])], [chat("c", base[2])]]);
  const { calls, last } = await walk(createChatSync({ storage, api }));
  assert.equal(calls, 2);
  assert.equal(last.total, 3);
  assert.equal(storage.data[CHAT_CACHE_KEY].order, "updateTime");
});

test("a storage failure never breaks listing", async () => {
  const storage = {
    async get() {
      throw new Error("disk on fire");
    },
    async set() {
      throw new Error("disk on fire");
    },
    async remove() {},
  };
  const sync = createChatSync({ storage, api: pagedApi([[chat("a", times(1)[0])]]) });
  const result = await sync.next();
  assert.equal(result.total, 1);
  assert.equal(result.done, true);
  assert.deepEqual(await sync.peek(), {
    chats: [],
    count: 0,
    complete: false,
    ageMs: 0,
    fresh: false,
    pageSize: 100,
  });
});

test("describeAge reads like a status line", () => {
  assert.equal(describeAge(5_000), "刚刚更新");
  assert.equal(describeAge(3 * 60_000), "3 分钟前更新");
  assert.equal(describeAge(2 * 3600_000), "2 小时前更新");
  assert.equal(describeAge(50 * 3600_000), "2 天前更新");
});

test("an oversized history is trimmed to the newest chats and marked incomplete", async () => {
  const storage = memoryStorage();
  const pad = "x".repeat(100);
  const fits = [
    Array.from({ length: 100 }, (_, i) => chat(`p1-${i}`, times(300)[i], { pad })),
    Array.from({ length: 100 }, (_, i) => chat(`p2-${i}`, times(300)[100 + i], { pad })),
  ];
  const sync = createChatSync({ storage, api: pagedApi(fits), maxCacheBytes: 120_000 });
  const { last } = await walk(sync);
  assert.equal(last.total, 200, "the caller still sees the whole list");
  const cached = normalizeCache(storage.data[CHAT_CACHE_KEY]);
  assert.equal(cached.chats.length, 200);
  assert.equal(cached.complete, true);

  // A history that cannot fit in full keeps only its newest slice.
  const huge = [
    Array.from({ length: 600 }, (_, i) => chat(`h-${i}`, times(700)[i], { pad: "y".repeat(100) })),
  ];
  const result = await walk(createChatSync({ storage, api: pagedApi(huge), maxCacheBytes: 120_000 }));
  const trimmed = normalizeCache(storage.data[CHAT_CACHE_KEY]);
  assert.equal(result.last.total, 600);
  assert.ok(trimmed.chats.length < 600, `expected a truncated cache, got ${trimmed.chats.length}`);
  assert.ok(trimmed.chats.length >= 200, "the newest slice is still worth keeping");
  assert.equal(trimmed.complete, false);
  assert.equal(trimmed.resume, null);
  assert.equal(trimmed.chats[0].id, "h-0");
});

test("a cache that cannot be trimmed is skipped instead of failing", async () => {
  const storage = memoryStorage();
  const pages = [[chat("a", times(1)[0], { pad: "z".repeat(2000) })]];
  const sync = createChatSync({ storage, api: pagedApi(pages), maxCacheBytes: 10 });
  const { last } = await walk(sync);
  assert.equal(last.total, 1);
  assert.equal(storage.data[CHAT_CACHE_KEY], undefined);
});
