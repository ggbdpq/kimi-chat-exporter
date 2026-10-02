import { test } from "node:test";
import assert from "node:assert/strict";
import { newJob } from "../lib/job-db.js";
import { optionsWithDefaults } from "../lib/pipeline.js";

const CHAT_ID = "9f0e5f4c-1a2b-4c3d-8e9f-0123456789ab";
const make = (chatIds, chats) => newJob({ chatIds, chats, options: optionsWithDefaults() });

test("a target without a cached entry never borrows its id as the name", () => {
  // The current-chat export used to reach the task page with name === id, so
  // the ledger showed a raw uuid instead of a conversation title.
  const job = make([CHAT_ID], []);
  assert.equal(job.targets.length, 1);
  assert.equal(job.targets[0].id, CHAT_ID);
  assert.equal(job.targets[0].name, "");
});

test("a target keeps the cached entry, raw ListChats payload included", () => {
  const chat = {
    id: CHAT_ID,
    name: "对话标题",
    createTime: "2026-09-01T00:00:00.000Z",
    files: [],
    raw: { id: CHAT_ID, name: "对话标题" },
  };
  const job = make([CHAT_ID], [chat]);
  assert.equal(job.targets[0], chat);
});

test("repeated ids collapse into a single target", () => {
  const job = make([CHAT_ID, CHAT_ID], []);
  assert.equal(job.targets.length, 1);
});
