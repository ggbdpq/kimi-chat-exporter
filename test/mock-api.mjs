import {
  LIST_CHATS_PAGES,
  MESSAGES_C1,
  MESSAGES_C2,
  MESSAGES_C3,
  MESSAGES_C4,
  TOOL_BLOCKS,
  FILES,
  CITATIONS,
  MEDIA,
} from "./make-fixtures.mjs";

// Mock satisfying the surface the pipeline needs: api.rpc(method, body).
export function makeApi(failChat) {
  const calls = [];
  const api = {
    calls,
    async rpc(method, body) {
      calls.push({ method, body });
      if (method.endsWith("ListChats")) {
        return body.pageToken ? LIST_CHATS_PAGES[1] : LIST_CHATS_PAGES[0];
      }
      if (method.endsWith("ListMessages")) {
        const id = body.chatId;
        if (failChat && id === failChat) throw new Error("mock chat failure");
        const set = { c1: MESSAGES_C1, c2: MESSAGES_C2, c3: MESSAGES_C3, c4: MESSAGES_C4 }[id];
        if (!set) return { messages: [], nextPageToken: "" };
        return body.pageToken ? set.page2 || { messages: [], nextPageToken: "" } : set.page1;
      }
      if (method.endsWith("GetToolBlock")) return TOOL_BLOCKS[body.toolCallId] || {};
      if (method.endsWith("GetFile")) return FILES[body.fileId] || {};
      if (method.endsWith("GetSearchCitation")) return CITATIONS["sc-1"] || {};
      throw new Error("unexpected rpc " + method);
    },
  };
  return api;
}

/** Media fetcher stub. Returns real `Response` objects so the engine's streaming
 * media path (`response.body.getReader()`) is exercised, not just `blob()`. */
export function makeFetch() {
  const requested = [];
  return {
    requested,
    fetchBinary: async (url) => {
      requested.push(url);
      const media = MEDIA[url];
      if (!media) return new Response("", { status: 403 });
      const bytes = new Uint8Array(media.bytes).fill(0x41);
      return new Response(bytes, {
        headers: { "Content-Type": media.type, "Content-Length": String(bytes.byteLength) },
      });
    },
  };
}
