# CLAUDE.md

Guidance for Claude Code working in this repo. Loaded into every conversation — keep it tight.

## Project

CompiFlow (package name `compi-builder`) is a Tauri 2 desktop app for the Quantastic team to ingest, tag, download, and arrange external video clips (Instagram, TikTok, YouTube, Pinterest, Bilibili, Douyin, Kuaishou, Xiaohongshu). Frontend is React 19 + Vite + TypeScript + Tailwind v4. Backend is Rust (`src-tauri/`). Persistence and search are via Supabase. HubSpot integration uploads downloaded clips.

Distribution: macOS DMG + Windows MSI via the Tauri auto-updater. **A bad release reaches every installed copy on the next launch** — release safety rules below are non-optional.

## Layout

- `src/` — React frontend (components, lib, hooks, types).
- `src-tauri/` — Rust backend. `lib.rs` holds Tauri commands and wiring; `helpers.rs` holds testable pure functions with `#[cfg(test)] mod tests` at the bottom.
- `supabase/` — schema, migrations, edge functions.
- `docs/` — long-form specs (notably `download-system-requirements.md`).
- `scripts/` — `release.sh`, sidecar download, etc.
- `.cursor/` — Cursor rules and skills (mirrored into `.claude/skills/`; keep both in sync).
- `.claude/skills/` — Claude-native skills mirrored from `.cursor/skills/`.

## Common commands

- `cd src-tauri && cargo test` — Rust unit tests.
- `npm test` — Vitest run (one-shot).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run dev` — Vite dev server (frontend only).
- `npm run tauri dev` — full Tauri app in dev mode.
- `npm run release -- X.Y.Z` — full release pipeline. **Never run without the confirmation gate below.**

## Release process — mandatory gate

Releases are irreversible (auto-updater). Treat any of these as a hard stop requiring explicit user approval in the same turn:

- `bash scripts/release.sh <version>` / `npm run release -- <version>`
- `git push --tags` or `git push origin v<version>`
- `gh release create` or anything that publishes a release
- Moving or recreating an existing tag

Approval rules (full text in `.claude/skills/confirm-release/SKILL.md`):

- Implicit approval from a previous turn is **not** enough. Re-confirm with the actual diff in front of the user.
- Applies even for tiny releases (typo fix, copy tweak).
- Send the confirmation message described in the skill (version, headline, draft changelog, commits since last tag, local verification status, explicit ask).
- Wait for an affirmative reply (`yes`, `go`, `ship it`, `release it`, `approved`). Anything ambiguous = not approved.
- An explicit pre-authorization in the same turn (e.g. "ship it without asking") overrides the gate; record that in the reply.

The full release flow is, in order: invoke `pre-release-checklist` → invoke `release-version-bump` → invoke `release-changelog` → send confirmation → run `npm run release -- X.Y.Z`.

### Version-bump policy (summary)

Default is **PATCH**. Bump **MINOR** only for several user-facing features or one substantial new surface (new tab, new download provider, new sync mechanism). Bump **MAJOR** only when the user explicitly asks. When in doubt between PATCH and MINOR, choose PATCH. Full policy: `.claude/skills/release-version-bump/SKILL.md`.

### Changelog voice (summary)

Every release needs a `CHANGELOG.md` entry written for the team, not engineers. No code identifiers, file paths, package names, or commit hashes. Group bullets under `### What's new`, `### What got better`, `### Behind the scenes` (omit empty headings). New entries go directly below `<!-- changelog-entries -->` with heading `## vX.Y.Z - YYYY-MM-DD`. Full rules and voice examples: `.claude/skills/release-changelog/SKILL.md`.

## Testing & refactor discipline

Writing tests is a refactoring checkpoint: read the code, write tests against current behavior, then evaluate complexity / naming / duplication / abstraction / dead code and propose changes before applying. Do **not** refactor code outside the test scope, change behavior, rename public APIs without approval, or optimize without a measured problem. Full checklist: `.claude/skills/refactor-while-testing/SKILL.md`.

## Download pipeline (high-risk area)

Any change to `src-tauri/src/lib.rs`, `src-tauri/src/helpers.rs`, the provider cascade, the `localfile://` protocol, or yt-dlp invocation **must** go through the cross-platform checklist in `.cursor/rules/download-system.mdc` and the spec in `docs/download-system-requirements.md`. Top pitfalls to keep front-of-mind:

1. **Black videos on Windows/Instagram** — Instagram reports `vcodec: null` for h264 streams. `bestvideo+bestaudio` can pick a VP9 DASH video-only stream → black video. Always use `format_selection_for_url()` (returns `best` for Instagram, `bestvideo+bestaudio/best` elsewhere).
2. **`yt-dlp not found` in macOS .app bundles** — bundles don't inherit shell PATH. Always use `augmented_path()` and `find_system_ytdlp()`; pass `.env("PATH", augmented_path())` to spawned commands.
3. **Cookie DB locked on Windows** — Chromium locks the Cookies SQLite. `apply_windows_cookie_workaround` (copy-to-temp) must run before yt-dlp on Windows.

Other invariants: `--merge-output-format mp4` always present; cookie cascade is browser → file → none (never skip the no-cookies fallback); all providers prefix output files with `{clipId}_` so `find_downloaded_file` can locate them; user-facing yt-dlp errors go through `friendly_download_error()` and must never default to "Reinstall CompiFlow" (the `ytdlp_repair` self-repair handles the common cases).

## URL compliance

Canonical normalization rules for External Clip source URLs live in the user-level skill `~/.cursor/skills/url-formatting/spec.md` (shared across CompiFlow, the Quantastic Chrome extension, and any other Quantastic repo that ingests clip URLs). Read `spec.md` before editing `src/lib/url-compliance.ts`. Issue strings in that file are user-facing and must match the spec verbatim — translation happens at the UI layer.

## Where to look

- Long specs: `docs/`
- Auto-applied (in Cursor) domain rules: `.cursor/rules/`
- Skill bodies (full text): `.claude/skills/` (mirrored from `.cursor/skills/` — keep both in sync when editing)
