---
name: pre-release-checklist
description: Run all tests locally and verify cross-platform compatibility before tagging a release. Use when the user asks to release, create a new version, bump version numbers, tag a release, or run release.sh.
---

# Pre-Release Checklist

Before tagging or pushing any release tag, ALWAYS run these steps in order. Do not skip any step even if the user asks to release quickly.

## Step 0 — Review changes and assess test coverage

Before running tests, review all changes since the last release:

```bash
git log --oneline $(git describe --tags --abbrev=0)..HEAD
git diff --stat $(git describe --tags --abbrev=0)..HEAD
```

For each changed file, ask:
- Does this change affect behavior that existing tests cover? If so, the tests may need updating.
- Does this introduce new logic (new functions, new branches, new user flows) that should have tests?
- Is this a pure UI change (styling, layout) that doesn't need new tests?

**Write new tests when**:
- New pure/helper functions are added (especially in `helpers.rs`, utility functions in `.tsx`)
- New Tauri commands are added
- New user-facing flows are added (e.g. a new sync mechanism, a new download provider)

**Do NOT write tests just to increase count** — every test must assert meaningful behavior.

## Step 1 — Run Rust tests

```bash
cd src-tauri && cargo test
```

All tests must pass. If any fail, diagnose carefully:

**Is the test catching a real bug?** Fix the bug, not the test. Then consider: could a cursor rule or skill have prevented this? If so, create or update one.

**Is the test broken by a valid change?** The test was too tightly coupled to implementation details. Fix the test to be more resilient, then update this skill's "Common failures" section with the pattern.

## Step 2 — Run frontend tests

```bash
npx tsc --noEmit && npx vitest run
```

(Release script also runs `npm run typecheck` before creating the tag, but you should still verify tests locally here.)

Same diagnosis approach as Step 1. Common frontend test issues:

- Tests that query by `title` or text content break when labels change. Prefer querying by `data-testid` for structural elements and `title` for interactive buttons (since `title` doubles as the tooltip).
- Tests that check exact element counts break when layout changes add/remove wrappers. Prefer semantic queries (`getByRole`, `getByTitle`) over structural ones.

## Step 3 — Commit all work; clean working tree

`scripts/release.sh` (via `npm run release`) will **refuse to run** if the working tree is not clean, so a tag cannot be pushed without a new file that was left untracked or uncommitted.

Before drafting the changelog and bumping the version, commit and push (or at least commit) all feature/fix changes that belong in the release, then confirm:

```bash
git status   # should show: nothing to commit, working tree clean
```

**Do not** plan to “fold” feature work into the same commit as the version bump with `git add -A` at the last second unless you already committed everything else first. The release script only stages `CHANGELOG.md` and the standard version files (`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` if it changed).

## Step 4 — Decide version and draft changelog

Decide the next version number with the `release-version-bump` skill. The default is a PATCH bump; escalate to MINOR/MAJOR only when appropriate.

Then use the `release-changelog` skill to draft a plain-language `CHANGELOG.md` entry for the new version from the commits and diff since the previous tag. This entry is required because GitHub release notes and app updater notes are generated from it.

At this point, `git status --short` should show only `CHANGELOG.md` as modified. Any other changed file means feature/fix work is not safely committed yet.

## Step 5 — Run the release command

Bump, typecheck, commit the version/changelog change, tag, and push in one step:

```bash
npm run release -- X.Y.Z
```

The script: verifies the changelog entry exists, bumps all version fields, verifies only `CHANGELOG.md` and version files differ, runs `npm run typecheck`, then commits, tags `vX.Y.Z`, and `git push && git push --tags`.

The tag push triggers the CI release pipeline (macOS + Windows builds).

## Step 6 — Verify CI passes

After pushing, check the GitHub Actions run for the release tag. If it fails, fix the issue, delete the remote tag, move it, and re-push:

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

## Common release / CI failures

- **Type check fails on tag, “Cannot find module …”** — a new file was committed in spirit but never added to git before the tag. The release script now blocks a dirty working tree; always commit (including new files) before `npm run release`, and use the pre-push typecheck the script runs.

## Common test failures after UI changes

- **`getByTitle("...")`** — button titles changed. Update both the component (`title="..."` on the button) and the test assertion. Always keep `title` on interactive buttons even when using `<Tip>` tooltips.
- **`AppSettings` fixture missing fields** — new fields added to `AppSettings` in `types.ts`. Add them to the `settings` fixture in the test file with sensible defaults.
- **`ClipCardData` fixture missing fields** — new fields added to `ClipCardData`. Add them to `toCardData()` in `ArrangeTab.tsx`.
- **Guard conditions removed** — e.g. `!isXiaohongshu` guard was removed, changing which buttons render. Tests checking for absence of buttons need updating.
