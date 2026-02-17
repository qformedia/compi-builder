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
    pub score: Option<String>,
    #[serde(rename = "editedDuration")]
    pub edited_duration: Option<f64>,
    #[serde(rename = "localDuration")]
    pub local_duration: Option<f64>,
    #[serde(rename = "localFile")]
    pub local_file: Option<String>,
    #[serde(rename = "downloadStatus")]
    pub download_status: String,
    pub order: usize,
    #[serde(rename = "licenseType", default)]
    pub license_type: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
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

/// Build HubSpot filterGroups for External Clips search.
/// `tag_mode` = "AND" → one group with all tag filters; "OR" → one group per tag.
fn build_filter_groups(tags: &[String], scores: &[String], never_used: bool, tag_mode: &str) -> Vec<serde_json::Value> {
    // Shared filters (always applied)
    let mut shared: Vec<serde_json::Value> = Vec::new();

    if !scores.is_empty() {
        shared.push(serde_json::json!({
            "propertyName": "score",
            "operator": "IN",
            "values": scores
        }));
    }

    if never_used {
        shared.push(serde_json::json!({
            "propertyName": "num_of_published_video_project",
            "operator": "EQ",
            "value": "0"
        }));
    }

    shared.push(serde_json::json!({
        "propertyName": "creator_status",
        "operator": "EQ",
        "value": "Granted"
    }));

    if tags.is_empty() {
        return vec![serde_json::json!({ "filters": shared })];
    }

    if tag_mode == "OR" {
        // One filter group per tag, each combined with shared filters
        tags.iter()
            .map(|tag| {
                let mut group = shared.clone();
                group.push(serde_json::json!({
                    "propertyName": "tags",
                    "operator": "CONTAINS_TOKEN",
                    "value": tag
                }));
                serde_json::json!({ "filters": group })
            })
            .collect()
    } else {
        // AND: all tags in one filter group
        let mut group = shared;
        for tag in tags {
            group.push(serde_json::json!({
                "propertyName": "tags",
                "operator": "CONTAINS_TOKEN",
                "value": tag
            }));
        }
        vec![serde_json::json!({ "filters": group })]
    }
}

#[tauri::command]
async fn search_clips(
    token: String,
    tags: Vec<String>,
    scores: Vec<String>,
    never_used: bool,
    tag_mode: String,
    after: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let filter_groups = build_filter_groups(&tags, &scores, never_used, &tag_mode);

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
    creator_name: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut filter_groups = build_filter_groups(&tags, &scores, never_used, &tag_mode);

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
    let client = reqwest::Client::new();

    // Step 1: Get associated External Clip IDs
    let assoc_url = format!(
        "https://api.hubapi.com/crm/v3/objects/{}/{}/associations/{}",
        VIDEO_PROJECTS_OBJECT_ID, project_id, EXTERNAL_CLIPS_OBJECT_ID
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

    let clip_ids: Vec<String> = body
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

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
            "to": { "id": project_id }
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

/// Find a file in a directory whose name contains the given ID prefix
fn find_file_by_id(dir: &PathBuf, id_prefix: &str) -> Option<PathBuf> {
    if id_prefix.is_empty() { return None; }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Strip our prefixes to find the underlying ID
        let clean = strip_prefix(&name);
        if clean.starts_with(id_prefix) {
            return Some(entry.path());
        }
    }
    None
}

/// Generate a CSV file with clip order, creator, link, etc.
/// Returns the absolute path to the CSV file.
#[tauri::command]
async fn generate_clips_csv(
    root_folder: String,
    project_name: String,
    clips: Vec<serde_json::Value>,
) -> Result<String, String> {
    let project_dir = PathBuf::from(&root_folder).join(&project_name);
    let csv_path = project_dir.join("clips.csv");

    let mut csv_content = String::from("Order,Creator,Link,HubSpot Clip ID,Score,Duration\n");
    for (i, clip) in clips.iter().enumerate() {
        let creator = clip.get("creatorName").and_then(|v| v.as_str()).unwrap_or("");
        let link = clip.get("link").and_then(|v| v.as_str()).unwrap_or("");
        let clip_id = clip.get("hubspotId").and_then(|v| v.as_str()).unwrap_or("");
        let score = clip.get("score").and_then(|v| v.as_str()).unwrap_or("");
        let duration = clip.get("editedDuration")
            .and_then(|v| v.as_f64())
            .map(|d| format!("{:.0}", d))
            .unwrap_or_default();

        // Escape CSV fields that may contain commas or quotes
        let escape = |s: &str| {
            if s.contains(',') || s.contains('"') || s.contains('\n') {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.to_string()
            }
        };

        csv_content.push_str(&format!(
            "{},{},{},{},{},{}\n",
            i + 1,
            escape(creator),
            escape(link),
            clip_id,
            score,
            duration,
        ));
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

/// Strip existing prefixes: "3 - ", "unused_", or both
fn strip_prefix(name: &str) -> String {
    let mut s = name.to_string();
    // Strip "unused_"
    if let Some(rest) = s.strip_prefix("unused_") {
        s = rest.to_string();
    }
    // Strip "N - " (digit(s) + " - ")
    if let Some(pos) = s.find(" - ") {
        let prefix = &s[..pos];
        if prefix.chars().all(|c| c.is_ascii_digit()) {
            s = s[pos + 3..].to_string();
        }
    }
    s
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
) -> Result<(), String> {
    let clips_dir = PathBuf::from(&root_folder)
        .join(&project_name)
        .join("clips");

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
            // Resolve to absolute for ffprobe, but emit relative path
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
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
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
                local_duration: None,
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

/// Get duration of a local video file using ffprobe (seconds).
fn probe_duration(path: &str) -> Option<f64> {
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    json.get("format")?
        .get("duration")?
        .as_str()?
        .parse::<f64>()
        .ok()
}

/// Find a downloaded file by clip ID prefix. Returns a **relative** path like "clips/ID_title.mp4".
fn find_downloaded_file(clips_dir: &PathBuf, clip_id: &str) -> Option<String> {
    if let Ok(entries) = fs::read_dir(clips_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{clip_id}_")) {
                // Return relative path: "clips/<filename>"
                return Some(format!("clips/{}", name));
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
            fetch_tag_options,
            search_clips,
            search_creator_clips,
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
            create_project,
            load_project,
            save_project_data,
            list_projects,
            download_clip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
