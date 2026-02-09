use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

// ── Data types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectClip {
    #[serde(rename = "hubspotId")]
    pub hubspot_id: String,
    pub link: String,
    #[serde(rename = "creatorName")]
    pub creator_name: String,
    pub tags: Vec<String>,
    #[serde(rename = "localFile")]
    pub local_file: Option<String>,
    #[serde(rename = "downloadStatus")]
    pub download_status: String,
    pub order: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub clips: Vec<ProjectClip>,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    #[serde(rename = "clipId")]
    pub clip_id: String,
    pub status: String, // "downloading" | "complete" | "failed"
    pub progress: Option<f64>,
    #[serde(rename = "localFile")]
    pub local_file: Option<String>,
    pub error: Option<String>,
}

// ── HubSpot API ─────────────────────────────────────────────────────────────

const EXTERNAL_CLIPS_OBJECT_ID: &str = "2-192287471";
const VIDEO_PROJECTS_OBJECT_ID: &str = "2-192286893";

#[tauri::command]
async fn search_clips(
    token: String,
    tags: Vec<String>,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    // Build filters: each tag as EQ + creator_status=Granted
    let mut filters: Vec<serde_json::Value> = tags
        .iter()
        .map(|tag| serde_json::json!({
            "propertyName": "tags",
            "operator": "EQ",
            "value": tag
        }))
        .collect();

    filters.push(serde_json::json!({
        "propertyName": "creator_status",
        "operator": "EQ",
        "value": "Granted"
    }));

    let mut body = serde_json::json!({
        "filterGroups": [{ "filters": filters }],
        "properties": [
            "link", "tags", "creator_name", "creator_status", "creator_main_link", "creator_id",
            "score", "edited_duration", "date_found", "link_not_working_anymore",
            "available_ask_first", "num_of_published_video_project",
            "clip_mix_link_1", "clip_mix_link_2", "clip_mix_link_3",
            "clip_mix_link_4", "clip_mix_link_5", "clip_mix_link_6",
            "clip_mix_link_7", "clip_mix_link_8", "clip_mix_link_9",
            "clip_mix_link_10", "notes"
        ],
        "sorts": [{ "propertyName": "date_found", "direction": "DESCENDING" }],
        "limit": 50
    });

    if let Some(after_val) = after {
        body.as_object_mut().unwrap().insert("after".into(), serde_json::json!(after_val));
    }

    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot API error ({}): {}", status, text));
    }

    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

/// Fetch Video Projects associated with an External Clip, returning name + category
#[tauri::command]
async fn fetch_clip_video_projects(
    token: String,
    clip_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::new();

    // Step 1: Get associated Video Project IDs
    let assoc_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/{}/associations/{}",
        EXTERNAL_CLIPS_OBJECT_ID, clip_id, VIDEO_PROJECTS_OBJECT_ID
    );

    let res = client
        .get(&assoc_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot associations error ({}): {}", status, text));
    }

    let body: serde_json::Value = res.json().await
        .map_err(|e| format!("Failed to parse associations: {e}"))?;

    let project_ids: Vec<String> = body
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if project_ids.is_empty() {
        return Ok(vec![]);
    }

    // Step 2: Batch-read those Video Projects
    let batch_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/batch/read",
        VIDEO_PROJECTS_OBJECT_ID
    );

    let batch_body = serde_json::json!({
        "properties": ["name", "tag", "pub_date", "youtube_video_id", "status"],
        "inputs": project_ids.iter().map(|id| serde_json::json!({ "id": id })).collect::<Vec<_>>()
    });

    let res2 = client
        .post(&batch_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&batch_body)
        .send()
        .await
        .map_err(|e| format!("Batch read failed: {e}"))?;

    if !res2.status().is_success() {
        let status = res2.status();
        let text = res2.text().await.unwrap_or_default();
        return Err(format!("HubSpot batch read error ({}): {}", status, text));
    }

    let batch_result: serde_json::Value = res2.json().await
        .map_err(|e| format!("Failed to parse batch read: {e}"))?;

    let projects = batch_result
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| {
                    let props = item.get("properties").cloned().unwrap_or(serde_json::json!({}));
                    serde_json::json!({
                        "id": item.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": props.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed"),
                        "tag": props.get("tag").and_then(|v| v.as_str()).unwrap_or(""),
                        "pubDate": props.get("pub_date").and_then(|v| v.as_str()).unwrap_or(""),
                        "youtubeVideoId": props.get("youtube_video_id").and_then(|v| v.as_str()).unwrap_or(""),
                        "status": props.get("status").and_then(|v| v.as_str()).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(projects)
}

/// Resolve a thumbnail URL for a video link via oEmbed, URL patterns, or yt-dlp fallback
#[tauri::command]
async fn fetch_thumbnail(url: String, cookies_browser: Option<String>, cookies_file: Option<String>) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // YouTube: construct thumbnail directly (instant, no API call)
    if url.contains("youtube.com") || url.contains("youtu.be") {
        let video_id = if url.contains("youtu.be/") {
            url.split("youtu.be/").nth(1).and_then(|s| s.split(['?', '&']).next())
        } else if url.contains("/shorts/") {
            url.split("/shorts/").nth(1).and_then(|s| s.split(['?', '&']).next())
        } else {
            url.split("v=").nth(1).and_then(|s| s.split(['&', '#']).next())
        };
        if let Some(id) = video_id {
            return Ok(Some(format!("https://img.youtube.com/vi/{}/hqdefault.jpg", id)));
        }
    }

    // TikTok: oEmbed API (fast)
    if url.contains("tiktok.com") {
        let oembed_url = format!("https://www.tiktok.com/oembed?url={}", urlencoding::encode(&url));
        if let Ok(res) = client.get(&oembed_url).send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(thumb) = json.get("thumbnail_url").and_then(|v| v.as_str()) {
                    return Ok(Some(thumb.to_string()));
                }
            }
        }
    }

    // Universal fallback: yt-dlp --dump-json
    // Try browser cookies first, then fall back to cookies file if that fails
    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file.as_ref().map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());

    if has_browser {
        match ytdlp_thumbnail_with(&url, &cookies_browser, &None).await {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            Err(err) => return Err(err), // cookie extraction error
            Ok(None) if has_file => {
                // Browser cookies failed for this URL, retry with cookies file
                match ytdlp_thumbnail_with(&url, &None, &cookies_file).await {
                    Ok(Some(thumb)) => return Ok(Some(thumb)),
                    _ => return Ok(None),
                }
            }
            Ok(None) => return Ok(None),
        }
    } else if has_file {
        match ytdlp_thumbnail_with(&url, &None, &cookies_file).await {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            Err(err) => return Err(err),
            Ok(None) => return Ok(None),
        }
    } else {
        match ytdlp_thumbnail_with(&url, &None, &None).await {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            Err(err) => return Err(err),
            Ok(None) => return Ok(None),
        }
    }
}

/// Run yt-dlp --dump-json with a specific cookie method
async fn ytdlp_thumbnail_with(url: &str, cookies_browser: &Option<String>, cookies_file: &Option<String>) -> Result<Option<String>, String> {
    let mut args = vec![
        "--dump-json",
        "--skip-download",
        "--no-playlist",
    ];

    let browser_string;
    if let Some(ref browser) = cookies_browser {
        if !browser.is_empty() {
            args.push("--cookies-from-browser");
            browser_string = browser.clone();
            args.push(&browser_string);
        }
    }

    let cf_string;
    if let Some(ref cf) = cookies_file {
        if !cf.is_empty() && PathBuf::from(cf).exists() {
            args.push("--cookies");
            cf_string = cf.clone();
            args.push(&cf_string);
        }
    }

    args.push(url);

    let output = match tokio::process::Command::new("yt-dlp")
        .args(&args)
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Err("yt-dlp is not installed. Install it with: brew install yt-dlp".into());
            }
            return Ok(None);
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stderr_lower = stderr.to_lowercase();

        // Douyin extractor is broken in yt-dlp (known bug #9667)
        if stderr_lower.contains("[douyin]") && stderr_lower.contains("fresh cookies") {
            return Ok(None); // not a cookie error, just a broken extractor
        }

        if (stderr_lower.contains("could not find") && stderr_lower.contains("cookie"))
            || stderr_lower.contains("no suitable cookie")
            || stderr_lower.contains("failed to decrypt")
        {
            let browser_name = cookies_browser.as_ref().map(|b| b.as_str()).unwrap_or("your browser");
            return Err(format!(
                "Could not read cookies from {}. Make sure {} is installed and try closing it before searching.",
                browser_name, browser_name
            ));
        }

        return Ok(None);
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Failed to parse yt-dlp output".to_string())?;
    Ok(json.get("thumbnail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// Detect platform name from URL for user-friendly error messages
fn detect_platform(url: &str) -> &str {
    if url.contains("instagram.com") { "Instagram" }
    else if url.contains("tiktok.com") { "TikTok" }
    else if url.contains("douyin.com") { "Douyin" }
    else if url.contains("youtube.com") || url.contains("youtu.be") { "YouTube" }
    else if url.contains("bilibili.com") { "Bilibili" }
    else if url.contains("xiaohongshu.com") { "Xiaohongshu" }
    else { "this platform" }
}

// ── Project Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn create_project(root_folder: String, name: String) -> Result<Project, String> {
    let path = PathBuf::from(&root_folder).join(&name);
    let clips_path = path.join("clips");
    fs::create_dir_all(&clips_path).map_err(|e| format!("Failed to create folder: {e}"))?;

    let project = Project {
        name,
        created_at: chrono_now(),
        clips: vec![],
    };
    save_project(&path, &project)?;
    Ok(project)
}

#[tauri::command]
fn load_project(root_folder: String, name: String) -> Result<Project, String> {
    let path = PathBuf::from(&root_folder).join(&name).join("project.json");
    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read project: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid project file: {e}"))
}

#[tauri::command]
fn save_project_data(root_folder: String, project: Project) -> Result<(), String> {
    let path = PathBuf::from(&root_folder).join(&project.name);
    save_project(&path, &project)
}

#[tauri::command]
fn list_projects(root_folder: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&root_folder);
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    let entries = fs::read_dir(&path).map_err(|e| format!("Failed to read folder: {e}"))?;
    for entry in entries.flatten() {
        if entry.path().join("project.json").exists() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
async fn download_clip(
    app: AppHandle,
    root_folder: String,
    project_name: String,
    clip_id: String,
    url: String,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
) -> Result<(), String> {
    let clips_dir = PathBuf::from(&root_folder)
        .join(&project_name)
        .join("clips");

    let _ = app.emit("download-progress", DownloadProgress {
        clip_id: clip_id.clone(),
        status: "downloading".into(),
        progress: Some(0.0),
        local_file: None,
        error: None,
    });

    let output_template = clips_dir
        .join(format!("{}_%(title).50s.%(ext)s", &clip_id))
        .to_string_lossy()
        .to_string();

    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file.as_ref().map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());

    // Try browser cookies first
    let result = run_ytdlp_download(
        &url, &output_template,
        if has_browser { &cookies_browser } else { &None },
        if has_browser { &None } else { &cookies_file },
    ).await;

    // If browser cookies failed and we have a cookies file, retry with file
    let result = match &result {
        Ok(output) if !output.status.success() && has_browser && has_file => {
            run_ytdlp_download(&url, &output_template, &None, &cookies_file).await
        }
        _ => result,
    };

    match result {
        Ok(output) if output.status.success() => {
            let local_file = find_downloaded_file(&clips_dir, &clip_id);
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "complete".into(),
                progress: Some(100.0),
                local_file,
                error: None,
            });
            Ok(())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let friendly = friendly_download_error(&stderr, &url, &cookies_browser);
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "failed".into(),
                progress: None,
                local_file: None,
                error: Some(friendly.clone()),
            });
            Err(friendly)
        }
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp not found. Please install it: https://github.com/yt-dlp/yt-dlp#installation".into()
            } else {
                format!("Failed to run yt-dlp: {e}")
            };
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "failed".into(),
                progress: None,
                local_file: None,
                error: Some(msg.clone()),
            });
            Err(msg)
        }
    }
}

/// Run yt-dlp download with a specific cookie method
async fn run_ytdlp_download(
    url: &str,
    output_template: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<std::process::Output, std::io::Error> {
    let mut args = vec![
        "--no-warnings".to_string(),
        "-f".to_string(), "bestvideo+bestaudio/best".to_string(),
        "--merge-output-format".to_string(), "mp4".to_string(),
        "-o".to_string(), output_template.to_string(),
        "--newline".to_string(),
        "--progress-template".to_string(), "%(progress._percent_str)s".to_string(),
    ];

    if let Some(ref browser) = cookies_browser {
        if !browser.is_empty() {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.clone());
        }
    }

    if let Some(ref cf) = cookies_file {
        if !cf.is_empty() && PathBuf::from(cf).exists() {
            args.push("--cookies".to_string());
            args.push(cf.clone());
        }
    }

    args.push(url.to_string());

    tokio::process::Command::new("yt-dlp")
        .args(&args)
        .output()
        .await
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Translate raw yt-dlp stderr into user-friendly error messages
fn friendly_download_error(stderr: &str, url: &str, cookies_browser: &Option<String>) -> String {
    let lower = stderr.to_lowercase();
    let platform = detect_platform(url);
    let browser = cookies_browser.as_deref().unwrap_or("your browser");

    // Douyin extractor is broken in yt-dlp (known upstream bug)
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

    // Fallback: show the last meaningful line of stderr
    stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(stderr)
        .trim()
        .to_string()
}

fn save_project(folder: &PathBuf, project: &Project) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(folder.join("project.json"), json)
        .map_err(|e| format!("Failed to write project: {e}"))
}

fn find_downloaded_file(clips_dir: &PathBuf, clip_id: &str) -> Option<String> {
    if let Ok(entries) = fs::read_dir(clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{clip_id}_")) {
                return Some(
                    entry.path().to_string_lossy().to_string()
                );
            }
        }
    }
    None
}

fn chrono_now() -> String {
    // Simple ISO timestamp without chrono dependency
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", duration.as_secs())
}

// ── App entry ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("localfile", |_ctx, request| {
            // Decode the path from the URL
            let uri = request.uri().to_string();
            // URL format: localfile://localhost/<encoded_path>
            let path = uri
                .strip_prefix("localfile://localhost/")
                .unwrap_or(&uri);
            let decoded = urlencoding::decode(path).unwrap_or_default();

            let file_path = std::path::PathBuf::from(decoded.as_ref());
            match fs::read(&file_path) {
                Ok(data) => {
                    let mime = if file_path.extension().and_then(|e| e.to_str()) == Some("mp4") {
                        "video/mp4"
                    } else {
                        "application/octet-stream"
                    };
                    tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Accept-Ranges", "bytes")
                        .body(data)
                        .unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(b"Not found".to_vec())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            search_clips,
            fetch_clip_video_projects,
            fetch_thumbnail,
            create_project,
            load_project,
            save_project_data,
            list_projects,
            download_clip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
