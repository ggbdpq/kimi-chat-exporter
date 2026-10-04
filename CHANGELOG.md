# Changelog

## Unreleased

### English

**Added**
- An export parked for the optional media-host permission now continues as soon as the grant arrives, even when Chrome closed the popup mid-dialog (`bd40333`).

**Fixed**
- Assets whose URL is not an absolute `http(s)` URL (tool `sandbox:///` paths, host-less CDN values) stay plain text in the transcript instead of entering the download queue and `error.log` (`d70c438`).
- Unfetchable URLs are rejected in `downloadMedia` before host access is requested, so no bogus origin-pattern errors are reported (`d70c438`).
- The transfer rate freezes once packing starts, and the archive-size cell is hidden outside the packing/ready phases (`d70c438`).
- Pausing a job no longer records the abort reason as the job error, and a settled job drops any stale failure line (`9d6a8fb`).

### 中文

**新增**
- 因可选媒体域权限而被暂存的导出，在授权到达后立即继续，即使 Chrome 在授权弹窗中途关闭了 popup（`bd40333`）。

**修复**
- URL 不是绝对 `http(s)` 的素材（工具 `sandbox:///` 路径、丢失主机名的 CDN 值）在正文里保持纯文本，不再进入下载队列和 `error.log`（`d70c438`）。
- 无法下载的 URL 在申请域名权限之前就被拒绝，不再报出无意义的 origin pattern 错误（`d70c438`）。
- 打包开始后冻结传输速率，并在非 packing/ready 阶段隐藏归档体积一栏（`d70c438`）。
- 暂停任务不再把 abort 原因记为任务错误，任务结束后也会清掉残留的失败提示（`9d6a8fb`）。

## 1.0.0 - 2026-10-02

### English

**Added**
- First public release: export an entire Kimi Web chat history into a self-contained offline ZIP — Markdown transcripts, lossless raw API JSON, and all images, attachments and AI slides.
- The export runs in a task page backed by a Web Worker with checkpoints and resume, so a closed popup or a crash does not lose progress.
- Ships a 中 / EN interface and writes the exported reports in the language the job was started with.

### 中文

**新增**
- 首个公开版本：把整个 Kimi Web 聊天记录导出为一个自包含的离线 ZIP —— Markdown 正文、无损原始 API JSON，以及全部图片、附件和 AI 幻灯片。
- 导出在任务页由 Web Worker 执行，带检查点与断点续传，关闭 popup 或崩溃都不会丢失进度。
- 界面支持中 / EN 切换，导出的报告使用任务启动时所选的语言。
