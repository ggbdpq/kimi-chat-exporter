import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { connect, evaluate } from "./cdp.mjs";
const cdp = await connect(Number(process.env.CDP_PORT) || 9338);
let workerSession, sessionId, targetId, jobId;
const heap = [];
const receipt = { startedAt: new Date().toISOString() };
try {
  const targets = await cdp.send("Target.getTargets");
  const id =
    targets.targetInfos.find((t) => t.url.endsWith("/background.js"))?.url.split("/")[2] ||
    targets.targetInfos.find((t) => t.url.includes("/tasks.html"))?.url.split("/")[2];
  assert.ok(id);
  ({ targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${id}/tasks.html`,
  }));
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await new Promise((r) => setTimeout(r, 400));
  await evaluate(
    cdp,
    sessionId,
    `(()=>{window.stressResult=null;window.stressProgress=null;window.stressWorker=new Worker('test/browser/stress-worker.js',{type:'module'});stressWorker.onmessage=({data})=>{if(data.type==='result'||data.type==='error')window.stressResult=data;else window.stressProgress=data;};stressWorker.onerror=e=>window.stressResult={type:'error',error:e.message};stressWorker.postMessage({chats:1000,largeBytes:512*1024*1024});})()`,
  );
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    if (!workerSession) {
      const t = (await cdp.send("Target.getTargets")).targetInfos.find((t) =>
        t.url.endsWith("/test/browser/stress-worker.js"),
      );
      if (t)
        ({ sessionId: workerSession } = await cdp.send("Target.attachToTarget", {
          targetId: t.targetId,
          flatten: true,
        }));
    }
    if (workerSession) {
      const m = await cdp.send("Runtime.getHeapUsage", {}, workerSession);
      heap.push({ atMs: Date.now() - started, ...m });
    }
    const state = await evaluate(cdp, sessionId, "({result:stressResult,progress:stressProgress})");
    if (state.progress?.jobId) jobId = state.progress.jobId;
    if (state.result) {
      if (state.result.type === "error") throw new Error(state.result.error);
      receipt.result = state.result.result;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(receipt.result, "stress timeout");
  assert.equal(receipt.result.state, "completed", receipt.result.error);
  assert.equal(receipt.result.totals.chats, 1000);
  assert.equal(receipt.result.assetCalls, 10000);
  assert.ok(receipt.result.maxMedia <= 4);
  assert.ok(receipt.result.maxLarge <= 1);
  receipt.heap = {
    samples: heap.length,
    peakUsedBytes: Math.max(...heap.map((h) => h.usedSize)),
    peakBackingStorageBytes: Math.max(...heap.map((h) => h.backingStorageSize || 0)),
    first: heap[0],
    last: heap.at(-1),
  };
  receipt.ok = true;
} catch (e) {
  receipt.ok = false;
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await evaluate(cdp, sessionId, "stressWorker?.terminate()").catch(() => {});
    if (jobId)
      await evaluate(
        cdp,
        sessionId,
        `(async()=>{const {clearWorkspace}=await import('./lib/opfs.js');const {openJobDb}=await import('./lib/job-db.js');const db=await openJobDb();await clearWorkspace(${JSON.stringify(jobId)});await db.deleteJob(${JSON.stringify(jobId)});db.close();})()`,
      ).catch(() => {});
  }
  await mkdir("test/out", { recursive: true });
  await writeFile("test/out/stress-receipt.json", JSON.stringify(receipt, null, 2));
  await writeFile("test/out/stress-heap.json", JSON.stringify(heap));
  console.log(JSON.stringify(receipt, null, 2));
  cdp.close();
}
