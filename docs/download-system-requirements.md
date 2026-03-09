# Download System Requirements

This document specifies how video clip downloading works in CompiFlow.
It is the source of truth for the download pipeline and must be kept
up-to-date when the functionality changes.

---

## 1. Overview

CompiFlow downloads video clips via **yt-dlp** (bundled as a Tauri sidecar
binary). Downloads are triggered from the frontend, executed in Rust, and
progress is reported back via Tauri events.

## 2. Supported Platforms

| Platform | Architecture | yt-dlp binary |
|----------|-------------|---------------|
| macOS | aarch64 (Apple Silicon) | `yt-dlp_macos` (universal) |
| macOS | x86_64 (Intel) | `yt-dlp_macos` (universal) |
| Windows | x86_64 | `yt-dlp.exe` |

Both platforms must produce identical, playable MP4 output.

## 3. Download Flow

```
Frontend invoke("download_clip", { rootFolder, projectName, clipId, url, cookiesBrowser, cookiesFile })
    │
    ▼
Rust: download_clip()
    ├─ emit download-progress { status: "downloading", progress: 0 }
    ├─ build output template: {clips_dir}/{clipId}_%(title).50s.%(ext)s
    ├─ cookie retry cascade:
    │     1. Try with browser cookies (if configured)
    │     2. Try with cookies file (if configured and step 1 failed)
    │     3. Try without any cookies (if previous steps failed)
    ├─ run_ytdlp_download()
    │     ├─ run_ytdlp() → try sidecar first, fallback to system yt-dlp
    │     └─ yt-dlp args:
    │           --no-warnings
    │           -f bestvideo+bestaudio/best
    │           --merge-output-format mp4
    │           -o {output_template}
    │           --newline
    │           --progress-template %(progress._percent_str)s
    │           [--cookies-from-browser {browser}]
    │           [--cookies {file}]
    │           {url}
    ├─ on success:
    │     ├─ find_downloaded_file() → scan clips_dir for {clipId}_*
    │     ├─ probe_duration() → read MP4 headers (mp4 crate)
    │     └─ emit download-progress { status: "complete", localFile, localDuration }
    └─ on failure:
          ├─ friendly_download_error() → user-facing message
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
- The fallback yt-dlp error message mentions `brew install yt-dlp`.
  On Windows this should say something like `Install yt-dlp from https://github.com/yt-dlp/yt-dlp`.

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

## 11. Known Limitations

1. **No real-time progress**: Progress is only 0% or 100%. The
   `--progress-template` output is not streamed.
2. **MP4 only for duration**: `probe_duration` only works for MP4 files.
3. **Single file match**: `find_downloaded_file` returns the first match;
   multiple files with the same clip ID prefix could cause issues.
4. **Xiaohongshu**: Cannot be auto-downloaded; must be imported manually.
5. **Douyin**: Known upstream yt-dlp bug with cookie handling.

## 12. Code Structure

Testable helper functions live in `src-tauri/src/helpers.rs` with
`pub(crate)` visibility. Tests are in the same file under
`#[cfg(test)] mod tests`. Run with `cargo test` in `src-tauri/`.

Key helpers:
- `format_selection_for_url()` — platform-dependent `-f` argument
- `friendly_download_error()` — stderr → user message mapping
- `detect_platform()` — URL → platform name
- `strip_prefix()` — file rename prefix stripping
- `find_downloaded_file()` / `find_file_by_id()` — file discovery
- `probe_duration()` — MP4 duration via headers
- `build_filter_groups()` — HubSpot query construction
- `augmented_path()` (macOS) / `find_system_ytdlp()` — PATH resolution

## 13. Invariants (Must Always Hold)

1. Downloaded files MUST be playable MP4 with both video and audio streams.
2. `format_selection_for_url()` MUST return `best` for Instagram and
   `bestvideo+bestaudio/best` for all other platforms.
3. `--merge-output-format mp4` MUST always be present in download commands.
4. The cookie retry cascade MUST always end with a no-cookies attempt.
5. `find_downloaded_file` MUST be able to find any file downloaded by
   `run_ytdlp_download` using the same clip ID.
6. The `localfile://` protocol MUST serve video with Range support on all
   platforms.
7. All OS-specific code MUST be gated behind `#[cfg(target_os = "...")]`.
8. Error messages MUST be user-friendly (no raw stderr dumps).
9. The sidecar binary MUST be tried before the system fallback.
10. All tests in `cargo test` MUST pass before any release.
