mod helpers;
mod resolver;
mod socialkit;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

use helpers::{
    build_filter_groups, detect_platform, extract_instagram_caption_from_html,
    extract_instagram_shortcode, extract_instagram_username_from_html, extract_meta_content_text,
    find_downloaded_file, find_file_by_id, format_selection_for_url, friendly_download_error,
    parse_social_urls, probe_duration, providers_for_url, remove_existing_clip_files, strip_prefix,
    SocialPlatform,
};

use chrono::Utc;
use strsim::jaro_winkler;

pub use resolver::EnrichedProfile;

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
    #[serde(rename = "retryCount", default)]
    pub retry_count: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub clips: Vec<ProjectClip>,
    #[serde(
        rename = "hubspotVideoProjectId",
        skip_serializing_if = "Option::is_none"
    )]
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
    "link",
    "tags",
    "creator_name",
    "creator_status",
    "creator_main_link",
    "creator_id",
    "score",
    "edited_duration",
    "date_found",
    "link_not_working_anymore",
    "available_ask_first",
    "num_of_published_video_project",
    "clip_mix_link_1",
    "clip_mix_link_2",
    "clip_mix_link_3",
    "clip_mix_link_4",
    "clip_mix_link_5",
    "clip_mix_link_6",
    "clip_mix_link_7",
    "clip_mix_link_8",
    "clip_mix_link_9",
    "clip_mix_link_10",
    "notes",
    "creator_license_type",
    "creator_notes",
    "fetched_social_thumbnail",
    "original_clip",
];

/// Fetch the options for the "tags" property (label + internal value)
#[tauri::command]
async fn fetch_tag_options(token: String) -> Result<serde_json::Value, String> {
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

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse property: {e}"))?;

    let options = body
        .get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|o| o.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) == false)
                .map(|o| {
                    serde_json::json!({
                        "label": o.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                        "value": o.get("value").and_then(|v| v.as_str()).unwrap_or("")
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(serde_json::json!(options))
}

#[tauri::command]
async fn create_tag_option(token: String, label: String, value: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/properties/{}/tags",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let get_res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !get_res.status().is_success() {
        let status = get_res.status();
        let text = get_res.text().await.unwrap_or_default();
        return Err(format!(
            "HubSpot property fetch error ({}): {}",
            status, text
        ));
    }

    let mut body: serde_json::Value = get_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse property: {e}"))?;

    let options = body
        .get_mut("options")
        .and_then(|o| o.as_array_mut())
        .ok_or("No options array in property")?;

    options.push(serde_json::json!({
        "label": label,
        "value": value,
        "hidden": false,
        "displayOrder": -1
    }));

    let patch_res = client
        .patch(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "options": options }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !patch_res.status().is_success() {
        let status = patch_res.status();
        let text = patch_res.text().await.unwrap_or_default();
        return Err(format!("HubSpot create tag error ({}): {}", status, text));
    }

    Ok(())
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
    date_from: Option<String>,
    date_to: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let filter_groups = build_filter_groups(
        &tags,
        &scores,
        never_used,
        &tag_mode,
        creator_main_link.as_deref(),
        date_from.as_deref(),
        date_to.as_deref(),
    );

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES
        .iter()
        .map(|p| serde_json::json!(p))
        .collect();

    let mut body = serde_json::json!({
        "filterGroups": filter_groups,
        "properties": props,
        "sorts": [{ "propertyName": "date_found", "direction": "DESCENDING" }],
        "limit": 50
    });

    if let Some(after_val) = after {
        body.as_object_mut()
            .unwrap()
            .insert("after".into(), serde_json::json!(after_val));
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

/// Fetch clips for a specific creator matching the same tag filters, auto-paginating up to `max_results`.
#[tauri::command]
async fn search_creator_clips(
    token: String,
    tags: Vec<String>,
    scores: Vec<String>,
    never_used: bool,
    tag_mode: String,
    creator_main_link: Option<String>,
    creator_name: String,
    max_results: Option<u32>,
    date_from: Option<String>,
    date_to: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut filter_groups = build_filter_groups(
        &tags,
        &scores,
        never_used,
        &tag_mode,
        creator_main_link.as_deref(),
        date_from.as_deref(),
        date_to.as_deref(),
    );

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

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES
        .iter()
        .map(|p| serde_json::json!(p))
        .collect();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let max = max_results.unwrap_or(200).max(1) as usize;
    let mut all_results: Vec<serde_json::Value> = Vec::new();
    let mut after: Option<String> = None;
    let mut capped = false;

    loop {
        let mut body = serde_json::json!({
            "filterGroups": filter_groups,
            "properties": props,
            "sorts": [{ "propertyName": "date_found", "direction": "DESCENDING" }],
            "limit": 100
        });

        if let Some(ref after_val) = after {
            body.as_object_mut()
                .unwrap()
                .insert("after".into(), serde_json::json!(after_val));
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

        let page: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {e}"))?;

        let next_after = page
            .get("paging")
            .and_then(|p| p.get("next"))
            .and_then(|n| n.get("after"))
            .and_then(|a| a.as_str())
            .map(String::from);

        if let Some(results) = page.get("results").and_then(|r| r.as_array()) {
            all_results.extend(results.iter().cloned());
        }

        if all_results.len() > max {
            all_results.truncate(max);
            capped = true;
            break;
        }
        if all_results.len() == max {
            capped = next_after.is_some();
            break;
        }

        after = next_after;
        if after.is_none() {
            break;
        }
    }

    Ok(serde_json::json!({
        "total": all_results.len(),
        "results": all_results,
        "capped": capped
    }))
}

/// Search Creator records by name or main_link (OR across both fields).
#[tauri::command]
async fn search_creators(token: String, query: String) -> Result<serde_json::Value, String> {
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

    let body: serde_json::Value = res
        .json()
        .await
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
        "properties": ["name", "tag", "pub_date", "youtube_video_id", "status", "clips_order", "editing_notes"],
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

    let batch_result: serde_json::Value = res2
        .json()
        .await
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
async fn search_video_projects(token: String, query: String) -> Result<serde_json::Value, String> {
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
        "properties": ["name", "tag", "pub_date", "youtube_video_id", "status", "clips_order", "editing_notes"],
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

        let body: serde_json::Value = res
            .json()
            .await
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

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES
        .iter()
        .map(|p| serde_json::json!(p))
        .collect();

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

        let batch_result: serde_json::Value = res2
            .json()
            .await
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
        .map(|clip_id| {
            serde_json::json!({
                "from": { "id": clip_id },
                "to": { "id": project_id },
                "types": [{
                    "associationCategory": category,
                    "associationTypeId": type_id
                }]
            })
        })
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
        "properties": ["name", "clips_order", "editing_notes"],
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
        "main_link",
        "main_account",
        "name",
        "douyin_id",
        "kuaishou_id",
        "xiaohongshu_id",
        "special_requests",
        "notes",
        "license_checked",
        "license_type",
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

        let batch_result: serde_json::Value = res
            .json()
            .await
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

    let created: serde_json::Value = res
        .json()
        .await
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
        .map(|clip_id| {
            serde_json::json!({
                "from": { "id": clip_id },
                "to": [{ "id": project_id }]
            })
        })
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
            return Err(format!(
                "Failed to disassociate clips ({}): {}",
                status, text
            ));
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

        let file_name = actual_path
            .file_name()
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
/// Clips with `"missing": true` get a warning row; all other fields are preserved.
/// The Order column always uses the clip's position in the full project list.
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
        // Each clip carries its 1-based project position (passed from frontend).
        // Fall back to loop index + 1 if not provided.
        let order = clip
            .get("order")
            .and_then(|v| v.as_u64())
            .unwrap_or((i + 1) as u64);

        let is_missing = clip
            .get("missing")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let download_status = get(clip, "downloadStatus");

        if is_missing {
            // Warning row: preserve link + ids so the editor can identify the clip,
            // leave all creator/duration fields empty.
            let warning_note = format!(
                "\u{26A0} MISSING \u{2014} {}",
                if download_status.is_empty() {
                    "not downloaded".to_string()
                } else {
                    download_status
                }
            );
            let fields = [
                format!("{}", order),
                String::new(),         // Duration
                escape(&warning_note), // Editing Notes (warning)
                escape(&get(clip, "link")),
                String::new(), // Main Link
                String::new(), // Main Account
                String::new(), // Name
                String::new(), // Douyin ID
                String::new(), // Kuaishou ID
                String::new(), // Xiaohongshu ID
                String::new(), // Clip Mix Links
                String::new(), // Special Requests
                String::new(), // Notes
                String::new(), // License Checked
                String::new(), // License Type
                String::new(), // Available Ask First
                String::new(), // Score
                escape(&get(clip, "externalClipId")),
                escape(&get(clip, "creatorId")),
                escape(&get(clip, "videoProjectId")),
            ];
            csv_content.push_str(&fields.join(","));
        } else {
            let duration = clip
                .get("duration")
                .and_then(|v| v.as_f64())
                .map(|d| format!("{:.0}", d))
                .unwrap_or_default();

            let fields = [
                format!("{}", order),
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
        }
        csv_content.push('\n');
    }

    fs::write(&csv_path, &csv_content).map_err(|e| format!("Failed to write CSV: {e}"))?;

    Ok(csv_path.to_string_lossy().to_string())
}

/// Rename clips with order prefix, mark unused files, and create a zip archive.
/// The zip includes the numbered clips and clips.csv (if it exists).
/// `clip_files` is a list of optional relative paths — None entries represent missing
/// clips whose position is preserved in numbering but skipped in the zip.
/// Returns JSON with `dir`, `zipPath`, and `newPaths` (None for missing entries).
#[tauri::command]
async fn order_and_zip_clips(
    root_folder: String,
    project_name: String,
    clip_files: Vec<Option<String>>,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let clips_dir = project_dir.join("clips");

    // Step A: Rename downloaded clips using their project position (1-indexed over ALL clips).
    // Missing entries (None) skip a number — the gap is intentional.
    let mut new_rel_paths: Vec<serde_json::Value> = Vec::new();
    let mut new_used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut zip_files: Vec<(String, PathBuf)> = Vec::new();

    for (i, maybe_path) in clip_files.iter().enumerate() {
        let position = i + 1; // 1-indexed project position, preserved regardless of gaps

        let rel_path = match maybe_path {
            None => {
                // Missing clip: preserve the position slot but skip file operations
                new_rel_paths.push(serde_json::Value::Null);
                continue;
            }
            Some(p) => p,
        };

        let abs_path = project_dir.join(rel_path);

        let actual_path = if abs_path.exists() {
            abs_path.clone()
        } else {
            let original_name = abs_path.file_name().unwrap_or_default().to_string_lossy();
            let clean = strip_prefix(&original_name);
            let id_prefix = clean.split('_').next().unwrap_or("");
            find_file_by_id(&clips_dir, id_prefix).unwrap_or(abs_path.clone())
        };

        let file_name = actual_path
            .file_name()
            .ok_or(format!("Invalid file path: {}", actual_path.display()))?
            .to_string_lossy()
            .to_string();

        let clean_name = strip_prefix(&file_name);
        let new_name = format!("{} - {}", position, clean_name);
        new_used_names.insert(new_name.clone());
        let new_abs_path = actual_path.with_file_name(&new_name);

        if actual_path != new_abs_path {
            fs::rename(&actual_path, &new_abs_path)
                .map_err(|e| format!("Failed to rename {}: {e}", file_name))?;
        }
        zip_files.push((new_name.clone(), new_abs_path));
        new_rel_paths.push(serde_json::json!(format!("clips/{}", new_name)));
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

    // Step C: Create zip archive
    let zip_path = project_dir.join(format!("{}.zip", project_name));
    let zip_file = fs::File::create(&zip_path).map_err(|e| format!("Failed to create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(zip_file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored); // no compression for video

    // Add clip files (missing clips have no file, so nothing to add for them)
    for (name, path) in &zip_files {
        let data = fs::read(path).map_err(|e| format!("Failed to read {}: {e}", name))?;
        zip.start_file(name, options)
            .map_err(|e| format!("Zip error: {e}"))?;
        std::io::Write::write_all(&mut zip, &data).map_err(|e| format!("Zip write error: {e}"))?;
    }

    // Add clips.csv if it exists
    let csv_path = project_dir.join("clips.csv");
    if csv_path.exists() {
        let csv_data = fs::read(&csv_path).map_err(|e| format!("Failed to read CSV: {e}"))?;
        zip.start_file("clips.csv", options)
            .map_err(|e| format!("Zip CSV error: {e}"))?;
        std::io::Write::write_all(&mut zip, &csv_data)
            .map_err(|e| format!("Zip CSV write error: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip: {e}"))?;

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
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let original_stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported");

    // Truncate stem to 50 chars like yt-dlp does
    let truncated: String = original_stem.chars().take(50).collect();
    let dest_name = format!("{}_{}.{}", clip_id, truncated, ext);
    let dest_path = clips_dir.join(&dest_name);

    fs::copy(&source, &dest_path).map_err(|e| format!("Failed to copy file: {e}"))?;

    let rel_path = format!("clips/{}", dest_name);
    let local_duration = probe_duration(&dest_path.to_string_lossy());

    Ok(serde_json::json!({
        "localFile": rel_path,
        "localDuration": local_duration
    }))
}

/// Resolve a thumbnail URL for a video link via oEmbed, URL patterns, Evil0ctal API, or yt-dlp fallback
#[tauri::command]
async fn fetch_thumbnail(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
    evil0ctal_api_url: Option<String>,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Douyin / Kuaishou / Bilibili: use Evil0ctal API if configured (fast, no cookies needed)
    let is_chinese_platform =
        url.contains("douyin.com") || url.contains("kuaishou.com") || url.contains("bilibili.com");
    if is_chinese_platform {
        if let Some(ref base_url) = evil0ctal_api_url {
            if !base_url.is_empty() {
                if let Some(thumb) = evil0ctal_thumbnail(&client, base_url, &url).await {
                    return Ok(Some(thumb));
                }
            }
        }
    }

    // YouTube: construct thumbnail directly (instant, no API call)
    if url.contains("youtube.com") || url.contains("youtu.be") {
        let video_id = if url.contains("youtu.be/") {
            url.split("youtu.be/")
                .nth(1)
                .and_then(|s| s.split(['?', '&']).next())
        } else if url.contains("/shorts/") {
            url.split("/shorts/")
                .nth(1)
                .and_then(|s| s.split(['?', '&']).next())
        } else {
            url.split("v=")
                .nth(1)
                .and_then(|s| s.split(['&', '#']).next())
        };
        if let Some(id) = video_id {
            return Ok(Some(format!(
                "https://img.youtube.com/vi/{}/hqdefault.jpg",
                id
            )));
        }
    }

    // TikTok: oEmbed API (fast)
    if url.contains("tiktok.com") {
        let oembed_url = format!(
            "https://www.tiktok.com/oembed?url={}",
            urlencoding::encode(&url)
        );
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
    let has_file = cookies_file
        .as_ref()
        .map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());
    let mut cookie_error: Option<String> = None;
    let is_instagram = url.contains("instagram.com");

    // 1. Try with browser cookies (rate-limited for Instagram)
    if has_browser {
        let result = if is_instagram {
            let _permit = INSTAGRAM_SEMAPHORE
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            let r = ytdlp_thumbnail_with(&app, &url, &cookies_browser, &None).await;
            instagram_delay().await;
            r
        } else {
            ytdlp_thumbnail_with(&app, &url, &cookies_browser, &None).await
        };
        match result {
            Ok(Some(thumb)) => return Ok(Some(thumb)),
            Err(err) => {
                cookie_error = Some(err);
            }
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

/// Extract a thumbnail frame from a local video file using ffmpeg.
/// Returns the raw JPEG bytes, or None if ffmpeg is not available / failed.
async fn extract_video_thumbnail_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Err(format!("Video file not found: {}", path.display()));
    }

    let ffmpeg = which::which("ffmpeg")
        .or_else(|_| which::which("/opt/homebrew/bin/ffmpeg"))
        .or_else(|_| which::which("/usr/local/bin/ffmpeg"));

    let ffmpeg_path = match ffmpeg {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[extract_video_thumbnail] ffmpeg not found");
            return Ok(None);
        }
    };

    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let out_path = dir.path().join("thumb.jpg");

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-ss").arg("1").arg("-i").arg(path.as_os_str());
    cmd.args(["-vframes", "1", "-q:v", "3", "-vf", "scale=480:-1", "-y"]);
    cmd.arg(out_path.as_os_str());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    #[cfg(target_os = "macos")]
    {
        let aug = helpers::augmented_path();
        cmd.env("PATH", &aug);
    }

    let status = cmd
        .status()
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if !status.success() || !out_path.exists() {
        eprintln!("[extract_video_thumbnail] ffmpeg exited with {}", status);
        return Ok(None);
    }

    let bytes = fs::read(&out_path).map_err(|e| format!("Failed to read thumbnail: {e}"))?;
    Ok(Some(bytes))
}

/// Extract a thumbnail frame from a local video file using ffmpeg.
/// Returns a base64-encoded JPEG string, or None if ffmpeg is not available.
#[tauri::command]
async fn extract_video_thumbnail(video_path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let path = PathBuf::from(&video_path);
    let bytes = extract_video_thumbnail_bytes(&path).await?;
    Ok(bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(&b)))
}

/// Fetch thumbnail URL for Chinese platforms via Evil0ctal API metadata endpoint.
async fn evil0ctal_thumbnail(
    client: &reqwest::Client,
    api_base_url: &str,
    video_url: &str,
) -> Option<String> {
    let base = api_base_url.trim_end_matches('/');
    let api_url = format!(
        "{}/api/hybrid/video_data?url={}&minimal=true",
        base,
        urlencoding::encode(video_url)
    );

    let resp = client.get(&api_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let data = body.get("data").unwrap_or(&body);

    // Try cover URLs in order of quality
    data.pointer("/cover_data/cover/url_list/0")
        .or_else(|| data.pointer("/cover_data/origin_cover/url_list/0"))
        .or_else(|| data.pointer("/cover_data/dynamic_cover/url_list/0"))
        .or_else(|| data.pointer("/video/cover/url_list/0"))
        .or_else(|| data.pointer("/video/origin_cover/url_list/0"))
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
        .map(|s| s.to_string())
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
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
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
        format!(
            "https://www.instagram.com/reel/{}/embed/captioned/",
            shortcode
        )
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
    let re =
        regex::Regex::new(r#"<img[^>]+src="(https://[^"]*?(?:cdninstagram|fbcdn)[^"]*?)""#).ok()?;
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

    let temp_profile = std::env::temp_dir().join("compiflow_cookies").join(profile);
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
#[cfg(debug_assertions)]
use helpers::find_system_ytdlp;

#[cfg(target_os = "macos")]
static STRIP_YTDLP_QUARANTINE: std::sync::Once = std::sync::Once::new();

/// macOS: strip quarantine from the bundled sidecar once per process so Gatekeeper allows it to run.
#[cfg(target_os = "macos")]
fn ensure_ytdlp_sidecar_unquarantined(app: &AppHandle) {
    STRIP_YTDLP_QUARANTINE.call_once(|| {
        if let Ok(dir) = app.path().resource_dir() {
            helpers::unquarantine_path(&dir.join("binaries").join("yt-dlp_macos"));
            helpers::unquarantine_path(
                &dir.join("binaries").join(helpers::ytdlp_sidecar_filename()),
            );
        }
    });
}

fn configured_ytdlp_path() -> Result<Option<PathBuf>, String> {
    let Some(raw) = std::env::var_os("COMPIFLOW_YTDLP_PATH") else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if path.exists() {
        Ok(Some(path))
    } else {
        Err(format!(
            "COMPIFLOW_YTDLP_PATH points to {}, but that file does not exist.",
            path.display()
        ))
    }
}

#[cfg(target_os = "macos")]
fn bundled_macos_ytdlp_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app
        .path()
        .resource_dir()
        .ok()?
        .join(helpers::ytdlp_macos_resource_executable());
    if path.exists() {
        return Some(path);
    }

    let dev_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(helpers::ytdlp_macos_resource_executable());
    dev_path.exists().then_some(dev_path)
}

async fn run_ytdlp_binary(path: &PathBuf, args: &[String]) -> Result<YtDlpOutput, String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(args);
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
        .map_err(|e| format!("Failed to run yt-dlp at {}: {}", path.display(), e))?;

    Ok(YtDlpOutput {
        success: out.status.success(),
        stdout: out.stdout,
        stderr: out.stderr,
    })
}

/// Run yt-dlp with args. Release builds use CompiFlow's bundled downloader unless
/// COMPIFLOW_YTDLP_PATH is set; dev builds may fall back to a system yt-dlp.
async fn run_ytdlp(app: &AppHandle, args: &[String]) -> Result<YtDlpOutput, String> {
    #[allow(unused_mut)]
    let mut args = args.to_vec();

    #[cfg(target_os = "windows")]
    apply_windows_cookie_workaround(&mut args);

    if let Some(path) = configured_ytdlp_path()? {
        return run_ytdlp_binary(&path, &args).await;
    }

    #[cfg(target_os = "macos")]
    ensure_ytdlp_sidecar_unquarantined(app);

    #[cfg(target_os = "macos")]
    {
        if let Some(path) = bundled_macos_ytdlp_path(app) {
            return run_ytdlp_binary(&path, &args).await;
        }
        eprintln!("[yt-dlp] bundled macOS resource not available");
    }

    // Try bundled sidecar first.
    // yt-dlp may spawn helper runtimes (e.g. deno for YouTube's n-challenge),
    // so we inject an augmented PATH that includes Homebrew directories.
    #[cfg(not(target_os = "macos"))]
    match app.shell().sidecar("binaries/yt-dlp") {
        Ok(cmd) => match cmd.args(&args).output().await {
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
        },
        Err(e) => {
            eprintln!("[yt-dlp] sidecar not available: {e}");
        }
    }

    // Fallback: system-installed yt-dlp for development only. Release builds
    // must not be hijacked by a broken Homebrew/pip install on the user's PATH.
    #[cfg(debug_assertions)]
    {
        let ytdlp_path = find_system_ytdlp().ok_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                "yt-dlp is not installed. Install it from https://github.com/yt-dlp/yt-dlp/releases"
                    .to_string()
            }
            #[cfg(target_os = "macos")]
            {
                "yt-dlp is not installed. Install it with: brew install yt-dlp".to_string()
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                "yt-dlp is not installed.".to_string()
            }
        })?;
        return run_ytdlp_binary(&ytdlp_path, &args).await;
    }

    #[cfg(not(debug_assertions))]
    {
        #[cfg(target_os = "windows")]
        {
            Err(concat!(
                "CompiFlow's bundled yt-dlp failed to start. ",
                "Reinstall CompiFlow from the official installer, or set ",
                "COMPIFLOW_YTDLP_PATH to a working yt-dlp binary."
            )
            .to_string())
        }
        #[cfg(target_os = "macos")]
        {
            Err(concat!(
                "CompiFlow's bundled yt-dlp failed to start. ",
                "Reinstall CompiFlow from the latest DMG, or set ",
                "COMPIFLOW_YTDLP_PATH to a working yt-dlp binary."
            )
            .to_string())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(concat!(
                "CompiFlow's bundled yt-dlp failed to start. ",
                "Set COMPIFLOW_YTDLP_PATH to a working yt-dlp binary."
            )
            .to_string())
        }
    }
}

/// Run yt-dlp --dump-json with a specific cookie method
async fn ytdlp_thumbnail_with(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<Option<String>, String> {
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

    let output = run_ytdlp(app, &args)
        .await
        .map_err(|e| friendly_download_error(&e, url, cookies_browser))?;

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
            let browser_name = cookies_browser
                .as_ref()
                .map(|b| b.as_str())
                .unwrap_or("your browser");
            return Err(format!(
                "Could not read cookies from {}. Make sure {} is installed and try closing it before searching.",
                browser_name, browser_name
            ));
        }

        return Ok(None);
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Failed to parse yt-dlp output".to_string())?;
    Ok(json
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// Upload raw bytes to HubSpot File Manager and return the public file URL.
async fn upload_bytes_to_hubspot_files(
    client: &reqwest::Client,
    token: &str,
    bytes: Vec<u8>,
    filename: &str,
    mime: &str,
    folder_path: &str,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("File data is empty".into());
    }

    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(mime)
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
        .text("folderPath", folder_path.to_string())
        .text("fileName", filename.to_string());

    let res = client
        .post("https://api.hubapi.com/files/v3/files")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to upload to HubSpot: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot file upload failed ({}): {}", status, body));
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse upload response: {}", e))?;

    json.get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "No URL in upload response".to_string())
}

/// PATCH a single string property on an External Clip record.
async fn set_clip_property(
    client: &reqwest::Client,
    token: &str,
    clip_id: &str,
    property: &str,
    value: &str,
) -> Result<(), String> {
    let body = serde_json::json!({ "properties": { property: value } });

    let res = client
        .patch(format!(
            "https://api.hubapi.com/crm/v3/objects/{}/{}",
            EXTERNAL_CLIPS_OBJECT_ID, clip_id
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to update clip: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to update clip {} ({}): {}",
            property, status, body
        ));
    }
    Ok(())
}

fn extension_from_mime(mime: &str) -> &'static str {
    if mime.contains("png") {
        "png"
    } else if mime.contains("webp") {
        "webp"
    } else if mime.contains("gif") {
        "gif"
    } else {
        "jpg"
    }
}

/// Upload image bytes to HubSpot File Manager and set them as the clip's thumbnail.
async fn upload_thumb_bytes_to_hubspot(
    client: &reqwest::Client,
    token: &str,
    clip_id: &str,
    img_bytes: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let filename = format!("thumb_{}.{}", clip_id, extension_from_mime(content_type));
    let file_url = upload_bytes_to_hubspot_files(
        client,
        token,
        img_bytes,
        &filename,
        content_type,
        "/thumbnails",
    )
    .await?;
    set_clip_property(
        client,
        token,
        clip_id,
        "fetched_social_thumbnail",
        &file_url,
    )
    .await?;
    Ok(file_url)
}

#[tauri::command]
async fn upload_clip_thumbnail(
    token: String,
    clip_id: String,
    thumbnail_url: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let img_response = client
        .get(&thumbnail_url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
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

    upload_thumb_bytes_to_hubspot(&client, &token, &clip_id, img_bytes.to_vec(), &content_type)
        .await
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
    set_clip_property(&client, &token, &clip_id, &property_name, &property_value).await
}

/// Update a single property on a Video Project in HubSpot
#[tauri::command]
async fn update_video_project_property(
    token: String,
    project_id: String,
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
            VIDEO_PROJECTS_OBJECT_ID, project_id
        ))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to update Video Project: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot update failed ({}): {}", status, text));
    }

    Ok(())
}

/// Build a reqwest client with a HubSpot-friendly long timeout (used for video uploads).
fn build_hubspot_upload_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}

/// Upload a local video file to HubSpot File Manager and set the clip's `original_clip` property.
async fn upload_video_file_to_hubspot(
    client: &reqwest::Client,
    token: &str,
    clip_id: &str,
    path: &Path,
) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let filename = format!("clip_{}.mp4", clip_id);
    let file_url =
        upload_bytes_to_hubspot_files(client, token, bytes, &filename, "video/mp4", "/clips")
            .await?;
    set_clip_property(client, token, clip_id, "original_clip", &file_url).await?;
    Ok(file_url)
}

/// Upload a local video file to HubSpot File Manager and store the URL on the clip's original_clip property
#[tauri::command]
async fn upload_clip_video(
    token: String,
    clip_id: String,
    file_path: String,
) -> Result<String, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    let client = build_hubspot_upload_client()?;
    upload_video_file_to_hubspot(&client, &token, &clip_id, &path).await
}

/// Run yt-dlp with the cookie cascade, applying the Instagram concurrency limiter and delay
/// when the URL is an Instagram link. Centralises the rate-limit handling shared by the
/// download-on-demand flows.
async fn download_clip_with_rate_limits(
    app: &AppHandle,
    url: &str,
    clips_dir: &Path,
    clip_id: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<(), String> {
    let clips_path = clips_dir.to_path_buf();
    if url.contains("instagram.com") {
        let _permit = INSTAGRAM_SEMAPHORE
            .acquire()
            .await
            .map_err(|e| e.to_string())?;
        let result = run_ytdlp_with_cookie_cascade(
            app,
            url,
            &clips_path,
            clip_id,
            cookies_browser,
            cookies_file,
        )
        .await;
        instagram_delay().await;
        result.map(|_| ())
    } else {
        run_ytdlp_with_cookie_cascade(
            app,
            url,
            &clips_path,
            clip_id,
            cookies_browser,
            cookies_file,
        )
        .await
        .map(|_| ())
    }
}

/// Download a clip on demand, upload it to HubSpot, and persist original_clip.
/// Best-effort: a thumbnail frame is extracted from the freshly downloaded video and
/// uploaded as `fetched_social_thumbnail` if ffmpeg is available.
#[tauri::command]
async fn ensure_clip_video_uploaded(
    app: AppHandle,
    token: String,
    clip_id: String,
    url: String,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
) -> Result<String, String> {
    let temp_dir =
        tempfile::tempdir().map_err(|e| format!("Failed to create temp download folder: {e}"))?;
    let clips_dir = temp_dir.path().to_path_buf();

    download_clip_with_rate_limits(
        &app,
        &url,
        &clips_dir,
        &clip_id,
        &cookies_browser,
        &cookies_file,
    )
    .await?;

    let downloaded_rel = find_downloaded_file(&clips_dir, &clip_id)
        .ok_or_else(|| "Downloaded video file was not found".to_string())?;
    let downloaded_name = downloaded_rel
        .strip_prefix("clips/")
        .unwrap_or(&downloaded_rel);
    let downloaded_path = clips_dir.join(downloaded_name);

    let client = build_hubspot_upload_client()?;
    let video_url =
        upload_video_file_to_hubspot(&client, &token, &clip_id, &downloaded_path).await?;

    if let Err(err) =
        upload_video_thumbnail_best_effort(&client, &token, &clip_id, &downloaded_path).await
    {
        eprintln!("[ensure_clip_video_uploaded] {err}");
    }

    Ok(video_url)
}

/// Try to extract a frame from a local video and upload it as the clip's thumbnail.
/// Returns `Ok(())` when no thumbnail is available (ffmpeg missing) so the caller can skip silently.
async fn upload_video_thumbnail_best_effort(
    client: &reqwest::Client,
    token: &str,
    clip_id: &str,
    video_path: &Path,
) -> Result<(), String> {
    let Some(bytes) = extract_video_thumbnail_bytes(video_path).await? else {
        return Ok(());
    };
    upload_thumb_bytes_to_hubspot(client, token, clip_id, bytes, "image/jpeg")
        .await
        .map(|_| ())
        .map_err(|err| format!("thumbnail upload failed: {err}"))
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
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read project: {e}"))?;
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
    #[allow(unused_variables)] force: Option<bool>,
    hubspot_url: Option<String>,
    evil0ctal_api_url: Option<String>,
    download_providers: Option<String>,
) -> Result<(), String> {
    let clips_dir = PathBuf::from(&root_folder)
        .join(&project_name)
        .join("clips");

    if force.unwrap_or(false) {
        let removed = remove_existing_clip_files(&clips_dir, &clip_id);
        if !removed.is_empty() {
            eprintln!(
                "[download_clip] force: removed old files for {}: {:?}",
                clip_id, removed
            );
        }
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            clip_id: clip_id.clone(),
            status: "downloading".into(),
            progress: Some(0.0),
            local_file: None,
            local_duration: None,
            error: None,
        },
    );

    // Fast path: download from HubSpot CDN if available (already uploaded by another user)
    if let Some(ref hs_url) = hubspot_url {
        if !hs_url.is_empty() {
            let _ = fs::create_dir_all(&clips_dir);
            let dest = clips_dir.join(format!("{}_hubspot.mp4", &clip_id));
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .map_err(|e| e.to_string())?;

            match client.get(hs_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                    if let Ok(()) = fs::write(&dest, &bytes) {
                        let rel_path = format!("clips/{}_hubspot.mp4", &clip_id);
                        let project_dir = PathBuf::from(&root_folder).join(&project_name);
                        let local_duration =
                            probe_duration(&project_dir.join(&rel_path).to_string_lossy());
                        let _ = app.emit(
                            "download-progress",
                            DownloadProgress {
                                clip_id,
                                status: "complete".into(),
                                progress: Some(100.0),
                                local_file: Some(rel_path),
                                local_duration,
                                error: None,
                            },
                        );
                        return Ok(());
                    }
                }
                _ => {
                    eprintln!("[download_clip] HubSpot CDN download failed for {}, falling back to providers", clip_id);
                }
            }
        }
    }

    // Provider cascade: try each configured provider in order
    let providers = providers_for_url(&url, &download_providers);
    let mut errors: Vec<String> = Vec::new();

    for provider in &providers {
        let result = match provider.as_str() {
            "evil0ctal" => {
                let base_url = evil0ctal_api_url.as_deref().unwrap_or("");
                if base_url.is_empty() {
                    eprintln!("[download_clip] evil0ctal provider skipped: no API URL configured");
                    errors.push(format!(
                        "{}: not configured (set API URL in Settings)",
                        provider
                    ));
                    continue;
                }
                run_evil0ctal_download(base_url, &url, &clips_dir, &clip_id).await
            }
            _ => {
                run_ytdlp_with_cookie_cascade(
                    &app,
                    &url,
                    &clips_dir,
                    &clip_id,
                    &cookies_browser,
                    &cookies_file,
                )
                .await
            }
        };

        match result {
            Ok(()) => {
                let local_file = find_downloaded_file(&clips_dir, &clip_id);
                let project_dir = PathBuf::from(&root_folder).join(&project_name);
                let local_duration = local_file.as_ref().and_then(|rel| {
                    let abs = project_dir.join(rel);
                    probe_duration(&abs.to_string_lossy())
                });
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        clip_id,
                        status: "complete".into(),
                        progress: Some(100.0),
                        local_file,
                        local_duration,
                        error: None,
                    },
                );
                return Ok(());
            }
            Err(e) => {
                eprintln!(
                    "[download_clip] provider '{}' failed for {}: {}",
                    provider, clip_id, e
                );
                errors.push(format!("{}: {}", provider, e));
            }
        }
    }

    let friendly = if errors.len() == 1 {
        errors.into_iter().next().unwrap()
    } else {
        errors.join(" | ")
    };
    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            clip_id,
            status: "failed".into(),
            progress: None,
            local_file: None,
            local_duration: None,
            error: Some(friendly.clone()),
        },
    );
    Err(friendly)
}

/// Run yt-dlp with the cookie retry cascade. Returns Ok(()) on success.
async fn run_ytdlp_with_cookie_cascade(
    app: &AppHandle,
    url: &str,
    clips_dir: &PathBuf,
    clip_id: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<(), String> {
    let output_template = clips_dir
        .join(format!("{}_%(title).50s.%(ext)s", clip_id))
        .to_string_lossy()
        .to_string();

    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file
        .as_ref()
        .map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());

    let result = run_ytdlp_download(
        app,
        url,
        &output_template,
        if has_browser { cookies_browser } else { &None },
        if has_browser { &None } else { cookies_file },
    )
    .await;

    let result = match &result {
        Ok((success, _)) if !success && has_browser && has_file => {
            run_ytdlp_download(app, url, &output_template, &None, cookies_file).await
        }
        _ => result,
    };

    let result = match &result {
        Ok((success, _)) if !success && (has_browser || has_file) => {
            run_ytdlp_download(app, url, &output_template, &None, &None).await
        }
        _ => result,
    };

    match result {
        Ok((true, _)) => Ok(()),
        Ok((false, stderr_bytes)) => {
            let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
            Err(friendly_download_error(&stderr, url, cookies_browser))
        }
        Err(msg) => Err(friendly_download_error(&msg, url, cookies_browser)),
    }
}

/// Download a video via the Evil0ctal Douyin/TikTok API.
/// Uses the `/api/download` endpoint which proxies the download through the
/// server, avoiding geo-blocking issues with Chinese CDNs (Douyin, Kuaishou).
async fn run_evil0ctal_download(
    api_base_url: &str,
    video_url: &str,
    clips_dir: &std::path::Path,
    clip_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let base = api_base_url.trim_end_matches('/');
    let platform = detect_platform(video_url);

    // Quick pre-check: the /api/download endpoint only handles video URLs,
    // not user profiles or other page types. Fail fast for obvious non-video URLs.
    let url_lower = video_url.to_lowercase();
    let is_likely_non_video = url_lower.contains("/user/")
        || url_lower.contains("/profile/")
        || url_lower.contains("/hashtag/")
        || url_lower.contains("/search");
    if is_likely_non_video {
        return Err(format!(
            "{} URL is a profile/page, not a video link",
            platform
        ));
    }

    let download_url = format!(
        "{}/api/download?url={}&prefix=false&with_watermark=false",
        base,
        urlencoding::encode(video_url)
    );

    eprintln!("[evil0ctal] downloading {} via {}", clip_id, download_url);

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("{} API unreachable: {e}", platform))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = if body.len() > 200 {
            &body[..200]
        } else {
            &body
        };
        return Err(format!(
            "{} API returned HTTP {} — {}",
            platform, status, detail
        ));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // The /api/download endpoint returns the video binary directly.
    // If it returns JSON instead, the request likely failed with an error payload.
    if content_type.contains("application/json") {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "{} API error: {}",
            platform,
            body.chars().take(200).collect::<String>()
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("{} video download incomplete: {e}", platform))?;

    if bytes.len() < 1024 {
        return Err(format!(
            "{} API returned a suspiciously small file ({} bytes)",
            platform,
            bytes.len()
        ));
    }

    let _ = fs::create_dir_all(clips_dir);
    let dest = clips_dir.join(format!("{}_evil0ctal.mp4", clip_id));

    fs::write(&dest, &bytes).map_err(|e| format!("Failed to save video: {e}"))?;

    eprintln!(
        "[evil0ctal] saved {} ({} bytes)",
        dest.display(),
        bytes.len()
    );
    Ok(())
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
        "-f".to_string(),
        fmt.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "-o".to_string(),
        output_template.to_string(),
        "--newline".to_string(),
        "--progress-template".to_string(),
        "%(progress._percent_str)s".to_string(),
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
    let json =
        serde_json::to_string_pretty(project).map_err(|e| format!("Failed to serialize: {e}"))?;
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

// ── General Search Commands ──────────────────────────────────────────────────

/// Parse a block of pasted URLs into structured entries with platform detection
#[tauri::command]
fn parse_clip_urls(raw: String) -> Vec<serde_json::Value> {
    parse_social_urls(&raw)
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "url": p.url,
                "platform": match p.platform {
                    SocialPlatform::Instagram => "instagram",
                    SocialPlatform::TikTok => "tiktok",
                },
                "handle": p.handle,
                "profileUrl": p.profile_url,
            })
        })
        .collect()
}

/// Unified Instagram info extraction: handle + caption + thumbnail from a single call cascade.
/// Strategy 1: oEmbed -> Strategy 2: embed page -> Strategy 3: yt-dlp --dump-json
#[tauri::command]
async fn resolve_instagram_info(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let shortcode = extract_instagram_shortcode(&url);

    // Strategy 1: oEmbed API
    let oembed_url = format!(
        "https://www.instagram.com/api/v1/oembed/?url={}",
        urlencoding::encode(&url)
    );
    if let Ok(res) = client
        .get(&oembed_url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
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
                // Extract username from the HTML embed field if author_name is gone
                let html = json.get("html").and_then(|v| v.as_str()).unwrap_or("");
                let handle = author_name.or_else(|| extract_instagram_username_from_html(html));
                // Caption may be in the title field
                let caption = json.get("title").and_then(|v| v.as_str()).map(String::from);

                if let Some(ref h) = handle {
                    return Ok(serde_json::json!({
                        "handle": h,
                        "profileUrl": format!("https://www.instagram.com/{}/", h),
                        "caption": caption,
                        "thumbnail": thumbnail,
                        "source": "oembed",
                    }));
                }
            }
        }
    }

    // Strategy 2: Embed page scraping
    if let Some(ref code) = shortcode {
        let embed_url = format!("https://www.instagram.com/reel/{}/embed/captioned/", code);
        if let Ok(res) = client
            .get(&embed_url)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(html) = res.text().await {
                    let handle = extract_instagram_username_from_html(&html);
                    let caption = extract_instagram_caption_from_html(&html);
                    let thumbnail = extract_meta_content_text(&html, "og:image")
                        .filter(|u| u.starts_with("http"));

                    if let Some(ref h) = handle {
                        return Ok(serde_json::json!({
                            "handle": h,
                            "profileUrl": format!("https://www.instagram.com/{}/", h),
                            "caption": caption,
                            "thumbnail": thumbnail,
                            "source": "embed",
                        }));
                    }
                }
            }
        }
    }

    // Strategy 3: yt-dlp --dump-json (most reliable, slowest)
    let _permit = INSTAGRAM_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let result = ytdlp_dump_json(&app, &url, &cookies_browser, &cookies_file).await;
    instagram_delay().await;

    if let Ok(json) = result {
        let handle = json
            .get("uploader_id")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("uploader").and_then(|v| v.as_str()))
            .map(String::from);
        let display_name = json
            .get("channel")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("uploader").and_then(|v| v.as_str()))
            .map(String::from);
        let caption = json
            .get("description")
            .and_then(|v| v.as_str())
            .map(String::from);
        let thumbnail = json
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(String::from);
        let likes = json.get("like_count").and_then(|v| v.as_i64());
        let comments = json.get("comment_count").and_then(|v| v.as_i64());
        let views = json.get("view_count").and_then(|v| v.as_i64());
        let timestamp = json.get("timestamp").and_then(|v| v.as_i64());

        if let Some(ref h) = handle {
            return Ok(serde_json::json!({
                "handle": h,
                "profileUrl": format!("https://www.instagram.com/{}/", h),
                "displayName": display_name,
                "caption": caption,
                "thumbnail": thumbnail,
                "source": "ytdlp",
                "likes": likes,
                "comments": comments,
                "views": views,
                "timestamp": timestamp,
            }));
        }
    }

    Err("Could not resolve Instagram author from any source".into())
}

/// Run yt-dlp --dump-json to get metadata without downloading
pub(crate) async fn ytdlp_dump_json(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<serde_json::Value, String> {
    let has_browser = cookies_browser.as_ref().map_or(false, |b| !b.is_empty());
    let has_file = cookies_file
        .as_ref()
        .map_or(false, |f| !f.is_empty() && PathBuf::from(f).exists());

    let result = ytdlp_dump_json_attempt(
        app,
        url,
        if has_browser { cookies_browser } else { &None },
        if has_browser { &None } else { cookies_file },
    )
    .await;

    // On cookie-related failures, retry without cookies
    if let Err(ref e) = result {
        let lower = e.to_lowercase();
        if (has_browser || has_file)
            && (lower.contains("could not copy") || lower.contains("cookie"))
        {
            // Try with file-only if we used browser and have a file fallback
            if has_browser && has_file {
                let file_result = ytdlp_dump_json_attempt(app, url, &None, cookies_file).await;
                if file_result.is_ok() {
                    return file_result;
                }
            }
            // Last resort: no cookies at all
            return ytdlp_dump_json_attempt(app, url, &None, &None).await;
        }
    }

    result
}

/// Single attempt of yt-dlp --dump-json with given cookie configuration
async fn ytdlp_dump_json_attempt(
    app: &AppHandle,
    url: &str,
    cookies_browser: &Option<String>,
    cookies_file: &Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args = vec!["--dump-json".to_string(), "--no-download".to_string()];

    if let Some(ref browser) = cookies_browser {
        if !browser.is_empty() {
            args.push("--cookies-from-browser".into());
            args.push(browser.clone());
        }
    } else if let Some(ref cf) = cookies_file {
        if !cf.is_empty() && PathBuf::from(cf).exists() {
            args.push("--cookies".into());
            args.push(cf.clone());
        }
    }

    args.push(url.to_string());

    let output = run_ytdlp(app, &args).await?;

    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse yt-dlp JSON: {e}"))
}

/// Fetch metrics for a clip via yt-dlp --dump-json (used for TikTok and IG when metrics weren't obtained during handle resolution)
#[tauri::command]
async fn fetch_clip_metrics(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
) -> Result<serde_json::Value, String> {
    let is_instagram = url.contains("instagram.com");

    if is_instagram {
        let _permit = INSTAGRAM_SEMAPHORE
            .acquire()
            .await
            .map_err(|e| e.to_string())?;
        let result = ytdlp_dump_json(&app, &url, &cookies_browser, &cookies_file).await;
        instagram_delay().await;
        let json = result?;

        let display_name = json
            .get("channel")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("uploader").and_then(|v| v.as_str()));

        return Ok(serde_json::json!({
            "displayName": display_name,
            "caption": json.get("description").and_then(|v| v.as_str()),
            "thumbnail": json.get("thumbnail").and_then(|v| v.as_str()),
            "likes": json.get("like_count").and_then(|v| v.as_i64()),
            "comments": json.get("comment_count").and_then(|v| v.as_i64()),
            "views": json.get("view_count").and_then(|v| v.as_i64()),
            "shares": json.get("repost_count").and_then(|v| v.as_i64()),
            "timestamp": json.get("timestamp").and_then(|v| v.as_i64()),
        }));
    }

    // TikTok or other
    let json = ytdlp_dump_json(&app, &url, &cookies_browser, &cookies_file).await?;

    let display_name = json
        .get("creator")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("uploader").and_then(|v| v.as_str()));

    Ok(serde_json::json!({
        "displayName": display_name,
        "caption": json.get("description").and_then(|v| v.as_str()),
        "thumbnail": json.get("thumbnail").and_then(|v| v.as_str()),
        "likes": json.get("like_count").and_then(|v| v.as_i64()),
        "comments": json.get("comment_count").and_then(|v| v.as_i64()),
        "views": json.get("view_count").and_then(|v| v.as_i64()),
        "shares": json.get("repost_count").and_then(|v| v.as_i64()),
        "timestamp": json.get("timestamp").and_then(|v| v.as_i64()),
    }))
}

/// Lookup creators in HubSpot by their instagram or tiktok property value
#[tauri::command]
async fn lookup_creators_by_social(
    token: String,
    platform: String,
    profile_urls: Vec<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        CREATORS_OBJECT_ID
    );

    let property_name = match platform.as_str() {
        "instagram" => "instagram",
        "tiktok" => "tiktok",
        _ => return Err(format!("Unsupported platform: {}", platform)),
    };

    let mut results = Vec::new();

    // Search one at a time to get precise matches
    for profile_url in &profile_urls {
        let body = serde_json::json!({
            "filterGroups": [{
                "filters": [{
                    "propertyName": property_name,
                    "operator": "EQ",
                    "value": profile_url
                }]
            }],
            "properties": ["name", "instagram", "tiktok", "main_link", "main_account", "status"],
            "limit": 1
        });

        let res = client
            .post(&search_url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Creator lookup failed: {e}"))?;

        if res.status().is_success() {
            let data: serde_json::Value = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse creator search: {e}"))?;

            if let Some(first) = data
                .get("results")
                .and_then(|r| r.as_array())
                .and_then(|arr| arr.first())
            {
                results.push(serde_json::json!({
                    "profileUrl": profile_url,
                    "found": true,
                    "creatorId": first.get("id").and_then(|v| v.as_str()),
                    "name": first.get("properties").and_then(|p| p.get("name")).and_then(|v| v.as_str()),
                    "status": first.get("properties").and_then(|p| p.get("status")).and_then(|v| v.as_str()),
                }));
            } else {
                results.push(serde_json::json!({
                    "profileUrl": profile_url,
                    "found": false,
                }));
            }
        } else {
            results.push(serde_json::json!({
                "profileUrl": profile_url,
                "found": false,
                "error": format!("Search failed ({})", res.status()),
            }));
        }

        // Small delay to respect rate limits
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    Ok(serde_json::json!({ "results": results }))
}

/// Create a new Creator in HubSpot
#[tauri::command]
async fn create_creator(
    token: String,
    name: String,
    platform: String,
    profile_url: String,
    owner_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}",
        CREATORS_OBJECT_ID
    );

    let platform_display = match platform.as_str() {
        "instagram" => "Instagram",
        "tiktok" => "TikTok",
        _ => return Err(format!("Unsupported platform: {}", platform)),
    };

    let mut properties = serde_json::json!({
        "name": name,
        "main_account": platform_display,
        "status": "To Contact",
    });

    properties[&platform] = serde_json::Value::String(profile_url);

    if let Some(ref oid) = owner_id {
        if !oid.is_empty() {
            properties["hubspot_owner_id"] = serde_json::Value::String(oid.clone());
        }
    }

    let body = serde_json::json!({ "properties": properties });

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create creator: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "HubSpot create creator error ({}): {}",
            status, text
        ));
    }

    let created: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    Ok(serde_json::json!({
        "id": created.get("id").and_then(|v| v.as_str()),
        "name": name,
    }))
}

/// Resolve a HubSpot user email to a numeric owner ID
#[tauri::command]
async fn resolve_owner_id(token: String, email: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("https://api.hubapi.com/crm/v3/owners")
        .bearer_auth(&token)
        .query(&[("email", &email), ("limit", &"1".to_string())])
        .send()
        .await
        .map_err(|e| format!("Owner lookup failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Owner lookup error ({}): {}", status, text));
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse owner response: {e}"))?;

    data.get("results")
        .and_then(|r| r.as_array())
        .and_then(|arr| arr.first())
        .and_then(|owner| owner.get("id"))
        .and_then(|id| id.as_str())
        .map(String::from)
        .ok_or_else(|| format!("No HubSpot owner found for email: {}", email))
}

/// List all HubSpot owners (id, email, firstName, lastName)
#[tauri::command]
async fn list_owners(token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("https://api.hubapi.com/crm/v3/owners")
        .bearer_auth(&token)
        .query(&[("limit", "100")])
        .send()
        .await
        .map_err(|e| format!("Owners list failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Owners list error ({}): {}", status, text));
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse owners: {e}"))?;

    let owners = data
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .map(|o| {
                    serde_json::json!({
                        "id": o.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "email": o.get("email").and_then(|v| v.as_str()).unwrap_or(""),
                        "firstName": o.get("firstName").and_then(|v| v.as_str()).unwrap_or(""),
                        "lastName": o.get("lastName").and_then(|v| v.as_str()).unwrap_or(""),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(serde_json::json!(owners))
}

/// Search for an existing External Clip by its link URL. Returns the clip ID if found.
#[tauri::command]
async fn find_clip_by_link(token: String, link: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let props: Vec<serde_json::Value> = CLIP_PROPERTIES
        .iter()
        .map(|p| serde_json::json!(p))
        .collect();

    let body = serde_json::json!({
        "filterGroups": [{
            "filters": [{
                "propertyName": "link",
                "operator": "EQ",
                "value": link
            }]
        }],
        "properties": props,
        "limit": 1
    });

    let res = client
        .post(&search_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Clip search failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot search error ({}): {}", status, text));
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse search response: {e}"))?;

    let result = data
        .get("results")
        .and_then(|r| r.as_array())
        .and_then(|arr| arr.first())
        .cloned();
    let id = result
        .as_ref()
        .and_then(|clip| clip.get("id"))
        .and_then(|id| id.as_str())
        .map(String::from);

    Ok(serde_json::json!({
        "found": id.is_some(),
        "id": id,
        "result": result,
    }))
}

/// Create a new External Clip in HubSpot (only link + owner, creator fields are synced via association)
#[tauri::command]
async fn create_external_clip(
    token: String,
    link: String,
    owner_id: String,
    found_in: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let body = serde_json::json!({
        "properties": {
            "link": link,
            "hubspot_owner_id": owner_id,
            "found_in": found_in,
        }
    });

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create external clip: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot create clip error ({}): {}", status, text));
    }

    let created: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    Ok(serde_json::json!({
        "id": created.get("id").and_then(|v| v.as_str()),
        "link": link,
    }))
}

/// Associate an External Clip to a Creator
#[tauri::command]
async fn associate_clip_to_creator(
    token: String,
    clip_id: String,
    creator_id: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    // Use default association (no custom label needed)
    let assoc_url = format!(
        "https://api.hubapi.com/crm/v4/objects/{}/{}/associations/default/{}/{}",
        EXTERNAL_CLIPS_OBJECT_ID, clip_id, CREATORS_OBJECT_ID, creator_id
    );

    let res = client
        .put(&assoc_url)
        .bearer_auth(&token)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Association request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to associate clip {} with creator {} ({}): {}",
            clip_id, creator_id, status, text
        ));
    }

    Ok(())
}

/// Search for External Clips that have no tags, sorted by creation date (most recent first)
#[tauri::command]
async fn search_untagged_clips(
    token: String,
    after: Option<String>,
    creator_status: Option<String>,
    owner_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let mut filters = vec![
        serde_json::json!({ "propertyName": "tags", "operator": "NOT_HAS_PROPERTY" }),
        serde_json::json!({ "propertyName": "link_not_working_anymore", "operator": "NEQ", "value": "true" }),
    ];

    if let Some(ref status) = creator_status {
        if !status.is_empty() {
            filters.push(serde_json::json!({
                "propertyName": "creator_status",
                "operator": "EQ",
                "value": status
            }));
        }
    }

    if let Some(ref oid) = owner_id {
        if !oid.is_empty() {
            filters.push(serde_json::json!({
                "propertyName": "hubspot_owner_id",
                "operator": "EQ",
                "value": oid
            }));
        }
    }

    let mut body = serde_json::json!({
        "filterGroups": [{
            "filters": filters
        }],
        "properties": [
            "link", "tags", "creator_name", "creator_status", "creator_main_link",
            "creator_id", "date_found", "createdate", "social_media_caption",
            "social_media_tags", "fetched_social_thumbnail", "original_clip", "score", "hubspot_owner_id",
            "likes", "plays", "comments", "shares"
        ],
        "sorts": [
            { "propertyName": "date_found", "direction": "DESCENDING" }
        ],
        "limit": 200
    });

    if let Some(cursor) = after {
        body["after"] = serde_json::Value::String(cursor);
    }

    let res = client
        .post(&search_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Untagged clips search failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot search error ({}): {}", status, text));
    }

    res.json()
        .await
        .map_err(|e| format!("Failed to parse search response: {e}"))
}

/// Search one page of External Clips with no creator linked.
/// Used by Data Integrity: frontend appends more pages as the user scrolls.
#[tauri::command]
async fn search_clips_missing_creator(
    token: String,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let filter_groups = serde_json::json!([{
        "filters": [
            { "propertyName": "creator_id", "operator": "NOT_HAS_PROPERTY" },
            { "propertyName": "link_not_working_anymore", "operator": "NEQ", "value": "true" },
        ]
    }]);

    let mut props: Vec<serde_json::Value> = CLIP_PROPERTIES
        .iter()
        .map(|p| serde_json::json!(p))
        .collect();
    props.push(serde_json::json!("hs_lastmodifieddate"));

    let mut body = serde_json::json!({
        "filterGroups": filter_groups,
        "properties": props,
        "sorts": [{ "propertyName": "num_of_published_video_project", "direction": "DESCENDING" }],
        "limit": 50
    });
    if let Some(ref a) = after {
        body.as_object_mut()
            .unwrap()
            .insert("after".into(), serde_json::json!(a));
    }

    send_missing_creator_search(&client, &search_url, &token, body, "search").await
}

/// Count External Clips with no creator linked without fetching all rows.
/// Used by Data Integrity alerts to avoid auto-paginating HubSpot search results.
#[tauri::command]
async fn count_clips_missing_creator(token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    async fn search_total(
        client: &reqwest::Client,
        search_url: &str,
        token: &str,
        filters: Vec<serde_json::Value>,
    ) -> Result<u64, String> {
        let body = serde_json::json!({
            "filterGroups": [{ "filters": filters }],
            "properties": ["hs_object_id"],
            "limit": 1
        });

        let page = send_missing_creator_search(client, search_url, token, body, "count").await?;

        Ok(page.get("total").and_then(|v| v.as_u64()).unwrap_or(0))
    }

    let base_filters = vec![
        serde_json::json!({ "propertyName": "creator_id", "operator": "NOT_HAS_PROPERTY" }),
        serde_json::json!({ "propertyName": "link_not_working_anymore", "operator": "NEQ", "value": "true" }),
    ];

    let total_missing = search_total(&client, &search_url, &token, base_filters.clone()).await?;
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;

    let mut published_filters = base_filters;
    published_filters.push(serde_json::json!({
        "propertyName": "num_of_published_video_project",
        "operator": "GT",
        "value": "0"
    }));
    let in_published = search_total(&client, &search_url, &token, published_filters).await?;
    let other = total_missing.saturating_sub(in_published);

    Ok(serde_json::json!({
        "inPublished": in_published,
        "other": other
    }))
}

async fn send_missing_creator_search(
    client: &reqwest::Client,
    search_url: &str,
    token: &str,
    body: serde_json::Value,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut delay_ms = 1_250;

    for attempt in 0..=3 {
        let res = client
            .post(search_url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Clips-missing-creator {context} failed: {e}"))?;

        if res.status().is_success() {
            return res
                .json()
                .await
                .map_err(|e| format!("Failed to parse {context} response: {e}"));
        }

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if status != reqwest::StatusCode::TOO_MANY_REQUESTS || attempt == 3 {
            return Err(format!("HubSpot {context} error ({}): {}", status, text));
        }

        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms *= 2;
    }

    Err(format!("HubSpot {context} error: retry budget exhausted"))
}

/// Search for External Clips that have a link but are missing social media metrics
#[tauri::command]
async fn search_clips_missing_metrics(
    token: String,
    after: Option<String>,
    creator_status: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let mut filters = vec![
        serde_json::json!({ "propertyName": "social_media_caption", "operator": "NOT_HAS_PROPERTY" }),
        serde_json::json!({ "propertyName": "link", "operator": "HAS_PROPERTY" }),
    ];

    if let Some(ref status) = creator_status {
        if !status.is_empty() {
            filters.push(serde_json::json!({
                "propertyName": "creator_status",
                "operator": "EQ",
                "value": status
            }));
        }
    }

    let mut body = serde_json::json!({
        "filterGroups": [{ "filters": filters }],
        "properties": [
            "link", "creator_status", "date_found",
            "social_media_caption", "likes", "plays",
            "fetched_social_thumbnail", "link_not_working_anymore", "original_clip"
        ],
        "sorts": [
            { "propertyName": "date_found", "direction": "DESCENDING" }
        ],
        "limit": 100
    });

    if let Some(cursor) = after {
        body["after"] = serde_json::Value::String(cursor);
    }

    let res = client
        .post(&search_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Missing-metrics search failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot search error ({}): {}", status, text));
    }

    res.json()
        .await
        .map_err(|e| format!("Failed to parse search response: {e}"))
}

const SK_CACHE_TTL_DAYS: i64 = 7;

/// HubSpot `sk_*` read for Tier-0 resolution (7-day TTL on `sk_last_enriched`).
pub(crate) struct SkCacheRead {
    pub handle: String,
    pub profile_url: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub last_enriched: chrono::DateTime<Utc>,
    pub platform: String,
}

fn infer_platform_key_from_social_url(url: &str) -> String {
    let u = url.to_lowercase();
    if u.contains("instagram.com") {
        "instagram".into()
    } else if u.contains("tiktok.com") {
        "tiktok".into()
    } else if u.contains("youtu.be") || u.contains("youtube.com") {
        "youtube".into()
    } else if u.contains("pinterest.") {
        "pinterest".into()
    } else if u.contains("bilibili.com") {
        "bilibili".into()
    } else if u.contains("xiaohongshu.com") {
        "xiaohongshu".into()
    } else {
        "other".into()
    }
}

fn parse_hs_datetime_prop(s: &str) -> Option<chrono::DateTime<Utc>> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<i64>() {
        if t.chars().count() >= 13 {
            return chrono::DateTime::from_timestamp_millis(n);
        }
        return chrono::DateTime::from_timestamp(n, 0);
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some(d.with_timezone(&Utc));
    }
    None
}

/// GET `sk_*` for Tier 0. Returns [None] if stale, incomplete, or missing fields.
pub(crate) async fn read_sk_creator_cache(
    token: &str,
    clip_id: &str,
) -> Result<Option<SkCacheRead>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let props: [&str; 5] = [
        "sk_creator_handle",
        "sk_creator_profile_url",
        "sk_creator_display_name",
        "sk_creator_avatar",
        "sk_last_enriched",
    ];
    let q = props
        .iter()
        .map(|p| format!("properties={}", urlencoding::encode(p)))
        .collect::<Vec<_>>()
        .join("&");
    let u = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/{}?{}",
        EXTERNAL_CLIPS_OBJECT_ID, clip_id, q
    );
    let res = client
        .get(&u)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Fetch clip failed: {e}"))?;
    if res.status() == 404 {
        return Ok(None);
    }
    if !res.status().is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(format!("Fetch clip: {t}"));
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Parse fetch clip: {e}"))?;
    let p = body
        .get("properties")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let handle = p
        .get("sk_creator_handle")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let profile_url = p
        .get("sk_creator_profile_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.starts_with("http"));
    let le_raw = p.get("sk_last_enriched").and_then(|v| v.as_str());
    let le = le_raw.and_then(parse_hs_datetime_prop);
    if handle.is_none() || profile_url.is_none() {
        return Ok(None);
    }
    if le.is_none() {
        // Property missing or not parseable → treat as no cache, live resolve
        return Ok(None);
    }
    let le = le.unwrap();
    if Utc::now() - le > chrono::Duration::days(SK_CACHE_TTL_DAYS) {
        return Ok(None);
    }
    let platform = infer_platform_key_from_social_url(profile_url.as_ref().unwrap());
    let display_name = p
        .get("sk_creator_display_name")
        .and_then(|v| v.as_str())
        .map(String::from);
    let avatar = p
        .get("sk_creator_avatar")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok(Some(SkCacheRead {
        handle: handle.unwrap().to_string(),
        profile_url: profile_url.unwrap().to_string(),
        display_name,
        avatar,
        last_enriched: le,
        platform,
    }))
}

/// Live-resolve writeback for `sk_creator_*` + `sk_status` + `sk_last_enriched` (n8n-compatible).
pub(crate) async fn write_clip_sk_creator_cache(
    token: &str,
    clip_id: &str,
    profile: &EnrichedProfile,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut props = serde_json::Map::new();
    props.insert(
        "sk_creator_handle".to_string(),
        serde_json::json!(profile.handle),
    );
    props.insert(
        "sk_creator_profile_url".to_string(),
        serde_json::json!(profile.profile_url),
    );
    if let Some(ref d) = profile.display_name {
        if !d.is_empty() {
            props.insert("sk_creator_display_name".to_string(), serde_json::json!(d));
        }
    }
    if let Some(ref a) = profile.avatar {
        if !a.is_empty() {
            props.insert("sk_creator_avatar".to_string(), serde_json::json!(a));
        }
    }
    props.insert("sk_status".to_string(), serde_json::json!("ok"));
    props.insert("sk_last_enriched".to_string(), serde_json::json!(now));
    update_clip_properties(
        token.to_string(),
        clip_id.to_string(),
        serde_json::Value::Object(props),
    )
    .await
}

// ── Creator suggest (integrity check) — resolve + match + create ─────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorMatch {
    pub creator_id: String,
    pub name: String,
    pub main_link: Option<String>,
    pub instagram: Option<String>,
    pub tiktok: Option<String>,
    pub confidence: String,
    pub reason: String,
    pub other_platform_url: Option<String>,
}

const CREATOR_LOOKUP_PROPS: &[&str] = &["name", "main_link", "instagram", "tiktok", "status"];

const CREATOR_SEARCH_GAP: Duration = Duration::from_millis(100);
const FUZZY_NAME_THRESHOLD: f64 = 0.85;
const SUGGEST_MAX_MATCHES: usize = 3;

fn match_rank(conf: &str) -> u8 {
    match conf {
        "high" => 0,
        "highish" => 1,
        "medium" => 2,
        _ => 3,
    }
}

fn instagram_handle_urls(handle: &str) -> [String; 2] {
    [
        format!("https://www.instagram.com/{}/", handle),
        format!("https://www.instagram.com/{}", handle),
    ]
}

fn tiktok_handle_urls(handle: &str) -> [String; 2] {
    [
        format!("https://www.tiktok.com/@{}", handle),
        format!("https://tiktok.com/@{}", handle),
    ]
}

async fn hubspot_search_one_creator(
    client: &reqwest::Client,
    token: &str,
    prop: &str,
    op: &str,
    value: &str,
) -> Result<Option<serde_json::Value>, String> {
    let body = serde_json::json!({
        "filterGroups": [{ "filters": [{ "propertyName": prop, "operator": op, "value": value }] }],
        "properties": CREATOR_LOOKUP_PROPS,
        "limit": 3
    });
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        CREATORS_OBJECT_ID
    );
    let res = client
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Creator search: {e}"))?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = res.json().await.map_err(|e| format!("Search parse: {e}"))?;
    Ok(v.get("results")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
        .cloned())
}

/// Build a [`CreatorMatch`] from one HubSpot search row plus a confidence/reason.
fn creator_match_from_row(
    row: &serde_json::Value,
    conf: &str,
    reason: impl Into<String>,
    other_platform_url: Option<String>,
) -> Option<CreatorMatch> {
    let id = row.get("id").and_then(|i| i.as_str())?.to_string();
    if id.is_empty() {
        return None;
    }
    let p = row.get("properties");
    let pick = |k: &str| {
        p.and_then(|x| x.get(k))
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    Some(CreatorMatch {
        creator_id: id,
        name: pick("name").unwrap_or_default(),
        main_link: pick("main_link"),
        instagram: pick("instagram"),
        tiktok: pick("tiktok"),
        confidence: conf.to_string(),
        reason: reason.into(),
        other_platform_url,
    })
}

/// Insert/upgrade `m` into `by_id`, keeping the strongest confidence per creator.
fn upsert_match(by_id: &mut HashMap<String, CreatorMatch>, m: CreatorMatch) {
    match by_id.get(&m.creator_id) {
        Some(existing) if match_rank(&m.confidence) >= match_rank(&existing.confidence) => {}
        _ => {
            by_id.insert(m.creator_id.clone(), m);
        }
    }
}

/// Run a single EQ search against `prop`, then upsert the resulting match.
/// Skips searches we've already done (same `(prop, value)`) to keep the call count low.
#[allow(clippy::too_many_arguments)]
async fn search_and_record_eq(
    client: &reqwest::Client,
    token: &str,
    seen: &mut HashSet<(String, String)>,
    by_id: &mut HashMap<String, CreatorMatch>,
    prop: &str,
    value: &str,
    conf: &str,
    reason: &str,
    other_platform_url: Option<String>,
) {
    if !seen.insert((prop.to_string(), value.to_string())) {
        return;
    }
    if let Ok(Some(row)) = hubspot_search_one_creator(client, token, prop, "EQ", value).await {
        if let Some(m) = creator_match_from_row(&row, conf, reason, other_platform_url) {
            upsert_match(by_id, m);
        }
    }
    tokio::time::sleep(CREATOR_SEARCH_GAP).await;
}

/// Same-platform candidate URLs to probe (profile URL plus canonical handle forms).
fn same_platform_search_urls(
    platform: &str,
    profile_url: &str,
    handle: &str,
) -> Option<(&'static str, Vec<String>)> {
    match platform {
        "instagram" => {
            let mut v: Vec<String> = std::iter::once(profile_url.to_string())
                .chain(instagram_handle_urls(handle))
                .collect();
            v.sort();
            v.dedup();
            Some(("instagram", v))
        }
        "tiktok" => {
            let mut v: Vec<String> = std::iter::once(profile_url.to_string())
                .chain(tiktok_handle_urls(handle))
                .collect();
            v.sort();
            v.dedup();
            Some(("tiktok", v))
        }
        _ => None,
    }
}

/// Cross-platform "same handle on the other network" probe set.
fn cross_platform_search_urls(platform: &str, handle: &str) -> Option<(&'static str, Vec<String>)> {
    match platform {
        "instagram" => Some(("tiktok", tiktok_handle_urls(handle).to_vec())),
        "tiktok" => Some(("instagram", instagram_handle_urls(handle).to_vec())),
        _ => None,
    }
}

/// Rank HubSpot creators for an enriched post author (never auto-apply; UI only).
#[tauri::command]
async fn match_creators_for_handle(
    token: String,
    profile_url: String,
    handle: String,
    display_name: Option<String>,
    platform: String,
) -> Result<Vec<CreatorMatch>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let plat = platform.to_lowercase();
    let mut by_id: HashMap<String, CreatorMatch> = HashMap::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    // 1+2) Same-platform: profile URL + canonical handle URLs.
    if let Some((field, urls)) = same_platform_search_urls(&plat, &profile_url, &handle) {
        let reason = format!(
            "Exact match on this creator's {} field",
            if field == "instagram" {
                "Instagram"
            } else {
                "TikTok"
            }
        );
        for u in &urls {
            search_and_record_eq(
                &client, &token, &mut seen, &mut by_id, field, u, "high", &reason, None,
            )
            .await;
        }
    }

    // 3) Cross-platform: same handle on the other network — verify-required.
    if let Some((field, urls)) = cross_platform_search_urls(&plat, &handle) {
        let reason = format!(
            "Same handle is registered on this creator's {} — verify same person",
            if field == "instagram" {
                "Instagram"
            } else {
                "TikTok"
            }
        );
        for u in &urls {
            search_and_record_eq(
                &client,
                &token,
                &mut seen,
                &mut by_id,
                field,
                u,
                "medium",
                &reason,
                Some(field.to_string()),
            )
            .await;
        }
    }

    // 3') Non-IG/TT platforms: search the generic `main_link` field.
    if same_platform_search_urls(&plat, &profile_url, &handle).is_none() {
        if let Ok(Some(row)) =
            hubspot_search_one_creator(&client, &token, "main_link", "CONTAINS_TOKEN", &handle)
                .await
        {
            if let Some(m) = creator_match_from_row(
                &row,
                "high",
                "main_link search matched this post author handle",
                None,
            ) {
                upsert_match(&mut by_id, m);
            }
        }
        tokio::time::sleep(CREATOR_SEARCH_GAP).await;
    }

    // 4) Display-name fuzzy fallback (low confidence; capped to keep results focused).
    if let Some(dn) = display_name.as_deref().filter(|s| s.len() >= 2) {
        let token_q = dn.split_whitespace().next().unwrap_or(dn).to_string();
        if let Ok(list) = search_creators(token.clone(), token_q).await {
            if let Some(results) = list.get("results").and_then(|r| r.as_array()) {
                for row in results {
                    let name = row
                        .get("properties")
                        .and_then(|x| x.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let score = jaro_winkler(&dn.to_lowercase(), &name.to_lowercase());
                    if score < FUZZY_NAME_THRESHOLD {
                        continue;
                    }
                    let reason = format!(
                        "Display name is similar to HubSpot (score {:.0}%)",
                        score * 100.0
                    );
                    if let Some(m) = creator_match_from_row(row, "low", reason, None) {
                        if by_id.contains_key(&m.creator_id) || by_id.len() < SUGGEST_MAX_MATCHES {
                            upsert_match(&mut by_id, m);
                        }
                    }
                }
            }
        }
    }

    let mut out: Vec<CreatorMatch> = by_id.into_values().collect();
    out.sort_by_key(|m| match_rank(&m.confidence));
    out.truncate(SUGGEST_MAX_MATCHES);
    Ok(out)
}

/// Inspect HubSpot for an exact creator match on a given field; map first hit into an error.
async fn duplicate_check_eq(
    client: &reqwest::Client,
    token: &str,
    seen: &mut HashSet<(String, String)>,
    prop: &str,
    op: &str,
    value: &str,
    msg_template: &str,
) -> Result<(), String> {
    if !seen.insert((prop.to_string(), value.to_string())) {
        return Ok(());
    }
    let hit = hubspot_search_one_creator(client, token, prop, op, value)
        .await
        .ok()
        .flatten();
    tokio::time::sleep(CREATOR_SEARCH_GAP).await;
    if let Some(c) = hit {
        let id = c.get("id").and_then(|i| i.as_str()).unwrap_or("?");
        return Err(msg_template.replace("{id}", id));
    }
    Ok(())
}

const DUP_MSG_HANDLE: &str =
    "A creator with this handle already exists in HubSpot (id {id}). Open them and apply the clip to that record.";
const DUP_MSG_MAIN_LINK: &str =
    "Possible duplicate (main link): id {id}. Verify and apply the existing record.";

/// HubSpot label for `main_account` (display value) given our internal platform key.
fn hubspot_main_account_label(platform_key: &str) -> &'static str {
    match platform_key {
        "instagram" => "Instagram",
        "tiktok" => "TikTok",
        "youtube" => "YouTube",
        "pinterest" => "Pinterest",
        "bilibili" => "Bilibili",
        "xiaohongshu" => "Xiaohongshu",
        "douyin" => "Douyin",
        "kuaishou" => "Kuaishou",
        _ => "Other",
    }
}

/// POST a new creator with the supplied properties; returns `{ id, name }`.
async fn hubspot_create_creator_record(
    token: &str,
    properties: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}",
        CREATORS_OBJECT_ID
    );
    let res = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "properties": properties }))
        .send()
        .await
        .map_err(|e| format!("Failed to create creator: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "HubSpot create creator error ({}): {}",
            status, text
        ));
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;
    let id = body.get("id").and_then(|i| i.as_str()).unwrap_or("");
    let name = properties
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(serde_json::json!({ "id": id, "name": name }))
}

/// Pre-flight for duplicates, then create. Non-IG/TT uses `main_link`.
#[tauri::command]
async fn create_creator_from_enrichment(
    token: String,
    profile: EnrichedProfile,
) -> Result<serde_json::Value, String> {
    let handle = profile.handle.trim();
    if handle.is_empty() {
        return Err("Missing handle".to_string());
    }

    let client = reqwest::Client::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    // Pre-flight A: exact URL collisions on instagram, tiktok, then main_link variants.
    let insta = instagram_handle_urls(handle);
    let ttv = tiktok_handle_urls(handle);
    for u in &insta {
        duplicate_check_eq(
            &client,
            &token,
            &mut seen,
            "instagram",
            "EQ",
            u,
            DUP_MSG_HANDLE,
        )
        .await?;
    }
    for u in &ttv {
        duplicate_check_eq(
            &client,
            &token,
            &mut seen,
            "tiktok",
            "EQ",
            u,
            DUP_MSG_HANDLE,
        )
        .await?;
    }
    let main_link_probes = [
        profile.profile_url.as_str(),
        insta[0].as_str(),
        ttv[0].as_str(),
    ];
    for u in main_link_probes {
        duplicate_check_eq(
            &client,
            &token,
            &mut seen,
            "main_link",
            "CONTAINS_TOKEN",
            u,
            DUP_MSG_MAIN_LINK,
        )
        .await?;
    }

    // Pre-flight B: fuzzy display-name match.
    if let Some(d) = profile.display_name.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(v) = search_creators(token.clone(), d.to_string()).await {
            if let Some(arr) = v.get("results").and_then(|r| r.as_array()) {
                for c in arr {
                    let name = c
                        .get("properties")
                        .and_then(|p| p.get("name"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("");
                    if jaro_winkler(&name.to_lowercase(), &d.to_lowercase()) >= FUZZY_NAME_THRESHOLD
                    {
                        return Err(
                            "Possible duplicate already in HubSpot — a creator with a very similar name was found. Apply the existing one instead, or check HubSpot first."
                                .to_string(),
                        );
                    }
                }
            }
        }
    }

    let name = profile
        .display_name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| handle.to_string());
    let plat = profile.platform.to_lowercase();
    let main_account = hubspot_main_account_label(&plat);

    let mut props = serde_json::json!({
        "name": name,
        "main_account": main_account,
        "status": "To Contact",
        "main_link": profile.profile_url,
    });
    // For IG/TT also write the dedicated platform field — that's how `create_creator` does it.
    if plat == "instagram" || plat == "tiktok" {
        props[plat.as_str()] = serde_json::Value::String(profile.profile_url.clone());
    }

    hubspot_create_creator_record(&token, props).await
}

/// Resolve a clip URL to an author profile. Tier-0: HubSpot `sk_*` when fresh. Live: cascade.
#[tauri::command]
async fn resolve_creator_from_clip_url(
    app: tauri::AppHandle,
    token: String,
    clip_id: String,
    clip_url: String,
    socialkit_api_key: Option<String>,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
    force_live: Option<bool>,
) -> Result<EnrichedProfile, String> {
    resolver::resolve_creator_from_url(
        &app,
        &token,
        &clip_id,
        &clip_url,
        socialkit_api_key.as_deref(),
        &cookies_browser,
        &cookies_file,
        force_live.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Update multiple properties on an External Clip in one call
#[tauri::command]
async fn update_clip_properties(
    token: String,
    clip_id: String,
    properties: serde_json::Value,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({ "properties": properties });

    let res = client
        .patch(&format!(
            "https://api.hubapi.com/crm/v3/objects/{}/{}",
            EXTERNAL_CLIPS_OBJECT_ID, clip_id
        ))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Update clip properties failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot update error ({}): {}", status, text));
    }

    Ok(())
}

/// Update properties on a Creator record
#[tauri::command]
async fn update_creator_properties(
    token: String,
    creator_id: String,
    properties: serde_json::Value,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({ "properties": properties });

    let res = client
        .patch(&format!(
            "https://api.hubapi.com/crm/v3/objects/{}/{}",
            CREATORS_OBJECT_ID, creator_id
        ))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Update creator properties failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "HubSpot update creator error ({}): {}",
            status, text
        ));
    }

    Ok(())
}

/// Fetch latest clips filtered by found_in and link pattern (instagram/tiktok)
#[tauri::command]
async fn search_latest_clips_by_platform(
    token: String,
    found_in: String,
    link_contains: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let search_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/search",
        EXTERNAL_CLIPS_OBJECT_ID
    );

    let body = serde_json::json!({
        "filterGroups": [{
            "filters": [
                { "propertyName": "found_in", "operator": "EQ", "value": found_in },
                { "propertyName": "link", "operator": "CONTAINS_TOKEN", "value": link_contains },
                { "propertyName": "link_not_working_anymore", "operator": "NEQ", "value": "true" },
            ]
        }],
        "properties": [
            "link", "creator_name", "date_found", "createdate", "fetched_social_thumbnail",
            "social_media_caption", "likes", "plays", "comments", "shares", "found_in"
        ],
        "sorts": [{ "propertyName": "createdate", "direction": "DESCENDING" }],
        "limit": 1
    });

    let res = client
        .post(&search_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Latest clips search failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HubSpot search error ({}): {}", status, text));
    }

    res.json()
        .await
        .map_err(|e| format!("Failed to parse search response: {e}"))
}

/// Save arbitrary text content to a file via native save dialog
#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("CSV", &["csv"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            std::fs::write(path.as_path().unwrap(), content)
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(true)
        }
        None => Ok(false), // user cancelled
    }
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
            let clean = if decoded_ref.starts_with('/')
                && decoded_ref.len() > 2
                && decoded_ref.as_bytes()[2] == b':'
            {
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
                        .unwrap();
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
                    parts[1]
                        .parse::<u64>()
                        .unwrap_or(file_size - 1)
                        .min(file_size - 1)
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
                .header(
                    "Access-Control-Expose-Headers",
                    "Content-Range, Content-Length, Accept-Ranges",
                );

            if is_range {
                response = response.status(206).header(
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
            create_tag_option,
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
            extract_video_thumbnail,
            upload_clip_thumbnail,
            upload_clip_thumbnail_base64,
            read_file_base64,
            update_clip_property,
            update_video_project_property,
            upload_clip_video,
            ensure_clip_video_uploaded,
            fetch_creators_batch,
            create_project,
            load_project,
            save_project_data,
            list_projects,
            download_clip,
            parse_clip_urls,
            resolve_instagram_info,
            fetch_clip_metrics,
            lookup_creators_by_social,
            create_creator,
            resolve_owner_id,
            list_owners,
            find_clip_by_link,
            create_external_clip,
            resolve_creator_from_clip_url,
            match_creators_for_handle,
            create_creator_from_enrichment,
            associate_clip_to_creator,
            search_untagged_clips,
            search_clips_missing_creator,
            count_clips_missing_creator,
            search_clips_missing_metrics,
            update_clip_properties,
            update_creator_properties,
            search_latest_clips_by_platform,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {

    /// Build the CSV content string inline (mirrors generate_clips_csv logic)
    /// so we can test it without a Tauri app handle.
    fn build_csv(clips: &[serde_json::Value]) -> String {
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

        let mut out = String::from(
            "Order,Duration,Editing Notes,Link,Main Link,Main Account,Name,Douyin ID,Kuaishou ID,Xiaohongshu ID,Clip Mix Links,Special Requests,Notes,License Checked,License Type,Available Ask First,Score,External Clip ID,Creator ID,Video Project ID\n"
        );

        for (i, clip) in clips.iter().enumerate() {
            let order = clip
                .get("order")
                .and_then(|v| v.as_u64())
                .unwrap_or((i + 1) as u64);
            let is_missing = clip
                .get("missing")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let download_status = get(clip, "downloadStatus");

            if is_missing {
                let warning = format!(
                    "\u{26A0} MISSING \u{2014} {}",
                    if download_status.is_empty() {
                        "not downloaded".to_string()
                    } else {
                        download_status
                    }
                );
                let row = [
                    format!("{}", order),
                    String::new(),
                    escape(&warning),
                    escape(&get(clip, "link")),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    escape(&get(clip, "externalClipId")),
                    escape(&get(clip, "creatorId")),
                    escape(&get(clip, "videoProjectId")),
                ];
                out.push_str(&row.join(","));
            } else {
                let duration = clip
                    .get("duration")
                    .and_then(|v| v.as_f64())
                    .map(|d| format!("{:.0}", d))
                    .unwrap_or_default();
                let row = [
                    format!("{}", order),
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
                out.push_str(&row.join(","));
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn csv_all_complete_has_correct_row_count() {
        let clips = vec![
            serde_json::json!({ "order": 1, "link": "https://tiktok.com/a", "duration": 30.0 }),
            serde_json::json!({ "order": 2, "link": "https://tiktok.com/b", "duration": 25.0 }),
            serde_json::json!({ "order": 3, "link": "https://tiktok.com/c", "duration": 20.0 }),
        ];
        let csv = build_csv(&clips);
        let data_rows: Vec<_> = csv.lines().skip(1).collect();
        assert_eq!(data_rows.len(), 3);
        assert!(data_rows[0].starts_with("1,"));
        assert!(data_rows[1].starts_with("2,"));
        assert!(data_rows[2].starts_with("3,"));
    }

    #[test]
    fn csv_missing_clip_preserves_row_count_and_order() {
        let clips = vec![
            serde_json::json!({ "order": 1, "link": "https://tiktok.com/a", "duration": 30.0 }),
            serde_json::json!({ "order": 2, "link": "https://instagram.com/b", "missing": true, "downloadStatus": "failed" }),
            serde_json::json!({ "order": 3, "link": "https://tiktok.com/c", "duration": 20.0 }),
        ];
        let csv = build_csv(&clips);
        let data_rows: Vec<_> = csv.lines().skip(1).collect();

        // Always 3 rows — clip 2 is missing but still present
        assert_eq!(data_rows.len(), 3);

        // Row 1 is normal
        assert!(data_rows[0].starts_with("1,"));
        // Row 2 has order 2, empty duration, and warning in Editing Notes
        assert!(data_rows[1].starts_with("2,,"));
        assert!(data_rows[1].contains("MISSING"));
        assert!(data_rows[1].contains("failed"));
        // Row 3 still has order 3 (not shifted to 2)
        assert!(data_rows[2].starts_with("3,"));
    }

    #[test]
    fn csv_missing_clip_preserves_link_for_identification() {
        let clips = vec![serde_json::json!({
            "order": 1,
            "link": "https://instagram.com/p/ABC/",
            "missing": true,
            "downloadStatus": "pending",
            "externalClipId": "clip_42"
        })];
        let csv = build_csv(&clips);
        let row = csv.lines().nth(1).unwrap();
        assert!(
            row.contains("https://instagram.com/p/ABC/"),
            "link must be present for missing clips"
        );
        assert!(
            row.contains("clip_42"),
            "clip ID must be present for missing clips"
        );
    }

    #[test]
    fn csv_all_missing_row_count_matches_total() {
        let clips = (1..=5)
            .map(|i| {
                serde_json::json!({
                    "order": i,
                    "link": format!("https://tiktok.com/{}", i),
                    "missing": true,
                    "downloadStatus": "failed"
                })
            })
            .collect::<Vec<_>>();
        let csv = build_csv(&clips);
        let data_rows: Vec<_> = csv.lines().skip(1).collect();
        assert_eq!(
            data_rows.len(),
            5,
            "must have one row per clip even if all are missing"
        );
    }
}
