# Changelog

All notable changes to CompiFlow are recorded here in plain language.
The latest release is at the top.

<!-- changelog-entries -->

## v2.3.0 - 2026-05-26

### What's new

- Specific Search clip sessions now include a tag picker both for clips and creators.
- Search can look up external clips by video code, not just by URL.
- External clip search cards now show HubSpot social metrics (views/plays, likes, comments).
- Clip cards have a copy-link button in the action bar.

## v2.2.0 - 2026-05-20

### What's new

- The Operativo column in the Finish Video CSV now fills in automatically for all platforms: Instagram, TikTok, YouTube, Bilibili, Douyin, Kuaishou, and Xiaohongshu.
- YouTube channels that use the older `/channel/UC...` URL format are resolved to their handle behind the scenes during export, so the Operativo column is correct even when the handle isn't visible in the URL.
- The Data Integrity page can now flag potential duplicate creator pairs from the Integrity check results, giving the team an earlier heads-up before duplicates cause problems downstream.
- Search reduces Chrome memory usage by deferring Instagram profile page opens and avoiding an unnecessary URL rewrite.

### What got better

- The CSV export now includes Available Channels and Available Platforms columns, and the column order has been updated to better match the team's workflow.

## v2.1.1 - 2026-05-18

### What got better

- Merging duplicate creators now correctly backs up license and traceability files before the merge completes. Previously, every file backup was silently failing, so the files were not being preserved.
- Merging no longer aborts when the loser has more associations than the winner's cap allows. The excess associations are automatically detached from the loser before the merge proceeds.
- The merge confirmation dialog is shorter and clearer.

### Behind the scenes

- File backups now use HubSpot signed URLs to download private files, derive the correct MIME type from the file extension, and authenticate to Supabase Storage with the right header for the new key format.
- HubSpot files that no longer exist are silently skipped instead of counted as failures, and merge retries no longer collide with earlier uploads.

## v2.1.0 - 2026-05-14

### What's new

- The app now prompts for your HubSpot token and other settings at startup if they are missing, ensuring you are fully set up before starting work.
- Data Integrity can now bulk auto-fix broken creator URLs across multiple clips at once, saving time on repetitive cleanups.
- Fixed creator URLs now stay visible in a session-scoped section, letting you review what was corrected before you refresh.
- Duplicates now includes a manual resolution option and the ability to reopen previously resolved pairs if you need to change your mind.

### What got better

- Duplicates now handles the HubSpot association limit gracefully, allowing you to merge creators even when they have an unusually large number of associated records.

### Behind the scenes

- Duplicates now captures a snapshot of the merge pairs for the session, ensuring the audit history has a reliable record of what was merged.

## v2.0.0 - 2026-05-13

### What's new

- New **Duplicates** page scans HubSpot creators for the same social URL across Instagram, TikTok, YouTube, Bilibili, Douyin, Xiaohongshu, and Kuaishou and lets the team review and merge each pair side-by-side, with associations, resolved owner names, and live presence showing who else is on the same record.
- New **License Information** card on every duplicate pair shows status, license type, license checked, license file, traceability file, available channels, available platforms, date granted, and special requests in one HubSpot-style table. License and traceability file ids are clickable, open the file in HubSpot, and display the friendly filename instead of the raw id.
- New **Merge history** tab keeps an immutable A/B comparison of every merge done from the app, so you can audit a past merge even after HubSpot archives the loser side.
- **Data Integrity** has a new check that flags creators whose profile URLs don't match the team's strict format rules, plus a manual refresh and a fix for clips that previously kept reappearing after being resolved.
- **Settings** lets you maintain an exclude list of HubSpot owners that should not appear in the Create-owner dropdown, synced across the team.
- **Latest Clips** in the sidebar now sorts by HubSpot create date and offers a one-click copy of the clip link.

### What got better

- Merging a duplicate no longer reloads the full creators list — resolved pairs stay visible under "Resolved this session", are clickable to reopen for review, and Refresh is the only thing that re-runs the scan.
- The merge confirmation dialog spells out HubSpot's "older create date wins" rule so reviewers aren't surprised by the merged record's create date.
- Creator suggestions skip dead Instagram links, General Search no longer overwrites later results with stale earlier batches, and numeric Instagram primary keys are no longer mistaken for handles.

### Behind the scenes

- Unified clip-resolution cascade with a SocialFetch fallback and friendlier messages when a provider is rate-limited or unreachable.
- New Supabase tables back duplicate resolutions, merge snapshots, and the owner exclude list — read/write open to the team, updates and deletes blocked so the audit history stays immutable.

## v1.1.0 - 2026-05-05

### What's new

- Data Integrity now includes a new monitor for published clips that have unknown tags, so this tagging gap is visible in one place.
- The new monitor can apply matching video-project tags to clips directly from the list, with both per-clip and bulk actions.
- Data Integrity now also flags clips that are still marked for deletion, so risky clips can be reviewed before they continue through the workflow.

### What got better

- The tag-fix rows now show the project tag and clip tag suggestion in separate side-by-side columns, making mappings easier to scan.
- Tag matching is smarter for compound project tags, so names like "Cute Art" can map to existing clip tags when each part is valid.

## v1.0.7 - 2026-05-04

### What's new

- Finish Video now opens a tag precheck when clips are missing tags, using a tagging layout similar to the main tagging page so fixes are faster and more familiar.
- You can stage tag updates across clips first and commit them together with one Save action, giving you a clear review step before anything is written to HubSpot.

### What got better

- The precheck footer now includes a subtle Skip action plus clear Save/Cancel controls, so it is easier to continue without losing context.

### Behind the scenes

- New audit scripts help identify clips with missing "Used in Video Tag" values and clips where Tags are empty even though "Used in Video Tag" is known.

## v1.0.6 - 2026-04-29

### What’s new

- New download log dialog shows a live feed of all download activity with search, level filtering, and a one-click HubSpot diagnose action for stuck clips.
- yt-dlp now repairs itself automatically when the bundled binary fails to start, so most “downloads not working” situations resolve without reinstalling the app.
- Download progress now streams live to Arrange as a real percentage, so you can see exactly how far along each clip is.

### What got better

- Douyin clips on Arrange no longer run automatic download or show a misleading retry loop — the app immediately tells you to import the file manually and keeps the import button front and centre.
- Finish Video no longer strips HubSpot metadata (thumbnail, uploaded clip URL) for clips that were removed or couldn’t be found locally.
- Thumbnail caching is more reliable: expired CDN thumbnails are refreshed automatically instead of getting stuck on a broken image.
- Clips stuck in “Downloading…” from a previous session are cleaned up when you open a project, so nothing appears permanently stuck.
- HubSpot media URLs (thumbnails and uploaded clips) are refreshed on project open, preventing stale fallback fetches.

## v1.0.5 - 2026-04-29

### What got better

- The Finish Video dialog now opens much wider and scrolls when the clip warning list is long, so the Confirm button stays reachable instead of getting cut off.

## v1.0.4 - 2026-04-28

### What got better

- Data Integrity now rejects broken Instagram system links as creator matches, so deleted or unavailable reels no longer suggest fake creators.
- Creator suggestions now include a direct HubSpot button, making it easier to review the suggested creator before applying it.
- Clip HubSpot links sit next to the clip URL, keeping clip actions separate from creator-fix actions.
- Long Data Integrity lists scroll normally again, including the "Not yet published" section.

## v1.0.3 - 2026-04-27

### What got better

- Tag Clips now separates comma-based social hashtags correctly, so clips with many Instagram hashtags no longer appear as one oversized tag.

## v1.0.2 - 2026-04-27

### What's new

- Untagged clips that didn't play inline (mainly Instagram reels) are now downloaded and uploaded to HubSpot in the background the first time they're previewed, so the next preview plays straight in the app and the thumbnail also lands on HubSpot.
- New in-app Changelog dialog (open from the sidebar) shows what changed in each release without leaving the app.
- Creator names in the Tag Clips list and preview header are clickable, jumping straight to the artist's profile in the browser.

### Behind the scenes

- The release script verifies the changelog entry exists and runs a type check before tagging, blocking incomplete releases.
- Internal HubSpot upload code consolidated so video, thumbnail, and clip property updates share a single path, reducing drift.

## v1.0.1 - 2026-04-27

### What got better

- Search keeps the type toggle visible when the app window is short, so switching between search modes stays easy on smaller screens.
