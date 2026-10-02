import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { connect, evaluate } from "./cdp.mjs";
const cdp = await connect(Number(process.env.CDP_PORT) || 9338);
const receipt = { startedAt: new Date().toISOString(), checks: [] };
let sessionId, targetId;
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
  ({ targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/tasks.html`,
  }));
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Runtime.enable", {}, sessionId);
  const run = (expression) => evaluate(cdp, sessionId, expression);
  // Wait for the page to actually load instead of guessing at a fixed delay:
  // a cold profile can take seconds to bring up the extension page.
  // The page title follows the browser language, so accept either catalog.
  const TASK_TITLES = ["Kimi 导出任务", "Kimi Export Tasks"];
  let title = "";
  for (let i = 0; i < 40 && !TASK_TITLES.includes(title); i++) {
    await new Promise((r) => setTimeout(r, 250));
    title = await run("document.title").catch(() => "");
  }
  assert.ok(TASK_TITLES.includes(title), `unexpected task-page title: ${title}`);
  receipt.checks.push({ name: "task-page-loads", ok: true });
  const setup = await run(`(async () => {
    const { openJobDb, newJob } = await import('./lib/job-db.js');
    const { optionsWithDefaults } = await import('./lib/pipeline.js');
    const { LIST_CHATS_PAGES } = await import('./test/make-fixtures.mjs');
    const { normalizeChat } = await import('./lib/api.js');
    window.testDb = await openJobDb();
    const chats = LIST_CHATS_PAGES[0].chats.filter(c => ['c1','c2'].includes(c.id)).map(normalizeChat);
    const job = newJob({ chatIds: chats.map(c => c.id), chats, options: optionsWithDefaults(), locale: 'zh-CN' });
    job.runId = 'browser-run1'; await testDb.createJob(job); window.testJobId = job.id;
    window.startTestWorker = config => new Promise((resolve, reject) => {
      const worker = new Worker('test/browser/engine-worker.js', { type: 'module' }); window.testWorker = worker;
      worker.onerror = e => reject(new Error(e.message));
      worker.onmessage = ({data}) => { if (data.type === 'checkpoint' || data.type === 'result') resolve(data); if (data.type === 'error') reject(new Error(data.error)); };
      worker.postMessage({ jobId: window.testJobId, ...config });
    });
    return { id: job.id, targets: chats.length };
  })()`);
  assert.equal(setup.targets, 2);
  const checkpoint = await run("startTestWorker({crashAfterPage:true})");
  assert.equal(checkpoint.type, "checkpoint");
  await run(
    `(async()=> { testWorker.terminate(); await testDb.updateJob(testJobId,{runId:'browser-run2',state:'interrupted'}); })()`,
  );
  const resumed = await run("startTestWorker({resume:true})");
  assert.ok(resumed.result.state.startsWith("completed"), resumed.result.error);
  assert.equal(resumed.result.artifacts.length, 1);
  receipt.checks.push({
    name: "worker-termination-and-real-opfs-idb-resume",
    ok: true,
    state: resumed.result.state,
    bytes: resumed.result.artifacts[0].bytes,
  });
  await run(
    `(async()=> { testWorker.terminate(); await testDb.updateJob(testJobId,{runId:'browser-run3'}); })()`,
  );
  const cached = await run("startTestWorker({resume:true})");
  assert.equal(cached.downloads, 0);
  assert.equal(cached.calls.length, 2);
  receipt.checks.push({ name: "completed-files-and-zip-reused", ok: true });
  const artifact = resumed.result.artifacts[0];
  const downloadPath = `/tmp/kimi-browser-downloads`;
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true,
  });
  const downloaded = await run(`(async()=> {
    const {opfsStore}=await import('./lib/opfs.js');const store=await opfsStore(testJobId);
    const blob=await store.getBlob(${JSON.stringify(artifact.path)});const url=URL.createObjectURL(blob);
    window.testDownloadURL=url;const id=await chrome.downloads.download({url,filename:'browser-integration.zip'});return {id,size:blob.size};
  })()`);
  let download;
  for (let i = 0; i < 50; i++) {
    download = await run(
      `chrome.downloads.search({id:${downloaded.id}}).then(x=>({state:x[0]?.state,filename:x[0]?.filename,error:x[0]?.error}))`,
    );
    if (download.state !== "in_progress") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(download.state, "complete", JSON.stringify(download));
  await run("URL.revokeObjectURL(testDownloadURL)");
  receipt.checks.push({ name: "extension-blob-download", ok: true, bytes: downloaded.size });
  const locks = await run(
    `(async()=> { let release, entered; const ready=new Promise(r=>entered=r); const task=navigator.locks.request('kimi-export-executor',async()=>{entered();await new Promise(r=>release=r);}); await ready;const blocked=await navigator.locks.request('kimi-export-executor',{ifAvailable:true},l=>l===null);release();await task;return blocked; })()`,
  );
  assert.equal(locks, true);
  receipt.checks.push({ name: "exclusive-executor-lock", ok: true });
  await run(`testWorker.terminate();location.hash='jobId='+testJobId;`);
  await new Promise((r) => setTimeout(r, 300));
  const ui = await run(
    `({text:document.querySelector('#detail').innerText,width:document.documentElement.scrollWidth,viewport:innerWidth})`,
  );
  assert.ok(
    ["导出完成", "完成但不完整", "Export complete", "Completed with errors"].some((s) =>
      ui.text.includes(s),
    ),
    ui.text,
  );
  assert.ok(ui.width <= ui.viewport);
  receipt.checks.push({ name: "persisted-result-visible-in-task-page", ok: true });
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const screen = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/tasks-browser.png", Buffer.from(screen.data, "base64"));
  receipt.ok = true;
} catch (e) {
  receipt.ok = false;
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/browser-receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  cdp.close();
}
