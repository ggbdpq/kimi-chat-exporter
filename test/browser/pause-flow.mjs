// Real Chrome check for pausing a live export: the run stops as "paused" and the
// task page must not report the abort as a failure. The engine is started for
// real (it parks on the missing login token), so this covers the abort path the
// pause button uses, not a stubbed engine.
//
// Usage: start Chrome with the unpacked extension, then
//   node test/browser/pause-flow.mjs      # CDP_PORT=9338 by default
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { connect, evaluate } from "./cdp.mjs";

const cdp = await connect(Number(process.env.CDP_PORT) || 9338);
const receipt = { startedAt: new Date().toISOString(), checks: [] };

async function extensionId() {
  const fromTargets = async () =>
    (await cdp.send("Target.getTargets")).targetInfos
      .map((t) => t.url.match(/^chrome-extension:\/\/([a-z]+)\/lib\/background\.js$/))
      .find(Boolean)?.[1];
  let id = await fromTargets();
  if (!id) id = (await cdp.send("Extensions.loadUnpacked", { path: process.cwd() }).catch(() => ({}))).id;
  for (let i = 0; i < 40 && !id; i++) {
    await new Promise((r) => setTimeout(r, 250));
    id = await fromTargets();
  }
  return id;
}

try {
  const id = await extensionId();
  assert.ok(id, "the unpacked extension must be loaded");
  const { targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${id}/tasks.html`,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  // The start/resume action asks for confirmation; this run is not interactive.
  cdp.on((message) => {
    if (message.method === "Page.javascriptDialogOpening")
      void cdp.send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
  });
  const run = (expression) => evaluate(cdp, sessionId, expression);

  const jobId = await run(`(async () => {
    const { openJobDb, newJob } = await import("./lib/job-db.js");
    const db = await openJobDb();
    const job = newJob({
      chatIds: ["c1"],
      chats: [{ id: "c1", name: "示例", files: [] }],
      options: { downloadMedia: false },
      tabId: 1,
      locale: "zh-CN",
    });
    await db.createJob(job);
    location.hash = "jobId=" + job.id;
    await new Promise((r) => setTimeout(r, 600));
    return job.id;
  })()`);
  const actionButton = (pattern) =>
    run(`(() => {
      const button = [...document.querySelectorAll(".actions button")].find((b) => ${pattern}.test(b.textContent));
      if (button) button.click();
      return button ? button.textContent : "";
    })()`);
  assert.match(await actionButton(/开始|继续|Start|Resume/), /./, "the job must offer a start action");
  await new Promise((r) => setTimeout(r, 2000));
  assert.match(await actionButton(/暂停|Pause/), /./, "a running job must offer a pause action");
  await new Promise((r) => setTimeout(r, 2500));

  const paused = await run(`(async () => {
    const { openJobDb } = await import("./lib/job-db.js");
    const job = await (await openJobDb()).getJob(${JSON.stringify(jobId)});
    return {
      state: job.state,
      error: job.error,
      alert: document.querySelector("#detail .alert")?.textContent || "",
      strip: document.getElementById("error")?.textContent || "",
    };
  })()`);
  assert.equal(paused.state, "paused", "the pause must stop the run");
  assert.equal(paused.error, null, `a paused job must not record an error: ${paused.error}`);
  assert.equal(paused.alert, "", "the detail card must not show an error box");
  assert.equal(paused.strip, "", "the page strip must stay empty");
  receipt.checks.push({ name: "pause-leaves-no-error", ok: true, ...paused });
  receipt.ok = true;
} catch (e) {
  receipt.ok = false;
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/pause-flow-receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  cdp.close();
}
