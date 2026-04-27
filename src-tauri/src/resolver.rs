//! Live creator resolution (mostly free) + 1h in-memory cache + optional HubSpot sk_* cache (7d).

use lru::LruCache;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::helpers::{
    extract_instagram_shortcode, extract_instagram_username_from_html, extract_tiktok_handle,
};
use crate::read_sk_creator_cache;
use crate::socialkit::resolve_via_socialkit_instagram_stats;
use crate::write_clip_sk_creator_cache;
use crate::ytdlp_dump_json;

static RESOLVE_CACHE: Lazy<tokio::sync::Mutex<LruCache<String, (EnrichedProfile, Instant)>>> =
    Lazy::new(|| {
        tokio::sync::Mutex::new(LruCache::new(
            NonZeroUsize::new(256).expect("256 is non-zero"),
        ))
    });
static IG_PACE: Lazy<tokio::sync::Mutex<Instant>> =
    Lazy::new(|| tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(10)));
static YTDLP_PACE: Lazy<tokio::sync::Mutex<Instant>> =
    Lazy::new(|| tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(10)));

const MEM_TTL: Duration = Duration::from_secs(3600);
const IG_MIN_GAP: Duration = Duration::from_millis(1500);
const YTDLP_MIN_GAP: Duration = Duration::from_millis(2000);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Browser-grade UA used for HTML scrapes that reject obvious bots.
const UA_SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

static RE_YT_AT_HANDLE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"youtube\.com/@([^/?#]+)").expect("valid regex"));
static RE_YT_C_PATH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"youtube\.com/c/([^/?#]+)").expect("valid regex"));
static RE_YT_USER_PATH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"youtube\.com/user/([^/?#]+)").expect("valid regex"));

/// Same shape as the Tauri command + [`crate::EnrichedProfile`] re-export in lib.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedProfile {
    pub platform: String,
    pub profile_url: String,
    pub handle: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub source: String,
    pub cached_at: Option<i64>,
}

#[derive(Debug)]
pub enum ResolveError {
    UnresolvableUrl,
    NetworkError(String),
    #[allow(dead_code)]
    NotFound,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::UnresolvableUrl => write!(f, "unresolvable_url"),
            ResolveError::NetworkError(s) => write!(f, "{}", s),
            ResolveError::NotFound => write!(f, "not_found"),
        }
    }
}

/// Canonicalize cache key: trim, strip common tracking params later if needed
fn cache_key_url(url: &str) -> String {
    url.trim().to_string()
}

async fn wait_ig() {
    let mut last = IG_PACE.lock().await;
    let el = last.elapsed();
    if el < IG_MIN_GAP {
        tokio::time::sleep(IG_MIN_GAP - el).await;
    }
    *last = Instant::now();
}

async fn wait_ytdlp() {
    let mut last = YTDLP_PACE.lock().await;
    let el = last.elapsed();
    if el < YTDLP_MIN_GAP {
        tokio::time::sleep(YTDLP_MIN_GAP - el).await;
    }
    *last = Instant::now();
}

/// Try to read `@handle` / `/c/…` / `/user/…` from a YouTube URL (no network).
fn parse_youtube_handle_from_url(url: &str) -> Option<(String, String)> {
    if let Some(h) = RE_YT_AT_HANDLE
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .filter(|s| !s.is_empty())
    {
        return Some((h.to_string(), format!("https://www.youtube.com/@{}", h)));
    }
    for re in [&*RE_YT_C_PATH, &*RE_YT_USER_PATH] {
        if let Some(h) = re
            .captures(url)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some((h.to_string(), format!("https://www.youtube.com/c/{}", h)));
        }
    }
    None
}

fn is_youtube_watchish(url: &str) -> bool {
    let u = url.to_lowercase();
    (u.contains("youtube.com/") && (u.contains("watch?v=") || u.contains("/shorts/")))
        || u.contains("youtu.be/")
}

fn ytdlp_best_profile(
    j: &serde_json::Value,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let handle = j
        .get("uploader_id")
        .and_then(|v| v.as_str())
        .or_else(|| j.get("uploader").and_then(|v| v.as_str()))
        .map(String::from);
    let profile = j
        .get("uploader_url")
        .and_then(|v| v.as_str())
        .or_else(|| j.get("channel").and_then(|v| v.as_str()))
        .or_else(|| j.get("channel_url").and_then(|v| v.as_str()))
        .map(String::from);
    let display = j
        .get("uploader")
        .and_then(|v| v.as_str())
        .or_else(|| j.get("channel").and_then(|v| v.as_str()))
        .map(String::from);
    let av = j
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(String::from);
    (handle, profile, display, av)
}

fn detect_resolver_platform_key(url: &str) -> &'static str {
    let u = url.to_lowercase();
    if u.contains("tiktok.com") {
        return "tiktok";
    }
    if u.contains("instagram.com") {
        return "instagram";
    }
    if u.contains("youtu.be") || u.contains("youtube.com") {
        return "youtube";
    }
    if u.contains("pinterest.") {
        return "pinterest";
    }
    if u.contains("bilibili.com") {
        return "bilibili";
    }
    if u.contains("xiaohongshu.com") {
        return "xiaohongshu";
    }
    if u.contains("douyin.com") {
        return "douyin";
    }
    if u.contains("kuaishou.com") {
        return "kuaishou";
    }
    "other"
}

/// Platforms where we attempt live author resolution (oEmbed/embed/yt-dlp/SocialKit).
/// Everything else falls back to a HubSpot manual pick — yt-dlp can't reliably
/// extract authors for those networks and the noisy errors aren't worth the cost.
fn is_live_resolvable(platform_key: &str) -> bool {
    matches!(platform_key, "tiktok" | "instagram" | "youtube")
}

fn ig_profile_url(handle: &str) -> String {
    format!("https://www.instagram.com/{}/", handle)
}

fn og_image_thumb(html: &str) -> Option<String> {
    crate::helpers::extract_meta_content_text(html, "og:image").filter(|u| u.starts_with("http"))
}

/// Instagram: oEmbed → embed (no yt-dlp; no user cookies in this feature).
async fn resolve_instagram_oembed_and_embed(
    client: &reqwest::Client,
    url: &str,
) -> Option<(String, String, Option<String>, Option<String>, String)> {
    // Strategy A: oEmbed
    let oembed_url = format!(
        "https://www.instagram.com/api/v1/oembed/?url={}",
        urlencoding::encode(url)
    );
    if let Ok(res) = client
        .get(&oembed_url)
        .header("User-Agent", UA_SAFARI)
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                let author_name = json
                    .get("author_name")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let thumbnail = json
                    .get("thumbnail_url")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let html = json.get("html").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(h) = author_name.or_else(|| extract_instagram_username_from_html(html))
                {
                    return Some((
                        h.clone(),
                        ig_profile_url(&h),
                        None,
                        thumbnail,
                        "ig_oembed".to_string(),
                    ));
                }
            }
        }
    }

    // Strategy B: embed (reel or photo post)
    if let Some(code) = extract_instagram_shortcode(url) {
        let kind = if url.to_lowercase().contains("/p/") {
            "p"
        } else {
            "reel"
        };
        let embed_url = format!(
            "https://www.instagram.com/{}/{}/embed/captioned/",
            kind, code
        );
        if let Ok(res) = client
            .get(&embed_url)
            .header("User-Agent", UA_SAFARI)
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(html) = res.text().await {
                    if let Some(h) = extract_instagram_username_from_html(&html) {
                        return Some((
                            h.clone(),
                            ig_profile_url(&h),
                            None,
                            og_image_thumb(&html),
                            "ig_embed".to_string(),
                        ));
                    }
                }
            }
        }
    }

    None
}

/// Run yt-dlp `--dump-single-json` for a YouTube watch URL and emit an [`EnrichedProfile`].
/// Only YouTube reaches this path — see [`is_live_resolvable`].
async fn resolve_youtube_via_ytdlp(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<EnrichedProfile, ResolveError> {
    wait_ytdlp().await;
    let json = ytdlp_dump_json(app, url, cookies_browser, cookies_file)
        .await
        .map_err(ResolveError::NetworkError)?;
    let (h_opt, p_opt, d_opt, a_opt) = ytdlp_best_profile(&json);
    let h = h_opt
        .filter(|s| !s.is_empty())
        .ok_or(ResolveError::UnresolvableUrl)?;
    let profile_url = p_opt
        .filter(|s| s.starts_with("http"))
        .unwrap_or_else(|| format!("https://www.youtube.com/@{}", h));
    Ok(EnrichedProfile {
        platform: "youtube".to_string(),
        profile_url,
        handle: h,
        display_name: d_opt,
        avatar: a_opt,
        source: "ytdlp".to_string(),
        cached_at: None,
    })
}

/// Core resolver (Tier 0 HubSpot + 1h memory + per-platform live cascade).
#[allow(clippy::too_many_arguments)]
pub async fn resolve_creator_from_url(
    app: &AppHandle,
    token: &str,
    clip_id: &str,
    url: &str,
    socialkit_api_key: Option<&str>,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
    force_live: bool,
) -> Result<EnrichedProfile, ResolveError> {
    let key = cache_key_url(url);
    if force_live {
        // bust memory cache; HubSpot cache is bypassed by skipping the read below
        let mut c = RESOLVE_CACHE.lock().await;
        c.pop(&key);
    } else {
        if let Ok(Some(cached)) = read_sk_creator_cache(token, clip_id).await {
            return Ok(EnrichedProfile {
                platform: cached.platform,
                profile_url: cached.profile_url,
                handle: cached.handle,
                display_name: cached.display_name,
                avatar: cached.avatar,
                source: "hubspot_cache".to_string(),
                cached_at: Some(cached.last_enriched.timestamp_millis()),
            });
        }
        let now = Instant::now();
        let mut cache = RESOLVE_CACHE.lock().await;
        if let Some((prof, t0)) = cache.get(&key) {
            if now.duration_since(*t0) < MEM_TTL {
                return Ok(prof.clone());
            }
        }
    }

    let pkey = detect_resolver_platform_key(url);
    if !is_live_resolvable(pkey) {
        return Err(ResolveError::UnresolvableUrl);
    }
    let out: EnrichedProfile = match pkey {
        "tiktok" => {
            let h = extract_tiktok_handle(url).ok_or(ResolveError::UnresolvableUrl)?;
            EnrichedProfile {
                platform: "tiktok".to_string(),
                profile_url: format!("https://www.tiktok.com/@{}", h),
                handle: h,
                display_name: None,
                avatar: None,
                source: "tiktok_url".to_string(),
                cached_at: None,
            }
        }
        "instagram" => {
            wait_ig().await;
            let client = reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .map_err(|e| ResolveError::NetworkError(e.to_string()))?;
            if let Some((h, pu, dn, th, src)) =
                resolve_instagram_oembed_and_embed(&client, url).await
            {
                EnrichedProfile {
                    platform: "instagram".to_string(),
                    profile_url: pu,
                    handle: h,
                    display_name: dn,
                    avatar: th,
                    source: src,
                    cached_at: None,
                }
            } else {
                let key = socialkit_api_key
                    .filter(|k| !k.is_empty())
                    .ok_or(ResolveError::UnresolvableUrl)?;
                wait_ig().await;
                resolve_via_socialkit_instagram_stats(url, key).await?
            }
        }
        "youtube" => {
            if let Some((h, pu)) = parse_youtube_handle_from_url(url) {
                EnrichedProfile {
                    platform: "youtube".to_string(),
                    profile_url: pu,
                    handle: h,
                    display_name: None,
                    avatar: None,
                    source: "yt_handle_url".to_string(),
                    cached_at: None,
                }
            } else if is_youtube_watchish(url) {
                resolve_youtube_via_ytdlp(app, url, cookies_browser, cookies_file).await?
            } else {
                return Err(ResolveError::UnresolvableUrl);
            }
        }
        // `is_live_resolvable` above guards anything except tiktok/instagram/youtube.
        _ => unreachable!("non-live-resolvable platform reached match arm"),
    };

    // write HubSpot + mem cache (live paths only, not re-entry from hubspot_cache)
    if let Err(e) = write_clip_sk_creator_cache(token, clip_id, &out).await {
        eprintln!("[resolve_creator] write sk_* cache: {e}");
    }

    {
        let mut cache = RESOLVE_CACHE.lock().await;
        cache.put(key, (out.clone(), Instant::now()));
    }

    Ok(out)
}
