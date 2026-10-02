// Real Chrome check for the chat-list pipeline: popup messages -> background
// session -> chat-cache -> chrome.storage.local. Everything is real except the
// network (fetch is stubbed in the service worker) and the login token.
//
// Usage: start Chrome with the unpacked extension, then
//   node test/browser/chat-list.mjs        # CDP_PORT=9338 by default
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { connect, evaluate } from "./cdp.mjs";

const cdp = await connect(Number(process.env.CDP_PORT) || 9338);
const receipt = { startedAt: new Date().toISOString(), checks: [] };
const jwtFor = (sub) =>
  `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
const pagesFor = (count, prefix) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `对话 ${prefix}${i}`,
    messageCount: 3,
  }));
/** Stamps a newest-first list, which is what the endpoint is expected to return. */
const dated = (list) =>
  list.map((chat, i) => {
    const at = new Date(Date.parse("2026-03-01T00:00:00Z") - i * 60_000).toISOString();
    return { ...chat, createTime: at, updateTime: at };
  });
const brief = (last) =>
  JSON.stringify({ pages: last?.pages, added: last?.added, total: last?.total, order: last?.order });

/** Runs inside the service worker: swap the network and the login tab. */
const stubSource = (chats, sub) => `(() => {
  const state = globalThis.__kimiStub || (globalThis.__kimiStub = { chats: [], sub: "", calls: [] });
  state.chats = ${JSON.stringify(chats)};
  state.sub = ${JSON.stringify(sub)};
  state.calls = [];
  const realFetch = state.fetch || globalThis.fetch;
  state.fetch = realFetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || "{}");
    const limit = Math.min(body.pageSize || 50, 100);
    const start = Number(body.pageToken || 0);
    state.calls.push({ url: String(url), pageSize: body.pageSize, pageToken: body.pageToken || "", at: Date.now() });
    const slice = state.chats.slice(start, start + limit);
    const next = start + limit < state.chats.length ? String(start + limit) : "";
    return new Response(JSON.stringify({ chats: slice, nextPageToken: next }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const kimiTab = { id: 1, url: "https://www.kimi.com/chat/01234567-89ab-cdef-0123-456789abcdef" };
  state.realQuery = state.realQuery || chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.get = async () => kimiTab;
  // Only answer the Kimi-looking queries; leave the task-page lookups intact.
  chrome.tabs.query = async (q) =>
    q && String(q.url || "").includes("kimi.com") ? [kimiTab] : state.realQuery(q);
  chrome.tabs.sendMessage = async () => ({ ok: true, accessToken: "h." + btoa(JSON.stringify({ sub: state.sub })).replace(/=+$/, "") + ".s", refreshToken: "" });
  return true;
})()`;

let pageSession, swSession;
try {
  let extensionId;
  try {
    extensionId = (await cdp.send("Extensions.loadUnpacked", { path: process.cwd() })).id;
  } catch {
    const targets = await cdp.send("Target.getTargets");
    extensionId = targets.targetInfos
      .find((t) => t.url.endsWith("/background.js"))
      ?.url.split("/")[2];
  }
  assert.ok(extensionId, "test extension must be loaded");

  const { targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/tasks.html`,
  });
  ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Runtime.enable", {}, pageSession);
  const page = (expr) => evaluate(cdp, pageSession, expr);
  for (let i = 0; i < 40; i++) {
    const title = await page("document.title").catch(() => "");
    if (["Kimi 导出任务", "Kimi Export Tasks"].includes(title)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Wake the service worker and grab its target.
  await page(`chrome.runtime.sendMessage({ type: "openTasks" }).catch(() => {})`);
  let swTarget;
  for (let i = 0; i < 40 && !swTarget; i++) {
    await new Promise((r) => setTimeout(r, 250));
    swTarget = (await cdp.send("Target.getTargets")).targetInfos.find(
      (t) => t.type === "service_worker" && t.url.includes(extensionId),
    );
  }
  assert.ok(swTarget, "the background service worker must be reachable");
  ({ sessionId: swSession } = await cdp.send("Target.attachToTarget", {
    targetId: swTarget.targetId,
    flatten: true,
  }));
  await cdp.send("Runtime.enable", {}, swSession);
  const worker = (expr) => evaluate(cdp, swSession, expr);

  // `reset` clears the stored cache so a scenario can start from nothing.
  const install = async (chats, sub, { reset = true } = {}) => {
    await worker(stubSource(chats, sub));
    await worker(
      `globalThis.__kimiStub.calls = [];${reset ? "chrome.storage.local.remove('chatListCache');" : ""}`,
    );
  };
  const calls = () => worker("JSON.stringify(globalThis.__kimiStub.calls)").then(JSON.parse);
  const send = (message) =>
    page(`chrome.runtime.sendMessage(${JSON.stringify(message)}).then((r) => JSON.stringify(r))`).then(
      JSON.parse,
    );
  /** Drives the popup's loop: begin, then next until done. */
  const drive = async (force = false) => {
    const begin = await send({ type: "listChatsBegin", tabId: 1, force });
    const seen = [...(begin.chats || [])];
    // A forced refresh walks even when the cache is still inside its TTL.
    if (begin.fresh && !force) return { begin, pages: 0, chats: seen };
    let pages = 0;
    for (let i = 0; i < 200; i++) {
      const step = await send({ type: "listChatsNext", tabId: 1, force });
      pages++;
      if (step.replace) seen.splice(0, seen.length, ...step.chats);
      else seen.unshift(...step.chats);
      if (step.done) return { begin, pages, chats: seen, last: step };
    }
    throw new Error("walk never finished");
  };

  // 1. First walk: 220 chats at 100 per page.
  const chats = dated(pagesFor(220, "c"));
  await install(chats, "user-1");
  const first = await drive();
  assert.equal(first.pages, 3, brief(first.last));
  assert.equal(first.chats.length, 220);
  assert.equal(first.last.order, "updateTime");
  assert.equal(first.last.pageSize, 100);
  const cached = await page(`chrome.storage.local.get("chatListCache").then((v) => JSON.stringify({ complete: v.chatListCache.complete, count: v.chatListCache.chats.length, order: v.chatListCache.order, accountKey: v.chatListCache.accountKey }))`).then(JSON.parse);
  assert.deepEqual(
    { complete: cached.complete, count: cached.count, order: cached.order },
    { complete: true, count: 220, order: "updateTime" },
  );
  assert.equal(cached.accountKey.length, 16);
  receipt.checks.push({ name: "first-walk-caches-every-page", ok: true, ...cached, pages: first.pages });

  // 2. Reopening the popup uses the cache without touching the network.
  await worker("globalThis.__kimiStub.calls = []");
  const warm = await drive();
  assert.equal(warm.begin.fresh, true);
  assert.equal(warm.begin.count, 220);
  assert.equal((await calls()).length, 0);
  receipt.checks.push({ name: "fresh-cache-skips-the-network", ok: true, count: warm.begin.count });

  // 3. An unchanged list refreshes in a single request.
  await worker("globalThis.__kimiStub.calls = []");
  const refresh = await drive(true);
  assert.equal(refresh.pages, 1);
  assert.equal(refresh.chats.length, 220);
  assert.equal((await calls()).length, 1);
  receipt.checks.push({ name: "unchanged-refresh-costs-one-request", ok: true });

  // 4. A new chat at the top costs exactly one extra page.
  await install(dated([...pagesFor(2, "new"), ...chats]), "user-1", { reset: false });
  const grown = await drive(true);
  assert.equal(grown.pages, 2, brief(grown.last));
  assert.equal(grown.last.order, "updateTime");
  assert.equal(grown.chats.length, 222);
  assert.equal(grown.chats[0].id, "new-0");
  receipt.checks.push({ name: "new-chat-stops-after-the-next-page", ok: true, pages: grown.pages });

  // 5. A deleted chat disappears once a full walk runs.
  await install(dated(chats.slice(0, 219)), "user-1", { reset: false });
  await worker("chrome.storage.local.get('chatListCache').then((v) => { v.chatListCache.walkedAt = 0; return chrome.storage.local.set(v); })");
  const pruned = await drive(true);
  assert.equal(pruned.chats.length, 219);
  assert.ok(!pruned.chats.some((c) => c.id === "c-219"));
  receipt.checks.push({ name: "full-walk-drops-deleted-chats", ok: true });

  // 6. Switching accounts drops the other account's history.
  await install(dated(pagesFor(7, "other")), "user-2", { reset: false });
  const switched = await drive(true);
  assert.equal(switched.begin.chats.length, 219, "the cache is still shown while the walk starts");
  assert.equal(switched.last.accountChanged, true);
  assert.equal(switched.chats.length, 7);
  assert.equal(switched.chats[0].id, "other-0");
  receipt.checks.push({ name: "account-switch-replaces-the-cache", ok: true });

  // 7. A new account is also detected from the ids alone (no usable token).
  await install(dated(pagesFor(5, "third")), "", { reset: false });
  const noFingerprint = await drive(true);
  assert.equal(noFingerprint.last.accountChanged, true);
  assert.equal(noFingerprint.chats.length, 5);
  receipt.checks.push({ name: "account-switch-detected-by-id-overlap", ok: true });

  // 8. No credential ever lands in storage.
  const dump = await page(`chrome.storage.local.get(null).then((v) => JSON.stringify(v))`);
  assert.ok(!dump.includes("eyJ") && !dump.includes("accessToken"), "storage must not hold credentials");
  assert.ok(dump.includes("chatListCache"));
  receipt.checks.push({ name: "no-credentials-in-storage", ok: true, bytes: dump.length });

  // 9. "Export everything" creates the job without needing the list at all;
  // the engine fills in the targets when it runs.
  const started = await send({
    type: "startJob",
    allChats: true,
    chatIds: [],
    chats: [],
    tabId: 1,
    options: {},
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const job = await page(`(async () => {
    const { openJobDb } = await import("./lib/job-db.js");
    const db = await openJobDb();
    const job = await db.getJob(${JSON.stringify(started.jobId)});
    return JSON.stringify({ allChats: job.allChats, targets: job.targets.length, state: job.state });
  })()`).then(JSON.parse);
  assert.deepEqual(job, { allChats: true, targets: 0, state: "queued" });
  receipt.checks.push({ name: "export-all-skips-the-list", ok: true, ...job });

  receipt.ok = true;
} catch (e) {
  receipt.ok = false;
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/chat-list-receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  cdp.close();
}
