//! Live creator resolution (mostly free) + 1h in-memory cache + optional HubSpot sk_* cache (7d).
//!
//! Refactored in Phase B onto the shared [`crate::cascade`] module: each
//! per-platform step (oEmbed, embed, yt-dlp+cookies, SocialKit, …) is a
//! [`cascade::Step`] that returns [`cascade::StepOutcome::Skip`] when not
//! applicable (no API key, no cookies configured, etc.) or
//! [`cascade::StepOutcome::Err`] with a *classified* reason when it ran and
//! failed. The frontend's smart classifier (Phase D) keys off those
//! reasons to produce truthful messages instead of always blaming a missing
//! SocialKit key.

use lru::LruCache;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::cascade::{self, StepOutcome};
use crate::helpers::{
    extract_instagram_shortcode, extract_instagram_username_from_html, extract_tiktok_handle,
    pick_ig_handle_from_ytdlp,
};
use crate::read_sk_creator_cache;
use crate::socialfetch;
use crate::socialkit::{resolve_via_socialkit_instagram_stats, SocialkitError};
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

/// Structured failure returned by the resolver. The Tauri command JSON-encodes
/// this into the error string so the frontend can `JSON.parse` it and branch
/// on `code` / `attempts`. See Phase D in the plan and
/// [`crate::resolve_creator_from_clip_url`] for the wire format.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCreatorError {
    /// Stable error code:
    /// - `"unresolvable_platform"` — URL is on a network with no live resolver
    ///   (e.g. Pinterest, Bilibili). Frontend should jump straight to the
    ///   manual picker without showing per-step diagnostics.
    /// - `"all_failed"` — every step skipped or errored. `attempts` carries
    ///   the per-step diagnostics for the smart classifier.
    pub code: &'static str,
    /// Per-step audit log. Empty for `unresolvable_platform`.
    pub attempts: Vec<cascade::Attempt>,
}

impl ResolveCreatorError {
    pub fn unresolvable_platform() -> Self {
        Self {
            code: "unresolvable_platform",
            attempts: Vec::new(),
        }
    }

    /// JSON-encode for transmission across the Tauri command boundary. The
    /// command returns `Result<EnrichedProfile, String>` and we put this JSON
    /// in the error string so the frontend can `JSON.parse` it.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"code\":\"all_failed\",\"attempts\":[]}".to_string()
        })
    }
}

impl std::fmt::Display for ResolveCreatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_json_string())
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

fn ytdlp_best_profile_yt(
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

// ── Per-step Instagram resolvers ───────────────────────────────────────────

/// Step `ig_oembed`: unauthenticated Instagram oEmbed. Free, fast, public.
async fn step_ig_oembed(client: &reqwest::Client, url: &str) -> StepOutcome<EnrichedProfile> {
    wait_ig().await;
    let oembed_url = format!(
        "https://www.instagram.com/api/v1/oembed/?url={}",
        urlencoding::encode(url)
    );
    let res = match client
        .get(&oembed_url)
        .header("User-Agent", UA_SAFARI)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return StepOutcome::Err(format!("network: {e}")),
    };
    let status = res.status();
    if !status.is_success() {
        // Logged-out gating shows up as 4xx here just like deleted posts.
        return StepOutcome::Err(format!("http_{}", status.as_u16()));
    }
    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => return StepOutcome::Err(format!("json: {e}")),
    };
    let author_name = json
        .get("author_name")
        .and_then(|v| v.as_str())
        .map(String::from);
    let thumbnail = json
        .get("thumbnail_url")
        .and_then(|v| v.as_str())
        .map(String::from);
    let html = json.get("html").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(h) = author_name.or_else(|| extract_instagram_username_from_html(html)) {
        StepOutcome::Ok(EnrichedProfile {
            platform: "instagram".to_string(),
            profile_url: ig_profile_url(&h),
            handle: h,
            display_name: None,
            avatar: thumbnail,
            source: "ig_oembed".to_string(),
            cached_at: None,
        })
    } else {
        StepOutcome::Err("oembed_missing_author".to_string())
    }
}

/// Step `ig_embed`: unauthenticated `/embed/captioned/` HTML scrape.
async fn step_ig_embed(client: &reqwest::Client, url: &str) -> StepOutcome<EnrichedProfile> {
    let code = match extract_instagram_shortcode(url) {
        Some(c) => c,
        None => return StepOutcome::Skip("no_shortcode_in_url".to_string()),
    };
    wait_ig().await;
    let kind = if url.to_lowercase().contains("/p/") {
        "p"
    } else {
        "reel"
    };
    let embed_url = format!(
        "https://www.instagram.com/{}/{}/embed/captioned/",
        kind, code
    );
    let res = match client
        .get(&embed_url)
        .header("User-Agent", UA_SAFARI)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return StepOutcome::Err(format!("network: {e}")),
    };
    let status = res.status();
    if !status.is_success() {
        return StepOutcome::Err(format!("http_{}", status.as_u16()));
    }
    let html = match res.text().await {
        Ok(h) => h,
        Err(e) => return StepOutcome::Err(format!("body: {e}")),
    };
    if let Some(h) = extract_instagram_username_from_html(&html) {
        StepOutcome::Ok(EnrichedProfile {
            platform: "instagram".to_string(),
            profile_url: ig_profile_url(&h),
            handle: h,
            display_name: None,
            avatar: og_image_thumb(&html),
            source: "ig_embed".to_string(),
            cached_at: None,
        })
    } else {
        StepOutcome::Err("embed_missing_author".to_string())
    }
}

/// Step `ig_ytdlp_cookies` (NEW in Phase B): yt-dlp `--dump-json` against the
/// IG URL using the user's already-configured browser cookies. This is the
/// *only* path that resolves Instagram posts gated to logged-in viewers,
/// because SocialKit / SocialFetch / oEmbed / embed all hit Instagram
/// unauthenticated.
///
/// Skips when no cookies are configured so we don't pointlessly spawn
/// yt-dlp.
async fn step_ig_ytdlp_cookies(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> StepOutcome<EnrichedProfile> {
    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file.as_ref().map_or(false, |f| !f.is_empty());
    if !has_browser && !has_file {
        return StepOutcome::Skip("no_cookies_configured".to_string());
    }

    wait_ytdlp().await;
    let json = match ytdlp_dump_json(app, url, cookies_browser, cookies_file).await {
        Ok(j) => j,
        Err(e) => {
            // Map common yt-dlp Instagram failures to actionable reasons.
            let lower = e.to_lowercase();
            let reason = if lower.contains("login required")
                || lower.contains("not granting access")
                || lower.contains("private")
                || lower.contains("rate-limit")
                || lower.contains("rate limit")
            {
                format!("needs_login: {e}")
            } else if lower.contains("cookie") {
                format!("cookie_error: {e}")
            } else {
                format!("ytdlp_failed: {e}")
            };
            return StepOutcome::Err(reason);
        }
    };

    let handle = match pick_ig_handle_from_ytdlp(&json) {
        Some(h) => h,
        None => return StepOutcome::Err("ytdlp_missing_handle".to_string()),
    };
    let display = json
        .get("channel")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("uploader").and_then(|v| v.as_str()))
        .map(String::from);
    let avatar = json
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(String::from);
    StepOutcome::Ok(EnrichedProfile {
        platform: "instagram".to_string(),
        profile_url: ig_profile_url(&handle),
        handle,
        display_name: display,
        avatar,
        source: "ig_ytdlp_cookies".to_string(),
        cached_at: None,
    })
}

/// Step `ig_socialkit`: paid fallback. Skipped when no API key is configured.
async fn step_ig_socialkit(
    url: &str,
    api_key: Option<&str>,
) -> StepOutcome<EnrichedProfile> {
    let key = match api_key.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => return StepOutcome::Skip("no_api_key".to_string()),
    };
    wait_ig().await;
    match resolve_via_socialkit_instagram_stats(url, key).await {
        Ok(p) => StepOutcome::Ok(p),
        Err(e) => match e {
            SocialkitError::UnresolvableData => {
                StepOutcome::Err("unresolvable_data: socialkit returned no usable handle".into())
            }
            other => StepOutcome::Err(other.reason()),
        },
    }
}

/// Step `tiktok_url`: parse `@handle` directly out of the TikTok URL — no
/// network call. The fastest possible resolver and the one that has always
/// served TikTok URLs in this app.
fn step_tiktok_url(url: &str) -> StepOutcome<EnrichedProfile> {
    match extract_tiktok_handle(url) {
        Some(h) => StepOutcome::Ok(EnrichedProfile {
            platform: "tiktok".to_string(),
            profile_url: format!("https://www.tiktok.com/@{}", h),
            handle: h,
            display_name: None,
            avatar: None,
            source: "tiktok_url".to_string(),
            cached_at: None,
        }),
        None => StepOutcome::Err("no_handle_in_url".to_string()),
    }
}

/// Step `yt_handle_url`: parse `@handle` / `/c/…` / `/user/…` from a YouTube
/// URL — no network call.
fn step_yt_handle_url(url: &str) -> StepOutcome<EnrichedProfile> {
    match parse_youtube_handle_from_url(url) {
        Some((h, pu)) => StepOutcome::Ok(EnrichedProfile {
            platform: "youtube".to_string(),
            profile_url: pu,
            handle: h,
            display_name: None,
            avatar: None,
            source: "yt_handle_url".to_string(),
            cached_at: None,
        }),
        None => StepOutcome::Skip("no_handle_in_url".to_string()),
    }
}

/// Step `yt_ytdlp`: yt-dlp `--dump-json` against a YouTube watch / shorts URL.
async fn step_yt_ytdlp(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> StepOutcome<EnrichedProfile> {
    if !is_youtube_watchish(url) {
        return StepOutcome::Skip("not_a_watch_url".to_string());
    }
    wait_ytdlp().await;
    let json = match ytdlp_dump_json(app, url, cookies_browser, cookies_file).await {
        Ok(j) => j,
        Err(e) => return StepOutcome::Err(format!("ytdlp_failed: {e}")),
    };
    let (h_opt, p_opt, d_opt, a_opt) = ytdlp_best_profile_yt(&json);
    let h = match h_opt.filter(|s| !s.is_empty()) {
        Some(h) => h,
        None => return StepOutcome::Err("ytdlp_missing_handle".to_string()),
    };
    let profile_url = p_opt
        .filter(|s| s.starts_with("http"))
        .unwrap_or_else(|| format!("https://www.youtube.com/@{}", h));
    StepOutcome::Ok(EnrichedProfile {
        platform: "youtube".to_string(),
        profile_url,
        handle: h,
        display_name: d_opt,
        avatar: a_opt,
        source: "ytdlp".to_string(),
        cached_at: None,
    })
}

// ── Cascade orchestration ──────────────────────────────────────────────────

/// Core resolver (Tier 0 HubSpot + 1h memory + per-platform live cascade).
///
/// On full-cascade failure returns [`ResolveCreatorError`] carrying the
/// per-step attempt log so the frontend can render an honest message — see
/// [`crate::resolver::ResolveCreatorError`].
#[allow(clippy::too_many_arguments)]
pub async fn resolve_creator_from_url(
    app: &AppHandle,
    token: &str,
    clip_id: &str,
    url: &str,
    socialkit_api_key: Option<&str>,
    socialfetch_api_key: Option<&str>,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
    force_live: bool,
) -> Result<EnrichedProfile, ResolveCreatorError> {
    let key = cache_key_url(url);
    if force_live {
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
        return Err(ResolveCreatorError::unresolvable_platform());
    }

    let cascade_label = "creator-resolve";
    let socialfetch_owned: Option<String> = socialfetch_api_key.map(|s| s.to_string());
    let result = match pkey {
        "tiktok" => {
            let url_owned = url.to_string();
            let url_sf = url.to_string();
            let sf_key = socialfetch_owned.clone();
            let steps: Vec<cascade::Step<'_, EnrichedProfile>> = vec![
                cascade::Step::new("tiktok_url", async move { step_tiktok_url(&url_owned) }),
                cascade::Step::new("socialfetch", async move {
                    socialfetch::resolve_profile_step(&url_sf, sf_key.as_deref().unwrap_or("")).await
                }),
            ];
            cascade::run(app, cascade_label, Some(clip_id), steps).await
        }
        "instagram" => {
            // One reqwest::Client shared across the IG public-endpoint steps so
            // we benefit from connection pooling.
            let http = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
                Ok(c) => c,
                Err(e) => {
                    return Err(ResolveCreatorError {
                        code: "all_failed",
                        attempts: vec![cascade::Attempt {
                            step: "http_client_init".to_string(),
                            outcome: "failed",
                            reason: format!("network: {e}"),
                        }],
                    });
                }
            };

            let url1 = url.to_string();
            let url2 = url.to_string();
            let url3 = url.to_string();
            let url4 = url.to_string();
            let url5 = url.to_string();
            let cb = cookies_browser.clone();
            let cf = cookies_file.clone();
            let socialkit_owned = socialkit_api_key.map(|s| s.to_string());
            let sf_key = socialfetch_owned.clone();
            let http2 = http.clone();
            let app_clone = app.clone();

            let steps: Vec<cascade::Step<'_, EnrichedProfile>> = vec![
                cascade::Step::new("ig_oembed", async move {
                    step_ig_oembed(&http, &url1).await
                }),
                cascade::Step::new("ig_embed", async move {
                    step_ig_embed(&http2, &url2).await
                }),
                cascade::Step::new("ig_ytdlp_cookies", async move {
                    step_ig_ytdlp_cookies(&app_clone, &url3, &cb, &cf).await
                }),
                cascade::Step::new("ig_socialkit", async move {
                    step_ig_socialkit(&url4, socialkit_owned.as_deref()).await
                }),
                cascade::Step::new("socialfetch", async move {
                    socialfetch::resolve_profile_step(&url5, sf_key.as_deref().unwrap_or("")).await
                }),
            ];
            cascade::run(app, cascade_label, Some(clip_id), steps).await
        }
        "youtube" => {
            let url1 = url.to_string();
            let url2 = url.to_string();
            let url3 = url.to_string();
            let cb = cookies_browser.clone();
            let cf = cookies_file.clone();
            let sf_key = socialfetch_owned.clone();
            let app_clone = app.clone();
            let steps: Vec<cascade::Step<'_, EnrichedProfile>> = vec![
                cascade::Step::new("yt_handle_url", async move { step_yt_handle_url(&url1) }),
                cascade::Step::new("yt_ytdlp", async move {
                    step_yt_ytdlp(&app_clone, &url2, &cb, &cf).await
                }),
                cascade::Step::new("socialfetch", async move {
                    socialfetch::resolve_profile_step(&url3, sf_key.as_deref().unwrap_or("")).await
                }),
            ];
            cascade::run(app, cascade_label, Some(clip_id), steps).await
        }
        // `is_live_resolvable` above guards anything except tiktok/instagram/youtube.
        _ => unreachable!("non-live-resolvable platform reached cascade dispatch"),
    };

    let out = match result {
        Ok((profile, _winner)) => profile,
        Err(attempts) => {
            return Err(ResolveCreatorError {
                code: "all_failed",
                attempts,
            });
        }
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
