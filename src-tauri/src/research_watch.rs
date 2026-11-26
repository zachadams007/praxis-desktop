//! research_watch.rs - Sage's watch loop, Rust half.
//!
//! The MECHANICAL work (RSS check, transcript fetch, watch-state, queueing) lives in
//! `scripts/research-scan.cjs` - a pure Node script with no brain/model dependency, so it
//! can run standalone (`node scripts/research-scan.cjs`) for testing or be spawned here.
//! This module is the thin Rust glue, mirroring two existing patterns exactly:
//!   - `memory_graph.rs`'s `refresh_memory_graph`: a debounced, fire-and-forget spawn of a
//!     node script from a Tauri command, resolved via `CARGO_MANIFEST_DIR` so it works both
//!     in `cargo tauri dev` and from an installed release build.
//!   - `session_poller.rs`'s `spawn(app, running)`: a background OS thread on a timer that
//!     emits a Tauri event when there's new work, so the FRONTEND (which alone owns
//!     `brain_chat` + the selected-model context, see `src/orchestrator/brain.ts`) does the
//!     idea-extraction + vault-note-writing half. This module never calls the brain itself.
//!
//! Flow once wired up:
//!   1. `research_scan` (Tauri command) OR the 6-hourly background timer spawns
//!      `node scripts/research-scan.cjs`, which does RSS-diff + transcript-fetch + writes
//!      any new transcript job into `%LOCALAPPDATA%\Praxis\research-pending.json` (or a
//!      LOUD failure straight into `research-inbox.md` if a transcript couldn't be fetched
//!      after every fallback layer - see fetch-transcript.cjs's own doc comment).
//!   3. `write_research_note` (this module) does that vault-note write - same shape as
//!      `run_notes.rs`'s `write_run_note` (frontmatter `readFrontmatter` in
//!      build-memory-graph.cjs already knows how to read), so digests become real Memory
//!      Galaxy nodes without any changes to the graph-build script.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Emitter;

/// How often the background thread kicks off a scan while the app is running.
const POLL_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Debounce for manual `research_scan` invocations (e.g. a Command Center "check now"
/// button) - mirrors memory_graph.rs's DEBOUNCE so a double-click doesn't stack node
/// processes or double-hit YouTube's RSS endpoint.
const DEBOUNCE: Duration = Duration::from_secs(30);

static LAST_RUN: Mutex<Option<Instant>> = Mutex::new(None);
static RUNNING: Mutex<bool> = Mutex::new(false);

/// The repo-root-relative script, resolved the same way memory_graph.rs resolves
/// build-memory-graph.cjs - correct both in `cargo tauri dev` and an installed release
/// (Praxis is always built from `C:\Users\dev\Desktop\praxis`, never relocated post-build).
fn script_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join(name)
}

/// Result payload emitted as `praxis://research-scan-result` after every scan (manual or
/// timer-triggered) - lets a future Command Center panel show "last checked" / "N new"
/// without polling a file. Schema-loose passthrough of research-scan.cjs's own JSON summary.
#[derive(Clone, serde::Serialize)]
struct ResearchScanResult {
    summary: serde_json::Value,
}

fn has_pending_research(summary: &serde_json::Value) -> bool {
    ["newVideos", "transcribed"].iter().any(|key| {
        summary.get(key).and_then(|v| v.as_u64()).unwrap_or(0) > 0
    })
}

/// Run `node scripts/research-scan.cjs` synchronously (from a blocking context - either the
/// background poll thread or the async command below via `spawn_blocking`) and return its
/// parsed JSON summary. Never panics; a spawn failure becomes an `Err` string so the caller
/// can surface it instead of crashing the poll loop.
fn run_scan_blocking() -> Result<serde_json::Value, String> {
    let script = script_path("research-scan.cjs");
    if !script.exists() {
        return Err(format!(
            "research-scan.cjs not found at {}",
            script.display()
        ));
    }
    let mut cmd = std::process::Command::new("node");
    cmd.arg(&script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW - never flash a console
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn node for research-scan.cjs: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trim = stdout.trim();
    if stdout_trim.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "research-scan.cjs produced no output (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    serde_json::from_str(stdout_trim).map_err(|e| {
        format!("research-scan.cjs output was not valid JSON: {e} — raw: {stdout_trim}")
    })
}

/// Tauri command: run a scan now (e.g. a future Command Center "check for new videos"
/// button, or called once at app startup so the owner doesn't wait up to 6h for the first check).
/// Debounced identically to `refresh_memory_graph` - near-duplicate calls no-op.
#[tauri::command]
pub async fn research_scan(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    {
        let mut last = LAST_RUN.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < DEBOUNCE {
                return Ok(serde_json::json!({ "ok": true, "skipped": "debounced" }));
            }
        }
        if *RUNNING.lock().unwrap() {
            return Ok(serde_json::json!({ "ok": true, "skipped": "already running" }));
        }
        *last = Some(Instant::now());
        *RUNNING.lock().unwrap() = true;
    }

    let result = tauri::async_runtime::spawn_blocking(run_scan_blocking)
        .await
        .map_err(|e| format!("research_scan join error: {e}"));

    *RUNNING.lock().unwrap() = false;

    let summary = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            crate::elog!("[research-watch] scan failed: {e}");
            return Err(e);
        }
        Err(e) => {
            crate::elog!("[research-watch] scan join error: {e}");
            return Err(e);
        }
    };

    let new_videos = summary
        .get("newVideos")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    crate::dlog!(
        "[research-watch] scan complete — newVideos={new_videos} transcribed={} failed={}",
        summary
            .get("transcribed")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        summary.get("failed").and_then(|v| v.as_u64()).unwrap_or(0),
    );

    // Always emit - the frontend decides whether there's anything to drain (checks the
    // pending-queue file itself), but a zero-result scan is still useful telemetry for a
    // future "last checked" indicator.
    let _ = app.emit(
        "praxis://research-scan-result",
        ResearchScanResult {
            summary: summary.clone(),
        },
    );
    if has_pending_research(&summary) {
        let _ = app.emit("praxis://research-pending", ());
    }

    Ok(summary)
}

/// Background thread: kick off a scan every `POLL_INTERVAL` while the app runs, per the
/// mission brief's "6-hourly poll while the app runs." Mirrors `session_poller::spawn`'s
/// `Arc<AtomicBool>` shutdown-flag shape exactly (flipped false on app exit in lib.rs).
///
/// Runs an IMMEDIATE first scan (a few seconds after boot, not after waiting a full 6h) so
/// The owner doesn't wait half a day for the first check after installing this feature - then
/// sleeps in short increments so the shutdown flag is observed promptly rather than only at
/// the end of a 6h sleep.
pub fn spawn(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        // Small initial delay so this doesn't compete with the flurry of other boot-time
        // spawns (hotkey registration retries, Hermes dashboard ensure, etc.) for the first
        // few seconds of app startup.
        std::thread::sleep(Duration::from_secs(15));

        while running.load(Ordering::Relaxed) {
            match run_scan_blocking() {
                Ok(summary) => {
                    let new_videos = summary
                        .get("newVideos")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    crate::dlog!("[research-watch] timer scan complete — newVideos={new_videos}");
                    let _ = app.emit(
                        "praxis://research-scan-result",
                        ResearchScanResult {
                            summary: summary.clone(),
                        },
                    );
                    if has_pending_research(&summary) {
                        let _ = app.emit("praxis://research-pending", ());
                    }
                }
                Err(e) => crate::elog!("[research-watch] timer scan failed: {e}"),
            }

            // Sleep in 30s increments up to POLL_INTERVAL so app-exit is observed within
            // 30s instead of blocking a full 6h on shutdown (matches the spirit of
            // session_poller's tight loop, just at a much coarser cadence).
            let mut slept = Duration::ZERO;
            while slept < POLL_INTERVAL && running.load(Ordering::Relaxed) {
                let step = Duration::from_secs(30).min(POLL_INTERVAL - slept);
                std::thread::sleep(step);
                slept += step;
            }
        }
    });
}

// ── Pending-queue access (frontend has no generic LOCALAPPDATA file-read plugin, so this
//    is a small dedicated pair of commands rather than growing a filesystem-plugin
//    dependency for one JSON file) ──────────────────────────────────────────────────────

fn pending_path() -> Option<PathBuf> {
    crate::praxis_dir().map(|d| d.join("research-pending.json"))
}

/// Read `research-pending.json` (the queue research-scan.cjs appends to) and ATOMICALLY
/// clear it in the same call - a job is either fully claimed by this read or left for the
/// next one; there's no window where two drains could double-process the same job (the
/// frontend's own retry-on-failure logic re-queues failed jobs itself via
/// `write_research_pending`, so clearing here is safe even though extraction can fail).
/// Returns the raw JSON text (or `null` if the file doesn't exist yet) - frontend parses it,
/// same "loose schema, frontend owns it" convention as `read_memory_graph`.
#[tauri::command]
pub fn take_research_pending() -> Result<Option<String>, String> {
    let Some(path) = pending_path() else {
        return Ok(None);
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    // Clear immediately after a successful read - best-effort; if the delete fails the
    // frontend still has the content in hand, worst case a future drain double-reads.
    let _ = std::fs::write(&path, "{\"jobs\":[]}");
    Ok(Some(content))
}

/// Write back a (possibly non-empty) job list - used by the frontend to re-queue jobs whose
/// idea-extraction failed (brain down, etc.) so the NEXT drain retries them instead of the
/// failure being silently lost. Takes raw JSON text (frontend already has the shape from
/// `take_research_pending`) so this module doesn't need to mirror the job struct twice.
#[tauri::command]
pub fn write_research_pending(json: String) -> Result<(), String> {
    let path = pending_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("pending mkdir: {e}"))?;
    }
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── Vault note writer (mirrors run_notes.rs's write_run_note exactly) ──────────────────────

/// One digest, as produced by the frontend's idea-extraction pass over a transcript
/// (`src/research/sageWatch.ts`). Deliberately schema-loose on `ideas` - frontend owns the
/// shape; this command only needs enough to render a useful note + frontmatter.
#[derive(serde::Deserialize)]
pub struct ResearchDigestEntry {
    pub source_label: String,
    pub video_id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub published: Option<String>,
    /// The brain's extracted-ideas text (already formatted as markdown bullets/prose).
    pub ideas_markdown: String,
    /// Which brain model produced the extraction (frontmatter/body context only).
    #[serde(default)]
    pub model: Option<String>,
    /// Unix epoch milliseconds - also the file's sort key.
    pub ts: u64,
}

/// The REAL Obsidian vault's research subfolder - same home run_notes.rs writes `runs/`
/// into, so `build-memory-graph.cjs`'s existing per-project `memory/*.md` top-level scan
/// picks these up automatically once this subfolder is added to that script (see the
/// companion change there: a dedicated `RESEARCH_DIR` block mirroring `RUNS_DIR`).
fn research_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join("C--Users-dev-Desktop-praxis")
            .join("memory")
            .join("research"),
    )
}

fn fm_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "'")
        .replace(['\n', '\r'], " ")
}

/// Both writes are best-effort at the call site (frontend wraps this in try/catch, same
/// convention as write_run_note), but real errors are still returned so a genuine
/// misconfiguration is diagnosable rather than silently swallowed.
#[tauri::command]
pub fn write_research_note(entry: ResearchDigestEntry) -> Result<(), String> {
    let dir = research_dir().ok_or_else(|| "USERPROFILE not set".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("research-note mkdir: {e}"))?;

    let title_line = fm_escape(entry.title.chars().take(160).collect::<String>().trim());
    let model = entry.model.clone().unwrap_or_else(|| "unknown".to_string());
    let published = entry
        .published
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let body = format!(
        "---\ndescription: \"{title_line} — transferable AI-workflow ideas\"\ntype: reference\n---\n\n\
         # Research digest — {title}\n\n\
         **Source:** {source}  \n\
         **Video:** [{title}]({url})  \n\
         **Published:** {published}  \n\
         **Extracted by:** {model}\n\n\
         ## Transferable ideas for Praxis\n\n{ideas}\n",
        title_line = title_line,
        title = entry.title.trim(),
        source = entry.source_label,
        url = entry.url,
        published = published,
        model = model,
        ideas = entry.ideas_markdown.trim(),
    );

    let path = dir.join(format!("research-{}-{}.md", entry.ts, entry.video_id));
    std::fs::write(&path, body.as_bytes())
        .map_err(|e| format!("research-note write {}: {e}", path.display()))?;

    // Inbox pointer - short, scannable, points back at the full note + the source video.
    if let Some(inbox_dir) =
        std::env::var_os("LOCALAPPDATA").map(|p| std::path::PathBuf::from(p).join("Praxis"))
    {
        std::fs::create_dir_all(&inbox_dir).map_err(|e| format!("inbox mkdir: {e}"))?;
        let inbox_path = inbox_dir.join("research-inbox.md");
        let stamp = chrono_stamp();
        let section = format!(
            "\n## 🎥 New research digest — {stamp}\n\
             - **Source:** {source}\n\
             - **Video:** [{title}]({url})\n\
             - **Full digest:** `{note_path}`\n\
             - **Needs Zach's input:** review the extracted ideas and decide what to build next.\n",
            stamp = stamp,
            source = entry.source_label,
            title = entry.title.trim(),
            url = entry.url,
            note_path = path.display(),
        );
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&inbox_path)
            .map_err(|e| format!("inbox open {}: {e}", inbox_path.display()))?;
        use std::io::Write;
        f.write_all(section.as_bytes())
            .map_err(|e| format!("inbox write {}: {e}", inbox_path.display()))?;
    }

    Ok(())
}

/// Cheap ISO-ish timestamp without pulling in a `chrono` dependency the crate doesn't
/// otherwise need - good enough for a human-scannable inbox heading.
fn chrono_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", now.as_secs())
}

#[cfg(test)]
mod tests {
    use super::has_pending_research;

    #[test]
    fn research_retry_success_notifies_sage_without_new_videos() {
        assert!(has_pending_research(&serde_json::json!({ "newVideos": 0, "transcribed": 1 })));
        assert!(has_pending_research(&serde_json::json!({ "newVideos": 1, "transcribed": 0 })));
        assert!(!has_pending_research(&serde_json::json!({ "newVideos": 0, "transcribed": 0, "failed": 1 })));
        assert!(!has_pending_research(&serde_json::json!({})));
    }
}
