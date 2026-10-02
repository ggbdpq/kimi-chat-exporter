# Privacy Policy / 隐私政策 — Kimi Chat Exporter

Last updated / 最后更新: 2026-10-02

## English

### Overview

Kimi Chat Exporter (the "extension") is a local-only export tool that saves your own Kimi Web (kimi.com) conversation history to a ZIP file on your computer. The extension does not collect, store, or upload any of your personal data to the developer or to any third party.

This extension is unofficial and is not affiliated with or endorsed by Moonshot AI or Kimi.

### What data is handled

To perform an export, the extension reads the following inside your browser. All of it is processed only on your own device:

- **Conversation content** — the chat list of your account, message text, thinking blocks, tool calls, search results, citations, and the links to images, attachments and slides in your conversations.
- **Authentication** — the access token of your current kimi.com session, used solely to request your own data as yourself.

The extension does not read content from any site unrelated to Kimi, and does not read your browsing history, bookmarks, passwords or download history.

### Where data is stored

- **The login token is kept in memory only.** It is never written to disk and never sent to the developer or any third party.
- **Work-in-progress data** — job progress, checkpoints and files being downloaded are held in your browser's local storage (extension storage, IndexedDB and the browser-private OPFS file system) so that an interrupted export can resume. This data is never uploaded.
- **Export results** — the final ZIP is saved to a location you choose when you click download, and is entirely yours.
- **Settings** — the language and export options you pick in the extension UI are kept in your browser's local storage. They are not used for tracking, profiling or advertising.

### Network requests

The extension only contacts the following, and only to fetch your own data or to hand your files to you:

- `www.kimi.com` and its subdomains — to list chats and read messages and media links. These requests carry your own session credentials.
- The Kimi CDN hosts that serve images, attachments and slides (their domains are not fixed).

No data is sent anywhere else. The extension contains no analytics, telemetry, tracking or advertising code.

### Optional permission

Downloading images, attachments and slides requires access to several Kimi CDN domains. Because these domains are not fixed and cannot be enumerated in advance, the extension requests the optional "access all sites" permission **separately**, at the moment you choose to include media. If you decline, the export still runs; media keeps its original link, which may expire.

### Third-party services

The extension uses no third-party analytics, advertising or data services, and never shares, sells or transfers your data to anyone.

### Data retention and deletion

The extension retains none of your data. Exported ZIP files are entirely in your possession. You can remove the extension from Chrome's extension manager; uninstalling clears its local storage, job database and temporary workspaces.

### Children

The extension is not directed at children and does not knowingly collect any data from them.

### Changes to this policy

If how the extension handles data changes, this page will be updated and the "Last updated" date above will change. Significant changes will also be noted in the extension's release notes.

### Contact

Questions about this policy: `micooz@hotmail.com`

## 中文

### 概述

Kimi Chat Exporter（下称“本扩展”）是一个在浏览器本地运行的导出工具，用于把用户本人 Kimi 网页版（kimi.com）的对话历史保存为本地 ZIP 文件。本扩展不收集、不存储、不上传用户的任何个人数据到开发者或任何第三方。

本扩展是非官方工具，与月之暗面（Moonshot AI）及 Kimi 官方没有任何隶属或合作关系。

### 我们处理哪些数据

为了完成导出，本扩展会在你的浏览器中读取以下内容。这些内容全部只在你自己的设备上处理：

- **对话内容**：你账号下的会话列表、消息正文、思考过程、工具调用、搜索结果、引用，以及对话中的图片、附件和 PPT 链接。
- **登录凭证**：你当前 kimi.com 登录会话的访问令牌，仅用于以你本人的身份向 Kimi 请求你自己的数据。

本扩展不读取与 Kimi 无关的网站内容，也不读取你的浏览历史、书签、密码或下载记录。

### 数据存在哪里

- **登录令牌只保存在内存中**，用完即弃，不会写入磁盘，也不会发送给开发者或任何第三方。
- **导出过程中间数据**：任务进度、检查点和已下载的文件临时保存在你浏览器的本地存储（扩展存储、IndexedDB 与浏览器私有文件系统 OPFS）中，用于支持中断后续传。它们不会被上传。
- **导出结果**：最终的 ZIP 文件由你点击下载后保存到你自己选择的位置，完全属于你本人。
- **设置**：你在扩展界面里选择的语言、导出选项会被保存在浏览器本地存储中，不用于追踪、画像或广告。

### 网络请求

本扩展只向以下地址发起请求，全部用于获取你自己的数据或把文件交给你：

- `www.kimi.com` 及其子域名：列出会话、读取消息与媒体链接。请求携带的是你自己的登录凭证。
- Kimi 用于托管图片、附件和 PPT 的 CDN 地址（域名不固定）。

除上述地址外，本扩展不会向任何服务器发送数据。本扩展不包含任何统计分析、遥测、追踪或广告代码。

### 可选权限

下载图片、附件和 PPT 需要访问 Kimi 的多个 CDN 域名。由于这些域名不固定、无法提前枚举，本扩展会在你勾选“下载图片附件”时**单独申请**“访问所有网站”权限。如果你拒绝授权，导出仍会正常进行，只是媒体文件会保留原始链接（该链接可能会过期）。

### 第三方服务

本扩展不使用任何第三方分析、广告或数据服务，也不会把数据分享、出售或转让给任何第三方。

### 数据保留与删除

本扩展不保留你的任何数据。导出的 ZIP 完全由你自行保管。你可以在 Chrome 的扩展管理页面移除本扩展，卸载后浏览器会一并清除本扩展的本地存储、任务数据库和临时工作区。

### 儿童

本扩展不面向儿童，也不会有意收集儿童的任何数据。

### 政策变更

如果本扩展的数据处理方式发生变化，我们会更新本页面并修改顶部的“最后更新”日期。重大变更会同时体现在扩展的版本更新说明中。

### 联系方式

如对本政策有疑问，请联系：`micooz@hotmail.com`
