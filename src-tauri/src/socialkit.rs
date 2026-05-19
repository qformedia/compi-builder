//! Optional SocialKit API — Instagram /stats only (paid fallback for creator resolution).

use crate::helpers::username_from_ig_profile_url;
use crate::resolver::EnrichedProfile;
use reqwest::Url;

/// Classified failure reasons from a SocialKit call. Each variant maps to a
/// stable `reason` string consumed by the cascade and the frontend's smart
/// error classifier (Phase D).
#[derive(Debug)]
pub enum SocialkitError {
    /// HTTP 401 / 403 — `access_key` rejected. User-actionable: update key.
    BadApiKey(String),
    /// HTTP 404 / `data: null` / "media not found". We cannot tell deleted
    /// from "gated to logged-in viewers" from the upstream response alone;
    /// `needs_login` is the actionable framing because the user can fix the
    /// gated case (configure cookies / try a logged-in scraper).
    NeedsLogin(String),
    /// HTTP 429.
    RateLimited(String),
    /// Network / 5xx / parse failures — i.e. SocialKit itself is sick.
    Network(String),
    /// 2xx but the payload didn't yield a usable handle (e.g. `author` was
    /// numeric pk and `authorLink` was empty/numeric).
    UnresolvableData,
}

impl SocialkitError {
    /// Stable identifier consumed by the frontend classifier.
    pub fn reason(&self) -> String {
        match self {
            SocialkitError::BadApiKey(s) => format!("bad_api_key: {s}"),
            SocialkitError::NeedsLogin(s) => format!("needs_login: {s}"),
            SocialkitError::RateLimited(s) => format!("rate_limited: {s}"),
            SocialkitError::Network(s) => format!("network: {s}"),
            SocialkitError::UnresolvableData => "unresolvable_data".to_string(),
        }
    }
}

/// Reject SocialKit `author` values that are clearly Instagram `pk` numeric
/// IDs leaking through the API (e.g. for restricted/private posts) instead
/// of real usernames. SocialKit documents `author` as a username string but
/// occasionally returns the numeric `pk` for edge-case accounts.
fn looks_like_ig_pk(s: &str) -> bool {
    !s.is_empty() && s.len() >= 6 && s.chars().all(|c| c.is_ascii_digit())
}

/// Pick a real handle from a SocialKit `/instagram/stats` response.
///
/// Tries `data.author` first; if it's empty or a numeric `pk`, falls back
/// to extracting the username from `data.authorLink`. Returns `None` when
/// neither yields a usable handle so the caller can surface "unresolvable"
/// instead of creating a creator with a numeric `instagram.com/<digits>/`
/// profile URL.
pub(crate) fn pick_socialkit_ig_handle(data: &serde_json::Value) -> Option<String> {
    let author = data
        .get("author")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(a) = author {
        if !looks_like_ig_pk(a) {
            return Some(a.to_string());
        }
    }

    let author_link = data
        .get("authorLink")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.starts_with("http"))?;
    username_from_ig_profile_url(author_link)
}

/// GET /instagram/stats and map `author` + `authorLink` into an [`EnrichedProfile`].
///
/// On HTTP errors the response is *classified* (see [`SocialkitError`]) so
/// callers can produce truthful messages — the previous behaviour collapsed
/// every failure into "unresolvable", which led to "add a SocialKit key"
/// errors firing even when SocialKit was working but the post was gated to
/// logged-in viewers.
pub async fn resolve_via_socialkit_instagram_stats(
    url: &str,
    api_key: &str,
) -> Result<EnrichedProfile, SocialkitError> {
    let mut u = Url::parse("https://api.socialkit.dev/instagram/stats")
        .map_err(|e| SocialkitError::Network(e.to_string()))?;
    u.query_pairs_mut()
        .append_pair("url", url)
        .append_pair("access_key", api_key)
        .append_pair("cache", "true")
        .append_pair("cache_ttl", "2592000");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| SocialkitError::Network(e.to_string()))?;

    let res = client
        .get(u)
        .header("User-Agent", "CompiBuilder/1.0 (Tauri; creator-resolve)")
        .send()
        .await
        .map_err(|e| SocialkitError::Network(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let body_preview = res.text().await.unwrap_or_default();
        let body_short: String = body_preview.chars().take(200).collect();
        return Err(match status_code {
            401 | 403 => SocialkitError::BadApiKey(format!("HTTP {status_code}: {body_short}")),
            404 => SocialkitError::NeedsLogin(format!("HTTP 404: {body_short}")),
            429 => SocialkitError::RateLimited(format!("HTTP 429: {body_short}")),
            _ => SocialkitError::Network(format!("HTTP {status_code}: {body_short}")),
        });
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| SocialkitError::Network(format!("json: {e}")))?;

    let data = json.get("data").unwrap_or(&json);

    let handle = pick_socialkit_ig_handle(data).ok_or(SocialkitError::UnresolvableData)?;

    // Always rebuild the canonical profile URL from the validated handle so
    // we can never store a `https://www.instagram.com/<numeric-pk>/` link
    // even if SocialKit's `authorLink` happens to point at one.
    let profile_url = format!("https://www.instagram.com/{}/", handle);

    let thumb = data
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            data.get("thumbnails")
                .and_then(|a| a.as_array())
                .and_then(|arr| arr.last())
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
                .map(String::from)
        });

    Ok(EnrichedProfile {
        platform: "instagram".to_string(),
        profile_url,
        handle,
        display_name: None,
        avatar: thumb,
        source: "ig_socialkit".to_string(),
        cached_at: None,
    })
}

/// Pick the YouTube handle from a SocialKit `/youtube/channel-stats` payload.
///
/// SocialKit returns the bare handle on `data.username` (no leading `@`).
/// `data.profileUrl` (e.g. `https://www.youtube.com/@socialkit-dev`) is used
/// as a fallback in case `username` is absent for some channels.
pub(crate) fn pick_socialkit_youtube_handle(data: &serde_json::Value) -> Option<String> {
    let username = data
        .get("username")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(u) = username {
        return Some(u.to_string());
    }
    let profile_url = data
        .get("profileUrl")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.starts_with("http"))?;
    crate::helpers::extract_youtube_handle_from_url(profile_url)
}

/// GET `/youtube/channel-stats` and return the channel's handle.
///
/// Used by [`crate::operativo`] to resolve YouTube `/channel/UC...` URLs into
/// `@handle` form for the Operativo CSV column. Errors are classified the
/// same way as the Instagram path so the waterfall can fall through to
/// SocialFetch on the recoverable cases.
pub async fn resolve_youtube_handle_socialkit(
    channel_url: &str,
    api_key: &str,
) -> Result<String, SocialkitError> {
    let mut u = Url::parse("https://api.socialkit.dev/youtube/channel-stats")
        .map_err(|e| SocialkitError::Network(e.to_string()))?;
    u.query_pairs_mut()
        .append_pair("url", channel_url)
        .append_pair("access_key", api_key)
        .append_pair("cache", "true")
        .append_pair("cache_ttl", "2592000");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| SocialkitError::Network(e.to_string()))?;

    let res = client
        .get(u)
        .header("User-Agent", "CompiBuilder/1.0 (Tauri; operativo)")
        .send()
        .await
        .map_err(|e| SocialkitError::Network(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let body_preview = res.text().await.unwrap_or_default();
        let body_short: String = body_preview.chars().take(200).collect();
        return Err(match status_code {
            401 | 403 => SocialkitError::BadApiKey(format!("HTTP {status_code}: {body_short}")),
            404 => SocialkitError::NeedsLogin(format!("HTTP 404: {body_short}")),
            429 => SocialkitError::RateLimited(format!("HTTP 429: {body_short}")),
            _ => SocialkitError::Network(format!("HTTP {status_code}: {body_short}")),
        });
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| SocialkitError::Network(format!("json: {e}")))?;
    let data = json.get("data").unwrap_or(&json);
    pick_socialkit_youtube_handle(data).ok_or(SocialkitError::UnresolvableData)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socialkit_handle_accepts_real_username() {
        let data = serde_json::json!({
            "author": "yuumi_cat9",
            "authorLink": "https://www.instagram.com/yuumi_cat9/",
        });
        assert_eq!(pick_socialkit_ig_handle(&data), Some("yuumi_cat9".into()));
    }

    #[test]
    fn socialkit_handle_rejects_numeric_pk_in_author_field() {
        // `author` is a numeric `pk` and `authorLink` is also numeric — the
        // observed bug shape. Resolution must fail so the cascade falls
        // through and the UI shows "Failed" rather than a `@65486544502`.
        let data = serde_json::json!({
            "author": "65486544502",
            "authorLink": "https://www.instagram.com/65486544502/",
        });
        assert_eq!(pick_socialkit_ig_handle(&data), None);
    }

    #[test]
    fn socialkit_handle_recovers_username_from_author_link() {
        // `author` is empty but `authorLink` has the real handle.
        let data = serde_json::json!({
            "author": "",
            "authorLink": "https://www.instagram.com/yuumi_cat9/",
        });
        assert_eq!(pick_socialkit_ig_handle(&data), Some("yuumi_cat9".into()));
    }

    #[test]
    fn socialkit_handle_recovers_username_when_author_is_numeric() {
        // `author` is a numeric pk but `authorLink` points at a real handle.
        let data = serde_json::json!({
            "author": "65486544502",
            "authorLink": "https://www.instagram.com/yuumi_cat9/",
        });
        assert_eq!(pick_socialkit_ig_handle(&data), Some("yuumi_cat9".into()));
    }

    #[test]
    fn socialkit_handle_returns_none_when_nothing_usable() {
        let data = serde_json::json!({
            "author": "",
            "authorLink": "",
        });
        assert_eq!(pick_socialkit_ig_handle(&data), None);
    }

    #[test]
    fn socialkit_handle_returns_none_when_fields_missing() {
        let data = serde_json::json!({});
        assert_eq!(pick_socialkit_ig_handle(&data), None);
    }

    // ── pick_socialkit_youtube_handle ─────────────────────────────────────

    #[test]
    fn socialkit_youtube_handle_uses_username_field() {
        let data = serde_json::json!({
            "username": "entroisdimensions",
            "profileUrl": "https://www.youtube.com/@entroisdimensions",
        });
        assert_eq!(
            pick_socialkit_youtube_handle(&data),
            Some("entroisdimensions".into())
        );
    }

    #[test]
    fn socialkit_youtube_handle_falls_back_to_profile_url() {
        let data = serde_json::json!({
            "username": "",
            "profileUrl": "https://www.youtube.com/@entroisdimensions",
        });
        assert_eq!(
            pick_socialkit_youtube_handle(&data),
            Some("entroisdimensions".into())
        );
    }

    #[test]
    fn socialkit_youtube_handle_returns_none_when_unusable() {
        let data = serde_json::json!({});
        assert_eq!(pick_socialkit_youtube_handle(&data), None);
    }

    #[test]
    fn socialkit_youtube_handle_skips_non_handle_profile_url() {
        // A profileUrl that isn't an @handle URL (e.g. a channel-id URL)
        // gives us nothing usable — fall through to None so the waterfall
        // tries SocialFetch.
        let data = serde_json::json!({
            "username": "",
            "profileUrl": "https://www.youtube.com/channel/UC2YgTFZyJr1j6fft_ywS7mg",
        });
        assert_eq!(pick_socialkit_youtube_handle(&data), None);
    }
}
