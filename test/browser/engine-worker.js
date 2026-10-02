// Browser-only harness: real worker/storage, invented Kimi responses.
import { openJobDb } from "../../lib/job-db.js";
import { opfsStore, requireSpace } from "../../lib/opfs.js";
import { JobEngine } from "../../lib/job-engine.js";
import { makeApi } from "../mock-api.mjs";
import { MEDIA } from "../make-fixtures.mjs";
let controller;
self.onmessage = async ({ data }) => {
  if (data.type === "abort") {
    controller?.abort();
    return;
  }
  const db = await openJobDb();
  controller = new AbortController();
  const job = await db.getJob(data.jobId),
    raw = await opfsStore(job.id),
    api = makeApi();
  let downloads = 0;
  if (data.crashAfterPage) {
    const put = db.putItem;
    db.putItem = async (...args) => {
      const value = await put(...args);
      if (args[2].kind === "page") {
        postMessage({ type: "checkpoint" });
        await new Promise(() => {});
      }
      return value;
    };
  }
  try {
    const engine = new JobEngine({
      db,
      raw,
      job,
      runId: job.runId,
      api,
      signal: controller.signal,
      requireSpace,
      emit: (e) => postMessage(e),
      canAccessHost: async () => true,
      fetchBinary: async (url) => {
        downloads++;
        const m = MEDIA[url];
        return m
          ? new Response(new Uint8Array(m.bytes), { headers: { "Content-Type": m.type } })
          : new Response("", { status: 404 });
      },
    });
    const result = await engine.run({ resume: !!data.resume });
    postMessage({ type: "result", result, calls: api.calls, downloads });
  } catch (e) {
    postMessage({ type: "error", error: e.stack });
  } finally {
    db.close();
  }
};
