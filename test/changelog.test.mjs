// Release notes: CHANGELOG.md section extraction, the commit-derived fallback
// used when a tag has no section, and the CLI that wires them to a file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANGELOG_PATH,
  buildNotes,
  extractSection,
  renderFromCommits,
} from "../scripts/changelog.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/changelog.mjs", import.meta.url));

const CHANGELOG = `# Changelog

## Unreleased

### English

**Fixed**
- Unreleased fix

### 中文

**修复**
- 未发布修复

## 1.1.0 - 2026-10-04

### English

**Added**
- Parked export resumes

### 中文

**新增**
- 暂存导出会继续

## 1.0.0 - 2026-10-02

### English

**Added**
- First release

### 中文

**新增**
- 首个版本
`;

test("extractSection returns the requested version verbatim", () => {
  const body = extractSection(CHANGELOG, "1.1.0");
  assert.ok(body.startsWith("### English"));
  assert.ok(body.includes("- 暂存导出会继续"));
  assert.ok(body.endsWith("**新增**\n- 暂存导出会继续"));
});

test("extractSection stops at the next version heading", () => {
  const body = extractSection(CHANGELOG, "1.1.0");
  assert.ok(!body.includes("First release"), body);
  assert.ok(!body.includes("## 1.0.0"), body);
});

test("extractSection never publishes Unreleased by accident", () => {
  assert.equal(extractSection(CHANGELOG, "1.2.0"), null);
  assert.ok(extractSection(CHANGELOG, "Unreleased").includes("未发布修复"));
});

test("extractSection returns null for an empty or missing section", () => {
  assert.equal(extractSection(CHANGELOG, "9.9.9"), null);
  assert.equal(extractSection("## 2.0.0 - 2026-10-05\n\n## 1.0.0 - 2026-10-02\n", "2.0.0"), null);
});

test("extractSection tolerates CRLF and a padded version heading", () => {
  const messy = CHANGELOG.replace(/\n/g, "\r\n").replace(
    "## 1.0.0 - 2026-10-02",
    "## 1.0.0 - 2026-10-02   ",
  );
  assert.equal(extractSection(messy, "1.0.0"), extractSection(CHANGELOG, "1.0.0"));
});

test("renderFromCommits groups conventional subjects and drops internal ones", () => {
  const notes = renderFromCommits([
    { hash: "aaa1111", subject: "feat(permissions): start parked export" },
    { hash: "bbb2222", subject: "fix: skip non-downloadable urls" },
    { hash: "ccc3333", subject: "refactor: split the packer" },
    { hash: "ddd4444", subject: "ci(release): pin ubuntu-24.04" },
    { hash: "eee5555", subject: "docs(readme): add a screenshot" },
    { hash: "fff6666", subject: "chore: tidy" },
    { hash: "ggg7777", subject: "Merge branch 'main'" },
  ]);
  assert.deepEqual(notes.split("\n"), [
    "**Added**",
    "- **permissions:** start parked export (`aaa1111`)",
    "",
    "**Fixed**",
    "- skip non-downloadable urls (`bbb2222`)",
    "",
    "**Changed**",
    "- split the packer (`ccc3333`)",
  ]);
});

test("renderFromCommits flags breaking changes and stays empty without matches", () => {
  assert.ok(
    renderFromCommits([{ hash: "aaa1111", subject: "feat!: drop the old api" }]).includes(
      "- **breaking** drop the old api (`aaa1111`)",
    ),
  );
  assert.equal(renderFromCommits([{ hash: "ddd4444", subject: "ci: pin node" }]), "");
});

test("buildNotes prefers the changelog section and appends the compare link", () => {
  const notes = buildNotes({
    changelog: CHANGELOG,
    version: "1.1.0",
    commits: [{ hash: "aaa1111", subject: "feat: ignored" }],
    prev: "v1.0.0",
    tag: "v1.1.0",
  });
  assert.ok(notes.startsWith("### English"));
  assert.ok(!notes.includes("ignored"));
  assert.ok(
    notes.includes(
      "**Full Changelog**: https://github.com/micooz/kimi-chat-exporter/compare/v1.0.0...v1.1.0",
    ),
  );
});

test("buildNotes falls back to English-only commit notes", () => {
  const notes = buildNotes({
    changelog: CHANGELOG,
    version: "1.2.0",
    commits: [{ hash: "aaa1111", subject: "fix: repair the resume path" }],
    prev: "v1.1.0",
    tag: "v1.2.0",
  });
  assert.ok(notes.includes("- repair the resume path (`aaa1111`)"));
  assert.ok(notes.includes("中文说明待补"));
  assert.ok(!notes.includes("### 中文"));
});

test("buildNotes omits the compare link for the first release", () => {
  const notes = buildNotes({
    changelog: null,
    version: "1.0.0",
    commits: [{ hash: "aaa1111", subject: "feat: first" }],
    prev: null,
    tag: "v1.0.0",
  });
  assert.ok(!notes.includes("Full Changelog"));
  assert.ok(notes.endsWith("\n"));
});

test("the shipped CHANGELOG.md keeps both languages in every released section", async () => {
  const markdown = await readFile(CHANGELOG_PATH, "utf8");
  const released = markdown.match(/^## \S+ - \d{4}-\d{2}-\d{2}$/gm) ?? [];
  assert.ok(released.length > 0, "no released section in CHANGELOG.md");
  for (const heading of released) {
    const version = heading.match(/^## (\S+)/)[1];
    const body = extractSection(markdown, version);
    assert.ok(body.includes("### English"), `${version} has no English part`);
    assert.ok(body.includes("### 中文"), `${version} has no 中文 part`);
  }
});

test("cli writes the extracted section to --out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "changelog-"));
  const changelogPath = join(dir, "CHANGELOG.md");
  const out = join(dir, "nested", "release-notes.md");
  await writeFile(changelogPath, CHANGELOG);

  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--tag", "v1.0.0", "--out", out, "--changelog", changelogPath],
    { encoding: "utf8" },
  );
  assert.match(stdout, /^wrote .*release-notes\.md \(\d+ bytes\)\n$/);
  // v1.0.0 is the first tag, so there is no previous tag to compare against.
  assert.equal(await readFile(out, "utf8"), extractSection(CHANGELOG, "1.0.0") + "\n");
});

test("cli prints and warns when the tag has no section", async () => {
  const dir = await mkdtemp(join(tmpdir(), "changelog-"));
  const changelogPath = join(dir, "CHANGELOG.md");
  await writeFile(changelogPath, "# Changelog\n");

  // v1.1.0 does not exist yet in this checkout, so the script falls back to
  // HEAD and still finds the previous tag (v1.0.0) for the compare link.
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--tag", "v1.1.0", "--changelog", changelogPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /::warning::CHANGELOG\.md has no section for 1\.1\.0/);
  assert.ok(result.stdout.includes("中文说明待补"), result.stdout);
  assert.ok(result.stdout.includes("d70c438"), result.stdout);
  assert.ok(result.stdout.includes("..v1.1.0"), result.stdout);
  assert.ok(!result.stdout.includes("### 中文"));
});

test("cli rejects a missing tag", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--tag v<version> is required/);
});
