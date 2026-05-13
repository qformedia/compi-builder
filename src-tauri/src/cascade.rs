//! Generic "service waterfall" runner shared by the creator-resolution and
//! download pipelines.
//!
//! The two pipelines historically had hand-rolled cascades — one in
//! [`crate::resolver`] (Instagram oEmbed → embed → SocialKit, etc.) and one in
//! [`crate::download_clip`] (HubSpot CDN → Evil0ctal → yt-dlp). Both wanted
//! the same things: try steps in order, stop on first success, distinguish
//! "not configured / not applicable" from "tried and failed", and emit
//! consistent log breadcrumbs into [`crate::download_log`]. This module is
//! that shared abstraction.
//!
//! ## Skip vs Err
//!
//! - [`StepOutcome::Skip`] means "this step was not applicable" (e.g. the API
//!   key isn't configured, the URL is not on this provider's platform). It
//!   does NOT count toward the user-visible error list.
//! - [`StepOutcome::Err`] means "this step ran and failed". It is recorded in
//!   the attempt vec returned to the caller, so frontends can produce
//!   accurate messages ("post needs login" vs "no API key configured").
//!
//! ## Why not async-trait?
//!
//! A `Step` carries a boxed `Future`, not a trait object, so the caller can
//! capture local references in a closure without battling lifetimes through
//! a trait. This keeps the call sites small and the machinery `'a`-bounded.

use std::future::Future;
use std::pin::Pin;

use serde::Serialize;
use tauri::AppHandle;

use crate::download_log;

/// Per-step outcome returned by each step's future. Generic over the success
/// payload `T` so the cascade is reusable across `()` (download) and
/// [`crate::EnrichedProfile`] (creator resolution) without modification.
pub enum StepOutcome<T> {
    /// Step succeeded — cascade short-circuits and returns this value.
    Ok(T),
    /// Step was not applicable (no API key, wrong platform, missing config).
    /// Recorded as `info`-level log only; never treated as a user-visible
    /// failure.
    Skip(String),
    /// Step ran and failed. Recorded in the per-step attempt log returned to
    /// the caller on full-cascade failure.
    Err(String),
}

/// One named step in the cascade. The future is consumed at most once.
pub struct Step<'a, T> {
    pub name: &'static str,
    pub future: Pin<Box<dyn Future<Output = StepOutcome<T>> + Send + 'a>>,
}

impl<'a, T> Step<'a, T> {
    /// Build a step from a future. Use `Box::pin` if you have a non-`Pin`
    /// future already, or `step!` for ergonomic local construction.
    pub fn new<F>(name: &'static str, future: F) -> Self
    where
        F: Future<Output = StepOutcome<T>> + Send + 'a,
    {
        Self {
            name,
            future: Box::pin(future),
        }
    }
}

/// One entry in the per-step attempt log returned on cascade failure. The
/// `outcome` distinguishes "not applicable" (`skipped`) from "tried and
/// failed" (`failed`) so the frontend can render the right message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub step: String,
    /// `"skipped"` or `"failed"`.
    pub outcome: &'static str,
    pub reason: String,
}

/// Run the cascade. Returns `(value, winning_step_name)` on first success.
/// On full failure returns the per-step attempt log (excluding `Ok`s — there
/// are none).
///
/// `label` is a short string used as the `source` in [`download_log`] entries
/// (e.g. `"download"`, `"creator-resolve"`).
pub async fn run<'a, T>(
    app: &AppHandle,
    label: &str,
    clip_id: Option<&str>,
    steps: Vec<Step<'a, T>>,
) -> Result<(T, &'static str), Vec<Attempt>> {
    let mut attempts: Vec<Attempt> = Vec::with_capacity(steps.len());

    for step in steps {
        let name = step.name;
        download_log::debug(app, label, clip_id, format!("trying step '{}'", name));

        match step.future.await {
            StepOutcome::Ok(value) => {
                download_log::info(app, label, clip_id, format!("step '{}' succeeded", name));
                return Ok((value, name));
            }
            StepOutcome::Skip(reason) => {
                download_log::debug(
                    app,
                    label,
                    clip_id,
                    format!("step '{}' skipped: {}", name, reason),
                );
                attempts.push(Attempt {
                    step: name.to_string(),
                    outcome: "skipped",
                    reason,
                });
            }
            StepOutcome::Err(detail) => {
                download_log::warn(
                    app,
                    label,
                    clip_id,
                    format!("step '{}' failed: {}", name, detail),
                );
                attempts.push(Attempt {
                    step: name.to_string(),
                    outcome: "failed",
                    reason: detail,
                });
            }
        }
    }

    Err(attempts)
}

#[cfg(test)]
mod tests {
    //! Tests run through the real `download_log` (which `emit`s to a Tauri
    //! `AppHandle`). Building a real `AppHandle` is heavy, so these tests
    //! exercise the cascade body via a tiny in-process helper that mirrors
    //! the public API without `download_log` calls. The contract tested is
    //! the one all callers rely on: ordering, short-circuit on `Ok`, skips
    //! don't poison the error list, errors are preserved in order.
    //!
    //! The actual `run()` is exercised end-to-end by Phase A's download
    //! refactor and Phase B's resolver refactor — both run as part of
    //! `cargo test` via their own integration-style tests.
    use super::*;

    /// Mirror of `run()` minus the `AppHandle`-dependent logging. Same
    /// semantics — keep them aligned.
    async fn run_no_log<'a, T>(steps: Vec<Step<'a, T>>) -> Result<(T, &'static str), Vec<Attempt>> {
        let mut attempts: Vec<Attempt> = Vec::with_capacity(steps.len());
        for step in steps {
            let name = step.name;
            match step.future.await {
                StepOutcome::Ok(v) => return Ok((v, name)),
                StepOutcome::Skip(r) => attempts.push(Attempt {
                    step: name.to_string(),
                    outcome: "skipped",
                    reason: r,
                }),
                StepOutcome::Err(r) => attempts.push(Attempt {
                    step: name.to_string(),
                    outcome: "failed",
                    reason: r,
                }),
            }
        }
        Err(attempts)
    }

    #[tokio::test]
    async fn first_ok_short_circuits() {
        let steps: Vec<Step<'_, &'static str>> = vec![
            Step::new("a", async { StepOutcome::Err("a failed".into()) }),
            Step::new("b", async { StepOutcome::Ok("b-value") }),
            Step::new("c", async { panic!("c should never run") }),
        ];
        let (value, winner) = run_no_log(steps).await.expect("cascade should succeed");
        assert_eq!(value, "b-value");
        assert_eq!(winner, "b");
    }

    #[tokio::test]
    async fn all_skipped_returns_skipped_attempts() {
        let steps: Vec<Step<'_, ()>> = vec![
            Step::new("a", async { StepOutcome::Skip("no key".into()) }),
            Step::new("b", async { StepOutcome::Skip("wrong platform".into()) }),
        ];
        let attempts = run_no_log(steps).await.expect_err("all skipped should fail");
        assert_eq!(attempts.len(), 2);
        assert!(attempts.iter().all(|a| a.outcome == "skipped"));
        assert_eq!(attempts[0].step, "a");
        assert_eq!(attempts[0].reason, "no key");
        assert_eq!(attempts[1].step, "b");
    }

    #[tokio::test]
    async fn mixed_skip_and_fail_preserves_order_and_outcomes() {
        let steps: Vec<Step<'_, ()>> = vec![
            Step::new("a", async { StepOutcome::Skip("no_api_key".into()) }),
            Step::new("b", async { StepOutcome::Err("404".into()) }),
            Step::new("c", async { StepOutcome::Err("network".into()) }),
        ];
        let attempts = run_no_log(steps).await.expect_err("all failed/skipped");
        assert_eq!(attempts.len(), 3);
        assert_eq!(
            (attempts[0].step.as_str(), attempts[0].outcome),
            ("a", "skipped")
        );
        assert_eq!(
            (attempts[1].step.as_str(), attempts[1].outcome),
            ("b", "failed")
        );
        assert_eq!(
            (attempts[2].step.as_str(), attempts[2].outcome),
            ("c", "failed")
        );
    }

    #[tokio::test]
    async fn empty_step_list_returns_empty_attempts() {
        let steps: Vec<Step<'_, ()>> = vec![];
        let attempts = run_no_log(steps).await.expect_err("empty cascade fails");
        assert!(attempts.is_empty());
    }

    #[tokio::test]
    async fn ok_after_skip_returns_ok() {
        let steps: Vec<Step<'_, i32>> = vec![
            Step::new("a", async { StepOutcome::Skip("not configured".into()) }),
            Step::new("b", async { StepOutcome::Ok(42) }),
        ];
        let (value, winner) = run_no_log(steps).await.expect("should succeed");
        assert_eq!(value, 42);
        assert_eq!(winner, "b");
    }

    #[tokio::test]
    async fn attempt_serializes_to_camel_case() {
        let attempt = Attempt {
            step: "ig_oembed".to_string(),
            outcome: "failed",
            reason: "404".to_string(),
        };
        let json = serde_json::to_string(&attempt).unwrap();
        assert!(json.contains("\"step\":\"ig_oembed\""));
        assert!(json.contains("\"outcome\":\"failed\""));
        assert!(json.contains("\"reason\":\"404\""));
    }
}
