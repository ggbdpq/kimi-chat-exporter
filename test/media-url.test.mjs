// Asset URLs Kimi cannot serve (tool sandbox paths, CDN strings that lost their
// host) must be treated as non-downloadable: they stay plain text in the
// transcript instead of entering the download queue or the host-permission
// bridge, where an unusable URL turns into a bogus "origin pattern" failure.
import { test } from "node:test";
import "./locale.mjs";
import assert from "node:assert/strict";
import { isDownloadableUrl, normalizeChat } from "../lib/model.js";
import { collectAssets, optionsWithDefaults } from "../lib/pipeline.js";
import { downloadMedia, mediaScheduler } from "../lib/media.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const message = (id, blocks) => ({
  id,
  parentId: NIL,
  childrenMessageIds: [],
  role: "assistant",
  status: "MESSAGE_STATUS_COMPLETED",
  createTime: "2026-10-04T00:00:00Z",
  blocks,
});

test("only absolute http(s) urls count as downloadable", () => {
  assert.equal(isDownloadableUrl("https://i0.hdslb.com/bfs/archive/a.jpg"), true);
  assert.equal(isDownloadableUrl("http://cdn.example.com/report.pdf"), true);
  assert.equal(isDownloadableUrl("sandbox:///mnt/agents/.tmp/tmp.png"), false);
  assert.equal(isDownloadableUrl("@672w_378h_1c_!web-search-common-cover.avif"), false);
  assert.equal(isDownloadableUrl("blob:https://www.kimi.com/8f2c"), false);
  assert.equal(isDownloadableUrl(""), false);
});

test("unfetchable urls are dropped from the download queue", () => {
  const thread = normalizeChat({ id: "cx", name: "不可下载资源" }, [
    message("m1", [
      {
        id: "b1",
        resourceLink: { uri: "sandbox:///mnt/agents/.tmp/tmp.png", title: "tmp.png" },
      },
      {
        id: "b2",
        videoCards: {
          cards: [{ title: "视频", coverThumbnailUrl: "@672w_378h_1c_!web-search-common-cover.avif" }],
        },
      },
      {
        id: "b3",
        resourceLink: {
          downloadUrl: "https://cdn.example.com/report.pdf",
          uri: "sandbox:/out/report.pdf",
          title: "报告",
        },
      },
    ]),
  ], optionsWithDefaults({}));
  const queued = collectAssets(thread.nodes, "cx").map((a) => a.url);
  assert.deepEqual(queued, ["https://cdn.example.com/report.pdf"]);
});

test("downloadMedia rejects an unfetchable url before asking for a host", async () => {
  for (const url of [
    "sandbox:///mnt/agents/.tmp/tmp.png",
    "@672w_378h_1c_!web-search-common-cover.avif",
  ]) {
    const asked = [];
    const err = await downloadMedia({
      asset: { kind: "resource", name: "资源", url, sizeBytes: 12 },
      scheduler: mediaScheduler(),
      signal: new AbortController().signal,
      canAccessHost: async (host) => {
        asked.push(host);
        return true;
      },
      store: {},
    }).then(
      () => null,
      (e) => e,
    );
    assert.equal(asked.length, 0, `${url} must not reach the permission bridge`);
    assert.match(err.message, /不支持的媒体链接/);
  }
});
