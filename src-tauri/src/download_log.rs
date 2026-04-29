//! In-memory download diagnostics log.
//!
//! Used by the Downloads Log UI to surface a live, technical stream of
//! everything the download pipeline is doing: provider attempts, cookie
//! cascade tries, yt-dlp invocations, self-repair, timeouts, full stderr
//! payloads, etc. Nothing here is required for downloads to work — this is
//! purely for debugging and support.
//!
//! Design choices:
//! - Capped ring buffer (`MAX_ENTRIES`) so memory cannot grow unbounded
//!   even during long sessions.
//! - Each push emits a Tauri event so the UI updates live without polling.
//! - Tauri commands `get_download_log` / `clear_download_log` let the UI
//!   load the full snapshot on open and offer a clear-log control.

use std::collections::VecDeque;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const MAX_ENTRIES: usize = 5000;
const EVENT_NAME: &str = "download-log-entry";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    #[allow(dead_code)] // exposed for future log-export / external filtering
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" | "warning" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadLogEntry {
    pub id: u64,
    /// ISO-8601 UTC timestamp.
    pub timestamp: String,
    pub level: LogLevel,
    /// Subsystem that produced the entry (e.g. "ytdlp", "evil0ctal", "hubspot",
    /// "repair", "cascade"). Helps filter the log when triaging issues.
    pub source: String,
    /// Optional clip id. Allows filtering by a specific clip when multiple
    /// downloads run in parallel.
    #[serde(rename = "clipId")]
    pub clip_id: Option<String>,
    /// One-line summary, safe to display inline.
    pub message: String,
    /// Optional multi-line technical payload (e.g. full stderr, command-line
    /// args, URL list). Hidden by default; expanded on demand in the UI.
    pub detail: Option<String>,
}

static LOG: Lazy<Mutex<VecDeque<DownloadLogEntry>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES + 16)));
static NEXT_ID: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(1));

fn next_id() -> u64 {
    let mut g = NEXT_ID.lock().unwrap_or_else(|e| e.into_inner());
    let id = *g;
    *g = g.wrapping_add(1);
    id
}

/// Push an entry onto the log and emit a Tauri event so the UI updates live.
/// Cheap (lock + small alloc + emit). Safe to call from any thread.
pub fn push(
    app: &AppHandle,
    level: LogLevel,
    source: impl Into<String>,
    clip_id: Option<&str>,
    message: impl Into<String>,
    detail: Option<String>,
) {
    let entry = DownloadLogEntry {
        id: next_id(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        level,
        source: source.into(),
        clip_id: clip_id.map(|s| s.to_string()),
        message: message.into(),
        detail,
    };

    if let Ok(mut log) = LOG.lock() {
        log.push_back(entry.clone());
        while log.len() > MAX_ENTRIES {
            log.pop_front();
        }
    }

    let _ = app.emit(EVENT_NAME, &entry);
}

/// Convenience wrappers — keep call sites concise at the use site.
pub fn debug(app: &AppHandle, source: &str, clip_id: Option<&str>, message: impl Into<String>) {
    push(app, LogLevel::Debug, source, clip_id, message, None);
}
pub fn info(app: &AppHandle, source: &str, clip_id: Option<&str>, message: impl Into<String>) {
    push(app, LogLevel::Info, source, clip_id, message, None);
}
pub fn warn(app: &AppHandle, source: &str, clip_id: Option<&str>, message: impl Into<String>) {
    push(app, LogLevel::Warn, source, clip_id, message, None);
}
pub fn error(app: &AppHandle, source: &str, clip_id: Option<&str>, message: impl Into<String>) {
    push(app, LogLevel::Error, source, clip_id, message, None);
}

/// Like `error`, but attaches a multi-line technical detail (full stderr, etc.).
pub fn error_detailed(
    app: &AppHandle,
    source: &str,
    clip_id: Option<&str>,
    message: impl Into<String>,
    detail: impl Into<String>,
) {
    let detail = detail.into();
    let detail = if detail.trim().is_empty() {
        None
    } else {
        Some(detail)
    };
    push(app, LogLevel::Error, source, clip_id, message, detail);
}

/// Snapshot the current log. Used by `get_download_log` Tauri command on UI open.
pub fn snapshot() -> Vec<DownloadLogEntry> {
    LOG.lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn clear() {
    if let Ok(mut g) = LOG.lock() {
        g.clear();
    }
}

#[tauri::command]
pub fn get_download_log() -> Vec<DownloadLogEntry> {
    snapshot()
}

#[tauri::command]
pub fn clear_download_log() {
    clear();
}

#[tauri::command]
pub fn log_event(
    app: AppHandle,
    level: String,
    source: String,
    #[allow(non_snake_case)] clipId: Option<String>,
    message: String,
    detail: Option<String>,
) -> Result<(), String> {
    let parsed = LogLevel::from_str(&level)
        .ok_or_else(|| format!("Invalid log level: {level}. Use debug/info/warn/error"))?;
    push(
        &app,
        parsed,
        source,
        clipId.as_deref(),
        message,
        detail,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_level_round_trips_through_json() {
        let json = serde_json::to_string(&LogLevel::Warn).unwrap();
        assert_eq!(json, "\"warn\"");
        let back: LogLevel = serde_json::from_str("\"error\"").unwrap();
        assert_eq!(back, LogLevel::Error);
    }

    #[test]
    fn log_level_as_str_is_lowercase() {
        assert_eq!(LogLevel::Debug.as_str(), "debug");
        assert_eq!(LogLevel::Info.as_str(), "info");
        assert_eq!(LogLevel::Warn.as_str(), "warn");
        assert_eq!(LogLevel::Error.as_str(), "error");
    }

    #[test]
    fn log_level_from_str_accepts_aliases() {
        assert_eq!(LogLevel::from_str("debug"), Some(LogLevel::Debug));
        assert_eq!(LogLevel::from_str("INFO"), Some(LogLevel::Info));
        assert_eq!(LogLevel::from_str("warning"), Some(LogLevel::Warn));
        assert_eq!(LogLevel::from_str("error"), Some(LogLevel::Error));
        assert_eq!(LogLevel::from_str("nope"), None);
    }

    #[test]
    fn next_id_increments_monotonically() {
        let a = next_id();
        let b = next_id();
        let c = next_id();
        assert!(b > a);
        assert!(c > b);
    }

    #[test]
    fn snapshot_returns_clones_of_entries() {
        clear();
        let mut g = LOG.lock().unwrap();
        g.push_back(DownloadLogEntry {
            id: 1,
            timestamp: "t".into(),
            level: LogLevel::Info,
            source: "test".into(),
            clip_id: None,
            message: "hello".into(),
            detail: None,
        });
        drop(g);
        let snap = snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].message, "hello");
        clear();
    }
}
