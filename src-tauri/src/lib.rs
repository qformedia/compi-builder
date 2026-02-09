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
            "link", "tags", "creator_name", "creator_status", "score",
            "edited_duration", "date_found", "link_not_working_anymore",
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
) -> Result<(), String> {
    let clips_dir = PathBuf::from(&root_folder)
        .join(&project_name)
        .join("clips");

    // Emit downloading status
    let _ = app.emit("download-progress", DownloadProgress {
        clip_id: clip_id.clone(),
        status: "downloading".into(),
        progress: Some(0.0),
        local_file: None,
        error: None,
    });

    // Build yt-dlp command
    let output_template = clips_dir
        .join(format!("{}_%(title).50s.%(ext)s", &clip_id))
        .to_string_lossy()
        .to_string();

    let result = tokio::process::Command::new("yt-dlp")
        .args([
            "--no-warnings",
            "-f", "bestvideo+bestaudio/best",
            "--merge-output-format", "mp4",
            "-o", &output_template,
            "--newline",
            "--progress-template", "%(progress._percent_str)s",
            &url,
        ])
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => {
            // Find the downloaded file
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
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "failed".into(),
                progress: None,
                local_file: None,
                error: Some(stderr.clone()),
            });
            Err(stderr)
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
            create_project,
            load_project,
            save_project_data,
            list_projects,
            download_clip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
