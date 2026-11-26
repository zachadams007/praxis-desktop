//! run_notes.rs - turns finished orchestrate() runs into first-class Memory Galaxy nodes.
//!
//! `run_ledger.rs` already appends every run to `runs.jsonl` (the Ledger agent's private log).
//!
//! One file per run, named by timestamp so they sort chronologically and never collide:
//! `runs/run-<unix-ms>.md`, with YAML frontmatter (`description`) the graph script already
//! knows how to read (see `readFrontmatter` in build-memory-graph.cjs) plus a short human
//! body. Deliberately NOT touching MEMORY.md - that's the curated hand-written index; this
//! is raw agent exhaust the galaxy picks up on its own.

use std::io::Write;

/// One executed step, trimmed to what's useful in a run-note body (the full per-step
/// summary/timing already lives in runs.jsonl via run_ledger.rs - this is a lighter mirror).
#[derive(serde::Deserialize)]
pub struct RunNoteStep {
    pub tool: String,
    #[serde(default)]
    pub model: Option<String>,
    pub ok: bool,
}

/// Payload from orchestrator.ts's `recordRun` - mirrors RunEntry's shape loosely (frontend
/// owns it; this command only needs enough to render a useful note + frontmatter).
#[derive(serde::Deserialize)]
pub struct RunNoteEntry {
    pub goal: String,
    pub steps: Vec<RunNoteStep>,
    /// Distinct per-step models used, e.g. ["opus", "sonnet"] - for the frontmatter line.
    #[serde(default)]
    pub models: Vec<String>,
    pub done: bool,
    /// Unix epoch milliseconds (JS `Date.now()`) - also the file's sort key.
    pub ts: u64,
}

/// The REAL Obsidian vault Praxis already points at (see quartz_sidecar.rs's `vault()` and
/// App.tsx's `obsidian://open?vault=memory`) - NOT `%LOCALAPPDATA%\Praxis`. Writing here
/// means the note is a genuine vault file from the moment it lands, no copy step needed.
fn runs_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join("C--Users-dev-Desktop-praxis")
            .join("memory")
            .join("runs"),
    )
}

/// Escape a string for safe embedding inside a single-quoted-free YAML frontmatter value
/// (the graph script's frontmatter regex expects `description: "..."` on one line).
fn fm_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "'")
        .replace(['\n', '\r'], " ")
}

/// Write one run-note markdown file into the vault's `runs/` subfolder. Best-effort by
/// design at the call site (orchestrator.ts wraps this in its own try/catch) - but the
/// command itself still surfaces real errors so a genuine misconfiguration is diagnosable.
#[tauri::command]
pub fn write_run_note(entry: RunNoteEntry) -> Result<(), String> {
    let dir = runs_dir().ok_or_else(|| "USERPROFILE not set".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("run-note mkdir: {e}"))?;

    let ok_count = entry.steps.iter().filter(|s| s.ok).count();
    let total = entry.steps.len();
    let outcome = if entry.done { "done" } else { "incomplete" };
    let models = if entry.models.is_empty() {
        "none".to_string()
    } else {
        entry.models.join(", ")
    };
    let goal_line = fm_escape(entry.goal.chars().take(160).collect::<String>().trim());

    let tools_list = entry
        .steps
        .iter()
        .map(|s| {
            format!(
                "- {} ({}) — {}",
                s.tool,
                s.model.clone().unwrap_or_else(|| "default".to_string()),
                if s.ok { "ok" } else { "failed" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let body = format!(
        "---\ndescription: \"{goal_line}\"\ntype: note\n---\n\n\
         # Agent run — {outcome}\n\n\
         **Goal:** {goal}\n\n\
         **Models:** {models}  \n\
         **Steps:** {ok_count}/{total} ok  \n\
         **Outcome:** {outcome}\n\n\
         ## Steps\n{tools_list}\n",
        goal_line = goal_line,
        outcome = outcome,
        goal = entry.goal.trim(),
        models = models,
        ok_count = ok_count,
        total = total,
        tools_list = if tools_list.is_empty() {
            "(no steps recorded)".to_string()
        } else {
            tools_list
        },
    );

    let path = dir.join(format!("run-{}.md", entry.ts));
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("run-note open {}: {e}", path.display()))?;
    f.write_all(body.as_bytes())
        .map_err(|e| format!("run-note write {}: {e}", path.display()))?;
    Ok(())
}
