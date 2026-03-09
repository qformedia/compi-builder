mod helpers;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use once_cell::sync::Lazy;
use tokio::sync::Semaphore;

use helpers::{
    build_filter_groups, strip_prefix, find_file_by_id, find_downloaded_file,
    probe_duration, friendly_download_error, format_selection_for_url,
    remove_existing_clip_files,
};

/// Rate limiter: max 1 concurrent Instagram yt-dlp request
static INSTAGRAM_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));

// ── Data types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectClip {
    #[serde(rename = "hubspotId")]
    pub hubspot_id: String,
    pub link: String,
    #[serde(rename = "creatorName")]
    pub creator_name: String,
    pub tags: Vec<String>,
    pub score: Option<String>,
    #[serde(rename = "editedDuration", default)]
    pub edited_duration: Option<f64>,
    #[serde(rename = "localDuration", default)]
    pub local_duration: Option<f64>,
    #[serde(rename = "localFile", default)]
    pub local_file: Option<String>,
    #[serde(rename = "downloadStatus", default)]
    pub download_status: String,
    #[serde(default)]
    pub order: usize,
    #[serde(rename = "licenseType", default)]
    pub license_type: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "fetchedThumbnail", default)]
    pub fetched_thumbnail: Option<String>,
    #[serde(rename = "editingNotes", default)]
    pub editing_notes: Option<String>,
    #[serde(rename = "creatorId", default)]
    pub creator_id: Option<String>,
    #[serde(rename = "creatorStatus", default)]
    pub creator_status: Option<String>,
    #[serde(rename = "clipMixLinks", default)]
    pub clip_mix_links: Option<Vec<String>>,
    #[serde(rename = "availableAskFirst", default)]
    pub available_ask_first: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub clips: Vec<ProjectClip>,
    #[serde(rename = "hubspotVideoProjectId", skip_serializing_if = "Option::is_none")]
    pub hubspot_video_project_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    #[serde(rename = "clipId")]
    pub clip_id: String,
    pub status: String, // "downloading" | "complete" | "failed"
    pub progress: Option<f64>,
    #[serde(rename = "localFile")]
    pub local_file: Option<String>,
    #[serde(rename = "localDuration")]
    pub local_duration: Option<f64>,
    pub error: Option<String>,
}

// ── HubSpot API ─────────────────────────────────────────────────────────────

const EXTERNAL_CLIPS_OBJECT_ID: &str = "2-192287471";
const CREATORS_OBJECT_ID: &str = "2-191972671";
const VIDEO_PROJECTS_OBJECT_ID: &str = "2-192286893";

/// Shared clip properties requested from HubSpot
const CLIP_PROPERTIES: &[&str] = &[
    "link", "tags", "creator_name", "creator_status", "creator_main_link", "creator_id",
    "score", "edited_duration", "date_found", "link_not_working_anymore",
    "available_ask_first", "num_of_published_video_project",
    "clip_mix_link_1", "clip_mix_link_2", "clip_mix_link_3",
    "clip_mix_link_4", "clip_mix_link_5", "clip_mix_link_6",
    "clip_mix_link_7", "clip_mix_link_8", "clip_mix_link_9",
    "clip_mix_link_10", "notes", "creator_license_type", "creator_notes",
    "fetched_social_thumbnail",
];

/// Fetch the options for the "tags" property (label + internal value)
#[tauri::command]
async fn fetch_tag_options(
    token: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/properties/{}/tags",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot property error ({}): {}", status, text));
    }

    let body: serde_json::Value = res.json().await
        .map_err(|e| format!("Failed to parse property: {e}"))?;

    let options = body.get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|o| o.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) == false)
                .map(|o| serde_json::json!({
                    "label": o.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                    "value": o.get("value").and_then(|v| v.as_str()).unwrap_or("")
                }))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(serde_json::json!(options))
}


#[tauri::command]
async fn search_clips(
    token: String,
    tags: Vec<String>,
    scores: Vec<String>,
    never_used: bool,
    tag_mode: String,
    creator_main_link: Option<String>,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let filter_groups = build_filter_groups(&tags, &scores, never_used, &tag_mode, creator_main_link.as_deref());

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES.iter().map(|p| serde_json::json!(p)).collect();

    let mut body = serde_json::json!({
        "filterGroups": filter_groups,
        "properties": props,
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

/// Fetch ALL clips for a specific creator matching the same tag filters, auto-paginating.
#[tauri::command]
async fn search_creator_clips(
    token: String,
    tags: Vec<String>,
    scores: Vec<String>,
    never_used: bool,
    tag_mode: String,
    creator_main_link: Option<String>,
    creator_name: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut filter_groups = build_filter_groups(&tags, &scores, never_used, &tag_mode, creator_main_link.as_deref());

    // Add creator_name filter to every group
    let creator_filter = serde_json::json!({
        "propertyName": "creator_name",
        "operator": "EQ",
        "value": creator_name
    });
    for group in &mut filter_groups {
        if let Some(filters) = group.get_mut("filters").and_then(|f| f.as_array_mut()) {
            filters.push(creator_filter.clone());
        }
    }

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES.iter().map(|p| serde_json::json!(p)).collect();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let mut all_results: Vec<serde_json::Value> = Vec::new();
    let mut after: Option<String> = None;

    loop {
        let mut body = serde_json::json!({
            "filterGroups": filter_groups,
            "properties": props,
            "sorts": [{ "propertyName": "date_found", "direction": "DESCENDING" }],
            "limit": 100
        });

        if let Some(ref after_val) = after {
            body.as_object_mut().unwrap().insert("after".into(), serde_json::json!(after_val));
        }

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

        let page: serde_json::Value = res.json().await
            .map_err(|e| format!("Failed to parse response: {e}"))?;

        if let Some(results) = page.get("results").and_then(|r| r.as_array()) {
            all_results.extend(results.iter().cloned());
        }

        // Check for next page
        after = page
            .get("paging")
            .and_then(|p| p.get("next"))
            .and_then(|n| n.get("after"))
            .and_then(|a| a.as_str())
            .map(String::from);

        if after.is_none() {
            break;
        }
    }

    Ok(serde_json::json!({
        "total": all_results.len(),
        "results": all_results
    }))
}

/// Search Creator records by name or main_link (OR across both fields).
#[tauri::command]
async fn search_creators(
    token: String,
    query: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        CREATORS_OBJECT_ID
    );

    let body = serde_json::json!({
        "filterGroups": [
            { "filters": [{ "propertyName": "name", "operator": "CONTAINS_TOKEN", "value": query }] },
            { "filters": [{ "propertyName": "main_link", "operator": "CONTAINS_TOKEN", "value": query }] }
        ],
        "properties": ["name", "main_link"],
        "sorts": [{ "propertyName": "name", "direction": "ASCENDING" }],
        "limit": 20
    });

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

/// Search Video Projects by name (for "Open from HubSpot" flow)
#[tauri::command]
async fn search_video_projects(
    token: String,
    query: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        VIDEO_PROJECTS_OBJECT_ID
    );

    let body = serde_json::json!({
        "filterGroups": [{
            "filters": [{
                "propertyName": "name",
                "operator": "CONTAINS_TOKEN",
                "value": query
            }]
        }],
        "properties": ["name", "tag", "pub_date", "youtube_video_id", "status"],
        "sorts": [{ "propertyName": "hs_lastmodifieddate", "direction": "DESCENDING" }],
        "limit": 20
    });

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

/// Fetch all External Clips associated with a Video Project
#[tauri::command]
async fn fetch_video_project_clips(
    token: String,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: Get ALL associated External Clip IDs (paginated)
    let base_assoc_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/{}/associations/{}",
        VIDEO_PROJECTS_OBJECT_ID, project_id, EXTERNAL_CLIPS_OBJECT_ID
    );

    let mut clip_ids: Vec<String> = Vec::new();
    let mut after: Option<String> = None;

    loop {
        let mut url = base_assoc_url.clone();
        if let Some(ref cursor) = after {
            url = format!("{}?after={}", url, cursor);
        }

        let res = client
            .get(&url)
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

        if let Some(results) = body.get("results").and_then(|r| r.as_array()) {
            for item in results {
                if let Some(id) = item.get("id").and_then(|id| id.as_str()) {
                    clip_ids.push(id.to_string());
                }
            }
        }

        after = body
            .get("paging")
            .and_then(|p| p.get("next"))
            .and_then(|n| n.get("after"))
            .and_then(|a| a.as_str())
            .map(String::from);

        if after.is_none() {
            break;
        }
    }

    if clip_ids.is_empty() {
        return Ok(serde_json::json!({ "total": 0, "results": [] }));
    }

    // Step 2: Batch-read the clips
    let batch_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/batch/read",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES.iter().map(|p| serde_json::json!(p)).collect();

    let mut all_results: Vec<serde_json::Value> = Vec::new();

    // HubSpot batch limit is 100
    for chunk in clip_ids.chunks(100) {
        let batch_body = serde_json::json!({
            "properties": props,
            "inputs": chunk.iter().map(|id| serde_json::json!({ "id": id })).collect::<Vec<_>>()
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

        if let Some(results) = batch_result.get("results").and_then(|r| r.as_array()) {
            all_results.extend(results.iter().cloned());
        }
    }

    Ok(serde_json::json!({
        "total": all_results.len(),
        "results": all_results
    }))
}

/// Batch-associate External Clips to a Video Project (reusable helper)
async fn batch_associate_clips(
    client: &reqwest::Client,
    token: &str,
    project_id: &str,
    clip_ids: &[String],
) -> Result<(), String> {
    // Association type: External Clips → Video Projects (discovered via /crm/v4/associations/.../labels)
    let type_id: u64 = 146;
    let category = "USER_DEFINED";

    let batch_url = format!(
        "https://api.hubapi.com/crm/v4/associations/{}/{}/batch/create",
        EXTERNAL_CLIPS_OBJECT_ID, VIDEO_PROJECTS_OBJECT_ID
    );

    let inputs: Vec<serde_json::Value> = clip_ids
        .iter()
        .map(|clip_id| serde_json::json!({
            "from": { "id": clip_id },
            "to": { "id": project_id },
            "types": [{
                "associationCategory": category,
                "associationTypeId": type_id
            }]
        }))
        .collect();

    for chunk in inputs.chunks(100) {
        let batch_body = serde_json::json!({ "inputs": chunk });
        let batch_res = client
            .post(&batch_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&batch_body)
            .send()
            .await
            .map_err(|e| format!("Batch association request failed: {e}"))?;

        if !batch_res.status().is_success() {
            let status = batch_res.status();
            let text = batch_res.text().await.unwrap_or_default();
            return Err(format!(
                "Failed to associate clips with Video Project {} ({}): {}",
                project_id, status, text
            ));
        }
    }
    Ok(())
}

/// Batch-check if Video Project IDs still exist in HubSpot
#[tauri::command]
async fn fetch_video_projects_by_ids(
    token: String,
    project_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    if project_ids.is_empty() {
        return Ok(serde_json::json!({ "results": [] }));
    }
    let client = reqwest::Client::new();
    let batch_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/batch/read",
        VIDEO_PROJECTS_OBJECT_ID
    );
    let batch_body = serde_json::json!({
        "properties": ["name"],
        "inputs": project_ids.iter().map(|id| serde_json::json!({ "id": id })).collect::<Vec<_>>()
    });

    let res = client
        .post(&batch_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&batch_body)
        .send()
        .await
        .map_err(|e| format!("Batch read failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot batch read error ({}): {}", status, text));
    }

    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

/// Batch-read Creator records by IDs for CSV export
#[tauri::command]
async fn fetch_creators_batch(
    token: String,
    creator_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    if creator_ids.is_empty() {
        return Ok(serde_json::json!({ "results": [] }));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let batch_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/batch/read",
        CREATORS_OBJECT_ID
    );
    let props = vec![
        "main_link", "main_account", "name",
        "douyin_id", "kuaishou_id", "xiaohongshu_id",
        "special_requests", "notes", "license_checked", "license_type",
    ];

    let mut all_results: Vec<serde_json::Value> = Vec::new();

    for chunk in creator_ids.chunks(100) {
        let batch_body = serde_json::json!({
            "properties": props,
            "inputs": chunk.iter().map(|id| serde_json::json!({ "id": id })).collect::<Vec<_>>()
        });

        let res = client
            .post(&batch_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&batch_body)
            .send()
            .await
            .map_err(|e| format!("Creator batch read failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Creator batch read error ({}): {}", status, text));
        }

        let batch_result: serde_json::Value = res.json().await
            .map_err(|e| format!("Failed to parse creator batch: {e}"))?;

        if let Some(results) = batch_result.get("results").and_then(|r| r.as_array()) {
            all_results.extend(results.iter().cloned());
        }
    }

    Ok(serde_json::json!({ "results": all_results }))
}

/// Create a Video Project in HubSpot and associate the given External Clip IDs.
#[tauri::command]
async fn create_video_project(
    token: String,
    name: String,
    clip_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    let create_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}",
        VIDEO_PROJECTS_OBJECT_ID
    );

    let create_body = serde_json::json!({
        "properties": {
            "name": name,
            "status": "Doing"
        }
    });

    let res = client
        .post(&create_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&create_body)
        .send()
        .await
        .map_err(|e| format!("Failed to create Video Project: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot create error ({}): {}", status, text));
    }

    let created: serde_json::Value = res.json().await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    let project_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("No id in created Video Project")?
        .to_string();

    if !clip_ids.is_empty() {
        batch_associate_clips(&client, &token, &project_id, &clip_ids).await?;
    }

    Ok(serde_json::json!({
        "id": project_id,
        "name": name,
        "clipCount": clip_ids.len()
    }))
}

/// Associate clips to an existing Video Project (without creating a new one)
#[tauri::command]
async fn associate_clips_to_project(
    token: String,
    project_id: String,
    clip_ids: Vec<String>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    batch_associate_clips(&client, &token, &project_id, &clip_ids).await
}

/// Disassociate clips from a Video Project
#[tauri::command]
async fn disassociate_clip_from_project(
    token: String,
    project_id: String,
    clip_ids: Vec<String>,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    let batch_url = format!(
        "https://api.hubapi.com/crm/v4/associations/{}/{}/batch/archive",
        EXTERNAL_CLIPS_OBJECT_ID, VIDEO_PROJECTS_OBJECT_ID
    );

    let inputs: Vec<serde_json::Value> = clip_ids
        .iter()
        .map(|clip_id| serde_json::json!({
            "from": { "id": clip_id },
            "to": [{ "id": project_id }]
        }))
        .collect();

    for chunk in inputs.chunks(100) {
        let batch_body = serde_json::json!({ "inputs": chunk });
        let res = client
            .post(&batch_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&batch_body)
            .send()
            .await
            .map_err(|e| format!("Disassociation request failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Failed to disassociate clips ({}): {}", status, text));
        }
    }
    Ok(())
}

/// Rename clip files with an order prefix: "1 - original_name.mp4", "2 - ...", etc.
/// Also prefix any other files in the clips directory with "unused_".
/// `clip_files` are **relative** paths (e.g. "clips/ID_title.mp4").
/// Returns JSON with `dir` (absolute clips directory) and `newPaths` (relative paths after rename).
#[tauri::command]
async fn order_clips(
    root_folder: String,
    project_name: String,
    clip_files: Vec<String>,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let clips_dir = project_dir.join("clips");

    // Step A: Rename ordered clips with number prefix
    let mut new_rel_paths: Vec<String> = Vec::new();
    let mut new_used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, rel_path) in clip_files.iter().enumerate() {
        let abs_path = project_dir.join(rel_path);

        // If the stored path doesn't exist, try to find the file in clips_dir by its HubSpot ID prefix
        let actual_path = if abs_path.exists() {
            abs_path.clone()
        } else {
            let original_name = abs_path.file_name().unwrap_or_default().to_string_lossy();
            // Strip prefixes to get the ID
            let clean = strip_prefix(&original_name);
            let id_prefix = clean.split('_').next().unwrap_or("");
            find_file_by_id(&clips_dir, id_prefix).unwrap_or(abs_path.clone())
        };

        let file_name = actual_path.file_name()
            .ok_or(format!("Invalid file path: {}", actual_path.display()))?
            .to_string_lossy()
            .to_string();

        let clean_name = strip_prefix(&file_name);
        let new_name = format!("{} - {}", i + 1, clean_name);
        new_used_names.insert(new_name.clone());
        let new_abs_path = actual_path.with_file_name(&new_name);

        if actual_path != new_abs_path {
            fs::rename(&actual_path, &new_abs_path)
                .map_err(|e| format!("Failed to rename {}: {e}", file_name))?;
        }
        // Return relative path
        new_rel_paths.push(format!("clips/{}", new_name));
    }

    // Step B: Prefix unused files in clips dir with "unused_"
    if let Ok(entries) = fs::read_dir(&clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if new_used_names.contains(&name) {
                continue;
            }
            if name.starts_with("unused_") {
                continue;
            }
            let clean = strip_prefix(&name);
            let new_name = format!("unused_{}", clean);
            let new_path = entry.path().with_file_name(&new_name);
            let _ = fs::rename(entry.path(), new_path);
        }
    }

    Ok(serde_json::json!({
        "dir": clips_dir.to_string_lossy().to_string(),
        "newPaths": new_rel_paths
    }))
}


/// Generate a CSV file matching the HubSpot workspace report format.
/// The frontend passes pre-merged clip+creator data as JSON objects.
/// Returns the absolute path to the CSV file.
#[tauri::command]
async fn generate_clips_csv(
    root_folder: String,
    project_name: String,
    clips: Vec<serde_json::Value>,
) -> Result<String, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let csv_path = project_dir.join("clips.csv");

    let escape = |s: &str| -> String {
        if s.contains(',') || s.contains('"') || s.contains('\n') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };

    let get = |clip: &serde_json::Value, key: &str| -> String {
        clip.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    let mut csv_content = String::from(
        "Order,Duration,Editing Notes,Link,Main Link,Main Account,Name,Douyin ID,Kuaishou ID,Xiaohongshu ID,Clip Mix Links,Special Requests,Notes,License Checked,License Type,Available Ask First,Score,External Clip ID,Creator ID,Video Project ID\n"
    );

    for (i, clip) in clips.iter().enumerate() {
        let duration = clip.get("duration")
            .and_then(|v| v.as_f64())
            .map(|d| format!("{:.0}", d))
            .unwrap_or_default();

        let fields = [
            format!("{}", i + 1),
            escape(&duration),
            escape(&get(clip, "editingNotes")),
            escape(&get(clip, "link")),
            escape(&get(clip, "mainLink")),
            escape(&get(clip, "mainAccount")),
            escape(&get(clip, "name")),
            escape(&get(clip, "douyinId")),
            escape(&get(clip, "kuaishouId")),
            escape(&get(clip, "xiaohongshuId")),
            escape(&get(clip, "clipMixLinks")),
            escape(&get(clip, "specialRequests")),
            escape(&get(clip, "notes")),
            escape(&get(clip, "licenseChecked")),
            escape(&get(clip, "licenseType")),
            escape(&get(clip, "availableAskFirst")),
            escape(&get(clip, "score")),
            escape(&get(clip, "externalClipId")),
            escape(&get(clip, "creatorId")),
            escape(&get(clip, "videoProjectId")),
        ];

        csv_content.push_str(&fields.join(","));
        csv_content.push('\n');
    }

    fs::write(&csv_path, &csv_content)
        .map_err(|e| format!("Failed to write CSV: {e}"))?;

    Ok(csv_path.to_string_lossy().to_string())
}

/// Rename clips with order prefix, mark unused files, and create a zip archive.
/// The zip includes the numbered clips and clips.csv (if it exists).
/// Returns JSON with `dir` (absolute clips dir), `zipPath` (absolute), `newPaths` (relative).
#[tauri::command]
async fn order_and_zip_clips(
    root_folder: String,
    project_name: String,
    clip_files: Vec<String>,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let clips_dir = project_dir.join("clips");

    // Step A: Rename ordered clips with number prefix
    let mut new_rel_paths: Vec<String> = Vec::new();
    let mut new_used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut zip_files: Vec<(String, PathBuf)> = Vec::new(); // (name_in_zip, abs_path)

    for (i, rel_path) in clip_files.iter().enumerate() {
        let abs_path = project_dir.join(rel_path);

        let actual_path = if abs_path.exists() {
            abs_path.clone()
        } else {
            let original_name = abs_path.file_name().unwrap_or_default().to_string_lossy();
            let clean = strip_prefix(&original_name);
            let id_prefix = clean.split('_').next().unwrap_or("");
            find_file_by_id(&clips_dir, id_prefix).unwrap_or(abs_path.clone())
        };

        let file_name = actual_path.file_name()
            .ok_or(format!("Invalid file path: {}", actual_path.display()))?
            .to_string_lossy()
            .to_string();

        let clean_name = strip_prefix(&file_name);
        let new_name = format!("{} - {}", i + 1, clean_name);
        new_used_names.insert(new_name.clone());
        let new_abs_path = actual_path.with_file_name(&new_name);

        if actual_path != new_abs_path {
            fs::rename(&actual_path, &new_abs_path)
                .map_err(|e| format!("Failed to rename {}: {e}", file_name))?;
        }
        zip_files.push((new_name.clone(), new_abs_path));
        new_rel_paths.push(format!("clips/{}", new_name));
    }

    // Step B: Prefix unused files in clips dir with "unused_"
    if let Ok(entries) = fs::read_dir(&clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if new_used_names.contains(&name) { continue; }
            if name.starts_with("unused_") { continue; }
            let clean = strip_prefix(&name);
            let new_name = format!("unused_{}", clean);
            let new_path = entry.path().with_file_name(&new_name);
            let _ = fs::rename(entry.path(), new_path);
        }
    }

    // Step C: Create zip archive
    let zip_path = project_dir.join(format!("{}.zip", project_name));
    let zip_file = fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored); // no compression for video

    // Add clip files
    for (name, path) in &zip_files {
        let data = fs::read(path)
            .map_err(|e| format!("Failed to read {}: {e}", name))?;
        zip.start_file(name, options)
            .map_err(|e| format!("Zip error: {e}"))?;
        std::io::Write::write_all(&mut zip, &data)
            .map_err(|e| format!("Zip write error: {e}"))?;
    }

    // Add clips.csv if it exists
    let csv_path = project_dir.join("clips.csv");
    if csv_path.exists() {
        let csv_data = fs::read(&csv_path)
            .map_err(|e| format!("Failed to read CSV: {e}"))?;
        zip.start_file("clips.csv", options)
            .map_err(|e| format!("Zip CSV error: {e}"))?;
        std::io::Write::write_all(&mut zip, &csv_data)
            .map_err(|e| format!("Zip CSV write error: {e}"))?;
    }

    zip.finish().map_err(|e| format!("Failed to finalize zip: {e}"))?;

    Ok(serde_json::json!({
        "dir": clips_dir.to_string_lossy().to_string(),
        "zipPath": zip_path.to_string_lossy().to_string(),
        "newPaths": new_rel_paths
    }))
}


/// Import a local file as a clip: copies it into the project's clips/ folder
/// with the HubSpot clip ID prefix. Returns the relative path.
#[tauri::command]
async fn import_clip_file(
    root_folder: String,
    project_name: String,
    clip_id: String,
    source_path: String,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let clips_dir = project_dir.join("clips");
    fs::create_dir_all(&clips_dir).map_err(|e| format!("Failed to create clips dir: {e}"))?;

    let source = PathBuf::from(&source_path);
    let ext = source.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let original_stem = source.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported");

    // Truncate stem to 50 chars like yt-dlp does
    let truncated: String = original_stem.chars().take(50).collect();
    let dest_name = format!("{}_{}.{}", clip_id, truncated, ext);
    let dest_path = clips_dir.join(&dest_name);

    fs::copy(&source, &dest_path)
        .map_err(|e| format!("Failed to copy file: {e}"))?;

    let rel_path = format!("clips/{}", dest_name);
    let local_duration = probe_duration(&dest_path.to_string_lossy());

    Ok(serde_json::json!({
        "localFile": rel_path,
        "localDuration": local_duration
    }))
}

/// Resolve a thumbnail URL for a video link via oEmbed, URL patterns, or yt-dlp fallback
#[tauri::command]
async fn fetch_thumbnail(app: AppHandle, url: String, cookies_browser: Option<String>, cookies_file: Option<String>) -> Result<Option<String>, String> {
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

    // Instagram: try embed page scraping (no cookies needed)
    if url.contains("instagram.com") {
        if let Some(thumb) = instagram_embed_thumbnail(&client, &url).await {
            return Ok(Some(thumb));
        }
    }

    // Universal fallback: yt-dlp --dump-json
    // Try browser cookies → cookies file → no cookies (graceful degradation)
    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file.as_ref().map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());
    let mut cookie_error: Option<String> = None;
    let is_instagram = url.contains("instagram.com");

    // 1. Try with browser cookies (rate-limited for Instagram)
    if has_browser {
        let result = if is_instagram {
            let _permit = INSTAGRAM_SEMAPHORE.acquire().await.map_err(|e| e.to_string())?;
            let r = ytdlp_thumbnail_with(&app, &url, &cookies_browser, &None).await;
            instagram_delay().await;
            r
        } else {
            ytdlp_thumbnail_with(&app, &url, &cookies_browser, &None).await
        };
        match result {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            Err(err) => { cookie_error = Some(err); }
            Ok(None) => {}
        }
    }

    // 2. Try with cookies file
    if has_file {
        match ytdlp_thumbnail_with(&app, &url, &None, &cookies_file).await {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            _ => {}
        }
    }

    // 3. Try without any cookies (works for many platforms)
    match ytdlp_thumbnail_with(&app, &url, &None, &None).await {
        Ok(Some(thumb)) => return Ok(Some(thumb)),
        // No-cookies fallback ran but found nothing: the video itself is
        // unavailable/removed, not a cookie problem. Don't blame cookies.
        Ok(None) => return Ok(None),
        Err(_) => {}
    }

    // Only surface the cookie error if the no-cookies fallback also errored
    // (meaning yt-dlp couldn't even run), not when the video simply doesn't exist.
    if let Some(err) = cookie_error {
        return Err(err);
    }

    Ok(None)
}

/// Try to extract Instagram thumbnail without cookies, using multiple strategies
async fn instagram_embed_thumbnail(client: &reqwest::Client, url: &str) -> Option<String> {
    // Extract path type and shortcode: /reel/CODE/, /reels/CODE/, /p/CODE/
    let re = regex::Regex::new(r"/(reel|reels|p)/([^/?]+)").ok()?;
    let caps = re.captures(url)?;
    let path_type = caps.get(1)?.as_str();
    let shortcode = caps.get(2)?.as_str();

    // Strategy 1: Instagram native oEmbed (no auth needed for public posts)
    let oembed_url = format!(
        "https://www.instagram.com/api/v1/oembed/?url={}",
        urlencoding::encode(url)
    );
    if let Ok(res) = client
        .get(&oembed_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(thumb) = json.get("thumbnail_url").and_then(|v| v.as_str()) {
                    if thumb.starts_with("http") {
                        return Some(thumb.to_string());
                    }
                }
            }
        }
    }

    // Strategy 2: Embed page scraping
    let embed_path = if path_type.starts_with("reel") {
        format!("https://www.instagram.com/reel/{}/embed/captioned/", shortcode)
    } else {
        format!("https://www.instagram.com/p/{}/embed/captioned/", shortcode)
    };

    if let Some(thumb) = scrape_instagram_embed(client, &embed_path).await {
        return Some(thumb);
    }

    None
}

/// Scrape an Instagram embed page for a thumbnail URL
async fn scrape_instagram_embed(client: &reqwest::Client, embed_url: &str) -> Option<String> {
    let res = client
        .get(embed_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .ok()?;

    if !res.status().is_success() {
        return None;
    }

    let html = res.text().await.ok()?;

    // Pattern 1: og:image meta tag
    if let Some(thumb) = extract_meta_content(&html, "og:image") {
        return Some(thumb);
    }

    // Pattern 2: img src with Instagram CDN URL (class="EmbeddedMediaImage" or similar)
    if let Some(thumb) = extract_img_src(&html) {
        return Some(thumb);
    }

    // Pattern 3: "display_url" in embedded JSON
    if let Some(thumb) = extract_json_field(&html, "display_url") {
        return Some(thumb);
    }

    // Pattern 4: "thumbnail_src" in embedded JSON
    if let Some(thumb) = extract_json_field(&html, "thumbnail_src") {
        return Some(thumb);
    }

    None
}

/// Extract an img src URL pointing to Instagram CDN from HTML
fn extract_img_src(html: &str) -> Option<String> {
    let re = regex::Regex::new(r#"<img[^>]+src="(https://[^"]*?(?:cdninstagram|fbcdn)[^"]*?)""#).ok()?;
    let caps = re.captures(html)?;
    let url = caps.get(1)?.as_str();
    Some(url.replace("&amp;", "&"))
}

/// Extract content from a meta property tag in HTML
fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let search = format!("property=\"{}\"", property);
    let pos = html.find(&search).or_else(|| {
        let alt = format!("name=\"{}\"", property);
        html.find(&alt)
    })?;

    let region = &html[pos.saturating_sub(200)..std::cmp::min(pos + 500, html.len())];
    let content_re = regex::Regex::new(r#"content="([^"]+)""#).ok()?;
    let caps = content_re.captures(region)?;
    let value = caps.get(1)?.as_str();

    if value.starts_with("http") {
        Some(value.replace("&amp;", "&"))
    } else {
        None
    }
}

/// Extract a URL value from a JSON field embedded in HTML
fn extract_json_field(html: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", field);
    let pos = html.find(&needle)?;
    let start = pos + needle.len();
    let end = html[start..].find('"')?;
    let value = &html[start..start + end];
    let decoded = value.replace("\\/", "/").replace("\\u0026", "&");
    if decoded.starts_with("http") {
        Some(decoded)
    } else {
        None
    }
}

/// Random delay between 0.5 and 3.0 seconds for Instagram rate limiting
async fn instagram_delay() {
    use rand::Rng;
    let ms = rand::thread_rng().gen_range(500..=3000);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

struct YtDlpOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// On Windows, Chromium browsers lock the Cookies SQLite file while running.
/// yt-dlp's Python shutil.copy2 can't read it, but Rust's File::open uses
/// FILE_SHARE_READ|WRITE|DELETE so we CAN read it. Pre-copy the Cookies DB
/// to a temp directory and redirect yt-dlp to use that copy.
#[cfg(target_os = "windows")]
fn apply_windows_cookie_workaround(args: &mut Vec<String>) {
    use std::io::Read;

    let browser_idx = match args.iter().position(|a| a == "--cookies-from-browser") {
        Some(i) if i + 1 < args.len() => i,
        _ => return,
    };

    let browser_arg = args[browser_idx + 1].clone();
    let parts: Vec<&str> = browser_arg.splitn(3, ':').collect();
    let browser_name = parts[0].to_lowercase();

    if parts.len() > 1 && PathBuf::from(parts[1]).is_absolute() {
        return;
    }

    let subpath = match browser_name.as_str() {
        "chrome" => r"Google\Chrome\User Data",
        "edge" => r"Microsoft\Edge\User Data",
        "brave" => r"BraveSoftware\Brave-Browser\User Data",
        "chromium" => r"Chromium\User Data",
        _ => return,
    };

    let local_app_data = match std::env::var("LOCALAPPDATA") {
        Ok(v) => v,
        Err(_) => return,
    };

    let user_data = PathBuf::from(&local_app_data).join(subpath);
    let profile = if parts.len() > 1 && !parts[1].is_empty() {
        parts[1]
    } else {
        "Default"
    };

    let cookies_src = user_data.join(profile).join("Cookies");
    if !cookies_src.exists() {
        return;
    }

    let data = match (|| -> std::io::Result<Vec<u8>> {
        let mut f = fs::File::open(&cookies_src)?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    })() {
        Ok(d) => d,
        Err(_) => return,
    };

    let temp_profile = std::env::temp_dir()
        .join("compiflow_cookies")
        .join(profile);
    if fs::create_dir_all(&temp_profile).is_err() {
        return;
    }
    if fs::write(temp_profile.join("Cookies"), &data).is_err() {
        return;
    }

    args[browser_idx + 1] = format!("{}:{}", browser_name, temp_profile.display());
}

#[cfg(target_os = "macos")]
use helpers::augmented_path;
use helpers::find_system_ytdlp;

/// Run yt-dlp with args, trying bundled sidecar first then system PATH as fallback
async fn run_ytdlp(app: &AppHandle, args: &[String]) -> Result<YtDlpOutput, String> {
    #[allow(unused_mut)]
    let mut args = args.to_vec();

    #[cfg(target_os = "windows")]
    apply_windows_cookie_workaround(&mut args);

    // Try bundled sidecar first.
    // yt-dlp may spawn helper runtimes (e.g. deno for YouTube's n-challenge),
    // so we inject an augmented PATH that includes Homebrew directories.
    match app.shell().sidecar("binaries/yt-dlp") {
        Ok(cmd) => {
            #[cfg(target_os = "macos")]
            let cmd = cmd.env("PATH", augmented_path());
            match cmd.args(&args).output().await {
                Ok(out) => {
                    return Ok(YtDlpOutput {
                        success: out.status.success(),
                        stdout: out.stdout,
                        stderr: out.stderr,
                    });
                }
                Err(e) => {
                    eprintln!("[yt-dlp] sidecar execution failed: {e}");
                }
            }
        }
        Err(e) => {
            eprintln!("[yt-dlp] sidecar not available: {e}");
        }
    }

    // Fallback: system-installed yt-dlp (works in dev mode).
    // macOS .app bundles don't inherit the user's shell PATH, so we probe
    // well-known Homebrew locations before falling back to bare PATH lookup.
    let ytdlp_path = find_system_ytdlp()
        .ok_or_else(|| "yt-dlp is not installed. Install it with: brew install yt-dlp".to_string())?;

    let mut cmd = tokio::process::Command::new(&ytdlp_path);
    cmd.args(&args);
    #[cfg(target_os = "macos")]
    cmd.env("PATH", augmented_path());
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp at {}: {}", ytdlp_path.display(), e))?;

    Ok(YtDlpOutput {
        success: out.status.success(),
        stdout: out.stdout,
        stderr: out.stderr,
    })
}

/// Run yt-dlp --dump-json with a specific cookie method
async fn ytdlp_thumbnail_with(app: &AppHandle, url: &str, cookies_browser: &Option<String>, cookies_file: &Option<String>) -> Result<Option<String>, String> {
    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--skip-download".into(),
        "--no-playlist".into(),
    ];

    if let Some(ref browser) = cookies_browser {
        if !browser.is_empty() {
            args.push("--cookies-from-browser".into());
            args.push(browser.clone());
        }
    }

    if let Some(ref cf) = cookies_file {
        if !cf.is_empty() && PathBuf::from(cf).exists() {
            args.push("--cookies".into());
            args.push(cf.clone());
        }
    }

    args.push(url.to_string());

    let output = run_ytdlp(app, &args).await?;

    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stderr_lower = stderr.to_lowercase();

        if stderr_lower.contains("[douyin]") && stderr_lower.contains("fresh cookies") {
            return Ok(None);
        }

        if (stderr_lower.contains("could not find") && stderr_lower.contains("cookie"))
            || stderr_lower.contains("no suitable cookie")
            || stderr_lower.contains("failed to decrypt")
            || stderr_lower.contains("could not copy")
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

/// Download a thumbnail image, upload to HubSpot File Manager, and set it on the clip
#[tauri::command]
/// Shared: upload image bytes to HubSpot File Manager and update the clip's thumbnail property
async fn upload_thumb_bytes_to_hubspot(
    client: &reqwest::Client,
    token: &str,
    clip_id: &str,
    img_bytes: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    if img_bytes.is_empty() {
        return Err("Image data is empty".into());
    }

    let ext = if content_type.contains("png") { "png" }
        else if content_type.contains("webp") { "webp" }
        else if content_type.contains("gif") { "gif" }
        else { "jpg" };

    let filename = format!("thumb_{}.{}", clip_id, ext);
    let file_part = reqwest::multipart::Part::bytes(img_bytes)
        .file_name(filename.clone())
        .mime_str(content_type)
        .map_err(|e| e.to_string())?;

    let options = serde_json::json!({
        "access": "PUBLIC_NOT_INDEXABLE",
        "overwrite": true,
        "duplicateValidationStrategy": "NONE",
        "duplicateValidationScope": "ENTIRE_PORTAL"
    });

    let form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("options", options.to_string())
        .text("folderPath", "/thumbnails")
        .text("fileName", filename);

    let upload_res = client
        .post("https://api.hubapi.com/files/v3/files")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to upload to HubSpot: {}", e))?;

    if !upload_res.status().is_success() {
        let status = upload_res.status();
        let body = upload_res.text().await.unwrap_or_default();
        return Err(format!("HubSpot file upload failed ({}): {}", status, body));
    }

    let upload_json: serde_json::Value = upload_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse upload response: {}", e))?;

    let file_url = upload_json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("No URL in upload response")?
        .to_string();

    let update_body = serde_json::json!({
        "properties": {
            "fetched_social_thumbnail": file_url
        }
    });

    let update_res = client
        .patch(&format!(
            "https://api.hubapi.com/crm/v3/objects/{}/{}",
            EXTERNAL_CLIPS_OBJECT_ID, clip_id
        ))
        .bearer_auth(token)
        .json(&update_body)
        .send()
        .await
        .map_err(|e| format!("Failed to update clip: {}", e))?;

    if !update_res.status().is_success() {
        let status = update_res.status();
        let body = update_res.text().await.unwrap_or_default();
        return Err(format!("HubSpot clip update failed ({}): {}", status, body));
    }

    Ok(file_url)
}

#[tauri::command]
async fn upload_clip_thumbnail(token: String, clip_id: String, thumbnail_url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let img_response = client
        .get(&thumbnail_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .send()
        .await
        .map_err(|e| format!("Failed to download thumbnail: {}", e))?;

    let content_type = img_response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let img_bytes = img_response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read thumbnail bytes: {}", e))?;

    upload_thumb_bytes_to_hubspot(&client, &token, &clip_id, img_bytes.to_vec(), &content_type).await
}

#[tauri::command]
async fn upload_clip_thumbnail_base64(
    token: String,
    clip_id: String,
    base64_data: String,
    mime_type: String,
) -> Result<String, String> {
    use base64::Engine;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let img_bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    upload_thumb_bytes_to_hubspot(&client, &token, &clip_id, img_bytes, &mime_type).await
}

/// Read a local file and return its contents as base64
#[tauri::command]
async fn read_file_base64(path: String) -> Result<(String, String), String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((b64, mime.to_string()))
}

/// Update a single property on an External Clip in HubSpot
#[tauri::command]
async fn update_clip_property(
    token: String,
    clip_id: String,
    property_name: String,
    property_value: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "properties": {
            property_name: property_value
        }
    });

    let res = client
        .patch(&format!(
            "https://api.hubapi.com/crm/v3/objects/{}/{}",
            EXTERNAL_CLIPS_OBJECT_ID, clip_id
        ))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to update clip: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot update failed ({}): {}", status, text));
    }

    Ok(())
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
        hubspot_video_project_id: None,
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
    #[allow(unused_variables)]
    force: Option<bool>,
) -> Result<(), String> {
    let clips_dir = PathBuf::from(&root_folder)
        .join(&project_name)
        .join("clips");

    // When force-redownloading, remove old files so stale/broken files
    // (e.g. audio-only .m4a from a previous failed format selection)
    // don't get picked up by find_downloaded_file afterwards.
    if force.unwrap_or(false) {
        let removed = remove_existing_clip_files(&clips_dir, &clip_id);
        if !removed.is_empty() {
            eprintln!("[download_clip] force: removed old files for {}: {:?}", clip_id, removed);
        }
    }

    let _ = app.emit("download-progress", DownloadProgress {
        clip_id: clip_id.clone(),
        status: "downloading".into(),
        progress: Some(0.0),
        local_file: None,
        local_duration: None,
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
        &app, &url, &output_template,
        if has_browser { &cookies_browser } else { &None },
        if has_browser { &None } else { &cookies_file },
    ).await;

    // If browser cookies failed and we have a cookies file, retry with file
    let result = match &result {
        Ok((success, _)) if !success && has_browser && has_file => {
            run_ytdlp_download(&app, &url, &output_template, &None, &cookies_file).await
        }
        _ => result,
    };

    // Last resort: retry without any cookies (works for YouTube, TikTok, etc.)
    let result = match &result {
        Ok((success, _)) if !success && (has_browser || has_file) => {
            run_ytdlp_download(&app, &url, &output_template, &None, &None).await
        }
        _ => result,
    };

    match result {
        Ok((true, _)) => {
            let local_file = find_downloaded_file(&clips_dir, &clip_id);
            let project_dir = PathBuf::from(&root_folder).join(&project_name);
            let local_duration = local_file.as_ref().and_then(|rel| {
                let abs = project_dir.join(rel);
                probe_duration(&abs.to_string_lossy())
            });
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "complete".into(),
                progress: Some(100.0),
                local_file,
                local_duration,
                error: None,
            });
            Ok(())
        }
        Ok((false, stderr_bytes)) => {
            let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
            let friendly = friendly_download_error(&stderr, &url, &cookies_browser);
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "failed".into(),
                progress: None,
                local_file: None,
                local_duration: None,
                error: Some(friendly.clone()),
            });
            Err(friendly)
        }
        Err(msg) => {
            let _ = app.emit("download-progress", DownloadProgress {
                clip_id,
                status: "failed".into(),
                progress: None,
                local_file: None,
                local_duration: None,
                error: Some(msg.clone()),
            });
            Err(msg)
        }
    }
}

/// Run yt-dlp download with a specific cookie method
async fn run_ytdlp_download(
    app: &AppHandle,
    url: &str,
    output_template: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<(bool, Vec<u8>), String> {
    let fmt = format_selection_for_url(url);
    let mut args = vec![
        "--no-warnings".to_string(),
        "-f".to_string(), fmt.to_string(),
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

    let output = run_ytdlp(app, &args).await?;
    Ok((output.success, output.stderr))
}

// ── Helpers ─────────────────────────────────────────────────────────────────


fn save_project(folder: &PathBuf, project: &Project) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(folder.join("project.json"), json)
        .map_err(|e| format!("Failed to write project: {e}"))
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol("localfile", |_ctx, request| {
            use std::io::{Read, Seek, SeekFrom};

            let uri = request.uri().to_string();
            // On macOS:  localfile://localhost/<path>
            // On Windows: http://localfile.localhost/<path>
            let path = uri
                .strip_prefix("localfile://localhost/")
                .or_else(|| uri.strip_prefix("http://localfile.localhost/"))
                .or_else(|| uri.strip_prefix("https://localfile.localhost/"))
                .unwrap_or(&uri);
            let decoded = urlencoding::decode(path).unwrap_or_default();
            let decoded_ref = decoded.as_ref();

            // On Windows, URL path may have a leading slash before the drive letter
            let clean = if decoded_ref.starts_with('/') && decoded_ref.len() > 2 && decoded_ref.as_bytes()[2] == b':' {
                &decoded_ref[1..]
            } else {
                decoded_ref
            };

            let file_path = PathBuf::from(clean);

            let mut file = match fs::File::open(&file_path) {
                Ok(f) => f,
                Err(e) => {
                    let msg = format!("Cannot open file: {} ({})", file_path.display(), e);
                    return tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(msg.into_bytes())
                        .unwrap()
                }
            };

            let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
            if file_size == 0 {
                return tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Length", "0")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::new())
                    .unwrap();
            }

            let mime = match file_path.extension().and_then(|e| e.to_str()) {
                Some("mp4") => "video/mp4",
                Some("webm") => "video/webm",
                Some("mkv") => "video/x-matroska",
                _ => "application/octet-stream",
            };

            // Parse Range header -- required for WebView2 video playback on Windows.
            let range_header = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes="));

            let (start, end, is_range) = if let Some(spec) = range_header {
                let parts: Vec<&str> = spec.splitn(2, '-').collect();
                let s = parts[0].parse::<u64>().unwrap_or(0).min(file_size - 1);
                let e = if parts.len() > 1 && !parts[1].is_empty() {
                    parts[1].parse::<u64>().unwrap_or(file_size - 1).min(file_size - 1)
                } else {
                    file_size - 1
                };
                (s, e, true)
            } else {
                (0, file_size - 1, false)
            };

            let length = (end - start + 1) as usize;
            let _ = file.seek(SeekFrom::Start(start));
            let mut buf = vec![0u8; length];
            let n = file.read(&mut buf).unwrap_or(0);
            buf.truncate(n);

            let mut response = tauri::http::Response::builder()
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", n.to_string())
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

            if is_range {
                response = response
                    .status(206)
                    .header(
                        "Content-Range",
                        format!("bytes {}-{}/{}", start, start + n as u64 - 1, file_size),
                    );
            } else {
                response = response.status(200);
            }

            response.body(buf).unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            fetch_tag_options,
            search_clips,
            search_creator_clips,
            search_creators,
            fetch_clip_video_projects,
            search_video_projects,
            fetch_video_project_clips,
            fetch_video_projects_by_ids,
            create_video_project,
            associate_clips_to_project,
            disassociate_clip_from_project,
            generate_clips_csv,
            order_and_zip_clips,
            order_clips,
            import_clip_file,
            fetch_thumbnail,
            upload_clip_thumbnail,
            upload_clip_thumbnail_base64,
            read_file_base64,
            update_clip_property,
            fetch_creators_batch,
            create_project,
            load_project,
            save_project_data,
            list_projects,
            download_clip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
