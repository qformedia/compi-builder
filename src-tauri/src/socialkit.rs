//! Optional SocialKit API — Instagram /stats only (paid fallback for creator resolution).

use crate::resolver::{EnrichedProfile, ResolveError};
use reqwest::Url;

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

    let author = data
        .get("author")
        .and_then(|v| v.as_str())
        .ok_or(ResolveError::UnresolvableUrl)?
        .trim();
    if author.is_empty() {
        return Err(ResolveError::UnresolvableUrl);
    }

    let author_link = data
        .get("authorLink")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
        .map(String::from)
        .unwrap_or_else(|| format!("https://www.instagram.com/{}/", author));
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
        profile_url: author_link,
        handle: author.to_string(),
        display_name: None,
        avatar: thumb,
        source: "ig_socialkit".to_string(),
        cached_at: None,
    })
}
