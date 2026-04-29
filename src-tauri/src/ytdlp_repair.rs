//! Self-repair for the bundled yt-dlp downloader.
//!
//! When the bundled `yt-dlp` cannot be started (Defender quarantine, locked
//! file, PyInstaller `_MEI` extraction failure, missing/corrupt sidecar, etc.)
//! we silently download a fresh copy of the official yt-dlp release into the
//! user's app data directory and use that going forward. No reinstall required.
//!
//! Resolution cascade (handled in `lib::run_ytdlp`):
//! 1. `COMPIFLOW_YTDLP_PATH` (explicit override)
//! 2. Bundled sidecar
//! 3. Self-repaired binary in app data (this module)
//! 4. Dev-only system fallback
//!
//! See `docs/download-system-requirements.md` for the full design.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MIN_REASONABLE_BYTES: usize = 100 * 1024; // sanity check the download isn't an HTML error page

/// Serializes concurrent self-repair attempts so we never download twice in
/// parallel. The mutex is process-global (cheap; held only during install).
fn install_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// File name of the repaired binary inside the app data `bin/` folder.
fn binary_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// Asset name on the yt-dlp GitHub release for the current OS.
fn release_asset_name() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        // Single-file fallback. The bundled onedir is preferred, but if it
        // fails (rare) the single-file build is the next best automatic option.
        Some("yt-dlp_macos")
    } else if cfg!(target_os = "linux") {
        Some("yt-dlp_linux")
    } else {
        None
    }
}

/// Directory where repaired binaries live: `<app_data>/bin/`.
pub(crate) fn repair_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bin"))
}

/// Full path the repaired binary would have on disk (file may not exist).
pub(crate) fn repair_target_path(app: &AppHandle) -> Option<PathBuf> {
    repair_dir(app).map(|d| d.join(binary_filename()))
}

/// Returns the path to a repaired binary that is present and runs `--version`
/// successfully. Does NOT trigger any download. Cheap (~50 ms) when present.
pub(crate) async fn existing_runnable_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = repair_target_path(app)?;
    if !path.exists() {
        return None;
    }
    if probe_runs(&path).await {
        Some(path)
    } else {
        None
    }
}

/// Returns a runnable repaired binary path, downloading + installing one if
/// necessary. Concurrent calls share the same install (serialized internally).
pub(crate) async fn ensure_runnable_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(existing) = existing_runnable_binary(app).await {
        crate::download_log::debug(
            app,
            "repair",
            None,
            format!("reusing existing repaired binary at {}", existing.display()),
        );
        return Ok(existing);
    }

    let _guard = install_lock().lock().await;

    if let Some(existing) = existing_runnable_binary(app).await {
        crate::download_log::debug(
            app,
            "repair",
            None,
            format!("repaired binary appeared while waiting for lock: {}", existing.display()),
        );
        return Ok(existing);
    }

    crate::download_log::info(
        app,
        "repair",
        None,
        "starting yt-dlp self-repair (downloading latest official release)",
    );
    let result = download_and_install(app).await;
    match &result {
        Ok(p) => crate::download_log::info(
            app,
            "repair",
            None,
            format!("self-repair installed binary at {}", p.display()),
        ),
        Err(e) => crate::download_log::error(
            app,
            "repair",
            None,
            format!("self-repair failed: {e}"),
        ),
    }
    result
}

/// Force a fresh download regardless of any existing repaired binary.
/// Useful for a future "Repair downloader" UI action.
#[allow(dead_code)]
pub(crate) async fn force_repair(app: &AppHandle) -> Result<PathBuf, String> {
    let _guard = install_lock().lock().await;
    download_and_install(app).await
}

async fn download_and_install(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = repair_dir(app).ok_or_else(|| {
        "Could not resolve app data directory for self-repair download".to_string()
    })?;
    let asset = release_asset_name()
        .ok_or_else(|| "Self-repair is not supported on this OS yet".to_string())?;

    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create {}: {e}", bin_dir.display()))?;

    let target = bin_dir.join(binary_filename());
    let partial = bin_dir.join(format!("{}.partial", binary_filename()));
    let _ = std::fs::remove_file(&partial);

    let url = format!("{RELEASE_BASE}/{asset}");
    eprintln!("[yt-dlp-repair] downloading {url}");

    let bytes = fetch_release_bytes(&url).await?;
    sanity_check_bytes(&bytes)?;

    std::fs::write(&partial, &bytes)
        .map_err(|e| format!("Failed to write {}: {e}", partial.display()))?;

    #[cfg(unix)]
    set_executable(&partial)?;

    if !probe_runs(&partial).await {
        let _ = std::fs::remove_file(&partial);
        return Err(
            "Downloaded yt-dlp could not be started (--version probe failed)".to_string(),
        );
    }

    // Atomic-ish swap. Best-effort remove of stale target before rename.
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&partial, &target)
        .map_err(|e| format!("Failed to install {}: {e}", target.display()))?;

    eprintln!(
        "[yt-dlp-repair] installed {} ({} bytes)",
        target.display(),
        bytes.len()
    );
    Ok(target)
}

async fn fetch_release_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download request returned error: {e}"))?;

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Reading download body failed: {e}"))?;
    Ok(bytes.to_vec())
}

pub(crate) fn sanity_check_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < MIN_REASONABLE_BYTES {
        return Err(format!(
            "Downloaded file is unexpectedly small ({} bytes); refusing to install.",
            bytes.len()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to chmod {}: {e}", path.display()))
}

/// Run `<binary> --version` and report whether it produced a successful, non-empty
/// response within `PROBE_TIMEOUT`. Used both before installing a freshly
/// downloaded binary and to verify an existing repaired binary still works.
pub(crate) async fn probe_runs(path: &Path) -> bool {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out.status.success() && !out.stdout.is_empty(),
        Ok(Err(e)) => {
            eprintln!("[yt-dlp-repair] probe spawn failed for {}: {e}", path.display());
            false
        }
        Err(_) => {
            eprintln!("[yt-dlp-repair] probe timed out for {}", path.display());
            false
        }
    }
}

/// Returns true if the stderr looks like a startup-class failure that would
/// benefit from self-repair: PyInstaller extraction errors, missing runtime
/// modules, or known "binary refused to start" patterns. yt-dlp's normal
/// download errors (login required, video unavailable, etc.) do NOT match.
pub(crate) fn looks_like_startup_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("[pyi-")
        || lower.contains("_mei")
        || lower.contains("no module named expat")
        || lower.contains("failed to extract")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_filename_has_exe_on_windows() {
        if cfg!(target_os = "windows") {
            assert_eq!(binary_filename(), "yt-dlp.exe");
        } else {
            assert_eq!(binary_filename(), "yt-dlp");
        }
    }

    #[test]
    fn release_asset_name_present_on_supported_oses() {
        if cfg!(any(target_os = "windows", target_os = "macos", target_os = "linux")) {
            assert!(release_asset_name().is_some());
        }
    }

    #[test]
    fn sanity_check_rejects_tiny_payload() {
        let small = vec![0u8; 1024];
        assert!(sanity_check_bytes(&small).is_err());
    }

    #[test]
    fn sanity_check_accepts_realistic_payload() {
        let big = vec![0u8; MIN_REASONABLE_BYTES + 1];
        assert!(sanity_check_bytes(&big).is_ok());
    }

    #[test]
    fn looks_like_startup_failure_matches_pyinstaller_errors() {
        assert!(looks_like_startup_failure("[PYI-1234:ERROR] Failed to extract"));
        assert!(looks_like_startup_failure(
            "Error loading Python lib '/tmp/_MEI12345/libpython3.so'"
        ));
        assert!(looks_like_startup_failure("ImportError: No module named expat"));
        assert!(looks_like_startup_failure("FAILED TO EXTRACT runtime"));
    }

    #[test]
    fn looks_like_startup_failure_ignores_normal_yt_dlp_errors() {
        assert!(!looks_like_startup_failure(
            "ERROR: [youtube] xyz: Video unavailable"
        ));
        assert!(!looks_like_startup_failure("ERROR: Private video"));
        assert!(!looks_like_startup_failure(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden"
        ));
        assert!(!looks_like_startup_failure(""));
    }
}
