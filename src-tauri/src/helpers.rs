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
    s.chars()
        .all(|c| c.is_ascii_digit() || c == '-')
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
    if id_prefix.is_empty() { return None; }
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
                let mtime = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::UNIX_EPOCH);
                matches.push((name, mtime));
            }
        }
    }

    if matches.is_empty() { return None; }

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
    if url.contains("instagram.com") { "instagram" }
    else if url.contains("tiktok.com") { "tiktok" }
    else if url.contains("douyin.com") { "douyin" }
    else if url.contains("youtube.com") || url.contains("youtu.be") { "youtube" }
    else if url.contains("bilibili.com") { "bilibili" }
    else if url.contains("xiaohongshu.com") { "xiaohongshu" }
    else if url.contains("kuaishou.com") { "kuaishou" }
    else { "default" }
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
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(json) {
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
pub(crate) fn friendly_download_error(stderr: &str, url: &str, cookies_browser: &Option<String>) -> String {
    let lower = stderr.to_lowercase();
    let platform = detect_platform(url);
    let browser = cookies_browser.as_deref().unwrap_or("your browser");

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
        return format!("This {} video is private. Log into {} first.", platform, browser);
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
pub(crate) fn find_system_ytdlp() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let extra_paths = [
            "/opt/homebrew/bin/yt-dlp",
            "/usr/local/bin/yt-dlp",
        ];
        for p in &extra_paths {
            let path = std::path::PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    which::which("yt-dlp").ok()
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
                let profile_url = handle.as_ref().map(|h| format!("https://www.tiktok.com/@{}", h));
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
pub(crate) fn extract_instagram_username_from_html(html: &str) -> Option<String> {
    // Pattern 1: href="https://www.instagram.com/username/" in embed HTML
    let re1 = regex::Regex::new(r#"instagram\.com/([a-zA-Z0-9._]+)/?"#).ok()?;
    for caps in re1.captures_iter(html) {
        let candidate = caps.get(1)?.as_str();
        let skip = ["reel", "reels", "p", "explore", "accounts", "api",
                     "embed", "developer", "about", "legal", "tags", "tv", "stories"];
        if !skip.contains(&candidate) && !candidate.starts_with("reel") {
            return Some(candidate.to_string());
        }
    }
    None
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
    let text = raw.replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    // Strip remaining HTML tags
    let stripped = regex::Regex::new(r"<[^>]+>").ok()?.replace_all(&text, "");
    let result = stripped.trim().to_string();
    if result.is_empty() { None } else { Some(result) }
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
    let tags: Vec<String> = re.captures_iter(caption)
        .map(|c| c.get(1).unwrap().as_str().to_string())
        .collect();
    if tags.is_empty() { None } else { Some(tags.join(";")) }
}

// ── Tests ────────────────────────────────────────────────────────────────────

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
        assert_eq!(platform_key("https://www.instagram.com/reel/ABC/"), "instagram");
        assert_eq!(platform_key("https://www.tiktok.com/@user/video/123"), "tiktok");
        assert_eq!(platform_key("https://www.douyin.com/video/123"), "douyin");
        assert_eq!(platform_key("https://www.youtube.com/watch?v=abc"), "youtube");
        assert_eq!(platform_key("https://youtu.be/abc"), "youtube");
        assert_eq!(platform_key("https://www.bilibili.com/video/BV123"), "bilibili");
        assert_eq!(platform_key("https://www.xiaohongshu.com/explore/abc"), "xiaohongshu");
        assert_eq!(platform_key("https://www.kuaishou.com/short-video/abc"), "kuaishou");
        assert_eq!(platform_key("https://example.com/video"), "default");
    }

    // ── detect_platform ──────────────────────────────────────────────────

    #[test]
    fn detect_platform_instagram() {
        assert_eq!(detect_platform("https://www.instagram.com/reel/ABC/"), "Instagram");
        assert_eq!(detect_platform("https://instagram.com/p/XYZ/"), "Instagram");
    }

    #[test]
    fn detect_platform_youtube() {
        assert_eq!(detect_platform("https://www.youtube.com/watch?v=abc"), "YouTube");
        assert_eq!(detect_platform("https://youtu.be/abc"), "YouTube");
    }

    #[test]
    fn detect_platform_tiktok() {
        assert_eq!(detect_platform("https://www.tiktok.com/@user/video/123"), "TikTok");
    }

    #[test]
    fn detect_platform_douyin() {
        assert_eq!(detect_platform("https://www.douyin.com/video/123"), "Douyin");
    }

    #[test]
    fn detect_platform_bilibili() {
        assert_eq!(detect_platform("https://www.bilibili.com/video/BV123"), "Bilibili");
    }

    #[test]
    fn detect_platform_xiaohongshu() {
        assert_eq!(detect_platform("https://www.xiaohongshu.com/explore/abc"), "Xiaohongshu");
    }

    #[test]
    fn detect_platform_unknown() {
        assert_eq!(detect_platform("https://example.com/video"), "this platform");
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
        let result = providers_for_url("https://www.douyin.com/video/123", &Some("not json".into()));
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
    fn friendly_error_fallback_shows_last_line() {
        let msg = friendly_download_error(
            "line 1\nline 2\nSome unknown error happened",
            "https://example.com/v",
            &None,
        );
        assert_eq!(msg, "Some unknown error happened");
    }

    // ── format_selection_for_url ─────────────────────────────────────────

    #[test]
    fn format_selection_instagram_uses_best() {
        assert_eq!(format_selection_for_url("https://www.instagram.com/p/ABC/"), "best");
        assert_eq!(format_selection_for_url("https://instagram.com/reel/XYZ/"), "best");
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
        assert!(filters.iter().any(|f| f["propertyName"] == "creator_status"));
        assert!(filters.iter().any(|f| f["propertyName"] == "link_not_working_anymore"));
    }

    #[test]
    fn filter_groups_or_mode_creates_group_per_tag() {
        let tags = vec!["tag1".into(), "tag2".into()];
        let groups = build_filter_groups(&tags, &[], false, "OR", None, None, None);
        assert_eq!(groups.len(), 2);
        for (i, group) in groups.iter().enumerate() {
            let filters = group["filters"].as_array().unwrap();
            let tag_filter = filters.iter().find(|f| f["propertyName"] == "tags").unwrap();
            assert_eq!(tag_filter["value"], tags[i]);
        }
    }

    #[test]
    fn filter_groups_and_mode_single_group_all_tags() {
        let tags = vec!["a".into(), "b".into(), "c".into()];
        let groups = build_filter_groups(&tags, &[], false, "AND", None, None, None);
        assert_eq!(groups.len(), 1);
        let filters = groups[0]["filters"].as_array().unwrap();
        let tag_filters: Vec<_> = filters.iter().filter(|f| f["propertyName"] == "tags").collect();
        assert_eq!(tag_filters.len(), 3);
    }

    #[test]
    fn filter_groups_with_scores() {
        let scores = vec!["A".into(), "B".into()];
        let groups = build_filter_groups(&[], &scores, false, "AND", None, None, None);
        let filters = groups[0]["filters"].as_array().unwrap();
        let score_filter = filters.iter().find(|f| f["propertyName"] == "score").unwrap();
        assert_eq!(score_filter["operator"], "IN");
        assert_eq!(score_filter["values"], serde_json::json!(["A", "B"]));
    }

    #[test]
    fn filter_groups_never_used() {
        let groups = build_filter_groups(&[], &[], true, "AND", None, None, None);
        let filters = groups[0]["filters"].as_array().unwrap();
        assert!(filters.iter().any(|f|
            f["propertyName"] == "num_of_published_video_project" && f["value"] == "0"
        ));
    }

    #[test]
    fn filter_groups_creator_link_added_to_all_groups() {
        let tags = vec!["x".into(), "y".into()];
        let groups = build_filter_groups(&tags, &[], false, "OR", Some("https://example.com"), None, None);
        assert_eq!(groups.len(), 2);
        for group in &groups {
            let filters = group["filters"].as_array().unwrap();
            assert!(filters.iter().any(|f|
                f["propertyName"] == "creator_main_link" && f["value"] == "https://example.com"
            ));
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
        let groups = build_filter_groups(&[], &[], false, "AND", None, Some("not-a-date"), Some(""));
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
        assert!(result.unwrap().to_string_lossy().contains("12345_title.mp4"));
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
        assert!(path.contains("/opt/homebrew/bin"), "missing /opt/homebrew/bin in: {path}");
        assert!(path.contains("/usr/local/bin"), "missing /usr/local/bin in: {path}");
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
        assert_eq!(results[0].profile_url.as_deref(), Some("https://www.tiktok.com/@dancepro"));
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
        assert_eq!(
            extract_tiktok_handle("https://tiktok.com/t/ZTR123/"),
            None
        );
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
        let html = r#"<a href="https://www.instagram.com/theartist/" target="_blank">@theartist</a>"#;
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
        assert_eq!(
            extract_hashtags(caption),
            Some("dance;music;viral".into())
        );
    }

    #[test]
    fn hashtags_none_when_no_hashtags() {
        assert_eq!(extract_hashtags("Just a regular caption with no tags"), None);
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
}
