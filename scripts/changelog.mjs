// Builds the GitHub Release body for a tag from CHANGELOG.md.
//
// The tag's section is the source of truth; a tag without a matching section
// (a forgotten changelog entry) falls back to notes derived from the
// conventional-commit subjects between the previous tag and this one. The
// fallback is English-only on purpose: the Chinese part is written by hand.
//
//   node scripts/changelog.mjs --tag v1.1.0 [--out dist/release-notes.md]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "https://github.com/micooz/kimi-chat-exporter";

// `## 1.0.0 - 2026-10-02` and `## Unreleased` both match; only the version
// asked for is used, so Unreleased can never be published by accident.
const HEADING = /^##\s+(\S+)(?:\s+-\s+(.+))?$/;

// Commit types that reach the release notes when the changelog is missing.
// Everything else (docs, ci, chore, test, build, style, revert) is internal.
const FALLBACK_GROUPS = [
  { label: "Added", types: ["feat"] },
  { label: "Fixed", types: ["fix"] },
  { label: "Changed", types: ["perf", "refactor"] },
];

const SUBJECT = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/;

export const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

/**
 * Returns the body of `## version` (without the heading), up to the next `##`
 * heading, or `null` when the file has no such section.
 */
export function extractSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i].trim());
    if (!heading) continue;
    if (start === -1) {
      if (heading[1] === version) start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start === -1) return null;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * Renders English notes from `[{ hash, subject }]`, grouped by type. Returns
 * an empty string when nothing user-visible was committed.
 */
export function renderFromCommits(commits) {
  const groups = new Map(FALLBACK_GROUPS.map((g) => [g.label, []]));
  const byType = new Map();
  for (const group of FALLBACK_GROUPS) {
    for (const type of group.types) byType.set(type, group.label);
  }
  for (const commit of commits) {
    const parsed = SUBJECT.exec(commit.subject.trim());
    if (!parsed) continue;
    const label = byType.get(parsed[1]);
    if (!label) continue;
    const scope = parsed[2] ? `**${parsed[2]}:** ` : "";
    const breaking = parsed[3] ? "**breaking** " : "";
    groups.get(label).push(`- ${scope}${breaking}${parsed[4]} (\`${commit.hash}\`)`);
  }
  const parts = [];
  for (const { label } of FALLBACK_GROUPS) {
    const entries = groups.get(label);
    if (entries.length === 0) continue;
    parts.push(`**${label}**`, ...entries, "");
  }
  return parts.join("\n").trim();
}

/**
 * Builds the full release body: the tag's changelog section when it exists,
 * otherwise commit-derived English notes plus a maintainer hint, and always
 * the compare link when there is a previous tag.
 */
export function buildNotes({ changelog, version, commits = [], prev = null, tag }) {
  const section = changelog === null ? null : extractSection(changelog, version);
  const parts = [];
  if (section) {
    parts.push(section);
  } else {
    const generated = renderFromCommits(commits);
    if (generated) parts.push(generated);
    parts.push(
      "> 中文说明待补：该版本在 CHANGELOG.md 里没有段落，以上说明由提交记录自动生成。",
    );
  }
  if (prev) {
    parts.push(`**Full Changelog**: ${REPO}/compare/${prev}...${tag}`);
  }
  return parts.join("\n\n") + "\n";
}

function git(args, { quiet = false } = {}) {
  // A missing previous tag is expected on the first release, so its "fatal:"
  // line is swallowed; everything else keeps its diagnostics.
  const stderr = quiet ? "ignore" : "inherit";
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", stderr] }).trim();
}

// In CI the tag always exists. Locally it may not, which is exactly the
// "what would this version's notes look like" preview before tagging HEAD.
function resolveRev(tag) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { quiet: true });
    return tag;
  } catch {
    return "HEAD";
  }
}

function previousTag(tag) {
  try {
    const prev = git(["describe", "--tags", "--abbrev=0", `${tag}^`], { quiet: true });
    return prev && prev !== tag ? prev : null;
  } catch {
    return null; // first release, or a tag that is not fetched locally
  }
}

function commitsBetween(prev, tag) {
  const range = prev ? `${prev}..${tag}` : tag;
  const format = "--format=%h%x1f%s";
  const out = git(["log", format, range]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [hash, subject] = line.split("\x1f");
    return { hash, subject };
  });
}

export function buildNotesForTag(tag, { changelogPath = CHANGELOG_PATH } = {}) {
  const version = tag.replace(/^v/, "");
  const rev = resolveRev(tag);
  const prev = previousTag(rev);
  let changelog = null;
  try {
    changelog = readFileSync(changelogPath, "utf8");
  } catch {
    changelog = null; // no changelog on this checkout; fall back to commits
  }
  const section = changelog === null ? null : extractSection(changelog, version);
  const notes = buildNotes({
    changelog,
    version,
    commits: section ? [] : commitsBetween(prev, rev),
    prev,
    tag,
  });
  return { version, prev, notes, fromChangelog: Boolean(section) };
}

function parseArgs(argv) {
  const args = { tag: null, out: null, changelogPath: CHANGELOG_PATH };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--tag" || flag === "--out" || flag === "--changelog") {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i++;
      if (flag === "--tag") args.tag = value;
      else if (flag === "--out") args.out = value;
      else args.changelogPath = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.tag) throw new Error("--tag v<version> is required");
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`changelog: ${error.message}\n`);
    process.stderr.write("usage: node scripts/changelog.mjs --tag v<version> [--out <file>]\n");
    process.exitCode = 1;
    return;
  }

  const { version, prev, notes, fromChangelog } = buildNotesForTag(args.tag, {
    changelogPath: args.changelogPath,
  });
  if (!fromChangelog) {
    process.stderr.write(
      `::warning::CHANGELOG.md has no section for ${version}; ` +
        `using commit-derived English notes (${prev ? `${prev}..${args.tag}` : args.tag}).\n`,
    );
  }
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, notes);
    process.stdout.write(`wrote ${args.out} (${notes.length} bytes)\n`);
  } else {
    process.stdout.write(notes);
  }
}

function isMainScript() {
  if (!process.argv[1]) return false;
  if (import.meta.filename === process.argv[1]) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainScript()) main(process.argv.slice(2));
