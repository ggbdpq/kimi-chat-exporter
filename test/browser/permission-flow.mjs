// Real Chrome check for the media-permission hand-off: granting the optional
// host permission must continue the export instead of asking for the same click
// again. The permission dialogs cannot be shown here, so `chrome.permissions`
// is stubbed on the extension page and the parked-intent path the
// `chrome.permissions.onAdded` listener uses is driven through messages.
//
// Usage: start Chrome with the unpacked extension, then
//   node test/browser/permission-flow.mjs   # CDP_PORT=9338 by default
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { connect } from "./cdp.mjs";

const cdp = await connect(Number(process.env.CDP_PORT) || 9338);
const receipt = { startedAt: new Date().toISOString(), checks: [] };

const targetInfos = async () => (await cdp.send("Target.getTargets")).targetInfos;
async function extensionId() {
  const fromTargets = () =>
    targetInfos().then((list) =>
      list
        .map((t) => t.url.match(/^chrome-extension:\/\/([a-z]+)\/lib\/background\.js$/))
        .find(Boolean)?.[1],
    );
  let id = await fromTargets();
  if (!id) id = (await cdp.send("Extensions.loadUnpacked", { path: process.cwd() }).catch(() => ({}))).id;
  for (let i = 0; i < 40 && !id; i++) {
    await new Promise((r) => setTimeout(r, 250));
    id = await fromTargets();
  }
  return id;
}

/** Open an extension page and return a one-shot evaluator for it. */
async function open(id, path) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${id}/${path}`,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  const run = async (expression, params = {}) => {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, ...params },
      sessionId,
    );
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 40; i++) {
    const ready = await run(`document.readyState === "complete" && !!document.title`).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Popup init binds its buttons after a few awaits in main().
  await new Promise((r) => setTimeout(r, 1500));
  return { targetId, run };
}

const listJobs = (run) =>
  run(`(async () => {
    const { openJobDb } = await import("./lib/job-db.js");
    return (await (await openJobDb()).listJobs()).map((j) => ({ id: j.id, state: j.state, allChats: j.allChats }));
  })()`);
const jobState = (run, id) =>
  run(`(async () => {
    const { openJobDb } = await import("./lib/job-db.js");
    return (await (await openJobDb()).getJob(${JSON.stringify(id)}))?.state;
  })()`);

try {
  const id = await extensionId();
  assert.ok(id, "the unpacked extension must be loaded");
  const reader = await open(id, "popup.html");

  // 1. The task page's own grant button continues the job it belongs to.
  const queued = await reader.run(`(async () => {
    const { openJobDb, newJob } = await import("./lib/job-db.js");
    const db = await openJobDb();
    const job = newJob({
      chatIds: ["c1"],
      chats: [{ id: "c1", name: "示例", files: [] }],
      options: { downloadMedia: true },
      tabId: 1,
      locale: "zh-CN",
    });
    await db.createJob(job);
    return job.id;
  })()`);
  const taskPage = await open(id, `tasks.html#jobId=${queued}`);
  await taskPage.run(`(() => {
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => false;
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const clicked = await taskPage.run(`(() => {
    const button = document.querySelector(".notice__action");
    if (button) button.click();
    return !!button;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const continued = await jobState(reader.run, queued);
  assert.equal(clicked, true, "a job without media permission must show the grant banner");
  assert.notEqual(continued, "queued", "granting must start the queued job");
  receipt.checks.push({ name: "task-page-grant-continues-the-job", ok: true, state: continued });

  // 2. Popup 导出全部 with the permission approved creates one job and hands off.
  const before = (await listJobs(reader.run)).length;
  const popup = await open(id, "popup.html");
  await popup.run(`(() => {
    chrome.permissions.request = async () => true;
    window.confirm = () => true;
    return true;
  })()`);
  await popup.run(`document.getElementById("btn-export-all").click()`);
  await new Promise((r) => setTimeout(r, 2000));
  const afterPopup = await listJobs(reader.run);
  const created = afterPopup.filter((j) => j.allChats);
  assert.equal(afterPopup.length, before + 1, "导出全部 must create exactly one job");
  assert.equal(created.length, 1, "the new job must cover the whole history");
  assert.ok(
    (await targetInfos()).some((t) => t.url.includes("/tasks.html")),
    "the task page must open",
  );
  assert.ok(
    !(await targetInfos()).some((t) => t.targetId === popup.targetId),
    "the popup must close itself after handing the job over",
  );
  receipt.checks.push({
    name: "popup-export-all-starts-after-the-grant",
    ok: true,
    jobCount: created.length,
  });

  // 3. The parked-intent path the grant listener uses starts exactly one job.
  const pendingId = `browser-${crypto.randomUUID()}`;
  const parked = await reader.run(`(async () => {
    const send = (message) => chrome.runtime.sendMessage(message);
    await send({
      type: "parkExport",
      pendingId: ${JSON.stringify(pendingId)},
      intent: { chatIds: [], chats: [], allChats: true, tabId: 1, locale: "zh-CN", options: {} },
    });
    const first = await send({ type: "startExport", pendingId: ${JSON.stringify(pendingId)} });
    const second = await send({ type: "startExport", pendingId: ${JSON.stringify(pendingId)} });
    return { first, second };
  })()`);
  const afterParked = (await listJobs(reader.run)).length;
  assert.ok(parked.first.jobId, "the parked export must start a job");
  assert.equal(parked.second.jobId, "", "a second start must not create another job");
  assert.equal(afterParked, afterPopup.length + 1, "the parked export adds exactly one job");
  receipt.checks.push({ name: "parked-export-starts-once", ok: true, jobId: parked.first.jobId });

  receipt.ok = true;
} catch (e) {
  receipt.ok = false;
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/permission-flow-receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  cdp.close();
}
