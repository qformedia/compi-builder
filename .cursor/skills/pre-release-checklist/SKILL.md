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

Same diagnosis approach as Step 1. Common frontend test issues:

- Tests that query by `title` or text content break when labels change. Prefer querying by `data-testid` for structural elements and `title` for interactive buttons (since `title` doubles as the tooltip).
- Tests that check exact element counts break when layout changes add/remove wrappers. Prefer semantic queries (`getByRole`, `getByTitle`) over structural ones.

## Step 3 — Decide and bump the version in all three files

First, decide the next version number by following the `release-version-bump` skill. The default is a PATCH bump (third number); only escalate to MINOR for notable feature releases, and only escalate to MAJOR when the user explicitly asks.

Then update the version in all three files — they must match exactly:

| File | Field |
|------|-------|
| `src-tauri/tauri.conf.json` | `"version"` |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` |

## Step 4 — Commit, tag, push

```bash
git add -A
git commit -m "release vX.Y.Z\n\n<summary of changes>"
git tag vX.Y.Z
git push origin main --tags
```

The tag push triggers the CI release pipeline (macOS + Windows builds).

## Step 5 — Verify CI passes

After pushing, check the GitHub Actions run for the release tag. If it fails, fix the issue, delete the remote tag, move it, and re-push:

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

## Common test failures after UI changes

- **`getByTitle("...")`** — button titles changed. Update both the component (`title="..."` on the button) and the test assertion. Always keep `title` on interactive buttons even when using `<Tip>` tooltips.
- **`AppSettings` fixture missing fields** — new fields added to `AppSettings` in `types.ts`. Add them to the `settings` fixture in the test file with sensible defaults.
- **`ClipCardData` fixture missing fields** — new fields added to `ClipCardData`. Add them to `toCardData()` in `ArrangeTab.tsx`.
- **Guard conditions removed** — e.g. `!isXiaohongshu` guard was removed, changing which buttons render. Tests checking for absence of buttons need updating.
