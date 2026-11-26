//! run_ledger.rs - the Ledger agent's seed: persist every orchestrate() run.
//!
//! One Tauri command, `ledger_log_run`, appends a single JSON line to
//! `%LOCALAPPDATA%\Praxis\runs.jsonl`:
//!
//! ```json
//! {"ts":1751446800000,"goal":"…","iterations":2,
//!  "steps":[{"tool":"claude","model":"sonnet","ok":true,"summary":"…","secs":42.1}],
//!  "done":true,"total_secs":97.3}
//! ```
//!
//! JSONL on purpose: append-only, crash-safe per line, trivially greppable and
//! streamable - a future Ledger surface reads it newest-last without a DB.
//! File handling mirrors usage.rs: create the dir, append, never panic.

use std::io::Write;

/// One executed step of a run (tool + routed model + outcome).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct RunStep {
    pub tool: String,
    /// Per-step routed model ("opus", "sonnet", "gpt-5.5", …); null = CLI default.
    #[serde(default)]
    pub model: Option<String>,
    pub ok: bool,
    /// Truncated output (or the prompt when there was no output).
    #[serde(default)]
    pub summary: String,
    /// Wall-clock duration of this step, seconds.
    #[serde(default)]
    pub secs: f64,
    /// Per-delegation supervision (the Forge/Vega/Quill loop): how many
    /// corrective re-prompts this delegation took (0 = accepted on the first
    /// result). Absent on old lines and on Live-mode / unsupervised runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reprompts: Option<u32>,
    /// The per-cycle supervision trail - one entry per evaluate cycle with the
    /// brain's sufficiency verdict and the feedback that drove the next
    /// re-prompt. Schema-loose (raw JSON) so the frontend owns the shape:
    /// `[{ attempt, sufficient, feedback? }]`. Present only when supervision ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervision: Option<serde_json::Value>,
}

/// One orchestrate() run, as recorded by the frontend after the loop finishes.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct RunEntry {
    /// Unix epoch milliseconds (JS `Date.now()`).
    pub ts: u64,
    pub goal: String,
    /// How many plan → execute → verify passes ran.
    pub iterations: u32,
    pub steps: Vec<RunStep>,
    /// Final brain verdict - true when the goal was verified genuinely done.
    pub done: bool,
    /// Total wall-clock duration of the run, seconds.
    #[serde(default)]
    pub total_secs: f64,
    /// Optional visual-QA (Lens) summary - present only when the run included
    /// QA passes. Deliberately schema-loose (raw JSON) so the frontend owns
    /// the shape: `{ window, passes, findings, high, med, low }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa: Option<serde_json::Value>,
    /// Optional build record for a team/new-project run - schema-loose like `qa`
    /// (the frontend owns it): `{ team, workspace, files, entry, memory: [{label,
    /// path}], gate, delivery }`. It is how a run shows which real memory notes it
    /// used and whether the result was opened. Without this field serde silently
    /// DROPPED it, so the ledger could never prove the chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<serde_json::Value>,
}

/// `%LOCALAPPDATA%\Praxis\runs.jsonl` - same home as usage.json / boot log.
fn runs_file_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("runs.jsonl"))
}

/// Append one run entry as a JSON line. Errors are returned (not panicked) so
/// the frontend's best-effort recordRun() can swallow them without crashing.
#[tauri::command]
pub fn ledger_log_run(entry: RunEntry) -> Result<(), String> {
    let path = runs_file_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("run ledger mkdir: {e}"))?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| format!("run ledger serialize: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("run ledger open: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("run ledger write: {e}"))?;
    Ok(())
}
