# Download System Requirements

This document specifies how video clip downloading works in CompiFlow.
It is the source of truth for the download pipeline and must be kept
up-to-date when the functionality changes.

---

## 1. Overview

CompiFlow downloads video clips via a **provider cascade** system. Each
platform has an ordered list of download providers to try. The primary
provider is **yt-dlp** (bundled as a Tauri sidecar binary). For Chinese
platforms (Douyin, Kuaishou, Bilibili), an optional **Evil0ctal API**
provider is tried first, falling back to yt-dlp. Downloads are triggered
from the frontend, executed in Rust, and progress is reported back via
Tauri events.

## 2. Supported Platforms

| Platform | Architecture | yt-dlp binary |
|----------|-------------|---------------|
| macOS | aarch64 (Apple Silicon) | `yt-dlp_macos` (universal) |
| macOS | x86_64 (Intel) | `yt-dlp_macos` (universal) |
| Windows | x86_64 | `yt-dlp.exe` |

Both platforms must produce identical, playable MP4 output.

## 3. Download Flow

```
Frontend invoke("download_clip", { rootFolder, projectName, clipId, url,
    cookiesBrowser, cookiesFile, hubspotUrl, evil0ctalApiUrl, downloadProviders })
    │
    ▼
Rust: download_clip()
    ├─ emit download-progress { status: "downloading", progress: 0 }
    ├─ (Optional) Fast path: HubSpot CDN if hubspot_url available
    ├─ Resolve provider cascade: providers_for_url(url, downloadProviders)
    │     e.g. Douyin → ["evil0ctal", "ytdlp"], YouTube → ["ytdlp"]
    ├─ For each provider in order:
    │     ├─ "evil0ctal" → run_evil0ctal_download()
    │     │     ├─ GET {apiUrl}/api/hybrid/video_data?url={url}&minimal=true
    │     │     ├─ Extract no-watermark video URL from response
    │     │     └─ Download video to {clips_dir}/{clipId}_evil0ctal.mp4
    │     └─ "ytdlp" → run_ytdlp_with_cookie_cascade()
    │           ├─ cookie retry cascade:
    │           │     1. Try with browser cookies (if configured)
    │           │     2. Try with cookies file (if configured and step 1 failed)
    │           │     3. Try without any cookies (if previous steps failed)
    │           └─ run_ytdlp_download()
    │                 ├─ run_ytdlp() → try sidecar first, fallback to system yt-dlp
    │                 └─ yt-dlp args: -f {format} --merge-output-format mp4 ...
    ├─ On first provider success:
    │     ├─ find_downloaded_file() → scan clips_dir for {clipId}_*
    │     ├─ probe_duration() → read MP4 headers (mp4 crate)
    │     └─ emit download-progress { status: "complete", localFile, localDuration }
    └─ On all providers failed:
          ├─ Aggregate error messages from each provider
          └─ emit download-progress { status: "failed", error }
```

## 4. yt-dlp Binary Resolution

1. **Sidecar** (`binaries/yt-dlp`): Tauri resolves the correct binary by
   target triple (e.g. `yt-dlp-aarch64-apple-darwin`).
2. **System fallback**: If the sidecar fails, `find_system_ytdlp()` checks
   `/opt/homebrew/bin/yt-dlp`, `/usr/local/bin/yt-dlp` (macOS), then
   `which::which("yt-dlp")`.
3. Both paths inject an augmented `PATH` on macOS so yt-dlp can find helper
   runtimes (e.g. deno for YouTube).

## 5. yt-dlp Arguments (Critical)

| Arg | Purpose | Impact if wrong |
|-----|---------|-----------------|
| `-f {format}` | Format selection (platform-dependent, see below) | Black/silent video if wrong format selected |
| `--merge-output-format mp4` | Force MP4 container | Playback failure in WebView if not MP4 |
| `-o {template}` | File naming with clip ID prefix | `find_downloaded_file` won't match |
| `--no-warnings` | Suppress non-error output | Cleaner stderr parsing |
| `--newline` | Progress on separate lines | Needed for future progress streaming |

### Platform-dependent format selection (`format_selection_for_url()`)

| Platform | `-f` value | Reason |
|----------|-----------|--------|
| Instagram | `best` | Instagram serves single combined streams. Codec metadata is often missing (`vcodec: null` for h264/avc1), which causes `bestvideo+bestaudio` to select VP9 DASH video-only streams → black/silent output. |
| All others | `bestvideo+bestaudio/best` | Standard split selection with merge fallback. |

This logic lives in `helpers::format_selection_for_url()` and is tested.

## 6. Cookie Handling

### Browser cookies (`--cookies-from-browser`)
- Used for platforms requiring login (Instagram, Douyin, etc.).
- **Windows workaround**: Chromium locks its SQLite cookie DB. We pre-copy
  it to `%TEMP%\compiflow_cookies\{profile}\Cookies` and redirect yt-dlp
  to that copy (`apply_windows_cookie_workaround`).
- Supported browsers: chrome, edge, brave, chromium.

### File cookies (`--cookies`)
- Netscape-format cookies.txt file.
- Used as fallback when browser cookies fail.

### Retry cascade
1. Browser cookies (if configured)
2. Cookies file (if configured and step 1 failed)
3. No cookies (always tried as last resort)

## 7. Output File Handling

### Naming
- Template: `{clipId}_%(title).50s.%(ext)s`
- Title truncated to 50 chars by yt-dlp.
- Extension typically `.mp4` after merge.

### Discovery
- `find_downloaded_file()` scans the clips directory for files starting
  with `{clipId}_`. First match wins.
- Returns relative path: `clips/{filename}`.

### Ordering & Renaming
- `order_clips()`: Renames to `{N} - {clean_name}` (1-indexed).
- `strip_prefix()`: Removes existing `unused_` and `N - ` prefixes.
- Unused files get prefixed with `unused_`.

### Serving to WebView
- Custom `localfile://` URI scheme serves local files with:
  - Correct MIME type (video/mp4, video/webm, video/x-matroska)
  - `Range` header support (required for Windows WebView2)
  - CORS headers (`Access-Control-Allow-Origin: *`)

## 8. Duration Probing

- `probe_duration()` uses the `mp4` Rust crate to read MP4 headers.
- No external binary required.
- Returns `None` for non-MP4 files (WebM, MKV) or corrupt files.
- Duration is used for arrange tab stats and CSV export.

## 9. Error Handling

### User-facing errors (`friendly_download_error`)

| Stderr pattern | User message |
|----------------|--------------|
| `[douyin]` + `fresh cookies` | Douyin temporarily broken in yt-dlp |
| `not granting access` / `empty media response` | Login required |
| `could not find` + `cookie` | Could not read cookies |
| `could not copy` + `cookie` | Could not copy cookie DB |
| `failed to decrypt` + `cookie` | Cannot decrypt cookies |
| `video is unavailable` / `removed` | Video no longer available |
| `private video` | Video is private |
| `urlopen error` / `connection` | Network error |
| Fallback | Last non-empty stderr line |

### Platform-specific errors
- When **both** the bundled sidecar and system fallback fail, `friendly_download_error()` maps the internal `"yt-dlp is not installed…"` string to an actionable message (macOS: Gatekeeper / first-open guidance + optional Homebrew fallback; Windows: reinstall or GitHub releases link).
- macOS builds also strip `com.apple.quarantine` from the bundled sidecar once per process and adhoc-`codesign` the sidecar in CI to reduce Gatekeeper blocking.

## 10. Platform-Specific Considerations

### macOS
- `.app` bundles don't inherit the user's shell `PATH`.
- `augmented_path()` prepends `/opt/homebrew/bin` and `/usr/local/bin`.
- Applied to both sidecar and system fallback via `.env("PATH", ...)`.

### Windows
- Chromium cookie DB locking requires the copy workaround.
- `CREATE_NO_WINDOW` flag (0x08000000) prevents console windows.
- `localfile://` path parsing must strip leading `/` before drive letters.
- WebView2 requires `Range` header support for video playback.
- yt-dlp on Windows may produce different default codecs/containers;
  `--merge-output-format mp4` is critical.

## 11. Download Provider Cascade

### Provider config

The `downloadProviders` setting is a JSON map of platform keys to ordered
provider ID arrays. Default config:

```json
{
  "douyin":   ["evil0ctal", "ytdlp"],
  "kuaishou": ["evil0ctal", "ytdlp"],
  "bilibili": ["evil0ctal", "ytdlp"],
  "default":  ["ytdlp"]
}
```

Platform keys are resolved by `platform_key()` in `helpers.rs` (lowercase
hostname-based detection). If a platform isn't in the map, the `"default"`
key is used. If that's also missing, `["ytdlp"]` is the hardcoded fallback.

### Available providers

| Provider | ID | Requires | Platforms |
|----------|----|----------|-----------|
| yt-dlp | `ytdlp` | Bundled sidecar | All |
| Evil0ctal API | `evil0ctal` | `evil0ctalApiUrl` in settings | Douyin, Kuaishou, Bilibili |

### Evil0ctal API

Self-hosted instance of [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API).
Deploy to Railway or any Docker host. The base URL is configured in
Settings → Advanced → "Douyin/Kuaishou/Bilibili API URL".

- API endpoint used: `GET /api/download?url={url}&prefix=false&with_watermark=false`
- The server proxies the download from the Chinese CDN, avoiding geo-blocking
- Downloaded file saved as `{clips_dir}/{clipId}_evil0ctal.mp4`
- Provider is silently skipped if URL is not configured
- Timeout: 300s (video proxy can be slow depending on CDN)

### Adding new providers

1. Add the provider ID to `DEFAULT_DOWNLOAD_PROVIDERS` in `src/types.ts`
2. Add a `run_{provider}_download()` async function in `lib.rs`
3. Add a match arm in `download_clip()`'s provider loop
4. Update this doc

## 12. Known Limitations

1. **No real-time progress**: Progress is only 0% or 100%. The
   `--progress-template` output is not streamed.
2. **MP4 only for duration**: `probe_duration` only works for MP4 files.
3. **Single file match**: `find_downloaded_file` returns the first match;
   multiple files with the same clip ID prefix could cause issues.
4. **Xiaohongshu**: Cannot be auto-downloaded; must be imported manually.
5. **Douyin**: Known upstream yt-dlp bug with cookie handling (mitigated
   by Evil0ctal provider when configured).

## 13. Code Structure

Testable helper functions live in `src-tauri/src/helpers.rs` with
`pub(crate)` visibility. Tests are in the same file under
`#[cfg(test)] mod tests`. Run with `cargo test` in `src-tauri/`.

Key helpers:
- `platform_key()` — URL → lowercase platform key for provider lookups
- `detect_platform()` — URL → display-friendly platform name (uses `platform_key`)
- `providers_for_url()` — resolve provider cascade for a URL
- `format_selection_for_url()` — platform-dependent `-f` argument
- `friendly_download_error()` — stderr → user message mapping
- `strip_prefix()` — file rename prefix stripping
- `find_downloaded_file()` / `find_file_by_id()` — file discovery
- `probe_duration()` — MP4 duration via headers
- `build_filter_groups()` — HubSpot query construction
- `augmented_path()` (macOS) / `find_system_ytdlp()` — PATH resolution

Key download functions in `lib.rs`:
- `download_clip()` — Tauri command, orchestrates provider cascade
- `run_evil0ctal_download()` — Evil0ctal API provider
- `run_ytdlp_with_cookie_cascade()` — yt-dlp provider with cookie retry
- `run_ytdlp_download()` — single yt-dlp invocation with specific cookie method

## 14. Invariants (Must Always Hold)

1. Downloaded files MUST be playable MP4 with both video and audio streams.
2. `format_selection_for_url()` MUST return `best` for Instagram and
   `bestvideo+bestaudio/best` for all other platforms.
3. `--merge-output-format mp4` MUST always be present in yt-dlp commands.
4. The cookie retry cascade MUST always end with a no-cookies attempt.
5. `find_downloaded_file` MUST be able to find any file downloaded by
   any provider using the same clip ID prefix (`{clipId}_`).
6. The provider cascade MUST always have at least one provider. If the
   config is missing or invalid, fall back to `["ytdlp"]`.
7. Providers with missing configuration (e.g. evil0ctal without URL)
   MUST be silently skipped, not cause a hard failure.
6. The `localfile://` protocol MUST serve video with Range support on all
   platforms.
7. All OS-specific code MUST be gated behind `#[cfg(target_os = "...")]`.
8. Error messages MUST be user-friendly (no raw stderr dumps).
9. The sidecar binary MUST be tried before the system fallback.
10. All tests in `cargo test` MUST pass before any release.
