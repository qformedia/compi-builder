---
name: confirm-release
description: Pause for explicit user confirmation before any irreversible release action (pushing a version tag, running release.sh, publishing a GitHub release). Use whenever the user asks to release, create a new version, bump version numbers, tag a release, or run release.sh, even if they already mentioned releasing earlier in the conversation.
---

# Confirm Before Releasing

The user has asked to be notified before any new version goes out. Treat tag pushes and `scripts/release.sh` invocations as irreversible — once the tag is on the remote, GitHub Actions starts a release pipeline that publishes a public DMG/MSI and updates the auto-updater channel. Always pause for explicit, in-message approval right before that step.

## When this skill applies

Use this skill any time the agent is about to:

- Run `scripts/release.sh <version>`
- Run `git push --tags` or `git push origin v<version>`
- Run `gh release create` or anything else that publishes a release
- Move/recreate an existing release tag

It applies even when:

- The user already said "release" earlier in the conversation. Implicit approval from a previous turn is not enough; confirm again right before the irreversible step, with the actual diff in front of them.
- The agent is following the `pre-release-checklist` skill. This gate sits after the changelog has been drafted and before the irreversible release command or tag push.
- The change is "small" (a typo fix, a copy tweak). The user wants to know about every release, not just risky ones.

It does **not** apply to:

- Local commits that have not been pushed yet — the user can still amend or drop those.
- Pushing branches without tags (CI for `main` does not publish a release on this repo).
- Running tests, builds, or dry runs locally.

## What to send the user before releasing

Send one concise message (no tool call) that contains:

1. **Proposed version** and the previous tag (`v0.9.2 → v0.9.3`).
2. **One-line headline** describing the release theme (the pre-release-checklist commit message subject is fine).
3. **Draft changelog** copied from the new `CHANGELOG.md` section for this version. This is the exact text GitHub release notes and the app updater will use.
4. **Commits since the last tag**, copied verbatim from `git log --oneline <last-tag>..HEAD`. Include every commit that will be in the tag, not just the ones the agent authored — the user needs to see if unrelated work is riding along.
5. **Verification status**: whether `cargo test`, `npm test`, and `npm run typecheck` passed locally.
6. **Explicit ask**: "Ready to push `vX.Y.Z`?" or equivalent. Do not start any push until the user replies with an affirmative ("yes", "go", "release it", "ship it", "approved", or similar).

Keep the message short — bullets, no prose padding. The user reads this every release.

### Template

```
Ready to release **vX.Y.Z** (was `v<previous>`)?

**Headline**: <commit subject of the release commit>

**Changelog draft**:
<paste the CHANGELOG.md section for vX.Y.Z>

**Commits in this tag**:
- <hash> <subject>
- <hash> <subject>
- ...

**Local verification**: cargo test ✓ (N passed) · npm test ✓ (N passed) · typecheck ✓

Reply "go" to push the tag and trigger CI, or tell me what to change.
```

## What to do with the user's reply

- **Affirmative** ("yes", "go", "ship it", "release", "approved", "do it", "push") → proceed with `git push origin main && git push origin vX.Y.Z` (or `scripts/release.sh X.Y.Z` if not yet committed).
- **Negative or "wait"** ("no", "hold on", "let me check", "not yet") → stop. Do not run the push. Ask what they want changed; offer to drop the local tag with `git tag -d vX.Y.Z` if they want to abort entirely.
- **Ambiguous** ("looks good but…", "almost", a question) → treat as not-yet-approved. Resolve the question first, then ask again.

If the user has _explicitly_ pre-authorized in the same turn (e.g. "bump to 0.9.3 and ship it without asking" or "release without confirming"), record that in your reply and proceed without the gate. Their explicit override beats this skill.

## After pushing

Once the tag is pushed, link the GitHub Actions run so the user can watch CI. If CI fails, follow the recovery flow in `pre-release-checklist` (delete and re-push the tag) — but treat the recovery push as a fresh release and confirm again before re-pushing.

## Why this exists

CompiFlow ships via the Tauri auto-updater. A bad release reaches every installed copy on the next launch. The 30-second pause to confirm is cheaper than rolling back a public release.
