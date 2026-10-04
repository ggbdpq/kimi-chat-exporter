<div align="center">

<img src="icons/icon-128.png" alt="Kimi Chat Exporter" width="96" height="96" />

# Kimi Chat Exporter

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)
![Chrome 127+](https://img.shields.io/badge/Chrome-127%2B-4285F4)
![No build step](https://img.shields.io/badge/build-none-2ea44f)
![node:test](https://img.shields.io/badge/tests-node--test-2ea44f)

English · [中文](README.zh-CN.md)

</div>

An unofficial Chrome extension that exports your entire Kimi Web (kimi.com) chat history into one self-contained, offline ZIP — Markdown, raw JSON, images, attachments and slides — with nothing ever leaving your machine; not affiliated with or endorsed by Kimi or Moonshot AI.

![The extension popup, with the current chat and the export options](screenshot.png)

## Features

- **One archive**: Markdown transcripts, the raw JSON, and all media (images, attachments and slides).
- **Nothing lost**: thinking, tool calls, search results, citations and regenerated branches are all kept.
- **Interruptible**: close the tab, restart the browser or crash, then continue — finished work is never downloaded twice.
- **Resilient**: a single failing item is logged instead of aborting the export, and oversized exports split into volumes.
- **Simple**: export the current chat, any selection, or everything in one click — no build step, no dependencies.

## Install

> Nothing to compile or bundle — the repository *is* the extension. Clone it, or download the ZIP from the [latest release](https://github.com/micooz/kimi-chat-exporter/releases/latest).

1. Get the files, whichever way you prefer:
   - **Clone** the repository: `git clone https://github.com/micooz/kimi-chat-exporter`
   - **Download** `kimi-chat-exporter-v<version>.zip` from the [latest release](https://github.com/micooz/kimi-chat-exporter/releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository root (clone) or the unzipped folder.
4. Open and sign in to [kimi.com](https://www.kimi.com/).
5. Click the extension icon in the toolbar to start.

## Usage

> Chrome 127 or newer is required.

1. **Sign in first.** The extension borrows your in-memory session; it never writes it back or to disk.
2. **Choose the scope.** The popup shows the current chat by default; *Select other chats* lists everything with search, select-all and per-chat checkboxes.
3. **Choose the options.** Thinking, tool calls, citations, media download, branch scope and packaging.
4. **Keep the task page open.** The export runs there and shows live progress. Closing it just pauses: the progress is saved, and reopening offers to continue.
5. **Download.** When the job finishes, click download and the ZIP goes to Chrome's downloads.

## Archive layout

```
kimi-export-2026-10-01/
├── markdown/
│   └── 2026-09-30-chat-title_<chat-id>.md
├── raw/
│   └── <chat-id>.json                  # original responses, kept as-is
├── assets/
│   └── <chat-id>/
│       └── <hash16>-<file-name>
├── report.md                           # counts, options and error summary
└── error.log                           # one line per failure (empty when clean)
```

## How it works

An export runs in three layers: the extension's service worker handles short requests (reading your session, listing chats), the task page owns the export and shows live progress, and a Web Worker does the heavy lifting — paging through messages, downloading media and assembling the ZIP. Only one export runs at a time, and progress is checkpointed continuously, so closing the tab or restarting the browser never loses finished work.

For large accounts, the popup keeps a local cache of your chat list so it opens instantly, refreshes it incrementally, and does a periodic full refresh so deleted chats disappear. The cache never contains your session token.

## Permissions & privacy

> The session token only ever lives in memory: it is not persisted, not logged, and never sent to the developer or any third party. Everything runs locally, and the archive depends on neither the network nor the extension.

| Permission | Purpose |
| --- | --- |
| `storage` | Save export options and job progress. |
| `downloads` | Save the generated ZIP. |
| `scripting` | Read your kimi.com session when the page helper is not available. |
| `contextMenus` | Add the right-click export entry on kimi.com. |
| `https://www.kimi.com/*`, `https://*.kimi.com/*` | Request your own chat data with your own session. |
| `<all_urls>` (optional) | Download media from CDNs; if declined, the export continues and keeps original links. |

## Development

```sh
npm test                                                  # all tests (node --test "test/*.test.mjs")
node --test test/full-export.test.mjs                     # a single file
node --test --test-name-pattern "branch" test/*.test.mjs  # filter by test name
npm run pack                                              # build dist/kimi-chat-exporter-v<version>.zip
```

## License

MIT
