// MiniMiki handoff — captures the active CompiFlow window, uploads it to
// Supabase Storage, persists a single-use `minimiki_handoffs` row, and
// returns a `https://t.me/<bot>?start=<token>` deep link.
//
// The Telegram bot consumes the token in its `/start` handler, fetches the
// row, sends the screenshot back to the user as the bot's first reply, and
// uses the contextual payload (page, project, last error) to greet with
// awareness of what the user was doing.

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HandoffContext {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

const HANDOFF_BUCKET: &str = "feedback-screenshots";
const HANDOFF_PREFIX: &str = "minimiki-handoffs";

/// Generate a short single-use token. Stays under Telegram's 64-char
/// `/start` payload limit and uses only URL-safe alphanumerics.
fn new_token() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect();
    format!("mm_{suffix}")
}

/// Capture the active CompiFlow window (best-effort) and return PNG bytes.
///
/// Implementation is gated to non-Linux targets because CompiFlow only
/// ships macOS + Windows builds. The xcap Linux backend (Wayland +
/// PipeWire) is not pulled in for Linux compiles — see the
/// `[target.'cfg(not(target_os = "linux"))'.dependencies]` block in
/// `Cargo.toml`. The caller in `prepare_minimiki_handoff` already
/// handles `Err` by skipping the screenshot, so the Linux stub is a
/// drop-in that just degrades gracefully.
#[cfg(not(target_os = "linux"))]
fn capture_window_png() -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    use xcap::Window;

    let windows = Window::all().map_err(|e| format!("xcap window list failed: {e}"))?;
    if windows.is_empty() {
        return Err("no windows visible".to_string());
    }

    // Prefer the focused window matching CompiFlow's app/title; fall back to
    // the first visible window.
    let target = windows
        .iter()
        .find(|w| {
            let app = w.app_name().unwrap_or_default().to_lowercase();
            let title = w.title().unwrap_or_default().to_lowercase();
            app.contains("compi") || title.contains("compiflow") || title.contains("compi builder")
        })
        .cloned()
        .unwrap_or_else(|| windows[0].clone());

    let image = target
        .capture_image()
        .map_err(|e| format!("xcap capture failed: {e}"))?;

    let mut bytes: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn capture_window_png() -> Result<Vec<u8>, String> {
    Err("Screenshot capture is not supported on Linux builds".to_string())
}

/// Upload PNG bytes to the public `feedback-screenshots` bucket and return
/// the public URL.
async fn upload_screenshot(
    supabase_url: &str,
    supabase_anon_key: &str,
    png_bytes: Vec<u8>,
) -> Result<String, String> {
    let filename: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();
    let object_path = format!("{HANDOFF_PREFIX}/{filename}.png");
    let upload_url = format!(
        "{}/storage/v1/object/{}/{}",
        supabase_url.trim_end_matches('/'),
        HANDOFF_BUCKET,
        object_path,
    );

    let client = reqwest::Client::new();
    let res = client
        .post(&upload_url)
        .bearer_auth(supabase_anon_key)
        .header("apikey", supabase_anon_key)
        .header("Content-Type", "image/png")
        .header("x-upsert", "false")
        .body(png_bytes)
        .send()
        .await
        .map_err(|e| format!("storage upload request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("storage upload failed: {status} {body}"));
    }

    Ok(format!(
        "{}/storage/v1/object/public/{}/{}",
        supabase_url.trim_end_matches('/'),
        HANDOFF_BUCKET,
        object_path,
    ))
}

/// Insert the handoff row via Supabase REST.
async fn insert_handoff_row(
    supabase_url: &str,
    supabase_anon_key: &str,
    token: &str,
    screenshot_url: Option<&str>,
    context: &HandoffContext,
) -> Result<(), String> {
    let endpoint = format!(
        "{}/rest/v1/minimiki_handoffs",
        supabase_url.trim_end_matches('/')
    );
    let payload = serde_json::json!([{
        "token": token,
        "screenshot_url": screenshot_url,
        "context": context,
    }]);

    let client = reqwest::Client::new();
    let res = client
        .post(&endpoint)
        .bearer_auth(supabase_anon_key)
        .header("apikey", supabase_anon_key)
        .header("Content-Type", "application/json")
        .header("Prefer", "return=minimal")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("handoff insert failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("handoff insert failed: {status} {body}"));
    }
    Ok(())
}

/// Tauri command: build the MiniMiki deep link, optionally with a screenshot
/// of the active CompiFlow window. Returns the URL the frontend should open.
#[tauri::command]
pub async fn prepare_minimiki_handoff(
    supabase_url: String,
    supabase_anon_key: String,
    bot_username: String,
    context: HandoffContext,
    include_screenshot: bool,
) -> Result<String, String> {
    if supabase_url.is_empty() || supabase_anon_key.is_empty() {
        return Err("Supabase is not configured".to_string());
    }
    let bot = if bot_username.trim().is_empty() {
        "minimiki_bot".to_string()
    } else {
        bot_username.trim().to_string()
    };

    // Screenshot capture is best-effort: if it fails (e.g. screen-recording
    // permission denied on macOS), we still ship the deep link with text
    // context only.
    let screenshot_url = if include_screenshot {
        match capture_window_png() {
            Ok(bytes) => match upload_screenshot(&supabase_url, &supabase_anon_key, bytes).await {
                Ok(url) => Some(url),
                Err(err) => {
                    eprintln!("[minimiki] screenshot upload skipped: {err}");
                    None
                }
            },
            Err(err) => {
                eprintln!("[minimiki] screenshot capture skipped: {err}");
                None
            }
        }
    } else {
        None
    };

    let token = new_token();
    insert_handoff_row(
        &supabase_url,
        &supabase_anon_key,
        &token,
        screenshot_url.as_deref(),
        &context,
    )
    .await?;

    Ok(format!("https://t.me/{bot}?start={token}"))
}
