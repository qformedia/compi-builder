use std::fs;
use std::io::BufReader;
use std::path::PathBuf;

// ── HubSpot Filters ─────────────────────────────────────────────────────────

/// Accepts `YYYY-MM-DD` from HTML date inputs for HubSpot `date` properties.
fn is_plausible_iso_date(s: &str) -> bool {
    let s = s.trim();
    if s.len() != 10 {
        return false;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    s.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// Build HubSpot filterGroups for External Clips search.
/// `tag_mode` = "AND" → one group with all tag filters; "OR" → one group per tag.
/// When `creator_main_link` is provided, every group is narrowed to that creator.
/// `date_from` / `date_to` filter on `date_found` (inclusive, `YYYY-MM-DD`).
pub(crate) fn build_filter_groups(
    tags: &[String],
    scores: &[String],
    never_used: bool,
    tag_mode: &str,
    creator_main_link: Option<&str>,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut shared: Vec<serde_json::Value> = Vec::new();

    if !scores.is_empty() {
        shared.push(serde_json::json!({
            "propertyName": "score",
            "operator": "IN",
            "values": scores
        }));
    }

    if never_used {
        shared.push(serde_json::json!({
            "propertyName": "num_of_published_video_project",
            "operator": "EQ",
            "value": "0"
        }));
    }

    shared.push(serde_json::json!({
        "propertyName": "creator_status",
        "operator": "EQ",
        "value": "Granted"
    }));

    shared.push(serde_json::json!({
        "propertyName": "link_not_working_anymore",
        "operator": "NEQ",
        "value": "true"
    }));

    if let Some(d) = date_from {
        if is_plausible_iso_date(d) {
            shared.push(serde_json::json!({
                "propertyName": "date_found",
                "operator": "GTE",
                "value": d.trim()
            }));
        }
    }
    if let Some(d) = date_to {
        if is_plausible_iso_date(d) {
            shared.push(serde_json::json!({
                "propertyName": "date_found",
                "operator": "LTE",
                "value": d.trim()
            }));
        }
    }

    if let Some(link) = creator_main_link {
        shared.push(serde_json::json!({
            "propertyName": "creator_main_link",
            "operator": "EQ",
            "value": link
        }));
    }

    if tags.is_empty() {
        return vec![serde_json::json!({ "filters": shared })];
    }

    if tag_mode == "OR" {
        tags.iter()
            .map(|tag| {
                let mut group = shared.clone();
                group.push(serde_json::json!({
                    "propertyName": "tags",
                    "operator": "CONTAINS_TOKEN",
                    "value": tag
                }));
                serde_json::json!({ "filters": group })
            })
            .collect()
    } else {
        let mut group = shared;
        for tag in tags {
            group.push(serde_json::json!({
                "propertyName": "tags",
                "operator": "CONTAINS_TOKEN",
                "value": tag
            }));
        }
        vec![serde_json::json!({ "filters": group })]
    }
}

// ── File Helpers ─────────────────────────────────────────────────────────────

/// Strip existing prefixes: "3 - ", "unused_", or both.
pub(crate) fn strip_prefix(name: &str) -> String {
    let mut s = name.to_string();
    if let Some(rest) = s.strip_prefix("unused_") {
        s = rest.to_string();
    }
    if let Some(pos) = s.find(" - ") {
        let prefix = &s[..pos];
        if prefix.chars().all(|c| c.is_ascii_digit()) {
            s = s[pos + 3..].to_string();
        }
    }
    s
}

/// Find a file in a directory whose name contains the given ID prefix
/// (after stripping order/unused prefixes).
pub(crate) fn find_file_by_id(dir: &PathBuf, id_prefix: &str) -> Option<PathBuf> {
    if id_prefix.is_empty() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let clean = strip_prefix(&name);
        if clean.starts_with(id_prefix) {
            return Some(entry.path());
        }
    }
    None
}

/// Find a downloaded file by clip ID prefix.
/// Returns a **relative** path like "clips/ID_title.mp4".
/// When multiple files match (e.g. a leftover .m4a and a new .mp4),
/// prefers `.mp4` files, then falls back to the most recently modified.
pub(crate) fn find_downloaded_file(clips_dir: &PathBuf, clip_id: &str) -> Option<String> {
    let prefix = format!("{clip_id}_");
    let mut matches: Vec<(String, std::time::SystemTime)> = Vec::new();

    if let Ok(entries) = fs::read_dir(clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::UNIX_EPOCH);
                matches.push((name, mtime));
            }
        }
    }

    if matches.is_empty() {
        return None;
    }

    // Prefer .mp4 files (the intended output format)
    if let Some(mp4) = matches.iter().find(|(n, _)| n.ends_with(".mp4")) {
        return Some(format!("clips/{}", mp4.0));
    }

    // Fall back to most recently modified
    matches.sort_by(|a, b| b.1.cmp(&a.1));
    Some(format!("clips/{}", matches[0].0))
}

/// Remove all existing files for a clip ID from the clips directory.
/// Called before re-downloading so stale/broken files don't interfere.
pub(crate) fn remove_existing_clip_files(clips_dir: &PathBuf, clip_id: &str) -> Vec<String> {
    let prefix = format!("{clip_id}_");
    let mut removed = Vec::new();

    if let Ok(entries) = fs::read_dir(clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                if fs::remove_file(entry.path()).is_ok() {
                    removed.push(name);
                }
            }
        }
    }

    removed
}

/// Get duration of a local video file by reading MP4 headers.
pub(crate) fn probe_duration(path: &str) -> Option<f64> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[probe_duration] cannot open {path}: {e}");
            return None;
        }
    };
    let size = file.metadata().ok()?.len();
    let reader = BufReader::new(file);
    match mp4::Mp4Reader::read_header(reader, size) {
        Ok(mp4) => Some(mp4.duration().as_secs_f64()),
        Err(e) => {
            eprintln!("[probe_duration] failed to parse MP4 headers for {path}: {e}");
            None
        }
    }
}

// ── Download Helpers ─────────────────────────────────────────────────────────

/// Lowercase platform key used for provider cascade lookups.
pub(crate) fn platform_key(url: &str) -> &str {
    if url.contains("instagram.com") {
        "instagram"
    } else if url.contains("tiktok.com") {
        "tiktok"
    } else if url.contains("douyin.com") {
        "douyin"
    } else if url.contains("youtube.com") || url.contains("youtu.be") {
        "youtube"
    } else if url.contains("bilibili.com") {
        "bilibili"
    } else if url.contains("xiaohongshu.com") {
        "xiaohongshu"
    } else if url.contains("kuaishou.com") {
        "kuaishou"
    } else {
        "default"
    }
}

/// Display-friendly platform name from URL, derived from `platform_key`.
pub(crate) fn detect_platform(url: &str) -> &str {
    match platform_key(url) {
        "instagram" => "Instagram",
        "tiktok" => "TikTok",
        "douyin" => "Douyin",
        "youtube" => "YouTube",
        "bilibili" => "Bilibili",
        "xiaohongshu" => "Xiaohongshu",
        "kuaishou" => "Kuaishou",
        _ => "this platform",
    }
}

/// Resolve the ordered list of download providers for a URL.
/// `providers_json` is the JSON-serialised `DownloadProviders` map from settings.
/// Falls back to the `"default"` key, then to `["ytdlp"]`.
pub(crate) fn providers_for_url(url: &str, providers_json: &Option<String>) -> Vec<String> {
    let key = platform_key(url);
    if let Some(json) = providers_json {
        if let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(json)
        {
            if let Some(list) = map.get(key) {
                if !list.is_empty() {
                    return list.clone();
                }
            }
            if let Some(list) = map.get("default") {
                if !list.is_empty() {
                    return list.clone();
                }
            }
        }
    }
    vec!["ytdlp".to_string()]
}

/// Translate raw yt-dlp stderr into user-friendly error messages.
pub(crate) fn friendly_download_error(
    stderr: &str,
    url: &str,
    cookies_browser: &Option<String>,
) -> String {
    let lower = stderr.to_lowercase();
    let platform = detect_platform(url);
    let browser = cookies_browser.as_deref().unwrap_or("your browser");

    // Both the bundled binary AND the self-repair attempt failed. The cascade in
    // `run_ytdlp` already produces actionable, OS-specific copy via
    // `format_unavailable_error`, so just pass it through unchanged.
    if lower.contains("could not start the video downloader") {
        return stderr.trim().to_string();
    }

    // Hard timeout fired in run_ytdlp_binary / sidecar wrapper. The underlying
    // process was killed; tell the user the source server is unresponsive and
    // a retry is the right next step.
    if lower.contains("yt-dlp timed out") {
        return format!(
            "{} download timed out — the source server is unresponsive. Retry the download in a moment.",
            platform
        );
    }

    // Startup-class failure observed in the bundled binary's own stderr.
    // The cascade will trigger self-repair on the next attempt, so tell the
    // user that recovery is in progress instead of asking them to reinstall.
    if lower.contains("no module named expat") || lower.contains("[pyi-") || lower.contains("_mei")
    {
        return concat!(
            "CompiFlow's video downloader had a temporary startup problem. ",
            "It is repairing itself automatically — please retry the download in a moment."
        )
        .into();
    }

    if lower.contains("[douyin]") && lower.contains("fresh cookies") {
        return "Douyin downloads are temporarily broken in yt-dlp (known bug). Check for yt-dlp updates.".into();
    }

    if lower.contains("not granting access") || lower.contains("empty media response") {
        return format!(
            "Login required. Open {} and log into {}, then close it and retry.",
            browser, platform
        );
    }
    if lower.contains("could not find") && lower.contains("cookie") {
        return format!(
            "Could not read cookies from {}. Make sure it's installed. Try closing {} before downloading.",
            browser, browser
        );
    }
    if lower.contains("could not copy") && lower.contains("cookie") {
        return format!(
            "Could not copy {} cookie database. Close {} completely and retry.",
            browser, browser
        );
    }
    if lower.contains("failed to decrypt") && lower.contains("cookie") {
        return format!(
            "Cannot decrypt {} cookies. Try closing {} completely and retry.",
            browser, browser
        );
    }
    if lower.contains("video is unavailable") || lower.contains("removed") {
        return format!("This {} video is no longer available.", platform);
    }
    if lower.contains("private video") {
        return format!(
            "This {} video is private. Log into {} first.",
            platform, browser
        );
    }
    if lower.contains("urlopen error") || lower.contains("connection") {
        return "Network error. Check your internet connection.".into();
    }
    if lower.contains("unsupported url") {
        return format!(
            "{} links can't be downloaded automatically. Use KuKuTool or import the file manually.",
            platform
        );
    }

    stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(stderr)
        .trim()
        .to_string()
}

/// Build the yt-dlp format selection argument based on the URL.
///
/// Instagram serves single combined streams where the codec metadata is often
/// missing (`vcodec: null`). Using `bestvideo+bestaudio` can cause yt-dlp to
/// select a VP9 DASH video-only stream, resulting in black/silent videos.
/// We use `best` (pre-merged) for Instagram and the standard split selection
/// for other platforms.
pub(crate) fn format_selection_for_url(url: &str) -> &'static str {
    if url.contains("instagram.com") {
        "best"
    } else {
        "bestvideo+bestaudio/best"
    }
}

/// macOS .app bundles don't inherit the user's shell PATH. Build an augmented
/// PATH that includes well-known Homebrew directories.
#[cfg(target_os = "macos")]
pub(crate) fn augmented_path() -> String {
    let extra = ["/opt/homebrew/bin", "/usr/local/bin"];
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = extra.to_vec();
    if !current.is_empty() {
        parts.push(&current);
    }
    parts.join(":")
}

/// Resolve the system-installed yt-dlp path, checking common locations that may
/// not be in PATH when launched as a macOS .app bundle.
#[cfg(debug_assertions)]
pub(crate) fn find_system_ytdlp() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let extra_paths = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
        for p in &extra_paths {
            let path = std::path::PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    which::which("yt-dlp").ok()
}

/// Bundled yt-dlp sidecar filename inside `Resources/binaries/` (Tauri `externalBin` naming).
#[cfg(target_os = "macos")]
pub(crate) fn ytdlp_sidecar_filename() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "yt-dlp-aarch64-apple-darwin",
        "x86_64" => "yt-dlp-x86_64-apple-darwin",
        _ => "yt-dlp-aarch64-apple-darwin",
    }
}

/// Relative path to the pre-extracted macOS yt-dlp executable bundled as a resource.
#[cfg(target_os = "macos")]
pub(crate) fn ytdlp_macos_resource_executable() -> &'static str {
    "binaries/yt-dlp_macos/yt-dlp_macos"
}

/// Remove macOS download quarantine from a file or directory so Gatekeeper allows execution.
/// Best-effort: no-op if `xattr` is missing or the attribute is not set.
#[cfg(target_os = "macos")]
pub(crate) fn unquarantine_path(path: &std::path::Path) {
    use std::process::Command;

    if !path.exists() {
        return;
    }

    fn strip(path: &std::path::Path) {
        let _ = Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(path)
            .output();
    }

    strip(path);
    if path.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            unquarantine_path(&entry.path());
        }
    }
}

// ── General Search Helpers ───────────────────────────────────────────────────

/// Supported social platforms for General Search
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum SocialPlatform {
    Instagram,
    TikTok,
}

/// A parsed social media clip URL
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct ParsedSocialUrl {
    pub url: String,
    pub platform: SocialPlatform,
    /// TikTok: extracted from URL; Instagram: None (needs network resolution)
    pub handle: Option<String>,
    /// Full profile URL (constructed from handle when available)
    pub profile_url: Option<String>,
}

/// Parse a raw text block of URLs into structured entries.
/// Filters out empty lines, non-Instagram/TikTok URLs, and deduplicates.
pub(crate) fn parse_social_urls(raw: &str) -> Vec<ParsedSocialUrl> {
    let mut seen = std::collections::HashSet::new();
    raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let url = line.to_string();
            if !seen.insert(url.clone()) {
                return None;
            }

            if url.contains("tiktok.com") {
                let handle = extract_tiktok_handle(&url);
                let profile_url = handle
                    .as_ref()
                    .map(|h| format!("https://www.tiktok.com/@{}", h));
                Some(ParsedSocialUrl {
                    url,
                    platform: SocialPlatform::TikTok,
                    handle,
                    profile_url,
                })
            } else if url.contains("instagram.com") {
                Some(ParsedSocialUrl {
                    url,
                    platform: SocialPlatform::Instagram,
                    handle: None,
                    profile_url: None,
                })
            } else {
                None
            }
        })
        .collect()
}

/// Extract the TikTok handle from a URL like `tiktok.com/@handle/video/123`
pub(crate) fn extract_tiktok_handle(url: &str) -> Option<String> {
    let re = regex::Regex::new(r"tiktok\.com/@([^/?]+)").ok()?;
    let caps = re.captures(url)?;
    Some(caps.get(1)?.as_str().to_string())
}

/// Extract the Instagram shortcode from a reel/post URL
pub(crate) fn extract_instagram_shortcode(url: &str) -> Option<String> {
    let re = regex::Regex::new(r"/(reel|reels|p)/([^/?]+)").ok()?;
    let caps = re.captures(url)?;
    Some(caps.get(2)?.as_str().to_string())
}

/// Extract a username from Instagram embed/oEmbed HTML.
/// Looks for profile links like `href="/username/"` or `instagram.com/username/`
///
/// Anchored to a real `instagram.com` domain boundary so substrings inside
/// `cdninstagram.com/v/...` thumbnail URLs cannot leak through as handles.
/// Filters out Instagram-reserved path tokens (system pages, CDN asset paths
/// like `rsrc.php`, etc.) so we never claim those as a creator handle.
pub(crate) fn extract_instagram_username_from_html(html: &str) -> Option<String> {
    // The leading `(?:^|//|[^a-zA-Z0-9.-])` requires a domain boundary before
    // `instagram.com` — otherwise `cdninstagram.com/v/...` would match and
    // we'd return `v` as the handle.
    let re = regex::Regex::new(
        r#"(?:^|//|[^a-zA-Z0-9.-])(?:www\.)?instagram\.com/([a-zA-Z0-9._]+)"#,
    )
    .ok()?;
    for caps in re.captures_iter(html) {
        let candidate = caps.get(1)?.as_str();
        if is_valid_instagram_handle_candidate(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Parse the username out of a canonical Instagram profile URL.
///
/// Used by SocialKit recovery and as a defensive helper anywhere we need to
/// extract a handle from an `authorLink`-style URL. Only accepts strict
/// `instagram.com/<handle>` shapes; rejects anything that doesn't look like
/// a valid handle (numeric pk values, reserved paths, CDN segments).
pub(crate) fn username_from_ig_profile_url(link: &str) -> Option<String> {
    let re = regex::Regex::new(
        r#"^https?://(?:www\.)?instagram\.com/([a-zA-Z0-9._]+)/?"#,
    )
    .ok()?;
    let caps = re.captures(link.trim())?;
    let candidate = caps.get(1)?.as_str();
    if is_valid_instagram_handle_candidate(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Pick a real Instagram handle from a yt-dlp `--dump-json` payload.
///
/// yt-dlp's Instagram extractor sets `channel = user_info['username']` (the
/// real handle) and `uploader_id = user_info['pk']` (the numeric Instagram
/// internal ID). Reading `uploader_id` first — which the code used to do —
/// produced creators like `@65486544502` for any clip that fell through to
/// the yt-dlp strategy.
///
/// Order:
/// 1. `channel` — yt-dlp's username field for IG.
/// 2. `uploader_id` — only when not all-digits (TikTok-style legacy posts
///    sometimes have a username here; modern IG entries do not).
/// 3. `uploader` — display name fallback. Not ideal as a handle but better
///    than the numeric pk and still surfaces something reviewable in the UI.
pub(crate) fn pick_ig_handle_from_ytdlp(j: &serde_json::Value) -> Option<String> {
    let pick = |key: &str| {
        j.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    if let Some(s) = pick("channel") {
        return Some(s.to_string());
    }
    if let Some(s) = pick("uploader_id") {
        if !s.chars().all(|c| c.is_ascii_digit()) {
            return Some(s.to_string());
        }
    }
    pick("uploader").map(String::from)
}

/// Reject Instagram path tokens that can never be valid usernames.
///
/// IG handles are `[A-Za-z0-9._]{1,30}` but cannot contain `..`, end with `.`,
/// or look like CDN asset filenames (e.g. `rsrc.php`). Reserved system path
/// segments (`reel`, `accounts`, `explore`, …) are also excluded.
fn is_valid_instagram_handle_candidate(candidate: &str) -> bool {
    /// Instagram-reserved path segments that route to system pages or CDN assets,
    /// not to user profiles. Anything matched here means the scrape latched onto
    /// the wrong link in the embed HTML.
    const RESERVED_PATHS: &[&str] = &[
        "about",
        "accounts",
        "api",
        "challenge",
        "developer",
        "direct",
        "embed",
        "emails",
        "explore",
        "hashtag",
        "igtv",
        "legal",
        "oauth",
        "p",
        "press",
        "privacy",
        "reel",
        "reels",
        "rsrc.php",
        "settings",
        "static",
        "stories",
        "tags",
        "terms",
        "tv",
        "verification",
        "web",
    ];

    if candidate.is_empty() || candidate.len() > 30 {
        return false;
    }
    if candidate.starts_with('.') || candidate.ends_with('.') || candidate.contains("..") {
        return false;
    }
    // CDN/asset paths surface as "name.ext" — never a real handle.
    if let Some(ext) = candidate.rsplit('.').next() {
        if matches!(ext, "php" | "html" | "htm" | "js" | "css" | "json" | "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp") {
            return false;
        }
    }
    if RESERVED_PATHS.contains(&candidate) {
        return false;
    }
    if candidate.starts_with("reel") {
        return false;
    }
    // Single-letter tokens like `v`, `t`, `s` only appear in CDN paths
    // (`scontent.cdninstagram.com/v/...`). Real IG handles are ≥ 2 chars.
    if candidate.len() == 1 {
        return false;
    }
    // All-digit candidates with length ≥ 6 are Instagram `pk` (internal user
    // ID) values that leak in via SocialKit fallbacks or embed-page JSON
    // blobs. Real numeric-only IG handles are rare and well below 6 digits.
    if candidate.len() >= 6 && candidate.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    true
}

/// Extract caption text from Instagram embed HTML
pub(crate) fn extract_instagram_caption_from_html(html: &str) -> Option<String> {
    // The captioned embed page has the caption in a <div class="Caption"> or in og:description
    if let Some(desc) = extract_meta_content_text(html, "og:description") {
        if !desc.is_empty() {
            return Some(desc);
        }
    }
    // Fallback: look for the caption container
    let re = regex::Regex::new(r#"class="Caption"[^>]*>(.*?)</div>"#).ok()?;
    let caps = re.captures(html)?;
    let raw = caps.get(1)?.as_str();
    let text = raw
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    // Strip remaining HTML tags
    let stripped = regex::Regex::new(r"<[^>]+>").ok()?.replace_all(&text, "");
    let result = stripped.trim().to_string();
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

/// Extract text content from a meta property tag (not just URLs)
pub(crate) fn extract_meta_content_text(html: &str, property: &str) -> Option<String> {
    let search = format!("property=\"{}\"", property);
    let pos = html.find(&search).or_else(|| {
        let alt = format!("name=\"{}\"", property);
        html.find(&alt)
    })?;

    let region = &html[pos.saturating_sub(200)..std::cmp::min(pos + 2000, html.len())];
    let content_re = regex::Regex::new(r#"content="([^"]*?)""#).ok()?;
    let caps = content_re.captures(region)?;
    let value = caps.get(1)?.as_str().to_string();
    let decoded = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#039;", "'")
        .replace("&quot;", "\"");
    Some(decoded)
}

/// Extract hashtags from a social media caption and return them semicolon-separated.
/// Handles both `#tag` and adjacent `#tag1#tag2` patterns.
/// Returns None if no hashtags are found.
#[allow(dead_code)]
pub(crate) fn extract_hashtags(caption: &str) -> Option<String> {
    let re = regex::Regex::new(r"#([A-Za-z0-9_]+)").ok()?;
    let tags: Vec<String> = re
        .captures_iter(caption)
        .map(|c| c.get(1).unwrap().as_str().to_string())
        .collect();
    if tags.is_empty() {
        None
    } else {
        Some(tags.join(";"))
    }
}

// ── Creator property registry ────────────────────────────────────────────────

/// HubSpot internal property names fetched by `fetch_creators_batch` for
/// every "deep read" surface that needs to render the creator side-by-side
/// (e.g. the Duplicates page detail view). The narrower CSV-export path uses
/// only a subset of these (see `name`, `main_link`, etc.) but reusing one
/// canonical list keeps the request payloads consistent and avoids a creator
/// suddenly losing a column when a new feature consumes the same fetch.
///
/// HubSpot Creator property name that stores the profile URL for the given
/// platform key, or `None` if we don't have a dedicated column. The names
/// mirror the team's Creator object schema in HubSpot — kept in sync with
/// the dropdown options on the `main_account` property.
///
/// HubSpot computes `main_link` from these columns; never write `main_link`
/// directly because it's a calculated property and the API will 400.
pub(crate) fn hubspot_creator_url_property(platform_key: &str) -> Option<&'static str> {
    match platform_key {
        "instagram" => Some("instagram"),
        "tiktok" => Some("tiktok"),
        "youtube" => Some("youtube"),
        "facebook" => Some("facebook"),
        "twitter" | "x" => Some("x"),
        "bilibili" => Some("bilibili"),
        "douyin" => Some("douyin_id"),
        "xiaohongshu" => Some("xiaohongshu_id"),
        "kuaishou" => Some("kuaishou_id"),
        "ixigua" => Some("ixigua"),
        _ => None,
    }
}

/// Keep this in sync with the side-by-side property labels in
/// `src/lib/duplicates/diff.ts` — a property that's fetched here but missing
/// from the labels registry will render with its raw HubSpot internal name.
pub(crate) fn full_creator_properties() -> &'static [&'static str] {
    &[
        // Identity / classification
        "name",
        "email",
        "main_link",
        "main_account",
        "status",
        "category",
        "tags",
        "hubspot_owner_id",
        // License info — surfaced as a dedicated card on the Duplicates
        // detail page (see LICENSE_INFO_KEYS in src/lib/duplicates/diff.ts).
        // All of these come from the HubSpot `license_information` group.
        "license_type",
        "license_checked",
        "license_file",
        "traceability_file",
        "available_channels",
        "available_platforms",
        "date_granted",
        // Profile URLs (the 5 in-scope columns + cross-network extras)
        "instagram",
        "secondary_instagram",
        "tiktok",
        "secondary_tiktok",
        "youtube",
        "facebook",
        "x",
        "web",
        "other_links",
        // China-network handles (both the profile URL and the bare-handle *_id)
        "from_china",
        "bilibili",
        "douyin",
        "douyin_id",
        "ixigua",
        "kuaishou",
        "kuaishou_id",
        "weibo",
        "wechat",
        "xiaohongshu",
        "xiaohongshu_id",
        // Notes / follow-up
        "notes",
        "keep_up_1",
        "keep_up_2",
        "keep_up_3",
        "date_found",
        "date_initial_contact",
        "video_types_could_do",
        "discarded",
        "special_requests",
        // System / activity
        "hs_createdate",
        "hs_lastmodifieddate",
        // Rollup counts (team-defined properties)
        "num_of_contacts",
        "num_of_external_clips",
        "num_of_public_video_projects",
        "num_of_send_link_actions",
        "num_of_social_interactions",
        "num_of_video_projects",
    ]
}

// ── Native HubSpot merge ────────────────────────────────────────────────────

/// Validate the inputs for a HubSpot merge call. Returns the trimmed
/// `(winner, loser)` tuple on success, or a user-facing error message.
///
/// Centralised so the Tauri command and any future callers (e.g. a CLI
/// repair tool) share the same guardrails — the merge endpoint is
/// irreversible, so we want both ids non-empty and clearly distinct
/// before any network traffic happens.
pub(crate) fn validate_merge_ids(
    winner: &str,
    loser: &str,
) -> Result<(String, String), String> {
    let w = winner.trim().to_string();
    let l = loser.trim().to_string();
    if w.is_empty() || l.is_empty() {
        return Err("Winner and loser ids must both be non-empty".to_string());
    }
    if w == l {
        return Err("Winner and loser must be different records".to_string());
    }
    Ok((w, l))
}

/// Build the HubSpot v3 merge endpoint URL for the given custom-object id
/// (e.g. `2-191972671` for Creators). Pulled out so the Tauri command body
/// stays a thin glue layer and the URL shape is unit-testable.
pub(crate) fn hubspot_merge_url(object_type_id: &str) -> String {
    format!(
        "https://api.hubapi.com/crm/v3/objects/{}/merge",
        object_type_id
    )
}

/// Build the merge request body. HubSpot expects camelCase keys —
/// `primaryObjectId` is the winner that survives, `objectIdToMerge` is
/// the loser that gets archived and redirected.
pub(crate) fn hubspot_merge_body(winner_id: &str, loser_id: &str) -> serde_json::Value {
    serde_json::json!({
        "primaryObjectId": winner_id,
        "objectIdToMerge": loser_id,
    })
}

// ── Association-limit detection & pre-swap planning ──────────────────────────
//
// HubSpot's `POST /crm/v3/objects/{type}/merge` endpoint refuses to swap
// associations atomically when the admin has configured a per-record cap.
// The user-visible failure is a generic `VALIDATION_ERROR` with no detail
// about which pair tripped the limit. We work around it by:
//
//   1. Recognising the specific error text so the frontend can fall back to
//      the reassign flow only when this is the actual cause.
//   2. Probing each configured association limit involving the merging
//      object type and deciding whether the pair needs a pre-swap (limit on
//      the OTHER side, e.g. "1 Creator per External Clip") or a hard bail
//      (limit on the merging side that the union would exceed).
//
// All helpers here are intentionally pure — they take parsed JSON and return
// either a plan or a validation outcome — so we can unit-test them without
// spinning up an HTTP mock for HubSpot.

/// True when a HubSpot error string is the specific "association
/// configuration limits exceeded" payload that the merge endpoint returns
/// when an admin-configured per-record cap blocks the merge.
///
/// The merge endpoint only ever surfaces this exact phrase for this
/// failure mode, so we can detect it cheaply with a substring check
/// without parsing the JSON body. Stays case-sensitive because HubSpot
/// always returns the same casing — a future relaxation should be paired
/// with a wider response payload contract test.
pub(crate) fn is_association_limit_error(message: &str) -> bool {
    message.contains("Association configuration limits are exceeded")
}

/// Decision for a single (other-object-type, direction) configuration
/// after probing HubSpot's `/configurations/{from}/{to}` endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AssocLimitDirection {
    /// The cap lives on the OTHER side ("each {other} can have at most N
    /// {merging}"). When N is finite and small, merging would temporarily
    /// double-associate each loser-attached record; we pre-swap them
    /// (archive loser-association, then create winner-association).
    OtherSide { max: u32, type_id: u64, category: String },
    /// The cap lives on the MERGING side ("each {merging} can have at
    /// most N {other}"). The merge would push the winner past N if the
    /// union of (winner's count + loser's count) exceeds N, so we bail
    /// with a clear error before touching any records.
    MergingSide { max: u32 },
}

/// Per-pair plan derived from configurations + actual loser-side counts.
///
/// `other_object_type_id` is the HubSpot object type id of the side
/// opposite the merging records (e.g. External Clips when merging
/// Creators). Used by the caller to address the right `/v4/associations/`
/// endpoints when executing the plan.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AssocPairPlan {
    pub other_object_type_id: String,
    pub other_object_label: String,
    pub direction: AssocLimitDirection,
    /// Loser-side total of associations of this pair, sourced from the
    /// rollup property (e.g. `num_of_external_clips`). Only consulted for
    /// `MergingSide` pre-flight validation; ignored for `OtherSide`
    /// because we always page through the actual association ids before
    /// swapping anyway.
    pub loser_count: u32,
    /// Winner-side total of associations of this pair, sourced from the
    /// same rollup property on the winner. Only consulted for
    /// `MergingSide` pre-flight validation.
    pub winner_count: u32,
}

/// Outcome of evaluating a single `MergingSide` cap. Either the merge can
/// proceed for this pair or we have a precise human-readable explanation
/// of which pair would exceed the cap and by how much.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MergingSideOutcome {
    Ok,
    Exceeded {
        message: String,
    },
}

/// Decide whether a `MergingSide` cap would be violated by the merge.
///
/// The post-merge upper bound is `winner_count + loser_count` (HubSpot
/// could deduplicate records associated to both sides, which is rare; the
/// rollups don't tell us the overlap, so we use the safe upper bound — a
/// false-positive bail is far less harmful than a confusing post-merge
/// failure).
pub(crate) fn evaluate_merging_side_cap(
    plan: &AssocPairPlan,
    merging_label: &str,
) -> MergingSideOutcome {
    let max = match plan.direction {
        AssocLimitDirection::MergingSide { max } => max,
        AssocLimitDirection::OtherSide { .. } => return MergingSideOutcome::Ok,
    };
    let predicted = plan.winner_count.saturating_add(plan.loser_count);
    if predicted <= max {
        return MergingSideOutcome::Ok;
    }
    let message = format!(
        "Cannot merge: the surviving {merging_label} would end up with up to {predicted} {other} \
         (winner has {winner}, loser has {loser}), which exceeds your portal's limit of \
         {max} {other} per {merging_label}. Detach some {other} from one side in HubSpot \
         first, or have an admin raise the limit in Settings → Properties → Associations.",
        merging_label = merging_label,
        other = plan.other_object_label,
        predicted = predicted,
        winner = plan.winner_count,
        loser = plan.loser_count,
        max = max,
    );
    MergingSideOutcome::Exceeded { message }
}

/// Parse a single configuration entry from
/// `GET /crm/v4/associations/definitions/configurations/{from}/{to}`.
///
/// Returns `Some((max, type_id, category))` when the entry has a finite
/// `userEnforcedMaxToObjectIds` cap; `None` for entries representing
/// "Many" (no admin-set cap) or malformed entries we can't reason about.
///
/// The shape we accept matches the documented OpenAPI schema for
/// `PublicAssociationDefinitionUserConfiguration` but is tolerant about
/// missing / null fields — HubSpot has historically added fields without
/// a major-version bump and we don't want to break on a benign addition.
pub(crate) fn parse_assoc_limit_entry(
    entry: &serde_json::Value,
) -> Option<(u32, u64, String)> {
    let max = entry.get("userEnforcedMaxToObjectIds").and_then(|v| v.as_u64())?;
    let type_id = entry.get("typeId").and_then(|v| v.as_u64())?;
    let category = entry
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("HUBSPOT_DEFINED")
        .to_string();
    if max == 0 {
        // Defensive: HubSpot disallows 0 in the UI, but if it ever surfaces
        // here we'd never want to "swap" zero associations, so treat as no
        // cap (let the merge proceed and surface any actual error normally).
        return None;
    }
    Some((max as u32, type_id, category))
}

/// Pick the most-restrictive cap from a configurations response body.
///
/// HubSpot returns a `results` array with one entry per (typeId, label)
/// configuration on the pair. The merge engine's effective cap is the
/// minimum across labels (any label hitting its cap rejects the merge).
/// Returns `None` if no entry has a finite cap — the configurations
/// endpoint may legitimately return entries with `userEnforcedMaxToObjectIds`
/// absent when the admin chose "Many" for every label.
pub(crate) fn most_restrictive_limit(
    body: &serde_json::Value,
) -> Option<(u32, u64, String)> {
    let results = body.get("results").and_then(|v| v.as_array())?;
    let mut best: Option<(u32, u64, String)> = None;
    for entry in results {
        if let Some((max, type_id, category)) = parse_assoc_limit_entry(entry) {
            match &best {
                None => best = Some((max, type_id, category)),
                Some((current_max, _, _)) if max < *current_max => {
                    best = Some((max, type_id, category));
                }
                _ => {}
            }
        }
    }
    best
}

// ── Tests ────────────────────────────────────────────────────────────────────

pub(crate) fn combine_multi_file_value(winner: &str, loser: &str) -> String {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut process = |s: &str| {
        for token in s.split(|c: char| c == ';' || c == ',' || c.is_whitespace()) {
            let t = token.trim();
            if !t.is_empty() && seen.insert(t.to_string()) {
                out.push(t.to_string());
            }
        }
    };

    process(winner);
    process(loser);

    out.join(";")
}

pub(crate) fn safe_storage_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_prefix ─────────────────────────────────────────────────────

    #[test]
    fn strip_prefix_removes_unused() {
        assert_eq!(strip_prefix("unused_clip.mp4"), "clip.mp4");
    }

    #[test]
    fn strip_prefix_removes_order_number() {
        assert_eq!(strip_prefix("3 - clip.mp4"), "clip.mp4");
        assert_eq!(strip_prefix("12 - my_video.mp4"), "my_video.mp4");
    }

    #[test]
    fn strip_prefix_removes_both() {
        assert_eq!(strip_prefix("unused_3 - clip.mp4"), "clip.mp4");
    }

    #[test]
    fn strip_prefix_noop_on_clean_name() {
        assert_eq!(strip_prefix("abc_video.mp4"), "abc_video.mp4");
    }

    #[test]
    fn strip_prefix_preserves_dash_in_name() {
        assert_eq!(strip_prefix("my - video.mp4"), "my - video.mp4");
    }

    #[test]
    fn strip_prefix_empty_string() {
        assert_eq!(strip_prefix(""), "");
    }

    // ── platform_key ──────────────────────────────────────────────────────

    #[test]
    fn platform_key_returns_lowercase_keys() {
        assert_eq!(
            platform_key("https://www.instagram.com/reel/ABC/"),
            "instagram"
        );
        assert_eq!(
            platform_key("https://www.tiktok.com/@user/video/123"),
            "tiktok"
        );
        assert_eq!(platform_key("https://www.douyin.com/video/123"), "douyin");
        assert_eq!(
            platform_key("https://www.youtube.com/watch?v=abc"),
            "youtube"
        );
        assert_eq!(platform_key("https://youtu.be/abc"), "youtube");
        assert_eq!(
            platform_key("https://www.bilibili.com/video/BV123"),
            "bilibili"
        );
        assert_eq!(
            platform_key("https://www.xiaohongshu.com/explore/abc"),
            "xiaohongshu"
        );
        assert_eq!(
            platform_key("https://www.kuaishou.com/short-video/abc"),
            "kuaishou"
        );
        assert_eq!(platform_key("https://example.com/video"), "default");
    }

    // ── detect_platform ──────────────────────────────────────────────────

    #[test]
    fn detect_platform_instagram() {
        assert_eq!(
            detect_platform("https://www.instagram.com/reel/ABC/"),
            "Instagram"
        );
        assert_eq!(detect_platform("https://instagram.com/p/XYZ/"), "Instagram");
    }

    #[test]
    fn detect_platform_youtube() {
        assert_eq!(
            detect_platform("https://www.youtube.com/watch?v=abc"),
            "YouTube"
        );
        assert_eq!(detect_platform("https://youtu.be/abc"), "YouTube");
    }

    #[test]
    fn detect_platform_tiktok() {
        assert_eq!(
            detect_platform("https://www.tiktok.com/@user/video/123"),
            "TikTok"
        );
    }

    #[test]
    fn detect_platform_douyin() {
        assert_eq!(
            detect_platform("https://www.douyin.com/video/123"),
            "Douyin"
        );
    }

    #[test]
    fn detect_platform_bilibili() {
        assert_eq!(
            detect_platform("https://www.bilibili.com/video/BV123"),
            "Bilibili"
        );
    }

    #[test]
    fn detect_platform_xiaohongshu() {
        assert_eq!(
            detect_platform("https://www.xiaohongshu.com/explore/abc"),
            "Xiaohongshu"
        );
    }

    #[test]
    fn detect_platform_unknown() {
        assert_eq!(
            detect_platform("https://example.com/video"),
            "this platform"
        );
    }

    // ── providers_for_url ───────────────────────────────────────────────

    #[test]
    fn providers_for_url_douyin_uses_evil0ctal_first() {
        let json = r#"{"douyin":["evil0ctal","ytdlp"],"default":["ytdlp"]}"#;
        let result = providers_for_url("https://www.douyin.com/video/123", &Some(json.into()));
        assert_eq!(result, vec!["evil0ctal", "ytdlp"]);
    }

    #[test]
    fn providers_for_url_youtube_falls_back_to_default() {
        let json = r#"{"douyin":["evil0ctal","ytdlp"],"default":["ytdlp"]}"#;
        let result = providers_for_url("https://youtube.com/watch?v=abc", &Some(json.into()));
        assert_eq!(result, vec!["ytdlp"]);
    }

    #[test]
    fn providers_for_url_no_json_returns_ytdlp() {
        let result = providers_for_url("https://www.douyin.com/video/123", &None);
        assert_eq!(result, vec!["ytdlp"]);
    }

    #[test]
    fn providers_for_url_invalid_json_returns_ytdlp() {
        let result =
            providers_for_url("https://www.douyin.com/video/123", &Some("not json".into()));
        assert_eq!(result, vec!["ytdlp"]);
    }

    #[test]
    fn providers_for_url_empty_list_falls_back_to_default() {
        let json = r#"{"douyin":[],"default":["ytdlp"]}"#;
        let result = providers_for_url("https://www.douyin.com/video/123", &Some(json.into()));
        assert_eq!(result, vec!["ytdlp"]);
    }

    // ── friendly_download_error ──────────────────────────────────────────

    #[test]
    fn friendly_error_login_required() {
        let msg = friendly_download_error(
            "ERROR: not granting access to this resource",
            "https://instagram.com/reel/abc/",
            &Some("chrome".into()),
        );
        assert!(msg.contains("Login required"), "got: {msg}");
        assert!(msg.contains("Instagram"));
        assert!(msg.contains("chrome"));
    }

    #[test]
    fn friendly_error_empty_media() {
        let msg = friendly_download_error(
            "ERROR: empty media response",
            "https://tiktok.com/@u/video/1",
            &None,
        );
        assert!(msg.contains("Login required"));
        assert!(msg.contains("TikTok"));
    }

    #[test]
    fn friendly_error_douyin_bug() {
        let msg = friendly_download_error(
            "[douyin] ERROR: fresh cookies required",
            "https://douyin.com/video/123",
            &None,
        );
        assert!(msg.contains("temporarily broken"));
    }

    #[test]
    fn friendly_error_cookie_not_found() {
        let msg = friendly_download_error(
            "ERROR: could not find cookie database",
            "https://instagram.com/reel/x/",
            &Some("edge".into()),
        );
        assert!(msg.contains("Could not read cookies from edge"));
    }

    #[test]
    fn friendly_error_cookie_copy_failed() {
        let msg = friendly_download_error(
            "could not copy cookie database",
            "https://youtube.com/watch?v=x",
            &Some("brave".into()),
        );
        assert!(msg.contains("Could not copy brave cookie database"));
    }

    #[test]
    fn friendly_error_decrypt_failed() {
        let msg = friendly_download_error(
            "ERROR: failed to decrypt cookie value",
            "https://youtube.com/watch?v=x",
            &Some("chrome".into()),
        );
        assert!(msg.contains("Cannot decrypt chrome cookies"));
    }

    #[test]
    fn friendly_error_video_unavailable() {
        let msg = friendly_download_error(
            "ERROR: video is unavailable",
            "https://youtube.com/watch?v=x",
            &None,
        );
        assert!(msg.contains("no longer available"));
        assert!(msg.contains("YouTube"));
    }

    #[test]
    fn friendly_error_removed() {
        let msg = friendly_download_error(
            "ERROR: This video has been removed",
            "https://tiktok.com/@u/video/1",
            &None,
        );
        assert!(msg.contains("no longer available"));
    }

    #[test]
    fn friendly_error_private() {
        let msg = friendly_download_error(
            "ERROR: private video",
            "https://youtube.com/watch?v=x",
            &Some("chrome".into()),
        );
        assert!(msg.contains("private"));
        assert!(msg.contains("chrome"));
    }

    #[test]
    fn friendly_error_network() {
        let msg = friendly_download_error(
            "ERROR: urlopen error [Errno 111] Connection refused",
            "https://youtube.com/watch?v=x",
            &None,
        );
        assert!(msg.contains("Network error"));
    }

    #[test]
    fn friendly_error_pyinstaller_failure_announces_self_repair() {
        let msg = friendly_download_error(
            "yt-dlp: ERROR: No module named expat; use SimpleXMLTreeBuilder instead",
            "https://instagram.com/reel/abc/",
            &None,
        );
        assert!(msg.contains("repairing itself"), "got: {msg}");
        assert!(msg.contains("retry"), "got: {msg}");
    }

    #[test]
    fn friendly_error_fallback_shows_last_line() {
        let msg = friendly_download_error(
            "line 1\nline 2\nSome unknown error happened",
            "https://example.com/v",
            &None,
        );
        assert_eq!(msg, "Some unknown error happened");
    }

    #[test]
    fn friendly_error_timeout_is_actionable_with_platform_name() {
        let raw = "yt-dlp timed out after 5 minutes — the download server is unresponsive. Retry the download.";
        let msg = friendly_download_error(raw, "https://www.tiktok.com/@u/video/1", &None);
        assert!(msg.contains("TikTok"), "got: {msg}");
        assert!(msg.contains("timed out"), "got: {msg}");
        assert!(msg.contains("Retry"), "got: {msg}");
    }

    #[test]
    fn friendly_error_timeout_works_for_instagram() {
        let raw = "yt-dlp timed out after 5 minutes";
        let msg = friendly_download_error(raw, "https://instagram.com/reel/abc/", &None);
        assert!(msg.contains("Instagram"), "got: {msg}");
        assert!(msg.contains("timed out"), "got: {msg}");
    }

    #[test]
    fn friendly_error_passes_through_unavailable_downloader_message() {
        // When both the bundled binary and self-repair fail, `run_ytdlp` returns
        // an already-actionable string via `format_unavailable_error`. The
        // friendly mapper should pass it through unchanged instead of
        // dropping it to the generic last-line fallback.
        let raw = "CompiFlow could not start the video downloader and self-repair failed (network down). \
                   Connect to the internet and retry.";
        let msg = friendly_download_error(raw, "https://youtube.com/watch?v=x", &None);
        assert!(msg.contains("could not start the video downloader"), "got: {msg}");
        assert!(msg.contains("self-repair"), "got: {msg}");
    }

    #[cfg(all(test, target_os = "macos"))]
    #[test]
    fn unquarantine_path_does_not_panic_on_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("dummy_bin");
        fs::write(&p, b"x").unwrap();
        unquarantine_path(&p);
        assert!(p.exists());
    }

    #[cfg(all(test, target_os = "macos"))]
    #[test]
    fn unquarantine_path_recurses_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("yt-dlp_macos").join("_internal");
        fs::create_dir_all(&nested).unwrap();
        let p = nested.join("libpython.dylib");
        fs::write(&p, b"x").unwrap();
        unquarantine_path(dir.path());
        assert!(p.exists());
    }

    // ── format_selection_for_url ─────────────────────────────────────────

    #[test]
    fn format_selection_instagram_uses_best() {
        assert_eq!(
            format_selection_for_url("https://www.instagram.com/p/ABC/"),
            "best"
        );
        assert_eq!(
            format_selection_for_url("https://instagram.com/reel/XYZ/"),
            "best"
        );
    }

    #[test]
    fn format_selection_other_platforms_use_split() {
        assert_eq!(
            format_selection_for_url("https://youtube.com/watch?v=x"),
            "bestvideo+bestaudio/best"
        );
        assert_eq!(
            format_selection_for_url("https://tiktok.com/@u/video/1"),
            "bestvideo+bestaudio/best"
        );
    }

    // ── build_filter_groups ──────────────────────────────────────────────

    #[test]
    fn filter_groups_empty_tags_single_group() {
        let groups = build_filter_groups(&[], &[], false, "AND", None, None, None);
        assert_eq!(groups.len(), 1);
        let filters = groups[0]["filters"].as_array().unwrap();
        assert!(filters
            .iter()
            .any(|f| f["propertyName"] == "creator_status"));
        assert!(filters
            .iter()
            .any(|f| f["propertyName"] == "link_not_working_anymore"));
    }

    #[test]
    fn filter_groups_or_mode_creates_group_per_tag() {
        let tags = vec!["tag1".into(), "tag2".into()];
        let groups = build_filter_groups(&tags, &[], false, "OR", None, None, None);
        assert_eq!(groups.len(), 2);
        for (i, group) in groups.iter().enumerate() {
            let filters = group["filters"].as_array().unwrap();
            let tag_filter = filters
                .iter()
                .find(|f| f["propertyName"] == "tags")
                .unwrap();
            assert_eq!(tag_filter["value"], tags[i]);
        }
    }

    #[test]
    fn filter_groups_and_mode_single_group_all_tags() {
        let tags = vec!["a".into(), "b".into(), "c".into()];
        let groups = build_filter_groups(&tags, &[], false, "AND", None, None, None);
        assert_eq!(groups.len(), 1);
        let filters = groups[0]["filters"].as_array().unwrap();
        let tag_filters: Vec<_> = filters
            .iter()
            .filter(|f| f["propertyName"] == "tags")
            .collect();
        assert_eq!(tag_filters.len(), 3);
    }

    #[test]
    fn filter_groups_with_scores() {
        let scores = vec!["A".into(), "B".into()];
        let groups = build_filter_groups(&[], &scores, false, "AND", None, None, None);
        let filters = groups[0]["filters"].as_array().unwrap();
        let score_filter = filters
            .iter()
            .find(|f| f["propertyName"] == "score")
            .unwrap();
        assert_eq!(score_filter["operator"], "IN");
        assert_eq!(score_filter["values"], serde_json::json!(["A", "B"]));
    }

    #[test]
    fn filter_groups_never_used() {
        let groups = build_filter_groups(&[], &[], true, "AND", None, None, None);
        let filters = groups[0]["filters"].as_array().unwrap();
        assert!(filters
            .iter()
            .any(|f| f["propertyName"] == "num_of_published_video_project" && f["value"] == "0"));
    }

    #[test]
    fn filter_groups_creator_link_added_to_all_groups() {
        let tags = vec!["x".into(), "y".into()];
        let groups = build_filter_groups(
            &tags,
            &[],
            false,
            "OR",
            Some("https://example.com"),
            None,
            None,
        );
        assert_eq!(groups.len(), 2);
        for group in &groups {
            let filters = group["filters"].as_array().unwrap();
            assert!(filters
                .iter()
                .any(|f| f["propertyName"] == "creator_main_link"
                    && f["value"] == "https://example.com"));
        }
    }

    #[test]
    fn filter_groups_date_found_range() {
        let groups = build_filter_groups(
            &[],
            &[],
            false,
            "AND",
            None,
            Some("2025-01-15"),
            Some("2025-06-01"),
        );
        let filters = groups[0]["filters"].as_array().unwrap();
        let gte = filters
            .iter()
            .find(|f| f["propertyName"] == "date_found" && f["operator"] == "GTE")
            .unwrap();
        assert_eq!(gte["value"], "2025-01-15");
        let lte = filters
            .iter()
            .find(|f| f["propertyName"] == "date_found" && f["operator"] == "LTE")
            .unwrap();
        assert_eq!(lte["value"], "2025-06-01");
    }

    #[test]
    fn filter_groups_ignores_bad_date_strings() {
        let groups =
            build_filter_groups(&[], &[], false, "AND", None, Some("not-a-date"), Some(""));
        let filters = groups[0]["filters"].as_array().unwrap();
        assert!(!filters.iter().any(|f| f["propertyName"] == "date_found"));
    }

    // ── find_downloaded_file ─────────────────────────────────────────────

    #[test]
    fn find_downloaded_file_by_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("12345_my_video.mp4")).unwrap();
        let _ = fs::File::create(dir.path().join("other_file.txt")).unwrap();

        let result = find_downloaded_file(&dir.path().to_path_buf(), "12345");
        assert_eq!(result, Some("clips/12345_my_video.mp4".into()));
    }

    #[test]
    fn find_downloaded_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("99999_clip.mp4")).unwrap();

        let result = find_downloaded_file(&dir.path().to_path_buf(), "12345");
        assert_eq!(result, None);
    }

    #[test]
    fn find_downloaded_file_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = find_downloaded_file(&dir.path().to_path_buf(), "12345");
        assert_eq!(result, None);
    }

    #[test]
    fn find_downloaded_file_prefers_mp4_over_m4a() {
        let dir = tempfile::tempdir().unwrap();
        // Simulate the bug: both an audio-only .m4a and a proper .mp4 exist
        let _ = fs::File::create(dir.path().join("12345_video.m4a")).unwrap();
        let _ = fs::File::create(dir.path().join("12345_video.mp4")).unwrap();

        let result = find_downloaded_file(&dir.path().to_path_buf(), "12345");
        assert_eq!(result, Some("clips/12345_video.mp4".into()));
    }

    #[test]
    fn find_downloaded_file_falls_back_to_non_mp4() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("12345_video.webm")).unwrap();

        let result = find_downloaded_file(&dir.path().to_path_buf(), "12345");
        assert_eq!(result, Some("clips/12345_video.webm".into()));
    }

    // ── remove_existing_clip_files ───────────────────────────────────────

    #[test]
    fn remove_existing_clip_files_removes_matching() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("12345_video.mp4")).unwrap();
        let _ = fs::File::create(dir.path().join("12345_video.m4a")).unwrap();
        let _ = fs::File::create(dir.path().join("99999_other.mp4")).unwrap();

        let removed = remove_existing_clip_files(&dir.path().to_path_buf(), "12345");
        assert_eq!(removed.len(), 2);
        assert!(removed.iter().any(|n| n.contains("12345_video.mp4")));
        assert!(removed.iter().any(|n| n.contains("12345_video.m4a")));
        // Other clip's file untouched
        assert!(dir.path().join("99999_other.mp4").exists());
    }

    #[test]
    fn remove_existing_clip_files_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let removed = remove_existing_clip_files(&dir.path().to_path_buf(), "12345");
        assert!(removed.is_empty());
    }

    #[test]
    fn remove_existing_clip_files_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("99999_clip.mp4")).unwrap();

        let removed = remove_existing_clip_files(&dir.path().to_path_buf(), "12345");
        assert!(removed.is_empty());
        assert!(dir.path().join("99999_clip.mp4").exists());
    }

    // ── find_file_by_id ──────────────────────────────────────────────────

    #[test]
    fn find_file_by_id_with_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("3 - 12345_title.mp4")).unwrap();

        let result = find_file_by_id(&dir.path().to_path_buf(), "12345");
        assert!(result.is_some());
        assert!(result
            .unwrap()
            .to_string_lossy()
            .contains("12345_title.mp4"));
    }

    #[test]
    fn find_file_by_id_with_unused_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("unused_12345_title.mp4")).unwrap();

        let result = find_file_by_id(&dir.path().to_path_buf(), "12345");
        assert!(result.is_some());
    }

    #[test]
    fn find_file_by_id_empty_prefix_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("anything.mp4")).unwrap();

        let result = find_file_by_id(&dir.path().to_path_buf(), "");
        assert!(result.is_none());
    }

    #[test]
    fn find_file_by_id_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let _ = fs::File::create(dir.path().join("99999_clip.mp4")).unwrap();

        let result = find_file_by_id(&dir.path().to_path_buf(), "12345");
        assert!(result.is_none());
    }

    // ── probe_duration ───────────────────────────────────────────────────

    #[test]
    fn probe_duration_nonexistent_file() {
        assert_eq!(probe_duration("/nonexistent/path/video.mp4"), None);
    }

    #[test]
    fn probe_duration_non_mp4_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not_a_video.txt");
        fs::write(&path, "hello world").unwrap();
        assert_eq!(probe_duration(&path.to_string_lossy()), None);
    }

    // ── augmented_path (macOS only) ──────────────────────────────────────

    #[cfg(target_os = "macos")]
    #[test]
    fn augmented_path_includes_homebrew_dirs() {
        let path = augmented_path();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "missing /opt/homebrew/bin in: {path}"
        );
        assert!(
            path.contains("/usr/local/bin"),
            "missing /usr/local/bin in: {path}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn augmented_path_preserves_existing_path() {
        let original = std::env::var("PATH").unwrap_or_default();
        if !original.is_empty() {
            let augmented = augmented_path();
            assert!(augmented.contains(&original), "original PATH not preserved");
        }
    }

    // ── General Search: parse_social_urls ────────────────────────────────

    #[test]
    fn parse_social_urls_mixed_input() {
        let input = "https://www.tiktok.com/@dancepro/video/123456\nhttps://www.instagram.com/reel/ABC123/\nhttps://example.com/not-social\n\n";
        let results = parse_social_urls(input);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].platform, SocialPlatform::TikTok);
        assert_eq!(results[0].handle.as_deref(), Some("dancepro"));
        assert_eq!(
            results[0].profile_url.as_deref(),
            Some("https://www.tiktok.com/@dancepro")
        );
        assert_eq!(results[1].platform, SocialPlatform::Instagram);
        assert!(results[1].handle.is_none());
    }

    #[test]
    fn parse_social_urls_deduplicates() {
        let input = "https://www.tiktok.com/@user/video/1\nhttps://www.tiktok.com/@user/video/1\n";
        let results = parse_social_urls(input);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn parse_social_urls_empty_input() {
        assert!(parse_social_urls("").is_empty());
        assert!(parse_social_urls("   \n  \n  ").is_empty());
    }

    // ── extract_tiktok_handle ────────────────────────────────────────────

    #[test]
    fn tiktok_handle_standard_url() {
        assert_eq!(
            extract_tiktok_handle("https://www.tiktok.com/@cooluser/video/7123456"),
            Some("cooluser".into())
        );
    }

    #[test]
    fn tiktok_handle_with_dots() {
        assert_eq!(
            extract_tiktok_handle("https://tiktok.com/@user.name/video/1"),
            Some("user.name".into())
        );
    }

    #[test]
    fn tiktok_handle_no_at_sign() {
        assert_eq!(extract_tiktok_handle("https://tiktok.com/t/ZTR123/"), None);
    }

    // ── extract_instagram_shortcode ──────────────────────────────────────

    #[test]
    fn ig_shortcode_reel() {
        assert_eq!(
            extract_instagram_shortcode("https://www.instagram.com/reel/CxYz123/"),
            Some("CxYz123".into())
        );
    }

    #[test]
    fn ig_shortcode_reels() {
        assert_eq!(
            extract_instagram_shortcode("https://www.instagram.com/reels/AbC456/"),
            Some("AbC456".into())
        );
    }

    #[test]
    fn ig_shortcode_post() {
        assert_eq!(
            extract_instagram_shortcode("https://instagram.com/p/XyZ789/"),
            Some("XyZ789".into())
        );
    }

    #[test]
    fn ig_shortcode_with_query() {
        assert_eq!(
            extract_instagram_shortcode("https://www.instagram.com/reel/ABC/?igsh=123"),
            Some("ABC".into())
        );
    }

    // ── extract_instagram_username_from_html ─────────────────────────────

    #[test]
    fn ig_username_from_embed_html() {
        let html =
            r#"<a href="https://www.instagram.com/theartist/" target="_blank">@theartist</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("theartist".into())
        );
    }

    #[test]
    fn ig_username_skips_reel_paths() {
        let html = r#"<a href="https://www.instagram.com/reel/ABC123/">Reel</a>
                       <a href="https://www.instagram.com/coolcreator/">Profile</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("coolcreator".into())
        );
    }

    #[test]
    fn ig_username_none_when_only_system_paths() {
        let html = r#"<a href="https://www.instagram.com/reel/ABC/">X</a>
                       <a href="https://www.instagram.com/explore/">E</a>"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_skips_rsrc_php_cdn_path() {
        // Broken/deleted reels embed pages leak Facebook CDN paths like
        // `instagram.com/rsrc.php/v3/...` — never a real handle.
        let html = r#"<link href="https://www.instagram.com/rsrc.php/v4/yV/r/abc.js">
                      <a href="https://www.instagram.com/realartist/">Profile</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("realartist".into())
        );
    }

    #[test]
    fn ig_username_none_when_only_cdn_assets() {
        let html = r#"<link href="https://www.instagram.com/rsrc.php/v4/yV/r/abc.js">
                      <link href="https://www.instagram.com/static/bundles/main.css">"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_skips_extensionish_handles() {
        let html = r#"<a href="https://www.instagram.com/foo.html/">X</a>
                      <a href="https://www.instagram.com/bar.png/">Y</a>"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_skips_dotted_edges_and_double_dots() {
        let html = r#"<a href="https://www.instagram.com/.hidden/">X</a>
                      <a href="https://www.instagram.com/two..dots/">Y</a>"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_allows_dotted_handle() {
        let html = r#"<a href="https://www.instagram.com/julie.strings/">J</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("julie.strings".into())
        );
    }

    #[test]
    fn ig_username_skips_cdninstagram_v_path() {
        // The old unanchored regex matched `instagram.com/v/...` inside
        // `cdninstagram.com/v/...` thumbnail URLs and returned `v` as the
        // handle, producing `https://www.instagram.com/v/` artist links.
        let html = r#"<img src="https://scontent.cdninstagram.com/v/t51.29350-15/abc.jpg">"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_picks_real_handle_over_cdninstagram() {
        let html = r#"<img src="https://scontent.cdninstagram.com/v/t51.29350-15/abc.jpg">
                      <a href="https://www.instagram.com/realartist/">Profile</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("realartist".into())
        );
    }

    #[test]
    fn ig_username_rejects_numeric_pk_handle() {
        // 11-digit Instagram `pk` values leak in via embed-page JSON blobs
        // and must never be returned as a handle.
        let html = r#"<a href="https://www.instagram.com/65486544502/">X</a>"#;
        assert_eq!(extract_instagram_username_from_html(html), None);
    }

    #[test]
    fn ig_username_picks_real_handle_over_numeric_pk() {
        let html = r#"<a href="https://www.instagram.com/65486544502/">Numeric</a>
                      <a href="https://www.instagram.com/realartist/">Real</a>"#;
        assert_eq!(
            extract_instagram_username_from_html(html),
            Some("realartist".into())
        );
    }

    // ── username_from_ig_profile_url ─────────────────────────────────────

    #[test]
    fn ig_profile_url_extracts_username() {
        assert_eq!(
            username_from_ig_profile_url("https://www.instagram.com/yuumi_cat9/"),
            Some("yuumi_cat9".into())
        );
        assert_eq!(
            username_from_ig_profile_url("https://instagram.com/julie.strings"),
            Some("julie.strings".into())
        );
    }

    #[test]
    fn ig_profile_url_rejects_numeric_pk() {
        assert_eq!(
            username_from_ig_profile_url("https://www.instagram.com/65486544502/"),
            None
        );
    }

    #[test]
    fn ig_profile_url_rejects_non_instagram_host() {
        assert_eq!(
            username_from_ig_profile_url("https://scontent.cdninstagram.com/v/t51/abc.jpg"),
            None
        );
    }

    #[test]
    fn ig_profile_url_rejects_reserved_path() {
        assert_eq!(
            username_from_ig_profile_url("https://www.instagram.com/reel/ABC123/"),
            None
        );
    }

    // ── pick_ig_handle_from_ytdlp ────────────────────────────────────────

    #[test]
    fn ytdlp_ig_prefers_channel_over_numeric_uploader_id() {
        // yt-dlp's IG extractor sets `channel` to the username and
        // `uploader_id` to the numeric `pk`. We must read `channel`.
        let json = serde_json::json!({
            "channel": "realuser",
            "uploader_id": "65486544502",
            "uploader": "Real User",
        });
        assert_eq!(pick_ig_handle_from_ytdlp(&json), Some("realuser".into()));
    }

    #[test]
    fn ytdlp_ig_skips_numeric_uploader_id_when_channel_missing() {
        let json = serde_json::json!({
            "uploader_id": "65486544502",
            "uploader": "Real User",
        });
        // Falls through past the all-digit `uploader_id` to `uploader`.
        assert_eq!(pick_ig_handle_from_ytdlp(&json), Some("Real User".into()));
    }

    #[test]
    fn ytdlp_ig_accepts_string_uploader_id_when_channel_missing() {
        // Legacy / non-IG-API extractor paths still surface a string handle
        // in `uploader_id`. Accept it when it's clearly not a numeric pk.
        let json = serde_json::json!({
            "uploader_id": "naomipq",
            "uploader": "Naomi",
        });
        assert_eq!(pick_ig_handle_from_ytdlp(&json), Some("naomipq".into()));
    }

    #[test]
    fn ytdlp_ig_returns_none_when_all_fields_missing() {
        let json = serde_json::json!({});
        assert_eq!(pick_ig_handle_from_ytdlp(&json), None);
    }

    #[test]
    fn ytdlp_ig_ignores_empty_channel() {
        let json = serde_json::json!({
            "channel": "   ",
            "uploader_id": "naomipq",
        });
        assert_eq!(pick_ig_handle_from_ytdlp(&json), Some("naomipq".into()));
    }

    // ── extract_hashtags ─────────────────────────────────────────────────

    #[test]
    fn hashtags_from_caption_with_adjacent_tags() {
        let caption = "Sunlight through leaves ✨\n#AcrylicMarkerArt#PlantShadowArt#stationery #markerart #markplanplus";
        assert_eq!(
            extract_hashtags(caption),
            Some("AcrylicMarkerArt;PlantShadowArt;stationery;markerart;markplanplus".into())
        );
    }

    #[test]
    fn hashtags_from_caption_spaced() {
        let caption = "Check this out! #dance #music #viral";
        assert_eq!(extract_hashtags(caption), Some("dance;music;viral".into()));
    }

    #[test]
    fn hashtags_none_when_no_hashtags() {
        assert_eq!(
            extract_hashtags("Just a regular caption with no tags"),
            None
        );
    }

    #[test]
    fn hashtags_empty_string() {
        assert_eq!(extract_hashtags(""), None);
    }

    #[test]
    fn hashtags_with_underscores() {
        let caption = "#cool_art #my_video_123";
        assert_eq!(
            extract_hashtags(caption),
            Some("cool_art;my_video_123".into())
        );
    }

    // ── full_creator_properties ──────────────────────────────────────────

    #[test]
    fn full_creator_properties_contains_required_fields() {
        let props = full_creator_properties();
        // Every consumer of the side-by-side detail view depends on these.
        for required in [
            "name",
            "instagram",
            "secondary_instagram",
            "tiktok",
            "secondary_tiktok",
            "youtube",
            "num_of_contacts",
            "num_of_external_clips",
            "num_of_public_video_projects",
            "num_of_send_link_actions",
            "num_of_social_interactions",
            "num_of_video_projects",
        ] {
            assert!(
                props.contains(&required),
                "full_creator_properties is missing `{required}`",
            );
        }
    }

    #[test]
    fn full_creator_properties_has_no_duplicates() {
        let props = full_creator_properties();
        let mut sorted: Vec<&&str> = props.iter().collect();
        sorted.sort();
        for window in sorted.windows(2) {
            assert!(
                window[0] != window[1],
                "duplicate property `{}` in full_creator_properties",
                window[0]
            );
        }
    }

    // ── hubspot_creator_url_property ─────────────────────────────────────

    #[test]
    fn hubspot_creator_url_property_known_platforms() {
        // Live resolver paths — these MUST map or new creators 400 on
        // `main_link` because nothing else feeds the calculated property.
        assert_eq!(hubspot_creator_url_property("instagram"), Some("instagram"));
        assert_eq!(hubspot_creator_url_property("tiktok"), Some("tiktok"));
        assert_eq!(hubspot_creator_url_property("youtube"), Some("youtube"));
    }

    #[test]
    fn hubspot_creator_url_property_extended_platforms() {
        assert_eq!(hubspot_creator_url_property("facebook"), Some("facebook"));
        assert_eq!(hubspot_creator_url_property("twitter"), Some("x"));
        assert_eq!(hubspot_creator_url_property("x"), Some("x"));
        assert_eq!(hubspot_creator_url_property("bilibili"), Some("bilibili"));
        assert_eq!(hubspot_creator_url_property("douyin"), Some("douyin_id"));
        assert_eq!(
            hubspot_creator_url_property("xiaohongshu"),
            Some("xiaohongshu_id")
        );
        assert_eq!(hubspot_creator_url_property("kuaishou"), Some("kuaishou_id"));
        assert_eq!(hubspot_creator_url_property("ixigua"), Some("ixigua"));
    }

    #[test]
    fn hubspot_creator_url_property_unknown_returns_none() {
        // Pinterest isn't a `main_account` dropdown option and has no URL
        // column on the Creator object — caller must surface this instead of
        // silently creating a record without a profile link.
        assert_eq!(hubspot_creator_url_property("pinterest"), None);
        assert_eq!(hubspot_creator_url_property("other"), None);
        assert_eq!(hubspot_creator_url_property(""), None);
    }

    #[test]
    fn hubspot_creator_url_property_is_case_sensitive() {
        // Callers always pass `platform.to_lowercase()`; document the
        // contract so a future caller doesn't accidentally pass "Instagram".
        assert_eq!(hubspot_creator_url_property("Instagram"), None);
        assert_eq!(hubspot_creator_url_property("TIKTOK"), None);
    }

    #[test]
    fn hubspot_creator_url_property_returns_real_column_names() {
        // Every mapping must point at a column that exists in
        // `full_creator_properties()`, otherwise the POST will succeed but
        // the value lands on an unknown property and main_link stays empty.
        let known: std::collections::HashSet<&&str> =
            full_creator_properties().iter().collect();
        for platform in [
            "instagram",
            "tiktok",
            "youtube",
            "facebook",
            "twitter",
            "bilibili",
            "douyin",
            "xiaohongshu",
            "kuaishou",
            "ixigua",
        ] {
            let prop = hubspot_creator_url_property(platform)
                .unwrap_or_else(|| panic!("missing mapping for {platform}"));
            assert!(
                known.contains(&prop),
                "platform {platform} maps to `{prop}` which is not in full_creator_properties()"
            );
        }
    }

    // ── HubSpot merge helpers ────────────────────────────────────────────

    #[test]
    fn validate_merge_ids_accepts_distinct_ids() {
        let (w, l) = validate_merge_ids("12345", "67890").expect("should accept distinct ids");
        assert_eq!(w, "12345");
        assert_eq!(l, "67890");
    }

    #[test]
    fn validate_merge_ids_trims_whitespace() {
        let (w, l) = validate_merge_ids("  12345  ", "\t67890\n").expect("should trim");
        assert_eq!(w, "12345");
        assert_eq!(l, "67890");
    }

    #[test]
    fn validate_merge_ids_rejects_empty() {
        assert!(validate_merge_ids("", "67890").is_err());
        assert!(validate_merge_ids("12345", "").is_err());
        assert!(validate_merge_ids("   ", "67890").is_err());
        assert!(validate_merge_ids("12345", "\t").is_err());
    }

    #[test]
    fn validate_merge_ids_rejects_same_id_after_trim() {
        // Defence against a UI bug that swaps both sides to the same record —
        // HubSpot would 400 anyway but we'd rather fail fast with a clearer
        // message before the network call.
        assert!(validate_merge_ids("12345", "12345").is_err());
        assert!(validate_merge_ids(" 12345 ", "12345").is_err());
    }

    #[test]
    fn hubspot_merge_url_builds_creators_endpoint() {
        // The constant in lib.rs is the canonical id; we only spot-check the
        // shape here so a typo in the path component shows up as a test fail.
        assert_eq!(
            hubspot_merge_url("2-191972671"),
            "https://api.hubapi.com/crm/v3/objects/2-191972671/merge",
        );
    }

    #[test]
    fn hubspot_merge_body_has_camelcase_keys() {
        let body = hubspot_merge_body("12345", "67890");
        // HubSpot's documented contract — the keys are camelCase, not snake.
        assert_eq!(body["primaryObjectId"], "12345");
        assert_eq!(body["objectIdToMerge"], "67890");
        // Nothing else should leak into the body or HubSpot may reject it.
        assert_eq!(body.as_object().map(|o| o.len()), Some(2));
    }

    // ── Association-limit detection & planning ────────────────────────────

    #[test]
    fn is_association_limit_error_matches_real_payload() {
        // The exact substring HubSpot returns when an admin-configured
        // per-record cap blocks a merge (sampled from a 400 response).
        let payload = r#"HubSpot merge error (400 Bad Request): {"status":"error","message":"Association configuration limits are exceeded in portal 146859718 when merging 238292703419 into 238298166504 of object type 2-191972671","correlationId":"019e2559-bc5f-718a-85bc-1777f9178748","category":"VALIDATION_ERROR"}"#;
        assert!(is_association_limit_error(payload));
    }

    #[test]
    fn is_association_limit_error_rejects_unrelated_errors() {
        assert!(!is_association_limit_error(
            "HubSpot merge error (401 Unauthorized): missing scope crm.objects.custom.write"
        ));
        assert!(!is_association_limit_error(
            "HubSpot merge error (400 Bad Request): invalid object id"
        ));
        assert!(!is_association_limit_error(""));
    }

    #[test]
    fn parse_assoc_limit_entry_reads_finite_cap() {
        let entry = serde_json::json!({
            "category": "HUBSPOT_DEFINED",
            "typeId": 297,
            "label": null,
            "userEnforcedMaxToObjectIds": 1
        });
        let parsed = parse_assoc_limit_entry(&entry);
        assert_eq!(parsed, Some((1, 297, "HUBSPOT_DEFINED".to_string())));
    }

    #[test]
    fn parse_assoc_limit_entry_returns_none_when_no_cap() {
        // "Many" — the admin chose no limit; HubSpot omits the field.
        let entry = serde_json::json!({
            "category": "HUBSPOT_DEFINED",
            "typeId": 297,
            "label": null
        });
        assert_eq!(parse_assoc_limit_entry(&entry), None);
    }

    #[test]
    fn parse_assoc_limit_entry_treats_zero_as_no_cap() {
        // Defence-in-depth — if HubSpot ever surfaces 0 we should not try
        // to swap "zero" associations; let the merge run and fail visibly.
        let entry = serde_json::json!({
            "category": "USER_DEFINED",
            "typeId": 196,
            "userEnforcedMaxToObjectIds": 0
        });
        assert_eq!(parse_assoc_limit_entry(&entry), None);
    }

    #[test]
    fn most_restrictive_limit_picks_min_across_labels() {
        // Multiple labels on the same pair, each with its own cap. The
        // merge engine refuses if ANY label's cap is exceeded, so we want
        // the most restrictive one for our planning.
        let body = serde_json::json!({
            "results": [
                { "category": "HUBSPOT_DEFINED", "typeId": 297, "userEnforcedMaxToObjectIds": 5 },
                { "category": "USER_DEFINED",    "typeId": 196, "userEnforcedMaxToObjectIds": 1 },
                { "category": "USER_DEFINED",    "typeId": 198 } // "Many"
            ]
        });
        assert_eq!(
            most_restrictive_limit(&body),
            Some((1, 196, "USER_DEFINED".to_string()))
        );
    }

    #[test]
    fn most_restrictive_limit_returns_none_when_no_caps() {
        let body = serde_json::json!({
            "results": [
                { "category": "HUBSPOT_DEFINED", "typeId": 297 },
                { "category": "USER_DEFINED",    "typeId": 196 }
            ]
        });
        assert_eq!(most_restrictive_limit(&body), None);
    }

    #[test]
    fn evaluate_merging_side_cap_passes_when_under_limit() {
        let plan = AssocPairPlan {
            other_object_type_id: "0-1".to_string(),
            other_object_label: "Contacts".to_string(),
            direction: AssocLimitDirection::MergingSide { max: 5 },
            loser_count: 1,
            winner_count: 2,
        };
        assert_eq!(
            evaluate_merging_side_cap(&plan, "Creator"),
            MergingSideOutcome::Ok
        );
    }

    #[test]
    fn evaluate_merging_side_cap_bails_with_actionable_message() {
        let plan = AssocPairPlan {
            other_object_type_id: "0-1".to_string(),
            other_object_label: "Contacts".to_string(),
            direction: AssocLimitDirection::MergingSide { max: 5 },
            loser_count: 2,
            winner_count: 5,
        };
        match evaluate_merging_side_cap(&plan, "Creator") {
            MergingSideOutcome::Ok => panic!("expected Exceeded"),
            MergingSideOutcome::Exceeded { message } => {
                // The message must mention the actual numbers and point to
                // the HubSpot setting that fixes it — anything less and the
                // user has to dig through HubSpot to figure out what to do.
                assert!(message.contains("up to 7 Contacts"));
                assert!(message.contains("limit of 5 Contacts per Creator"));
                assert!(message.contains("Settings → Properties → Associations"));
            }
        }
    }

    #[test]
    fn evaluate_merging_side_cap_ignores_other_side_plans() {
        // OtherSide caps are handled by the pre-swap path, never by the
        // bail path. Make sure this helper doesn't accidentally bail on
        // them or it would block fixable merges.
        let plan = AssocPairPlan {
            other_object_type_id: "2-192287471".to_string(),
            other_object_label: "External Clips".to_string(),
            direction: AssocLimitDirection::OtherSide {
                max: 1,
                type_id: 297,
                category: "HUBSPOT_DEFINED".to_string(),
            },
            loser_count: 50,
            winner_count: 0,
        };
        assert_eq!(
            evaluate_merging_side_cap(&plan, "Creator"),
            MergingSideOutcome::Ok
        );
    }
    #[test]
    fn test_combine_multi_file_value() {
        assert_eq!(combine_multi_file_value("", ""), "");
        assert_eq!(combine_multi_file_value("123", ""), "123");
        assert_eq!(combine_multi_file_value("", "456"), "456");
        assert_eq!(combine_multi_file_value("123", "456"), "123;456");
        assert_eq!(combine_multi_file_value("123", "123"), "123");
        assert_eq!(combine_multi_file_value("123; 456", "789, 123"), "123;456;789");
        assert_eq!(combine_multi_file_value("  123 \n 456  ", " 456 ; 789 "), "123;456;789");
    }

    #[test]
    fn test_safe_storage_filename() {
        assert_eq!(safe_storage_filename("hello-world.mp4"), "hello-world.mp4");
        assert_eq!(safe_storage_filename("hello world!.mp4"), "hello_world_.mp4");
        assert_eq!(safe_storage_filename("special/chars?\\"), "special_chars__");
        assert_eq!(safe_storage_filename("valid_name-1.2.3"), "valid_name-1.2.3");
    }
}
