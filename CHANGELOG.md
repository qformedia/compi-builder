# Changelog

All notable changes to CompiFlow are recorded here in plain language.
The latest release is at the top.

<!-- changelog-entries -->

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
