---
name: release-version-bump
description: Decide which segment of the semantic version to increment when cutting a release. Use when the user asks to release, create a new version, bump version numbers, tag a release, or run release.sh, and the next version number must be chosen.
---

# Release Version Bump Policy

This project follows semantic versioning (`MAJOR.MINOR.PATCH`, e.g. `0.8.0`). When preparing a release, choose the next version number using the policy below. **The default is always a PATCH bump.** Only escalate to MINOR or MAJOR when the criteria below are clearly met.

User's terminology mapping (use these when summarizing the choice back to the user):
- "two decimals" = **PATCH** (third number, `X.Y.Z` → `X.Y.Z+1`)
- "one decimal" = **MINOR** (second number, `X.Y.Z` → `X.Y+1.0`)
- "the integer" = **MAJOR** (first number, `X.Y.Z` → `X+1.0.0`)

## Decision Workflow

Before bumping the version, list the changes since the last release:

```bash
git log --oneline $(git describe --tags --abbrev=0)..HEAD
git diff --stat $(git describe --tags --abbrev=0)..HEAD
```

Then walk through the rules in order. **Stop at the first rule that matches.**

### Rule 1 — MAJOR bump (only when user explicitly says so)

Bump MAJOR (`X.Y.Z` → `X+1.0.0`) **only** when the user explicitly asks for it (e.g. "this is a major release", "bump to 1.0", "increment the integer"). Do not infer a MAJOR bump from the diff alone, even if the changes look large or include breaking changes.

### Rule 2 — MINOR bump (notable feature release)

Bump MINOR (`X.Y.Z` → `X.Y+1.0`) when **all** of the following are true:
- The release contains **several** new user-facing features or capabilities (not just one), **or** a single substantial new feature (e.g. a new tab, a new download provider, a new sync mechanism, a new settings surface).
- The set of changes meaningfully expands what the app can do, beyond fixes and small tweaks.
- The user has not asked for a MAJOR bump.

Heuristics that suggest MINOR:
- Multiple `feat:` commits since the last tag.
- A new top-level UI surface, command, or integration.
- A new external API or provider integration.
- Many files changed across multiple subsystems for feature work (not refactors/fixes).

### Rule 3 — PATCH bump (default)

Bump PATCH (`X.Y.Z` → `X.Y.Z+1`) in **all other cases**. This is the default and covers:
- Bug fixes.
- Small UI/UX polish, copy changes, styling.
- Refactors with no user-visible change.
- Dependency bumps.
- A single small feature or enhancement to an existing feature.
- Documentation and config tweaks.

When in doubt between PATCH and MINOR, choose **PATCH**.

## Confirming the choice

After deciding, briefly state to the user:
1. The current version (read from `src-tauri/tauri.conf.json`).
2. The proposed next version.
3. Which rule applied (PATCH default / MINOR feature release / MAJOR explicit request) and a one-line justification referencing the diff.

Example:

> Current version is `0.8.0`. Proposing `0.8.1` (PATCH / default — changes since `v0.8.0` are a SearchTab fix and a Cargo.lock update, no new features).

If the user disagrees, follow their instruction and remember: a user request to "increase the integer" overrides everything in this skill.

## After the decision

Hand off to the `pre-release-checklist` skill, which covers running tests, updating the three version files (`src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`), tagging, and pushing.
