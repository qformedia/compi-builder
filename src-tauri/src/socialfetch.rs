//! SocialFetch (socialfetch.dev) — paid last-resort fallback for creator
//! resolution and media download.
//!
//! ## When this module gets called
//!
//! Both cascades (`creator-resolve` in [`crate::resolver`] and `download` in
//! [`crate::download_clip`]) put SocialFetch *after* the free / cookie-aware
//! paths so we never bill the user when something cheaper would have
//! worked. SocialFetch covers TikTok / Instagram / YouTube; it does NOT
//! cover Douyin / Kuaishou / Bilibili / Xiaohongshu / Pinterest, so this
//! module returns `Skip("unsupported_platform")` for those URLs and the
//! cascade keeps going.
//!
//! ## Auth
//!
//! `x-api-key: sfk_...` header on every call. Empty key → `Skip("no_api_key")`.
//!
//! ## Cost
//!
//! - Profile lookups (TikTok / Instagram / YouTube get-video endpoint): 1 credit
//! - Media download (`downloadMedia=true`): 11 credits (TikTok + Instagram only)
//!
//! See `meta.creditsCharged` in each response for authoritative cost data.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::cascade::StepOutcome;
use crate::download_log;
use crate::resolver::EnrichedProfile;

const SF_BASE: &str = "https://api.socialfetch.dev/v1";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

/// Classified failure reasons. The cascade encodes these into the per-step
/// `attempts` log so the frontend can render an honest error.
#[derive(Debug)]
pub enum SocialfetchError {
    /// HTTP 401 / 403.
    BadApiKey(String),
    /// HTTP 402 — out of credits.
    InsufficientCredits(String),
    /// HTTP 404 / `data.lookupStatus` of `not_found` / `private`.
    NeedsLogin(String),
    /// HTTP 429.
    RateLimited(String),
    /// 2xx but the payload didn't yield a usable handle or media URL.
    UnresolvableData,
    /// Network / 5xx / parse failure.
    Network(String),
}

impl SocialfetchError {
    pub fn reason(&self) -> String {
        match self {
            SocialfetchError::BadApiKey(s) => format!("bad_api_key: {s}"),
            SocialfetchError::InsufficientCredits(s) => {
                format!("insufficient_credits: {s}")
            }
            SocialfetchError::NeedsLogin(s) => format!("needs_login: {s}"),
            SocialfetchError::RateLimited(s) => format!("rate_limited: {s}"),
            SocialfetchError::UnresolvableData => "unresolvable_data".to_string(),
            SocialfetchError::Network(s) => format!("network: {s}"),
        }
    }
}

/// Internal: which SocialFetch endpoint family this URL maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SfPlatform {
    Instagram,
    TikTok,
    YouTube,
    /// Douyin/Kuaishou/Bilibili/Xiaohongshu/Pinterest/etc. — Skip.
    Unsupported,
}

fn sf_platform_for_url(url: &str) -> SfPlatform {
    let u = url.to_lowercase();
    if u.contains("instagram.com") {
        return SfPlatform::Instagram;
    }
    if u.contains("tiktok.com") {
        return SfPlatform::TikTok;
    }
    if u.contains("youtube.com") || u.contains("youtu.be") {
        return SfPlatform::YouTube;
    }
    SfPlatform::Unsupported
}

/// Build the relevant single-item endpoint path for a URL.
fn route_for_get_item(platform: SfPlatform) -> Option<&'static str> {
    match platform {
        SfPlatform::Instagram => Some("/instagram/posts"),
        SfPlatform::TikTok => Some("/tiktok/videos"),
        SfPlatform::YouTube => Some("/youtube/videos"),
        SfPlatform::Unsupported => None,
    }
}

/// Map an HTTP status to a classified [`SocialfetchError`]. `body_short` is
/// the truncated response body for diagnostics.
fn classify_http(status: u16, body_short: String) -> SocialfetchError {
    match status {
        401 | 403 => SocialfetchError::BadApiKey(format!("HTTP {status}: {body_short}")),
        402 => SocialfetchError::InsufficientCredits(format!("HTTP 402: {body_short}")),
        404 => SocialfetchError::NeedsLogin(format!("HTTP 404: {body_short}")),
        429 => SocialfetchError::RateLimited(format!("HTTP 429: {body_short}")),
        _ => SocialfetchError::Network(format!("HTTP {status}: {body_short}")),
    }
}

/// SocialFetch wraps every successful payload in `{ data, meta }`. Pull
/// `data` out, falling back to the root for forward-compat.
fn payload_data(json: &Value) -> &Value {
    json.get("data").unwrap_or(json)
}

/// Recognize the documented `lookupStatus` outcome field. Returns
/// `Some(SocialfetchError)` when the post is not visible to SocialFetch.
fn check_lookup_status(data: &Value) -> Option<SocialfetchError> {
    let status = data.get("lookupStatus").and_then(|v| v.as_str())?;
    match status {
        "found" => None,
        "not_found" | "private" => Some(SocialfetchError::NeedsLogin(format!(
            "lookupStatus={status}"
        ))),
        other => Some(SocialfetchError::Network(format!(
            "unexpected lookupStatus={other}"
        ))),
    }
}

// ── JSON extractors ─────────────────────────────────────────────────────────

/// Walk the response and pull out the *most likely* author handle. Defensive
/// because SocialFetch's per-platform schemas differ slightly and we'd rather
/// surface a usable handle than reject a good payload over a field name.
fn extract_handle(platform: SfPlatform, data: &Value) -> Option<String> {
    // Path candidates in order of how likely they are to contain a real
    // username (most specific first).
    let candidates: &[&[&str]] = match platform {
        SfPlatform::Instagram => &[
            &["author", "username"],
            &["owner", "username"],
            &["profile", "username"],
            &["username"],
        ],
        SfPlatform::TikTok => &[
            &["author", "uniqueId"],
            &["author", "username"],
            &["author", "handle"],
            &["uniqueId"],
        ],
        SfPlatform::YouTube => &[
            &["channel", "handle"],
            &["channel", "customUrl"],
            &["author", "handle"],
            &["author", "channelHandle"],
            &["uploader", "handle"],
        ],
        SfPlatform::Unsupported => return None,
    };
    for path in candidates {
        if let Some(s) = walk_string(data, path) {
            let trimmed = s.trim().trim_start_matches('@');
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Optional display name. Falls back to handle when missing.
fn extract_display_name(platform: SfPlatform, data: &Value) -> Option<String> {
    let candidates: &[&[&str]] = match platform {
        SfPlatform::Instagram => &[&["author", "fullName"], &["owner", "fullName"]],
        SfPlatform::TikTok => &[&["author", "nickname"], &["author", "displayName"]],
        SfPlatform::YouTube => &[
            &["channel", "title"],
            &["channel", "name"],
            &["author", "name"],
        ],
        SfPlatform::Unsupported => return None,
    };
    for path in candidates {
        if let Some(s) = walk_string(data, path) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Avatar / profile picture URL.
fn extract_avatar(platform: SfPlatform, data: &Value) -> Option<String> {
    let candidates: &[&[&str]] = match platform {
        SfPlatform::Instagram => &[
            &["author", "profilePicUrl"],
            &["author", "avatarUrl"],
            &["owner", "profilePicUrl"],
        ],
        SfPlatform::TikTok => &[
            &["author", "avatarLarger"],
            &["author", "avatarMedium"],
            &["author", "avatarThumb"],
            &["author", "profilePicUrl"],
        ],
        SfPlatform::YouTube => &[
            &["channel", "avatarUrl"],
            &["channel", "thumbnailUrl"],
            &["author", "avatarUrl"],
        ],
        SfPlatform::Unsupported => return None,
    };
    for path in candidates {
        if let Some(s) = walk_string(data, path) {
            if s.starts_with("http") {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Pull the direct media (video) URL out of a `downloadMedia=true` response.
/// Defensive across schema variants — TikTok and Instagram both put it
/// somewhere different.
fn extract_media_url(platform: SfPlatform, data: &Value) -> Option<String> {
    let candidates: &[&[&str]] = match platform {
        SfPlatform::Instagram => &[
            &["video", "downloadUrl"],
            &["video", "url"],
            &["media", "url"],
            &["media", "downloadUrl"],
            &["downloadUrl"],
            &["videoUrl"],
        ],
        SfPlatform::TikTok => &[
            &["video", "downloadUrl"],
            &["video", "playAddr"],
            &["video", "url"],
            &["downloadUrl"],
            &["playAddr"],
            &["videoUrl"],
        ],
        SfPlatform::YouTube => &[&["video", "downloadUrl"], &["downloadUrl"]],
        SfPlatform::Unsupported => return None,
    };
    for path in candidates {
        if let Some(s) = walk_string(data, path) {
            if s.starts_with("http") {
                return Some(s.to_string());
            }
        }
    }
    // Fallback: scan `media[]` arrays for the first http URL.
    if let Some(arr) = data.get("media").and_then(|v| v.as_array()) {
        for item in arr {
            for key in &["downloadUrl", "url"] {
                if let Some(s) = item.get(*key).and_then(|v| v.as_str()) {
                    if s.starts_with("http") {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

fn walk_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_str()
}

// ── Cascade-facing entry points ─────────────────────────────────────────────

/// Resolve creator profile via SocialFetch. Use as a step in
/// [`crate::resolver`]'s cascade.
pub async fn resolve_profile_step(url: &str, api_key: &str) -> StepOutcome<EnrichedProfile> {
    if let Some(reason) = resolve_profile_skip_reason(url, api_key) {
        return StepOutcome::Skip(reason.to_string());
    }
    let platform = sf_platform_for_url(url);
    let route = route_for_get_item(platform).expect("gate checked it");

    let request_url = format!("{SF_BASE}{route}?url={}", urlencoding::encode(url));
    match call_get_json(&request_url, api_key).await {
        Ok(json) => {
            let data = payload_data(&json);
            if let Some(err) = check_lookup_status(data) {
                return StepOutcome::Err(err.reason());
            }
            let handle = match extract_handle(platform, data) {
                Some(h) => h,
                None => return StepOutcome::Err(SocialfetchError::UnresolvableData.reason()),
            };
            let profile_url = profile_url_for(platform, &handle);
            let display_name = extract_display_name(platform, data);
            let avatar = extract_avatar(platform, data);
            let platform_str = match platform {
                SfPlatform::Instagram => "instagram",
                SfPlatform::TikTok => "tiktok",
                SfPlatform::YouTube => "youtube",
                SfPlatform::Unsupported => unreachable!(),
            };
            StepOutcome::Ok(EnrichedProfile {
                platform: platform_str.to_string(),
                profile_url,
                handle,
                display_name,
                avatar,
                source: "socialfetch".to_string(),
                cached_at: None,
            })
        }
        Err(e) => StepOutcome::Err(e.reason()),
    }
}

/// Pure gate so unit tests can verify the Skip semantics without building
/// an `AppHandle`. Returns `Some(reason)` when the step should Skip,
/// `None` when it should proceed.
fn media_download_skip_reason(url: &str, api_key: &str) -> Option<&'static str> {
    if api_key.is_empty() {
        return Some("no_api_key");
    }
    let platform = sf_platform_for_url(url);
    if !matches!(platform, SfPlatform::Instagram | SfPlatform::TikTok) {
        // YouTube is supported for *resolution* but not media-download via
        // SocialFetch. Skip so the cascade keeps going.
        return Some("media_download_unsupported_platform");
    }
    None
}

/// Pure gate for resolve_profile_step. Same rationale as
/// [`media_download_skip_reason`].
fn resolve_profile_skip_reason(url: &str, api_key: &str) -> Option<&'static str> {
    if api_key.is_empty() {
        return Some("no_api_key");
    }
    if route_for_get_item(sf_platform_for_url(url)).is_none() {
        return Some("unsupported_platform");
    }
    None
}

/// Download a clip's media via SocialFetch. Use as a step in
/// [`crate::download_clip`]'s cascade. Writes to
/// `{clips_dir}/{clip_id}_socialfetch.mp4` so [`crate::find_downloaded_file`]
/// keeps working unchanged (invariant #5 in download-system-requirements.md).
pub async fn download_media_step(
    app: &AppHandle,
    clip_id: &str,
    url: &str,
    api_key: &str,
    clips_dir: &Path,
) -> StepOutcome<()> {
    if let Some(reason) = media_download_skip_reason(url, api_key) {
        return StepOutcome::Skip(reason.to_string());
    }
    let platform = sf_platform_for_url(url);
    let route = route_for_get_item(platform).expect("gate checked it");

    let request_url = format!(
        "{SF_BASE}{route}?url={}&downloadMedia=true",
        urlencoding::encode(url)
    );
    download_log::debug(
        app,
        "socialfetch",
        Some(clip_id),
        format!("requesting {url} via {request_url}"),
    );

    let json = match call_get_json(&request_url, api_key).await {
        Ok(j) => j,
        Err(e) => return StepOutcome::Err(e.reason()),
    };
    let data = payload_data(&json);
    if let Some(err) = check_lookup_status(data) {
        return StepOutcome::Err(err.reason());
    }
    let media_url = match extract_media_url(platform, data) {
        Some(u) => u,
        None => return StepOutcome::Err(SocialfetchError::UnresolvableData.reason()),
    };

    download_log::debug(
        app,
        "socialfetch",
        Some(clip_id),
        format!("downloading media from {media_url}"),
    );

    // Stream the media URL to disk. SocialFetch returns CDN links that don't
    // require auth on the second request, so a plain reqwest client works.
    let dl_client = match reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return StepOutcome::Err(format!("network: HTTP client: {e}")),
    };
    let resp = match dl_client.get(&media_url).send().await {
        Ok(r) => r,
        Err(e) => return StepOutcome::Err(format!("network: media GET: {e}")),
    };
    let status = resp.status();
    if !status.is_success() {
        return StepOutcome::Err(format!(
            "network: media GET HTTP {} from CDN",
            status.as_u16()
        ));
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return StepOutcome::Err(format!("network: body read: {e}")),
    };
    if bytes.len() < 1024 {
        return StepOutcome::Err(format!(
            "media payload suspiciously small ({} bytes)",
            bytes.len()
        ));
    }

    if let Err(e) = std::fs::create_dir_all(clips_dir) {
        return StepOutcome::Err(format!("network: create clips dir: {e}"));
    }
    let dest = clips_dir.join(format!("{}_socialfetch.mp4", clip_id));
    if let Err(e) = std::fs::write(&dest, &bytes) {
        return StepOutcome::Err(format!("network: write {}: {e}", dest.display()));
    }
    download_log::info(
        app,
        "socialfetch",
        Some(clip_id),
        format!("saved {} ({} bytes)", dest.display(), bytes.len()),
    );
    StepOutcome::Ok(())
}

fn profile_url_for(platform: SfPlatform, handle: &str) -> String {
    match platform {
        SfPlatform::Instagram => format!("https://www.instagram.com/{}/", handle),
        SfPlatform::TikTok => format!("https://www.tiktok.com/@{}", handle),
        SfPlatform::YouTube => format!("https://www.youtube.com/@{}", handle),
        SfPlatform::Unsupported => format!("https://example.com/{}", handle),
    }
}

/// Pull the YouTube handle from a `/v1/youtube/channel` payload.
///
/// SocialFetch puts the bare handle (no leading `@`) on `data.channel.handle`,
/// per their OpenAPI contract. Falls back to `data.channel.profileUrl` if
/// present so we can recover the handle from the canonical URL when the
/// dedicated field is absent.
fn extract_youtube_channel_handle(data: &Value) -> Option<String> {
    if let Some(s) = walk_string(data, &["channel", "handle"]) {
        let trimmed = s.trim().trim_start_matches('@');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let profile_url = walk_string(data, &["channel", "profileUrl"])?;
    crate::helpers::extract_youtube_handle_from_url(profile_url)
}

/// Resolve a YouTube channel URL to its `@handle` via SocialFetch's
/// `/v1/youtube/channel` endpoint.
///
/// Used by [`crate::operativo`] as the second step of the
/// SocialKit -> SocialFetch waterfall when populating the Operativo CSV column.
pub async fn resolve_youtube_handle_socialfetch(
    channel_url: &str,
    api_key: &str,
) -> Result<String, SocialfetchError> {
    let request_url = format!(
        "{SF_BASE}/youtube/channel?url={}",
        urlencoding::encode(channel_url)
    );
    let json = call_get_json(&request_url, api_key).await?;
    let data = payload_data(&json);
    if let Some(err) = check_lookup_status(data) {
        return Err(err);
    }
    extract_youtube_channel_handle(data).ok_or(SocialfetchError::UnresolvableData)
}

/// Single point for HTTP + auth + classification.
async fn call_get_json(request_url: &str, api_key: &str) -> Result<Value, SocialfetchError> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| SocialfetchError::Network(e.to_string()))?;
    let res = client
        .get(request_url)
        .header("x-api-key", api_key)
        .header("User-Agent", "CompiBuilder/1.0 (Tauri; socialfetch)")
        .send()
        .await
        .map_err(|e| SocialfetchError::Network(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let body_short: String = body.chars().take(200).collect();
        return Err(classify_http(status.as_u16(), body_short));
    }
    res.json::<Value>()
        .await
        .map_err(|e| SocialfetchError::Network(format!("json: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_dispatch_matches_known_hosts() {
        assert_eq!(
            sf_platform_for_url("https://www.instagram.com/reel/abc/"),
            SfPlatform::Instagram
        );
        assert_eq!(
            sf_platform_for_url("https://www.tiktok.com/@user/video/123"),
            SfPlatform::TikTok
        );
        assert_eq!(
            sf_platform_for_url("https://www.youtube.com/watch?v=abc"),
            SfPlatform::YouTube
        );
        assert_eq!(
            sf_platform_for_url("https://youtu.be/abc"),
            SfPlatform::YouTube
        );
    }

    #[test]
    fn platform_dispatch_skips_unsupported() {
        assert_eq!(
            sf_platform_for_url("https://www.douyin.com/video/123"),
            SfPlatform::Unsupported
        );
        assert_eq!(
            sf_platform_for_url("https://www.kuaishou.com/short-video/abc"),
            SfPlatform::Unsupported
        );
        assert_eq!(
            sf_platform_for_url("https://www.bilibili.com/video/BV123"),
            SfPlatform::Unsupported
        );
        assert_eq!(
            sf_platform_for_url("https://www.pinterest.com/pin/abc/"),
            SfPlatform::Unsupported
        );
        assert_eq!(
            sf_platform_for_url("https://www.xiaohongshu.com/explore/abc"),
            SfPlatform::Unsupported
        );
    }

    #[test]
    fn classify_http_maps_known_status_codes() {
        assert!(matches!(
            classify_http(401, "x".into()),
            SocialfetchError::BadApiKey(_)
        ));
        assert!(matches!(
            classify_http(403, "x".into()),
            SocialfetchError::BadApiKey(_)
        ));
        assert!(matches!(
            classify_http(402, "x".into()),
            SocialfetchError::InsufficientCredits(_)
        ));
        assert!(matches!(
            classify_http(404, "x".into()),
            SocialfetchError::NeedsLogin(_)
        ));
        assert!(matches!(
            classify_http(429, "x".into()),
            SocialfetchError::RateLimited(_)
        ));
        assert!(matches!(
            classify_http(500, "x".into()),
            SocialfetchError::Network(_)
        ));
    }

    #[test]
    fn check_lookup_status_recognizes_known_outcomes() {
        let found = serde_json::json!({"lookupStatus": "found"});
        assert!(check_lookup_status(&found).is_none());

        let not_found = serde_json::json!({"lookupStatus": "not_found"});
        assert!(matches!(
            check_lookup_status(&not_found),
            Some(SocialfetchError::NeedsLogin(_))
        ));

        let private = serde_json::json!({"lookupStatus": "private"});
        assert!(matches!(
            check_lookup_status(&private),
            Some(SocialfetchError::NeedsLogin(_))
        ));

        let absent = serde_json::json!({});
        assert!(check_lookup_status(&absent).is_none());
    }

    #[test]
    fn extract_handle_walks_documented_paths() {
        // Instagram - common shape
        let ig = serde_json::json!({
            "author": { "username": "barbosaricks", "fullName": "Bárbara Ricks" }
        });
        assert_eq!(
            extract_handle(SfPlatform::Instagram, &ig),
            Some("barbosaricks".to_string())
        );

        // TikTok - uniqueId is the canonical username field
        let tt = serde_json::json!({
            "author": { "uniqueId": "charlidamelio", "nickname": "charli" }
        });
        assert_eq!(
            extract_handle(SfPlatform::TikTok, &tt),
            Some("charlidamelio".to_string())
        );

        // YouTube - channel.handle
        let yt = serde_json::json!({
            "channel": { "handle": "@MrBeast", "title": "MrBeast" }
        });
        // The leading @ is stripped because the rest of the codebase keys
        // off bare handles (see `helpers::extract_tiktok_handle`).
        assert_eq!(
            extract_handle(SfPlatform::YouTube, &yt),
            Some("MrBeast".to_string())
        );
    }

    #[test]
    fn extract_handle_returns_none_when_field_missing() {
        let empty = serde_json::json!({});
        assert_eq!(extract_handle(SfPlatform::Instagram, &empty), None);
        assert_eq!(extract_handle(SfPlatform::TikTok, &empty), None);
        assert_eq!(extract_handle(SfPlatform::YouTube, &empty), None);
    }

    #[test]
    fn extract_handle_skips_empty_strings() {
        let ig = serde_json::json!({ "author": { "username": "   " } });
        assert_eq!(extract_handle(SfPlatform::Instagram, &ig), None);
    }

    // ── extract_youtube_channel_handle ────────────────────────────────────

    #[test]
    fn yt_channel_handle_uses_handle_field() {
        let data = serde_json::json!({
            "channel": { "handle": "MrBeast", "displayName": "MrBeast" }
        });
        assert_eq!(
            extract_youtube_channel_handle(&data),
            Some("MrBeast".to_string())
        );
    }

    #[test]
    fn yt_channel_handle_strips_leading_at() {
        let data = serde_json::json!({
            "channel": { "handle": "@entroisdimensions" }
        });
        assert_eq!(
            extract_youtube_channel_handle(&data),
            Some("entroisdimensions".to_string())
        );
    }

    #[test]
    fn yt_channel_handle_falls_back_to_profile_url() {
        // `handle` missing but `profileUrl` is the canonical @handle URL.
        let data = serde_json::json!({
            "channel": { "profileUrl": "http://www.youtube.com/@entroisdimensions" }
        });
        assert_eq!(
            extract_youtube_channel_handle(&data),
            Some("entroisdimensions".to_string())
        );
    }

    #[test]
    fn yt_channel_handle_returns_none_when_unusable() {
        let data = serde_json::json!({ "channel": null });
        assert_eq!(extract_youtube_channel_handle(&data), None);
    }

    #[test]
    fn extract_avatar_requires_http_url() {
        let bad = serde_json::json!({
            "author": { "profilePicUrl": "/relative/path.jpg" }
        });
        assert_eq!(extract_avatar(SfPlatform::Instagram, &bad), None);

        let good = serde_json::json!({
            "author": { "profilePicUrl": "https://cdn.example/pic.jpg" }
        });
        assert_eq!(
            extract_avatar(SfPlatform::Instagram, &good),
            Some("https://cdn.example/pic.jpg".to_string())
        );
    }

    #[test]
    fn extract_media_url_finds_nested_or_flat() {
        let nested = serde_json::json!({
            "video": { "downloadUrl": "https://cdn.example/v.mp4" }
        });
        assert_eq!(
            extract_media_url(SfPlatform::Instagram, &nested),
            Some("https://cdn.example/v.mp4".to_string())
        );

        let flat = serde_json::json!({ "downloadUrl": "https://cdn.example/v.mp4" });
        assert_eq!(
            extract_media_url(SfPlatform::TikTok, &flat),
            Some("https://cdn.example/v.mp4".to_string())
        );

        let array_form = serde_json::json!({
            "media": [{ "downloadUrl": "https://cdn.example/v.mp4" }]
        });
        assert_eq!(
            extract_media_url(SfPlatform::Instagram, &array_form),
            Some("https://cdn.example/v.mp4".to_string())
        );
    }

    #[test]
    fn extract_media_url_rejects_relative_urls() {
        let bad = serde_json::json!({ "video": { "url": "/path/v.mp4" } });
        assert_eq!(extract_media_url(SfPlatform::Instagram, &bad), None);
    }

    #[test]
    fn route_for_get_item_covers_supported_platforms() {
        assert_eq!(route_for_get_item(SfPlatform::Instagram), Some("/instagram/posts"));
        assert_eq!(route_for_get_item(SfPlatform::TikTok), Some("/tiktok/videos"));
        assert_eq!(route_for_get_item(SfPlatform::YouTube), Some("/youtube/videos"));
        assert_eq!(route_for_get_item(SfPlatform::Unsupported), None);
    }

    // ── Skip-path gates ─────────────────────────────────────────────────
    //
    // The cost contract: "we never bill the user when SocialFetch is not
    // applicable". The actual network call is gated by these pure
    // functions, so testing them directly proves the contract holds
    // without needing an AppHandle or a mock HTTP server.

    #[test]
    fn resolve_profile_skips_on_empty_api_key() {
        assert_eq!(
            resolve_profile_skip_reason("https://www.instagram.com/reel/abc/", ""),
            Some("no_api_key")
        );
    }

    #[test]
    fn resolve_profile_skips_unsupported_platforms() {
        assert_eq!(
            resolve_profile_skip_reason("https://www.douyin.com/video/abc", "sfk_test"),
            Some("unsupported_platform")
        );
        assert_eq!(
            resolve_profile_skip_reason("https://www.kuaishou.com/short-video/abc", "sfk_test"),
            Some("unsupported_platform")
        );
        assert_eq!(
            resolve_profile_skip_reason("https://www.bilibili.com/video/BV123", "sfk_test"),
            Some("unsupported_platform")
        );
        assert_eq!(
            resolve_profile_skip_reason("https://www.pinterest.com/pin/abc/", "sfk_test"),
            Some("unsupported_platform")
        );
    }

    #[test]
    fn resolve_profile_proceeds_on_supported_platforms() {
        assert_eq!(
            resolve_profile_skip_reason("https://www.instagram.com/reel/abc/", "sfk_test"),
            None
        );
        assert_eq!(
            resolve_profile_skip_reason("https://www.tiktok.com/@user/video/123", "sfk_test"),
            None
        );
        assert_eq!(
            resolve_profile_skip_reason("https://www.youtube.com/watch?v=abc", "sfk_test"),
            None
        );
    }

    #[test]
    fn media_download_skips_on_empty_api_key() {
        assert_eq!(
            media_download_skip_reason("https://www.instagram.com/reel/abc/", ""),
            Some("no_api_key")
        );
    }

    #[test]
    fn media_download_skips_youtube_and_unsupported() {
        // YouTube is supported for resolution but not media download.
        assert_eq!(
            media_download_skip_reason("https://www.youtube.com/watch?v=abc", "sfk_test"),
            Some("media_download_unsupported_platform")
        );
        assert_eq!(
            media_download_skip_reason("https://www.douyin.com/video/abc", "sfk_test"),
            Some("media_download_unsupported_platform")
        );
    }

    #[test]
    fn media_download_proceeds_on_tiktok_and_instagram() {
        assert_eq!(
            media_download_skip_reason("https://www.instagram.com/reel/abc/", "sfk_test"),
            None
        );
        assert_eq!(
            media_download_skip_reason("https://www.tiktok.com/@user/video/123", "sfk_test"),
            None
        );
    }
}
