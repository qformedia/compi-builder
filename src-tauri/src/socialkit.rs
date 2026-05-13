//! Optional SocialKit API — Instagram /stats only (paid fallback for creator resolution).

use crate::helpers::username_from_ig_profile_url;
use crate::resolver::{EnrichedProfile, ResolveError};
use reqwest::Url;

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
pub async fn resolve_via_socialkit_instagram_stats(
    url: &str,
    api_key: &str,
) -> Result<EnrichedProfile, ResolveError> {
    let mut u = Url::parse("https://api.socialkit.dev/instagram/stats")
        .map_err(|e| ResolveError::NetworkError(e.to_string()))?;
    u.query_pairs_mut()
        .append_pair("url", url)
        .append_pair("access_key", api_key)
        .append_pair("cache", "true")
        .append_pair("cache_ttl", "2592000");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ResolveError::NetworkError(e.to_string()))?;

    let res = client
        .get(u)
        .header("User-Agent", "CompiBuilder/1.0 (Tauri; creator-resolve)")
        .send()
        .await
        .map_err(|e| ResolveError::NetworkError(e.to_string()))?;

    if !res.status().is_success() {
        return Err(ResolveError::UnresolvableUrl);
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| ResolveError::NetworkError(e.to_string()))?;

    let data = json.get("data").unwrap_or(&json);

    let handle = pick_socialkit_ig_handle(data).ok_or(ResolveError::UnresolvableUrl)?;

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
}
