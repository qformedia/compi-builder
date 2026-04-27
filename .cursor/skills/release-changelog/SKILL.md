---
name: release-changelog
description: Draft and maintain a plain-language CHANGELOG.md entry for every release. Use whenever the user asks to release, create a new version, bump version numbers, tag a release, or run release.sh.
---

# Release Changelog

Every release must have a non-technical changelog entry in `CHANGELOG.md` before `scripts/release.sh` runs. The entry is the source of truth for GitHub release notes and the app updater text.

## When this skill applies

Use this skill after choosing the next version with `release-version-bump` and before running `npm run release -- X.Y.Z`.

It applies even when:
- The release is small.
- The user says they do not want to spend time writing release notes.
- The changes are mostly internal, CI, or reliability work.

## Required inputs

Read the previous tag, commits, and changed-file summary:

```bash
PREVIOUS_TAG="$(git describe --tags --abbrev=0)"
git log --oneline "$PREVIOUS_TAG"..HEAD
git diff --stat "$PREVIOUS_TAG"..HEAD
```

Also skim any clearly relevant changed files when the commit messages are too vague to translate confidently.

## Writing rules

Write for the Quantastic team, not for engineers.

- No code identifiers, file paths, commit hashes, package names, or library names.
- Explain what changed for the team and why it matters.
- Keep bullets short, concrete, and factual.
- Do not inflate scope or use marketing language.
- Use present tense.
- Use at most 5 bullets total unless the release is unusually large.
- Group changes under these headings, omitting empty headings:
  - `### What's new`
  - `### What got better`
  - `### Behind the scenes`
- Use `Behind the scenes` only for release process, build, CI, security, cleanup, or reliability work that users may not directly see.

## Voice examples

Bad:

```markdown
- fix(general-search): keep search-type toggle visible at small heights.
- Add release tree guard: clean worktree, version-only bump, pre-tag typecheck.
```

Good:

```markdown
- Search keeps the type toggle visible when the app window is short, so switching between search modes stays easy on smaller screens.
- Releases now stop before publishing if any local work is missing from the version, preventing incomplete updates.
```

## Changelog format

New entries go directly below the `<!-- changelog-entries -->` marker in `CHANGELOG.md`.

Use this exact section heading format:

```markdown
## vX.Y.Z - YYYY-MM-DD
```

Example:

```markdown
## v1.0.0 - 2026-04-27

### What's new

- New Data Integrity page shows clips with missing creators so the team can fix them in one place.
- Downloaded clips are uploaded to HubSpot automatically, reducing manual follow-up after downloads finish.

### What got better

- The Data Integrity page loads large result sets more smoothly and can preview clips before deciding what to fix.

### Behind the scenes

- Releases now stop before publishing if any local work is missing from the version, preventing incomplete updates.
```

## Workflow

1. Determine the next version number from `release-version-bump`.
2. Draft the `CHANGELOG.md` entry from the commits and diff since the previous tag.
3. Prepend the new entry under `<!-- changelog-entries -->`.
4. Include the drafted entry in the `confirm-release` message before pushing.
5. Run `npm run release -- X.Y.Z` only after the entry exists.

`scripts/release.sh` verifies that `CHANGELOG.md` contains a matching `## vX.Y.Z` heading, stages it with the version files, and refuses to release if the entry is missing.
