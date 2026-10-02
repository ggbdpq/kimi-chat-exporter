// Synthetic proto-JSON fixtures shaped like Kimi's /apiv2 responses, with the
// quirks the real wire format has: enums as symbolic names, int64 as strings,
// message DAG with regenerations, PUA control chars, lazy tool blocks.
// All titles/questions/answers are invented placeholders — no real conversation
// content ever belongs in this file.

const NIL = "00000000-0000-0000-0000-000000000000";

function ts(offsetDays = 0) {
  const d = new Date(Date.UTC(2026, 8, 1 + offsetDays, 3, 30, 0));
  return d.toISOString().replace(".000Z", "Z");
}

const chat = (id, name, extra = {}) => ({
  id,
  name,
  createTime: ts(1),
  updateTime: ts(20),
  labels: ["CHAT_LABEL_UNSPECIFIED"],
  ...extra,
});

const chatFile9 = {
  id: "file-9",
  meta: { name: "数据表.csv", contentType: "text/csv", sizeBytes: "320", ext: "csv" },
  blob: { signUrl: "https://cdn.example.com/chatdata/dataset.csv" },
};
const chatFile10 = {
  id: "file-10",
  meta: { name: "附件长文.pdf", contentType: "application/pdf", sizeBytes: "800", ext: "pdf" },
};

export const LIST_CHATS_PAGES = [
  {
    chats: [
      chat("c1", "示例\u{e700}话题甲", { model: "kimi-k2", pinned: true, files: [chatFile9] }),
      chat("c2", "演示\u{e700}话题乙", {
        project: { id: "p1", name: "示例项目" },
        files: [chatFile10],
      }),
    ],
    // c1 appears under pinnedChats too, de-duplication by id must keep one copy
    pinnedChats: [chat("c1", "示例\u{e700}话题甲", { pinned: true, files: [chatFile9] })],
    nextPageToken: "page2",
  },
  {
    chats: [chat("c3", "空对话（无消息）"), chat("c4", "深度研究引用")],
    nextPageToken: "",
  },
];

const msg = (o) => ({
  id: o.id,
  parentId: o.parentId ?? NIL,
  childrenMessageIds: o.children || [],
  role: o.role,
  status: o.status ?? "MESSAGE_STATUS_COMPLETED",
  blocks: o.blocks || [],
  createTime: o.t || ts(3),
  ...(o.refs ? { refs: o.refs } : {}),
  ...(o.references ? { references: o.references } : {}),
  ...(o.vote ? { vote: o.vote } : {}),
  ...(o.scenario ? { scenario: o.scenario } : {}),
});

// c1: user -> assistant(thinking+text+citations) -> user(attachment) ->
//     assistant(lazy tool + image ref + sandbox file), with a regenerated branch
export const MESSAGES_C1 = {
  page1: {
    messages: [
      // Real conversations start with this content-free system stub.
      msg({ id: "s1", role: "system", children: ["m1"], t: ts(3), blocks: [] }),
      msg({
        id: "m1",
        parentId: "s1",
        role: "user",
        children: ["m2", "m2b"],
        t: ts(3),
        blocks: [
          {
            id: "b1",
            messageId: "m1",
            text: { content: "为什么示例问题会这样\u{e700}\n\n第二行" },
          },
        ],
      }),
      msg({
        id: "m2",
        parentId: "m1",
        role: "assistant",
        children: ["m3"],
        t: ts(3),
        blocks: [
          { id: "b2", messageId: "m2", think: { content: "示例思考内容", summary: "分析原因" } },
          {
            id: "b3",
            messageId: "m2",
            text: {
              content:
                "结论是**重点标记**。\n\n- 要点一\n- 要点二\n\n| 项目 | 值 |\n|---|---|\n| 甲 | 1.4 |",
            },
          },
          {
            id: "b4",
            messageId: "m2",
            search: {
              keywords: ["示例关键词"],
              webPages: [
                {
                  title: "示例来源",
                  url: "https://example.com/a",
                  siteName: "示例站",
                  snippet: "示例摘要",
                },
              ],
            },
          },
        ],
      }),
      // regeneration branch: same parent, becomes the mainline (last child)
      msg({
        id: "m2b",
        parentId: "m1",
        role: "assistant",
        children: [],
        t: ts(4),
        status: "MESSAGE_STATUS_CANCELLED",
        blocks: [
          {
            id: "b2b",
            messageId: "m2b",
            text: { content: "（这一版被重新生成取代）" },
            think: { content: "被丢弃分支的思考", summary: "未使用" },
          },
        ],
      }),
      msg({
        id: "m3",
        parentId: "m2",
        role: "user",
        children: ["m4"],
        t: ts(5),
        blocks: [
          { id: "b5", messageId: "m3", text: { content: "这份示例材料合理吗" } },
          {
            id: "b6",
            messageId: "m3",
            file: {
              id: "file-1",
              meta: {
                name: "示例照片.jpg",
                contentType: "image/jpeg",
                sizeBytes: "204800",
                type: "FILE_TYPE_IMAGE",
              },
              blob: { signUrl: "https://cdn.example.com/img/photo-1.jpg?sig=abc" },
            },
          },
        ],
      }),
      msg({
        id: "m4",
        parentId: "m3",
        role: "assistant",
        children: [],
        t: ts(6),
        vote: "VOTE_UP",
        blocks: [
          // lazy tool block: no contents, contentCount>0 -> needs GetToolBlock
          {
            id: "b7",
            messageId: "m4",
            tool: {
              toolCallId: "call-1",
              name: "搜索网页",
              args: '{"query":"示例查询"}',
              contentCount: "2",
              loadType: "LOAD_TYPE_EXTERNAL",
            },
          },
          { id: "b8", messageId: "m4", text: { content: "示例回答结论。" } },
        ],
        refs: {
          images: [
            {
              id: "img-1",
              caption: "示例图注",
              url: "https://cdn.example.com/img/table.png",
              fullSizeUrl: "https://cdn.example.com/img/table-full.png",
              width: "800",
              height: "600",
              state: "STATE_SUCCESS",
              source: "SOURCE_SEARCH",
            },
          ],
          sandboxFiles: [
            {
              uri: "sandbox:/out/report.pdf",
              downloadUrl: "https://sandbox.example.com/dl/report.pdf",
              fileName: "分析报告.pdf",
              sizeBytes: "51200",
            },
          ],
          searchChunks: [{ id: "sc-1", refIndex: "1", chunk: "示例引用片段" }], // no base -> needs GetSearchCitation
        },
        references: [
          {
            matchedText: "结论",
            type: "TYPE_CITE",
            items: [
              {
                search: {
                  base: {
                    title: "示例出处标题",
                    url: "https://example.com/wst",
                    snippet: "示例出处摘要",
                  },
                  refIndex: "1",
                },
              },
            ],
          },
        ],
      }),
    ],
    nextPageToken: "",
  },
};

// c2: artifact + aippt + slides + stages + unknown block + missing file url
export const MESSAGES_C2 = {
  page1: {
    messages: [
      msg({
        id: "n1",
        role: "user",
        children: ["n2"],
        blocks: [{ id: "nb1", text: { content: "给我一个示例脚本" } }],
      }),
      msg({
        id: "n2",
        parentId: "n1",
        role: "assistant",
        children: [],
        blocks: [
          {
            id: "nb2",
            artifact: {
              artifactId: "art-1",
              type: "ARTIFACT_TYPE_CODE",
              title: "demo.sh",
              path: "scripts/demo.sh",
              content: '#!/bin/sh\nset -e\necho "示例输出"\n',
              version: "3",
            },
          },
          {
            id: "nb3",
            aippt: {
              title: "演示文稿",
              status: "SUCCESS",
              pptDownloadUrl: "https://cdn.example.com/ppt/a.pptx",
              pdfDownloadUrl: "https://cdn.example.com/ppt/a.pdf",
              pptSizeByte: "4096",
              pdfSizeByte: "2048",
            },
          },
          {
            id: "nb4",
            slidesView: {
              name: "演示 PPT",
              slidesId: "sl-1",
              payloadUrl: "https://cdn.example.com/slides/p.json",
              coverUrl: "https://cdn.example.com/slides/cover.webp",
              status: "STATUS_COMPLETED",
            },
          },
          {
            id: "nb5",
            multiStage: {
              stages: [
                {
                  name: "STAGE_NAME_RESEARCH",
                  description: "检索资料",
                  durationSeconds: "12",
                  index: "0",
                },
                {
                  name: "STAGE_NAME_FINAL_REPORT",
                  description: "汇总",
                  durationSeconds: "5",
                  index: "1",
                },
              ],
            },
          },
          {
            id: "nb6",
            file: {
              id: "file-2",
              meta: { name: "示例附件.pdf", contentType: "application/pdf", sizeBytes: "999" },
            },
          }, // no blob -> GetFile
          { id: "nb7", someBrandNewBlock: { hello: "world" } }, // unknown
          {
            id: "nb8",
            memory: {
              created: ["用户偏好示例项目"],
              currentMemoryCount: "1",
              maxMemoryCount: "100",
            },
          },
          { id: "nb9", text: { content: "脚本和文稿都在上面。" } },
        ],
      }),
    ],
    nextPageToken: "p2c2",
  },
  page2: {
    messages: [
      msg({
        id: "n3",
        parentId: "n2",
        role: "assistant",
        children: [],
        blocks: [{ id: "nb10", text: { content: "补充：示例追加说明" } }],
      }),
    ],
    nextPageToken: "",
  },
};

export const MESSAGES_C3 = { page1: { messages: [], nextPageToken: "" } };

export const MESSAGES_C4 = {
  page1: {
    messages: [
      msg({
        id: "d1",
        role: "user",
        children: ["d2"],
        blocks: [{ id: "db1", text: { content: "帮我研究 X" } }],
      }),
      msg({
        id: "d2",
        parentId: "d1",
        role: "assistant",
        children: [],
        blocks: [
          {
            id: "db2",
            explorerResearch: {
              status: "STATUS_DONE",
              steps: [
                {
                  title: "第一步",
                  keywords: ["X 定义"],
                  webPages: [{ title: "关于 X", url: "https://example.com/x" }],
                },
              ],
            },
          },
          {
            id: "db3",
            error: {
              reason: "REASON_TOKEN_LENGTH_TOO_LONG",
              localizedMessage: { message: "上下文过长" },
              severity: "SEVERITY_INFO",
            },
          },
          { id: "db4", text: { content: "研究完成。" } },
        ],
      }),
    ],
    nextPageToken: "",
  },
};

export const TOOL_BLOCKS = {
  "call-1": {
    block: {
      tool: {
        toolCallId: "call-1",
        name: "搜索网页",
        contents: [
          { text: "已找到 45 个结果" },
          {
            searchResult: {
              base: { title: "示例检索结果", url: "https://example.com/search-result" },
            },
          },
        ],
      },
    },
  },
};

export const FILES = {
  "file-2": {
    file: {
      id: "file-2",
      meta: { name: "示例附件.pdf", contentType: "application/pdf", sizeBytes: "999" },
      blob: { signUrl: "https://cdn.example.com/attach/doc-2.pdf" },
    },
  },
  "file-10": {
    file: {
      id: "file-10",
      meta: { name: "附件长文.pdf", contentType: "application/pdf", sizeBytes: "800" },
      blob: { signUrl: "https://cdn.example.com/chatdata/long.pdf" },
    },
  },
};

export const CITATIONS = {
  "sc-1": {
    base: { title: "示例引用详情", url: "https://example.com/wst", snippet: "示例引用段落" },
  },
};

export const MEDIA = {
  "https://cdn.example.com/img/photo-1.jpg?sig=abc": { type: "image/jpeg", bytes: 2048 },
  "https://cdn.example.com/img/table-full.png": { type: "image/png", bytes: 1500 },
  "https://sandbox.example.com/dl/report.pdf": { type: "application/pdf", bytes: 900 },
  "https://cdn.example.com/ppt/a.pptx": {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: 700,
  },
  "https://cdn.example.com/ppt/a.pdf": { type: "application/pdf", bytes: 400 },
  "https://cdn.example.com/slides/p.json": { type: "application/json", bytes: 64 },
  "https://cdn.example.com/slides/cover.webp": { type: "image/webp", bytes: 120 },
  "https://cdn.example.com/attach/doc-2.pdf": { type: "application/pdf", bytes: 999 },
  "https://cdn.example.com/chatdata/dataset.csv": { type: "text/csv", bytes: 320 },
  "https://cdn.example.com/chatdata/long.pdf": { type: "application/pdf", bytes: 800 },
};
