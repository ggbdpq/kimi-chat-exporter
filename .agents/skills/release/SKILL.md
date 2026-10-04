---
name: release
description: Cut a new Kimi Chat Exporter release end to end — write the bilingual CHANGELOG.md entry, bump the version, tag, push, verify the GitHub Release body — and produce the Chrome Web Store "What's new" copy. Use when asked to release/publish a version (发布 vX.Y.Z) or to fix/refresh a release page.
---

# Release

Publish a version of Kimi Chat Exporter. The user usually triggers this with a
version ("发布 v1.1.0"); pick the bump yourself when they do not name one.

## Contract

- `CHANGELOG.md` is the single source of truth for the GitHub Release body.
  `.github/workflows/release.yml` extracts the tag's section with
  `scripts/changelog.mjs`; a tag without a matching section gets a thin,
  English-only commit dump, so write the section **before** pushing the tag.
- A version section is `## <version> - <YYYY-MM-DD>` with exactly two
  subsections, `### English` and `### 中文`, each a bullet list. Both are
  written by hand; never machine-translate, never leave one empty. Only `##`
  starts a new section, so keep everything inside a version at `###` or lower.
- The tag is `v<version>` and lightweight (matching `v1.0.0`); the version in
  `manifest.json` and `package.json` must be identical or the workflow fails.
- The Chrome Web Store "What's new" copy is printed in the reply. It is never
  committed, never uploaded as an asset, and never put on the Release page.

## Steps

1. Confirm the starting state: on `main`, clean worktree, `git fetch origin`
   done. Stop and report if the tree is dirty or another branch is checked out.
2. Pick the version from `git log --oneline "$(git describe --tags --abbrev=0)..HEAD"`:
   any `feat` -> minor, otherwise `fix`/`perf`/`refactor` -> patch. Ask the user
   only when the bump is genuinely ambiguous.
3. Write `CHANGELOG.md`: move the `## Unreleased` content into
   `## <version> - <today>`, fill both subsections with the user-visible
   changes, and leave a fresh empty `## Unreleased` above it.
4. Bump `version` in `manifest.json` and `package.json` to the same value.
5. Run `npm test` and `npm run pack`; both must pass before anything is tagged.
6. Commit (`chore(release): v<version>`), then `git tag v<version>` and push both:
   `git push origin main v<version>`.
7. Watch the run: `gh run list --workflow release.yml --limit 1`, then
   `gh run watch <id>`. On failure, read the log and fix the cause before
   re-tagging; never delete and re-push a tag that already produced a release
   without checking `gh release view` first.
8. Verify the page: `gh release view v<version>` must show the bilingual
   section. If the body is wrong, fix `CHANGELOG.md` and re-run the workflow —
   the publish step owns the body and refreshes it on every run. Do not
   hand-edit a release body.
9. Reply with the release URL, one line per language on what shipped, and the
   store copy below.

## Chrome Web Store copy

Condense the `### 中文` section into 2-3 sentences for the store's "What's new"
field: what changed for the user, no commit hashes, no internal file names.
Print it as plain text the user can paste.

## Also update

- `.publish/CHROMEWEBSTORE.md` (local, gitignored): submission state and the
  version history entry for this release.
- `PRIVACY.md` only if the name, version, permissions or data practices
  changed; the Pages workflow republishes it.
- `README.md` / `README.zh-CN.md` only if user-facing behavior or the feature
  list changed.
