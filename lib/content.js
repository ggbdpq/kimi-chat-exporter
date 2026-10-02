// Content script: lets the background read the session without paying the cost
// of chrome.scripting on every token refresh.
// The token is only ever returned in-memory to this extension; nothing is stored.

const HANDLERS = {
  "kimi:readTokens": () => ({
    ok: true,
    accessToken: localStorage.getItem("access_token") || "",
    refreshToken: localStorage.getItem("refresh_token") || "",
  }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && msg.type ? HANDLERS[msg.type] : null;
  if (!handler) return false;
  try {
    sendResponse(handler());
  } catch (err) {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  }
  return false;
});
