# Changelog

All notable changes to CompiFlow are recorded here in plain language.
The latest release is at the top.

<!-- changelog-entries -->

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
