---
name: pre-release-checklist
description: Run all tests locally and verify cross-platform compatibility before tagging a release. Use when the user asks to release, create a new version, bump version numbers, tag a release, or run release.sh.
---

# Pre-Release Checklist

Before tagging or pushing any release tag, ALWAYS run these steps in order. Do not skip any step even if the user asks to release quickly.

## Step 1 — Run Rust tests

```bash
cd src-tauri && cargo test
```

All tests must pass. If any fail, fix them first.

## Step 2 — Run frontend tests

```bash
npx tsc --noEmit && npx vitest run
```

Both must succeed. If `tsc` fails, there are type errors. If `vitest` fails, update tests to match any UI/API changes made since the last release (common causes: renamed `title` attributes, changed button labels, new required props on fixtures).

## Step 3 — Bump version in all three files

| File | Field |
|------|-------|
| `src-tauri/tauri.conf.json` | `"version"` |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` |

All three must match exactly.

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

- **`getByTitle("...")`** — button titles changed. Update both the component (`title="..."` on the button) and the test assertion.
- **`AppSettings` fixture missing fields** — new fields added to `AppSettings` in `types.ts`. Add them to the `settings` fixture in the test file with sensible defaults.
- **`ClipCardData` fixture missing fields** — new fields added to `ClipCardData`. Add them to `toCardData()` in `ArrangeTab.tsx`.
