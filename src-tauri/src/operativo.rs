//! Operativo — YouTube channel-handle resolution waterfall.
//!
//! ## Why this module exists
//!
//! Most platforms expose the Operativo handle directly: TikTok / Instagram /
//! YouTube `@handle` URLs are parsed inline by [`crate::helpers::extract_operativo_handle`],
//! while Bilibili / Kuaishou / Xiaohongshu / Douyin pull the value from
//! HubSpot fields already attached to the per-clip payload.
//!
//! YouTube `/channel/UC...` URLs are the only remaining shape that needs a
//! network round-trip — we have to look up the channel's `@handle`. This
//! module owns that lookup and is invoked from the `resolve_youtube_handles`
//! Tauri command at Finish-Video time so the resolved handles are baked into
//! `clipsData` before the CSV is written.
//!
//! ## Provider order
//!
//! 1. **SocialKit** (`/youtube/channel-stats`) — typically faster and the
//!    same provider used elsewhere in CompiFlow for YouTube metadata.
//! 2. **SocialFetch** (`/v1/youtube/channel`) — paid fallback that returns a
//!    structured `data.channel.handle` field.
//!
//! Both providers are best-effort: if neither succeeds we return an empty
//! string so the Operativo column is left blank for that row, matching the
//! behaviour the team had previously achieved with a Google Sheets formula.
//!
//! ## Concurrency
//!
//! [`resolve_all`] resolves up to [`PARALLELISM`] channel URLs at once via
//! `tokio::spawn` so a project with 20 YouTube creators doesn't pay 20x the
//! per-call latency.

use std::collections::HashMap;
use std::time::Duration;

use crate::socialfetch;
use crate::socialkit;

/// Per-URL hard timeout. SocialKit + SocialFetch each have a 20s internal
/// timeout; this caps the *combined* waterfall to keep Finish Video
/// responsive even when both providers are slow.
const PER_URL_TIMEOUT: Duration = Duration::from_secs(25);

/// Maximum concurrent channel lookups. Keeps us comfortably under both
/// providers' rate limits while still resolving 20 creators in well under
/// a minute.
const PARALLELISM: usize = 5;

/// Resolve a single YouTube channel URL to its `@handle` via the
/// SocialKit -> SocialFetch waterfall.
///
/// Returns `None` when:
/// - both providers' API keys are empty, or
/// - both providers returned errors / no usable handle.
///
/// Empty / blank API keys short-circuit so users who only configured one
/// provider don't pay a round-trip to a guaranteed-401.
pub async fn resolve_youtube_handle(
    channel_url: &str,
    socialkit_key: &str,
    socialfetch_key: &str,
) -> Option<String> {
    if !socialkit_key.trim().is_empty() {
        match socialkit::resolve_youtube_handle_socialkit(channel_url, socialkit_key).await {
            Ok(handle) if !handle.is_empty() => return Some(handle),
            Ok(_) => {}
            Err(e) => {
                eprintln!(
                    "[operativo] SocialKit YouTube channel lookup failed for {channel_url}: {}",
                    e.reason()
                );
            }
        }
    }
    if !socialfetch_key.trim().is_empty() {
        match socialfetch::resolve_youtube_handle_socialfetch(channel_url, socialfetch_key).await {
            Ok(handle) if !handle.is_empty() => return Some(handle),
            Ok(_) => {}
            Err(e) => {
                eprintln!(
                    "[operativo] SocialFetch YouTube channel lookup failed for {channel_url}: {}",
                    e.reason()
                );
            }
        }
    }
    None
}

/// Resolve a batch of YouTube channel URLs in parallel.
///
/// The returned map only contains entries that resolved successfully, so the
/// caller can simply do `map.get(url).cloned().unwrap_or_default()` to fold
/// the results back into per-clip rows.
pub async fn resolve_all(
    channel_urls: Vec<String>,
    socialkit_key: String,
    socialfetch_key: String,
) -> HashMap<String, String> {
    let mut deduped: Vec<String> = channel_urls;
    deduped.sort();
    deduped.dedup();

    let mut out: HashMap<String, String> = HashMap::with_capacity(deduped.len());
    if deduped.is_empty() {
        return out;
    }

    for chunk in deduped.chunks(PARALLELISM) {
        let mut handles = Vec::with_capacity(chunk.len());
        for url in chunk {
            let url_owned = url.clone();
            let sk = socialkit_key.clone();
            let sf = socialfetch_key.clone();
            handles.push(tokio::spawn(async move {
                let resolved = tokio::time::timeout(
                    PER_URL_TIMEOUT,
                    resolve_youtube_handle(&url_owned, &sk, &sf),
                )
                .await
                .ok()
                .flatten();
                (url_owned, resolved)
            }));
        }
        for h in handles {
            if let Ok((url, Some(handle))) = h.await {
                out.insert(url, handle);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn resolve_youtube_handle_short_circuits_when_both_keys_empty() {
        // No keys configured -> return None without any network attempt.
        // (Network calls would panic in tests without a tokio runtime that
        // allows IO; this test guards against accidentally reintroducing
        // an unconditional HTTP call.)
        let out =
            resolve_youtube_handle("https://www.youtube.com/channel/UC2YgTFZyJr1j6fft_ywS7mg", "", "")
                .await;
        assert_eq!(out, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolve_all_returns_empty_map_for_empty_input() {
        let out = resolve_all(vec![], "key".into(), "key".into()).await;
        assert!(out.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolve_all_dedupes_inputs_without_calling_apis_when_keys_empty() {
        // Same URL repeated three times — with empty keys we never reach
        // either provider, but the function should still return cleanly.
        let urls = vec![
            "https://www.youtube.com/channel/UC1".into(),
            "https://www.youtube.com/channel/UC1".into(),
            "https://www.youtube.com/channel/UC2".into(),
        ];
        let out = resolve_all(urls, "".into(), "".into()).await;
        assert!(out.is_empty());
    }
}
