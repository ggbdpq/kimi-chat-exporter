# AGENTS.md

Guidance for coding agents working in this repository. It reflects the current code; keep it in sync when behavior changes. The human-facing docs are `README.md` (English) and `README.zh-CN.md` (Chinese), and `README.md` also carries the deep module/architecture reference; this file is deliberately agent-focused, a quick reference, and English-only.

## Project Overview

Kimi Chat Exporter is a Chrome Manifest V3 extension that exports a user's entire Kimi Web (`www.kimi.com`) chat history into a self-contained, offline ZIP: Markdown transcripts + raw API JSON + images, attachments and AI PPT.

- **No build step**: the repository *is* the extension. `manifest.json` points at `lib/background.js` and `lib/content.js`; `popup.html` / `tasks.html` load `popup.js` / `tasks.js`. Chrome runs the native ES modules directly. Do not add a bundler or transpiler.
- **Zero dependencies**: `package.json` has only `test` and `pack` scripts — no `dependencies` / `devDependencies`. Tests use Node built-ins only (`node:test`, `node:zlib`).
- **Manifest**: MV3, `minimum_chrome_version` `127`; service worker is `lib/background.js` (`"type": "module"`); the content script is injected only into `https://www.kimi.com/*`. There is no `_locales` directory — the manifest strings are English literals and Chrome's native i18n is unused.
- **Permissions**: `storage`, `downloads`, `scripting`, `contextMenus`; host permissions `https://www.kimi.com/*` and `https://*.kimi.com/*`; optional host permission `<all_urls>` (used to download media only after the user grants it).
- **Languages**: the UI and the exported reports ship in English and Simplified Chinese; user-facing copy lives in `lib/locales/*` and is resolved through `lib/i18n.js` (see Key Conventions).

## Architecture

One export spans three processes: **service worker (short tasks) → task page (owns the work) → Web Worker (does the work)**.

- `lib/background.js`: MV3 service worker. Short requests only — read the session, list chats, create jobs, open the task page, register the context menu, and start an export parked by the popup once its media permission is granted. **It never exports.**
- `lib/content.js`: content script on `www.kimi.com`. Reads `access_token` / `refresh_token` from `localStorage` on demand and returns them in memory only; never persisted.
- `popup.js`: popup UI. Reads options, lists chats, lets the user pick a scope, creates a job via the `startJob` message, and opens the task page. When media permission is still missing it parks the intent (`parkExport`) before asking, so the grant can finish the hand-off. Shows a read-only status bar from `job-db.js`.
- `tasks.js`: the task page and **owner of the export**. Takes `EXECUTOR_LOCK`, spawns `new Worker("lib/job-worker.js", { type: "module" })`, drives `JobEngine`, and downloads artifacts via `chrome.downloads`.
- `lib/job-worker.js`: runs inside the Worker. Opens IndexedDB, builds `KimiApi` and `JobEngine`, and bridges "read a token" / "check host permission" requests back to the task page over a `postMessage` `bridge` protocol.

The export runs through the phases `validating → listing → fetching → enriching → downloading → packing → ready`.

### Core modules (`lib/`)

Grouped by concern — open each file header for its exact surface.

- **Kimi data**: `api.js` (the `/apiv2` client and the `SERVICES` RPC table), `model.js` (`normalizeChat`: message DAG → linear render order + assets/stats), `render.js` (Markdown, filenames, formatting), `enums.js` (proto enum decoding), `pipeline.js` (enrich → collect assets → write `markdown/` + `raw/`).
- **Control flow**: `control.js` (`checkAbort` / `sleep` / `Semaphore` / `pool` / `fatal()` / `retryAfter` / `timeoutSignal`), `chat-cache.js` (chat-list cache + incremental sync).
- **Export**: `job-engine.js` (orchestrator: phases, checkpoints, resume, retry, volumes), `job-db.js` (IndexedDB job/item records), `checkpoints.js` (immutable physical paths; a file is published only after write + size check), `opfs.js` (workspace + free-space reserve), `media.js` (hashing + download scheduler), `zip.js` / `pack.js` (classic streaming ZIP + volume planning).
- **i18n**: `i18n.js` (pure language layer: `t()` / `tn()`), `i18n-dom.js` (DOM binding: `applyStaticI18n` / `initPageI18n` / `bindLocaleSwitch`).

### Export data flow

1. The popup creates a job (`job-db.newJob`, with options and target chats) and opens `tasks.html#jobId=...&start=1`; if the media permission is still missing it parks the same intent in the worker first, so the export starts on the grant even when Chrome closed the popup.
2. The task page takes the lock, starts the Worker and runs `JobEngine.run()`.
3. Per chat: page through messages (→ `.pages/`) → lazily enrich (→ `.rpc/`) → normalize into render structures → download media concurrently (→ `assets/`) → write `markdown/` and `raw/`.
4. Build the reports (`report.md`, `error.log`) → pack into a single ZIP, multiple volumes, or one ZIP per chat.
5. The task page hands the artifacts to `chrome.downloads`.

### Archive layout

The export root is always `kimi-export-<YYYY-MM-DD>/`, containing:

- `markdown/<creation-date>-<title>_<chat-id>.md` — the full chat id is always appended, so same-day, same-title chats never collide.
- `raw/<chat-id>.json` (`schema: "kimi-raw/1"`, the untouched API responses).
- `assets/<chat-id>/<hash16>-<file-name>`.
- `report.md` (summary, options, failure counts) and `error.log` (`<timestamp> <level> <category> k=v` lines; empty when nothing failed).

`options.package` selects a single ZIP, multiple volumes (each a complete set of whole chats that unpacks on its own) or one ZIP per chat.

## Setup Commands

```sh
npm install        # not required (zero dependencies); listed only to be explicit
npm test           # run the whole suite: node --test "test/*.test.mjs"
npm run pack       # build dist/kimi-chat-exporter-v<version>.zip
```

There is no dev server: load the repository root as an unpacked extension in `chrome://extensions`.

## Development Workflow

- Edit files in place; Chrome loads the unpacked directory, so a Reload on the extensions page picks up changes.
- Runtime code lives in `lib/` plus `popup.*` and `tasks.*`; shared logic must stay free of `chrome.*` so it can run under Node.
- There is no lint / typecheck / formatter configured. Do not add one or add dependencies for it.

## Testing Instructions

Tests are pure `node:test`: **no network, no browser, no Python**.

```sh
npm test                                                  # whole suite
node --test test/full-export.test.mjs                     # one file
node --test --test-name-pattern "branch" test/*.test.mjs  # filter by test name
```

- Name test files `test/<domain>.test.mjs`; add new cases to the existing domain file or a new one following that pattern.
- `runFullExport()` in `test/harness.mjs` drives the **real `JobEngine`**, injecting `memoryStore` (`test/store-memory.js`) + `memoryDb` (`test/helpers-jobs.mjs`) + `makeApi` / `makeFetch` (`test/mock-api.mjs`). Behavior changes must go through this real-engine path — do not write a parallel implementation just for tests.
- Assert archive contents with `test/tools/zip_check.mjs` (pure Node); `inspectZip(buf, ...entries)` is the usual entry point.
- Fixtures in `test/make-fixtures.mjs` are **synthetic placeholders only** — never commit real conversation content. Hard-coded expectations (asset counts, request counts) must be updated when the pipeline changes.
- `test/browser/*.mjs` are manual tests that need a real Chrome (CDP, default port 9338, override with `CDP_PORT`, loading this repository as an unpacked extension). They are **not** part of `npm test`; output goes to `test/out/` (gitignored).

## Code Style

- The whole repository is native ES modules; `lib/` and the root are `.js`. Do not introduce CommonJS or build artifacts.
- Formatting: 2-space indent, double quotes, trailing semicolons, trailing commas in multiline literals, ~100 columns. There is no formatter config — **match the surrounding file**.
- Comments in English; every user-facing string (UI copy, error messages, report/log text) lives in `lib/locales/en-US.js` + `lib/locales/zh-CN.js` and is fetched with `t()` / `tn()` — never inline it. The two catalogs must keep identical key sets and placeholders (`test/i18n.test.mjs` enforces it, and also fails on a key that no code uses).
- UI color tokens are paired in the `@layer tokens` block of `popup.css` and `tasks.css` using `light-dark()`: change one color, update the counterpart, and check its contrast against the surface it sits on (body text ≥ 4.5:1, graphics ≥ 3:1).
- Keep modules **dependency-injected**: `pipeline.js` / `job-engine.js` / `media.js` receive a store, `api`, `signal`, etc., and never touch `chrome.*` or global storage directly, so they stay testable in Node.
- New RPCs must reuse the `SERVICES` table and `KimiApi.rpc` in `lib/api.js`; do not spin up a separate fetch path.
- Conventional commits, matching the existing history, e.g. `feat(ui):`, `fix(export):`, `refactor(extension):`.

## Build and Deployment

- `npm run pack` (`scripts/pack.sh`) builds the store upload ZIP from runtime files only: `manifest.json`, `popup.*`, `tasks.*`, `lib/`, `icons/`, and prints the archive listing. The version comes from `manifest.json`.
- Before releasing, bump the version in both `manifest.json` and `package.json`, and confirm all four icon sizes are present (`icons/icon-{16,32,48,128}.png`).
- There is no CI configuration (no `.github/`). At minimum run `npm test` before committing; changes touching the Worker / OPFS / IndexedDB should also run the `test/browser/` manual tests.

## Security Considerations

- **Credentials never touch disk**: the login token only lives in memory. `job-db.js` states at the top that no credentials may appear in the database. Do not persist, log or transmit tokens.
- **The chat list may be cached, credentials may not**: `chatListCache` holds only `ListChats` entries (including `raw`, needed for the target export's `raw/<chat-id>.json`) plus a SHA-256 fingerprint of the token's `sub`. Never write a token into it. An account switch must rebuild the whole table.
- **Permission boundary**: `chrome.permissions.request` only works in the popup (user gesture), not in the service worker; the Worker can only call `chrome.permissions.contains`. Chrome can close the popup while that dialog is up, so the popup parks the export intent in `chrome.storage.session` and the worker starts it from `chrome.permissions.onAdded` (`startExport` is idempotent per pending id, so only one job is created). The task page's own grant button continues the shown job instead. When the user declines, the export continues, media keeps its original link, and a WARN line is written to `error.log`.

## Key Conventions and Gotchas

- **Fatal vs best-effort**: the `fatal()` list in `control.js` (`AbortError` / `AuthError` / `StorageError` / `QuotaExceededError` / `SkipError`) aborts the whole job; every other error is recorded in `error.log` (and counted in `report.md`) and the run continues.
- **Raw output must be lossless**: any parsing change must still let unknown block types land verbatim in `raw/<chat-id>.json`. Kimi's content-free header system stub is skipped in Markdown only (`model.js` `isBlankSystemMessage`); it stays in raw, and stats count rendered messages.
- **Unfetchable media links are not download failures**: assets whose URL is not absolute `http(s)` (tool `sandbox:///` paths, CDN values that lost their host) are marked `nonDownload` in `model.js`, so they stay plain text in the transcript and never reach the download queue or the host-permission bridge — `error.log` only lists real download failures.
- **Markdown metadata lives in YAML frontmatter** (`chat_id`, `title`, `created_at`, `updated_at`, `project`, `model`, `agent`, `messages`, `exported_at`), with ISO-8601 UTC timestamps on messages too. Role headings are English (`👤 User`, `🤖 Kimi`); regenerated replies are labeled `Branch i/N` in API child order.
- **ZIP is the classic format (not ZIP64)**: entries must stay below 65535 and offsets below 4 GiB. `planVolumes` and `ZipWriter` are two lines of defense; do not bypass them when changing packaging.
- **Resumability is a hard requirement**: every intermediate file must go through the `checkpoints.js` "physical file + size check + database publish" path so a crash or closure can safely reuse or redo it.
- **Store material is local-only**: `CHROMEWEBSTORE.md` (root) and `.docs/` are gitignored scratch space — the store listing source of truth and the icon master/sequence diagrams live there, and neither is committed or packed. `PRIVACY.md` *is* committed and published to GitHub Pages by `.github/workflows/pages.yml` (site source in `.github/pages/`, served at `/privacy.html`), so keep it in sync with `manifest.json` whenever the name, version, permissions or user-facing data practices change.
- **`error.log` is empty when clean**: the writer returns `""` when nothing failed or was skipped, so a non-empty file is an unambiguous signal.
- **Language is snapshotted per job**: each chrome context resolves `locale` from `chrome.storage.local` (falling back to `chrome.i18n.getUILanguage()` / `navigator.language`, then `DEFAULT_LOCALE`); the 中/EN switch in the popup or task-page header is the only writer. `newJob({ locale })` stores it and `JobEngine.run()` calls `setLocale(job.locale)` before rendering, so a resumed or retried job keeps its original language.
- **What is deliberately not translated**: role headings, YAML frontmatter keys, `raw/<chat-id>.json`, the `error.log` level and category identifiers, and the `x-language` header the API client sends to Kimi.
- **Tests pin their language**: `test/locale.mjs` sets `zh-CN` for the suite files whose assertions quote Chinese copy; `test/i18n.test.mjs` owns catalog parity, key usage and plural handling.

## Pull Request Guidelines

- Title format: `[component] Brief description`, or keep the existing conventional-commit style in the subject (e.g. `fix(export): ...`).
- Required checks: `npm test` must be green; add or update tests for any behavior change.
- Note in the description which evidence level you verified (Node tests only, vs. real-browser manual tests vs. a real-account export); the real-account path is not yet end-to-end verified.
