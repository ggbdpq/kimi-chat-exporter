import { JobEngine } from "../../lib/job-engine.js";
import { openJobDb, newJob } from "../../lib/job-db.js";
import { opfsStore, requireSpace } from "../../lib/opfs.js";
import { optionsWithDefaults } from "../../lib/pipeline.js";
self.onmessage = async ({ data }) => {
  const db = await openJobDb(),
    count = data.chats || 1000;
  const targets = Array.from({ length: count }, (_, i) => ({
    id: `stress-${i}`,
    name: `合成对话 ${i}`,
    files: [],
    createTime: "2026-10-01T00:00:00Z",
  }));
  const job = newJob({
    chatIds: targets.map((c) => c.id),
    chats: targets,
    options: optionsWithDefaults(),
  });
  job.runId = "stress";
  await db.createJob(job);
  const raw = await opfsStore(job.id),
    controller = new AbortController();
  const start = performance.now();
  let currentMedia = 0,
    maxMedia = 0,
    currentLarge = 0,
    maxLarge = 0,
    networkBytes = 0,
    assetCalls = 0,
    lastProgress = 0;
  const largeBytes = data.largeBytes ?? 512 * 1024 * 1024;
  postMessage({ type: "started", jobId: job.id });
  const engine = new JobEngine({
    db,
    raw,
    job,
    runId: job.runId,
    signal: controller.signal,
    requireSpace,
    api: {
      async rpc(method, body) {
        if (!method.endsWith("ListMessages")) throw new Error("unexpected RPC");
        const index = Number(body.chatId.split("-")[1]);
        return {
          messages: [
            {
              id: `m-${index}`,
              role: "ROLE_ASSISTANT",
              status: "MESSAGE_STATUS_COMPLETED",
              blocks: Array.from({ length: 10 }, (_, j) => ({
                id: `b-${index}-${j}`,
                file: {
                  id: `f-${index}-${j}`,
                  meta: {
                    name: `file-${j}.bin`,
                    sizeBytes: String(index === 0 && j === 0 ? largeBytes : 1024),
                    contentType: "application/octet-stream",
                  },
                  blob: { signUrl: `https://stress.example/${index}/${j}` },
                },
              })),
            },
          ],
        };
      },
    },
    canAccessHost: async () => true,
    fetchBinary: async (url) => {
      const big = url.endsWith("/0/0"),
        size = big ? largeBytes : 1024;
      let remaining = size,
        closed = false;
      currentMedia++;
      assetCalls++;
      if (big) currentLarge++;
      maxMedia = Math.max(maxMedia, currentMedia);
      maxLarge = Math.max(maxLarge, currentLarge);
      const finish = () => {
        if (!closed) {
          closed = true;
          currentMedia--;
          if (big) currentLarge--;
        }
      };
      return new Response(
        new ReadableStream(
          {
            pull(c) {
              if (!remaining) {
                finish();
                c.close();
                return;
              }
              const n = Math.min(65536, remaining);
              remaining -= n;
              networkBytes += n;
              c.enqueue(new Uint8Array(n));
            },
            cancel: finish,
          },
          { highWaterMark: 0 },
        ),
        { headers: { "Content-Length": String(size) } },
      );
    },
    emit: (e) => {
      if (e.type === "progress" && performance.now() - lastProgress > 1000) {
        lastProgress = performance.now();
        postMessage(e);
      }
    },
  });
  try {
    const result = await engine.run();
    postMessage({
      type: "result",
      result: {
        jobId: job.id,
        state: result.state,
        error: result.error,
        totals: result.totals,
        artifacts: result.artifacts.length,
        archiveBytes: result.artifacts.reduce((n, a) => n + a.bytes, 0),
        elapsedMs: performance.now() - start,
        maxMedia,
        maxLarge,
        networkBytes,
        assetCalls,
        diskBytes: await raw.totalBytes(),
      },
    });
  } catch (e) {
    postMessage({ type: "error", error: e.stack });
  } finally {
    db.close();
  }
};
