//! board_meeting.rs - the 6am "all agents meet" digest.
//!
//! Five sections: done yesterday, confirmed completed, in progress now, next/open, needs the owner's
//! input.
//!
//! This module owns the READ side (gathering raw facts from every real data source) and
//! the WRITE side (persisting the finished digest as a vault note + firing a notification).
//! The COMPRESS side (turning raw facts into the 5-section bullet digest) is deliberately
//! NOT here - that's a `brain_chat` call, which only exists as an async HTTP round trip
//! already wired in hermes_bridge.rs and callable straight from the frontend. So the split
//! is: `board_meeting_gather` (Rust, fast, local I/O only) → brain compresses in TS →
//! `board_meeting_write` (Rust, persists the result). Mirrors the run_ledger/run_notes
//! split: one command gathers/logs, a sibling command turns it into a vault artifact.
//!
//! Every read here is best-effort: a missing file/dir returns empty data, never an error,
//! because this digest must still generate something useful even on a machine where the
//! app has never run before (fresh install, or the MSIX-sandbox stale-copy gotcha).

use serde::Serialize;

// ── Source paths ─────────────────────────────────────────────────────────────

/// `%LOCALAPPDATA%\Praxis\runs.jsonl` - same path run_ledger.rs appends to.
fn runs_ledger_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("runs.jsonl"))
}

/// `%LOCALAPPDATA%\Praxis\usage.json` - same accumulator usage.rs reads/writes.
fn usage_json_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("usage.json"))
}

/// `%LOCALAPPDATA%\Praxis\research-inbox.md` - a parallel lane's research-agent ideas
/// inbox. May not exist yet (built by a different in-flight lane) - read defensively.
fn research_inbox_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("research-inbox.md"))
}

/// The real Obsidian vault's `memory/runs/` - where run_notes.rs drops one .md per run.
fn run_notes_dir() -> Option<std::path::PathBuf> {
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

/// The vault's `memory/boardroom/` - where this module writes the finished digest.
fn boardroom_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join("C--Users-dev-Desktop-praxis")
            .join("memory")
            .join("boardroom"),
    )
}

/// The vault's `memory/organization/` - where `org_scan.rs` (Atlas's sweep) drops
/// `org-report-YYYY-MM-DD.md`. Read-only here; this module never writes to it.
fn organization_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join("C--Users-dev-Desktop-praxis")
            .join("memory")
            .join("organization"),
    )
}

/// `%LOCALAPPDATA%\Praxis\memory-graph.json` - same runtime path `memory_graph.rs`
/// writes to (`refresh_memory_graph`/`read_memory_graph`). Read defensively: a
/// fresh install or a galaxy window that's never been opened yet may not have
/// built one, and that must never block the digest.
fn memory_graph_json_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("memory-graph.json"))
}

/// The intent ledger index - same absolute path memory_todo.rs already reads.
const INTENT_INDEX_PATH: &str =
    r"C:\Users\dev\.claude\projects\C--Users-dev-Desktop-praxis\memory\intent\INDEX.md";

// ── Mechanical caps (the hard length rule lives here, not just in the prompt) ──

/// Hard ceiling on how many raw run-ledger lines feed the brain - most-recent first.
/// The brain is ALSO told to keep the digest to <=40 bullets total; this cap keeps the
/// INPUT small too, so a chatty day of 200 runs can't blow the prompt budget.
const MAX_RUNS_IN: usize = 40;
/// Hard ceiling on intent-ledger "Open now" lines fed in.
const MAX_OPEN_NOW_IN: usize = 20;
/// Hard ceiling on run-note filenames listed (recency signal only, not full bodies).
const MAX_RUN_NOTES_IN: usize = 20;
/// Truncate any single free-text field (goal/summary/research line) to this many chars
/// before it reaches the prompt - a single giant summary shouldn't eat the whole budget.
const MAX_FIELD_CHARS: usize = 220;
/// Hard ceiling on how many chars of research-inbox.md get read at all.
const MAX_RESEARCH_CHARS: usize = 6000;
/// Hard ceiling on how many chars of the latest org-report get read (Atlas's input).
const MAX_ORG_REPORT_CHARS: usize = 4000;
/// Hard ceiling on per-agent (Forge/Vega) runs fed to their own contribution prompt -
/// smaller than MAX_RUNS_IN since this is ONE agent's slice, not the whole ledger.
const MAX_AGENT_RUNS_IN: usize = 20;

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(n.saturating_sub(1)).collect();
        format!("{}…", truncated.trim_end())
    }
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/// One condensed run-ledger entry (mirrors RunEntry from run_ledger.rs, trimmed).
#[derive(Serialize, Clone)]
pub struct BoardRun {
    pub ts: u64,
    pub goal: String,
    pub done: bool,
    pub tools: Vec<String>,
    pub ok_steps: u32,
    pub total_steps: u32,
}

/// Raw facts gathered from every source, mechanically capped, handed to the brain to
/// compress. Every field is best-effort - absent source = empty vec/string, never Err.
#[derive(Serialize)]
pub struct BoardInputs {
    /// Runs from roughly the last 24h (falls back to the most recent N regardless of
    /// age if the ledger has no timestamp coverage in that window - an idle day still
    /// gets whatever's most recent rather than an empty digest).
    pub recent_runs: Vec<BoardRun>,
    /// Age of the newest run in `recent_runs`, in whole days, when NOTHING fell inside
    /// the 24h window. `None` means the runs really are from the last day.
    ///
    /// Without this the digest prints two-month-old work under the heading "WHAT WAS DONE
    /// YESTERDAY". The fallback itself is right (an idle day should still show real history);
    /// presenting it as yesterday's work is the bug.
    pub recent_runs_age_days: Option<u64>,
    pub total_runs_in_ledger: usize,
    /// Filenames of the most recent run-notes (vault artifacts) - recency signal for
    /// "what was done", independent of the JSONL ledger.
    pub recent_run_note_files: Vec<String>,
    /// Intent ledger "Open now" bullets (status emoji + date + title), most-recent-first.
    pub open_now: Vec<String>,
    pub spend_by_tool: Vec<(String, f64)>,
    /// Distinct models used across the ledger, for a one-line "fleet touched" summary.
    pub models_active: Vec<String>,
    /// Raw contents of research-inbox.md if present (a parallel lane's research-agent
    /// ideas file) - capped to MAX_RESEARCH_CHARS. Empty string if absent.
    pub research_inbox: String,
    /// Whether research_inbox.md existed at all (lets the brain/prompt distinguish
    /// "no new ideas" from "the file doesn't exist yet").
    pub research_inbox_present: bool,
    /// Runs whose steps used the "claude" tool (Forge's own delegations), most-recent
    /// first, capped to MAX_AGENT_RUNS_IN - Forge's contribution prompt summarizes ONLY
    /// these, not the whole fleet's ledger.
    pub forge_runs: Vec<BoardRun>,
    /// Runs whose steps used the "codex" tool (Vega's own delegations), same shape.
    pub vega_runs: Vec<BoardRun>,
    /// Latest org-report body (Atlas's organization sweep - `org_scan.rs`), capped to
    /// MAX_ORG_REPORT_CHARS. Empty string if no report has ever been written.
    pub latest_org_report: String,
    /// Filename of the org-report actually read (e.g. "org-report-2026-07-05.md"),
    /// for the prompt to cite; empty if none present.
    pub latest_org_report_file: String,
    /// Mechanical (non-LLM) vault/graph stats from the last-built memory-graph.json -
    /// Scribe's contribution is computed straight from these counts, no model call.
    pub vault_stats: VaultStats,
}

/// Mechanical counts pulled from memory-graph.json - no LLM involved. Every field
/// defaults to 0/empty when the graph hasn't been built yet (fresh install / galaxy
/// window never opened) so Scribe's contribution degrades to "no graph yet" rather
/// than erroring.
#[derive(Serialize, Default)]
pub struct VaultStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    /// (area id, node count) pairs, largest first.
    pub nodes_by_area: Vec<(String, usize)>,
    /// (kind/type, node count) pairs, largest first.
    pub nodes_by_kind: Vec<(String, usize)>,
    pub orphan_count: usize,
    pub present: bool,
}

// ── Run ledger read ───────────────────────────────────────────────────────────

/// Loosely-typed line reader - tolerates the real RunEntry shape without depending on
/// run_ledger.rs's private types (keeps this module independent / read-only).
fn read_runs_ledger() -> Vec<BoardRun> {
    let path = match runs_ledger_path() {
        Some(p) => p,
        None => return vec![],
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
        let goal = v
            .get("goal")
            .and_then(|x| x.as_str())
            .map(|s| clip(s, MAX_FIELD_CHARS))
            .unwrap_or_default();
        let done = v.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
        let steps = v
            .get("steps")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let tools: Vec<String> = steps
            .iter()
            .filter_map(|s| {
                s.get("tool")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        let ok_steps = steps
            .iter()
            .filter(|s| s.get("ok").and_then(|o| o.as_bool()).unwrap_or(false))
            .count() as u32;
        let total_steps = steps.len() as u32;
        if goal.is_empty() {
            continue;
        }
        out.push(BoardRun {
            ts,
            goal,
            done,
            tools,
            ok_steps,
            total_steps,
        });
    }
    // Newest first.
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const ONE_DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Prefer runs from the last 24h; if that window is empty (quiet day, or a run whose
/// clock predates today), fall back to the most recent MAX_RUNS_IN regardless of age
/// so the digest is never manufactured from nothing when the ledger has real history.
fn window_runs(all: &[BoardRun]) -> Vec<BoardRun> {
    window_runs_aged(all).0
}

/// Runs plus "how old is this, really".
///
/// Returns `(runs, Some(days))` when the 24h window was EMPTY and we fell back to
/// history, so the caller can say so out loud instead of letting the digest's
/// "what was done yesterday" heading speak for a July run.
fn window_runs_aged(all: &[BoardRun]) -> (Vec<BoardRun>, Option<u64>) {
    let now = now_ms();
    let cutoff = now.saturating_sub(ONE_DAY_MS);
    let recent: Vec<BoardRun> = all.iter().filter(|r| r.ts >= cutoff).cloned().collect();
    if !recent.is_empty() {
        return (recent.into_iter().take(MAX_RUNS_IN).collect(), None);
    }
    let chosen: Vec<BoardRun> = all.iter().cloned().take(MAX_RUNS_IN).collect();
    let newest = chosen.iter().map(|r| r.ts).max();
    let age_days = newest.map(|ts| now.saturating_sub(ts) / ONE_DAY_MS);
    (chosen, age_days)
}

/// Split the full (unwindowed) run list by which tool its steps used - Forge's own
/// delegations (tool "claude") vs Vega's (tool "codex"). A run can touch both tools
/// across its steps (rare, but the ledger allows it); it counts toward BOTH agents'
/// slices in that case, since both genuinely contributed to it. Newest-first, capped
/// to MAX_AGENT_RUNS_IN - this is one agent's own report to the board, not the whole
/// fleet's ledger, so a smaller cap than MAX_RUNS_IN is deliberate.
fn runs_for_tool(all: &[BoardRun], tool: &str) -> Vec<BoardRun> {
    all.iter()
        .filter(|r| r.tools.iter().any(|t| t == tool))
        .cloned()
        .take(MAX_AGENT_RUNS_IN)
        .collect()
}

// ── Run notes (vault) read ───────────────────────────────────────────────────

fn read_recent_run_note_files() -> Vec<String> {
    let dir = match run_notes_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut files: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, name))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(MAX_RUN_NOTES_IN)
        .map(|(_, n)| n)
        .collect()
}

// ── Intent ledger "Open now" read (mirrors memory_todo.rs's parse, generalized) ──

const OPEN_NOW_HEADING: &str = "## 🔴 Open now";

fn extract_open_now_lines(content: &str) -> Vec<String> {
    let mut in_section = false;
    let mut out = Vec::new();
    for line in content.lines() {
        if line.trim_start().starts_with(OPEN_NOW_HEADING) {
            in_section = true;
            continue;
        }
        if in_section && line.trim_start().starts_with("## ") {
            break;
        }
        if in_section {
            let trimmed = line.trim();
            if trimmed.starts_with("- ") {
                out.push(clip(trimmed, MAX_FIELD_CHARS));
            }
        }
    }
    out.into_iter().take(MAX_OPEN_NOW_IN).collect()
}

fn read_open_now() -> Vec<String> {
    match std::fs::read_to_string(INTENT_INDEX_PATH) {
        Ok(content) => extract_open_now_lines(&content),
        Err(_) => vec![],
    }
}

/// Ceiling for "is this number dollars?". Deliberately generous so a real month can never trip
/// it.
const MAX_PLAUSIBLE_TOOL_SPEND_USD: f64 = 1_000.0;

// ── Usage read ────────────────────────────────────────────────────────────────

fn read_spend_by_tool() -> Vec<(String, f64)> {
    let path = match usage_json_path() {
        Some(p) => p,
        None => return vec![],
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let v: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return vec![],
    };
    let mut out = Vec::new();
    for (k, val) in obj {
        // usage.json is a MIXED map: provider spend totals live beside bookkeeping.
        //
        // Two guards, because either alone would have missed it:
        //   * `_`-prefixed keys are bookkeeping by convention (APPLIED_LEDGER_SEQUENCE_KEY).
        //   * the value must be a plausible dollar amount, not a monotonic counter.
        if k == "models" || k.starts_with('_') {
            continue;
        }
        if let Some(f) = val.as_f64() {
            // A spend total is finite and non-negative. A sequence number is not spend
            // whatever it is called, so anything absurd for a personal tool budget is
            // reported as unknown rather than as dollars.
            if !f.is_finite() || f < 0.0 || f > MAX_PLAUSIBLE_TOOL_SPEND_USD {
                crate::elog!(
                    "[board] usage.json key {k:?} = {f} is not a plausible spend total;                      omitting it rather than reporting it as dollars"
                );
                continue;
            }
            out.push((k.clone(), f));
        }
    }
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Distinct model ids from usage.json's "models" map, for a one-line "fleet touched" hint.
fn read_models_active() -> Vec<String> {
    let path = match usage_json_path() {
        Some(p) => p,
        None => return vec![],
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let v: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    v.get("models")
        .and_then(|m| m.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

// ── Research inbox read (defensive - a parallel lane may or may not have built it) ──

fn read_research_inbox() -> (String, bool) {
    let path = match research_inbox_path() {
        Some(p) => p,
        None => return (String::new(), false),
    };
    match std::fs::read_to_string(&path) {
        Ok(c) => {
            let capped: String = c.chars().take(MAX_RESEARCH_CHARS).collect();
            (capped, true)
        }
        Err(_) => (String::new(), false),
    }
}

// ── Org-report read (Atlas's organization sweep - defensive, may not exist yet) ──

/// Find + read the most recently modified `org-report-*.md` in `memory/organization/`.
/// Returns (body capped to MAX_ORG_REPORT_CHARS, filename) or ("", "") if none exists.
fn read_latest_org_report() -> (String, String) {
    let dir = match organization_dir() {
        Some(d) => d,
        None => return (String::new(), String::new()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return (String::new(), String::new()),
    };
    let newest = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("org-report-") || !name.ends_with(".md") {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, name, e.path()))
        })
        .max_by_key(|(m, _, _)| *m);

    match newest {
        Some((_, name, path)) => match std::fs::read_to_string(&path) {
            Ok(c) => (c.chars().take(MAX_ORG_REPORT_CHARS).collect(), name),
            Err(_) => (String::new(), String::new()),
        },
        None => (String::new(), String::new()),
    }
}

// ── Vault stats read (Scribe's MECHANICAL - no LLM - contribution source) ───────

/// Pull counts straight out of the last-built memory-graph.json: total nodes/edges,
/// per-area and per-kind breakdowns, orphan count. Zero LLM calls - Scribe's board
/// contribution is generated entirely from this struct in the frontend. Best-effort:
/// any read/parse failure (graph never built, corrupt file) reads as `present: false`
/// rather than an error, since a fresh install has no graph yet.
fn read_vault_stats() -> VaultStats {
    let path = match memory_graph_json_path() {
        Some(p) => p,
        None => return VaultStats::default(),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return VaultStats::default(),
    };
    let v: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return VaultStats::default(),
    };

    let nodes = v
        .get("nodes")
        .and_then(|n| n.as_array())
        .cloned()
        .unwrap_or_default();
    let edges = v
        .get("edges")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    let mut by_area: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut by_kind: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut orphan_count = 0usize;

    for n in &nodes {
        let kind = n.get("kind").and_then(|x| x.as_str()).unwrap_or("unknown");
        if kind == "hub" {
            continue; // area hubs aren't real content - don't count them as notes
        }
        let area = n.get("area").and_then(|x| x.as_str()).unwrap_or("unknown");
        *by_area.entry(area.to_string()).or_insert(0) += 1;
        *by_kind.entry(kind.to_string()).or_insert(0) += 1;
        let degree = n.get("degree").and_then(|x| x.as_u64()).unwrap_or(1);
        if degree == 0 {
            orphan_count += 1;
        }
    }

    let mut nodes_by_area: Vec<(String, usize)> = by_area.into_iter().collect();
    nodes_by_area.sort_by(|a, b| b.1.cmp(&a.1));
    let mut nodes_by_kind: Vec<(String, usize)> = by_kind.into_iter().collect();
    nodes_by_kind.sort_by(|a, b| b.1.cmp(&a.1));

    VaultStats {
        total_nodes: nodes.len(),
        total_edges: edges.len(),
        nodes_by_area,
        nodes_by_kind,
        orphan_count,
        present: true,
    }
}

// ── Tauri command: gather ────────────────────────────────────────────────────

/// `board_meeting_gather` - collect raw facts from every real source, mechanically
/// capped. Read-only, synchronous, cheap (small local files) - never touches the
/// network. Called by the frontend right before it asks the brain to compress this
/// into the 5-section digest.
#[tauri::command]
pub fn board_meeting_gather() -> Result<BoardInputs, String> {
    let all_runs = read_runs_ledger();
    let total_runs_in_ledger = all_runs.len();
    let (recent_runs, recent_runs_age_days) = window_runs_aged(&all_runs);
    let recent_run_note_files = read_recent_run_note_files();
    let open_now = read_open_now();
    let spend_by_tool = read_spend_by_tool();
    let models_active = read_models_active();
    let (research_inbox, research_inbox_present) = read_research_inbox();
    // Per-agent slices for the multi-agent board meeting (Forge/Vega each summarize
    // ONLY their own delegations) - sourced from the full ledger, not the windowed/
    // capped recent_runs, so a quiet day for one tool doesn't starve its slice.
    let forge_runs = runs_for_tool(&all_runs, "claude");
    let vega_runs = runs_for_tool(&all_runs, "codex");
    let (latest_org_report, latest_org_report_file) = read_latest_org_report();
    let vault_stats = read_vault_stats();

    Ok(BoardInputs {
        recent_runs,
        recent_runs_age_days,
        total_runs_in_ledger,
        recent_run_note_files,
        open_now,
        spend_by_tool,
        models_active,
        research_inbox,
        research_inbox_present,
        forge_runs,
        vega_runs,
        latest_org_report,
        latest_org_report_file,
        vault_stats,
    })
}

// ── Tauri command: write ─────────────────────────────────────────────────────

/// One agent's one-line status snapshot, appended to the digest doc so the vault note
/// captures shared-state at generation time (not just the brain's prose).
#[derive(serde::Deserialize)]
pub struct AgentSnapshotLine {
    pub name: String,
    pub role: String,
    pub status: String,
    /// Current task/focus, or null when idle.
    #[serde(default)]
    pub task: Option<String>,
}

/// Payload from the frontend after the brain has produced the digest text.
#[derive(serde::Deserialize)]
pub struct BoardMeetingEntry {
    /// The already-brain-compressed digest body (markdown bullets, 5 sections).
    pub digest_markdown: String,
    /// ISO date string (`YYYY-MM-DD`, local) - also the filename.
    pub date: String,
    /// Unix ms of generation.
    pub ts: u64,
    /// Live agent roster snapshot for the shared-state sync footer.
    #[serde(default)]
    pub agents: Vec<AgentSnapshotLine>,
    /// True when at least one input source had real data (lets the frontend/us know
    /// whether this was a substantive digest or a "quiet day" placeholder).
    #[serde(default)]
    pub had_data: bool,
}

fn fm_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "'")
        .replace(['\n', '\r'], " ")
}

/// `board_meeting_write` - persist the finished digest as a vault markdown note
/// (frontmatter compatible with build-memory-graph.cjs's `readFrontmatter`, same
/// convention run_notes.rs already uses) plus append the per-agent snapshot footer.
/// Returns the written file path on success.
#[tauri::command]
pub fn board_meeting_write(entry: BoardMeetingEntry) -> Result<String, String> {
    let dir = boardroom_dir().ok_or_else(|| "USERPROFILE not set".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("boardroom mkdir: {e}"))?;

    let title_line = format!("Board meeting — {}", entry.date);
    let desc = fm_escape(&clip(
        &format!("Praxis board meeting digest for {}", entry.date),
        160,
    ));

    let agent_lines = if entry.agents.is_empty() {
        "(no live roster at generation time)".to_string()
    } else {
        entry
            .agents
            .iter()
            .map(|a| {
                format!(
                    "- **{}** ({}) — {}{}",
                    a.name,
                    a.role,
                    a.status,
                    a.task
                        .as_ref()
                        .map(|t| format!(" — {t}"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let body = format!(
        "---\ndescription: \"{desc}\"\ntype: note\n---\n\n\
         # {title_line}\n\n\
         {digest}\n\n\
         ## Agent status at generation time\n{agent_lines}\n",
        desc = desc,
        title_line = title_line,
        digest = entry.digest_markdown.trim(),
        agent_lines = agent_lines,
    );

    let path = dir.join(format!("{}.md", entry.date));
    std::fs::write(&path, body).map_err(|e| format!("boardroom write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// `board_meeting_exists_today` - catch-up check: has today's digest already been
/// generated? Lets the frontend scheduler decide whether to fire on app start when
/// it's already past 6am. Best-effort: any I/O error reads as "not generated yet"
/// (never blocks catch-up on a transient FS hiccup).
#[tauri::command]
pub fn board_meeting_exists_today(date: String) -> Result<bool, String> {
    let dir = boardroom_dir().ok_or_else(|| "USERPROFILE not set".to_string())?;
    let path = dir.join(format!("{date}.md"));
    Ok(path.exists())
}

#[cfg(test)]
mod spend_tests {
    use super::*;

    /// Every non-provider key must be ignored, not rendered as dollars.
    #[test]
    fn bookkeeping_keys_are_never_reported_as_spend() {
        let raw = r#"{
            "claude": 4.59,
            "openai": 3.69,
            "_usage_ledger_applied_seq": 273,
            "models": { "gpt-6-astra": { "calls": 3 } }
        }"#;
        let v: serde_json::Value = serde_json::from_str(raw).expect("valid json");
        let obj = v.as_object().expect("object");
        let mut out: Vec<(String, f64)> = Vec::new();
        for (k, val) in obj {
            if k == "models" || k.starts_with('_') {
                continue;
            }
            if let Some(f) = val.as_f64() {
                if !f.is_finite() || f < 0.0 || f > MAX_PLAUSIBLE_TOOL_SPEND_USD {
                    continue;
                }
                out.push((k.clone(), f));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            out,
            vec![("claude".to_string(), 4.59), ("openai".to_string(), 3.69)],
            "only real provider spend may reach the board"
        );
        assert!(
            !out.iter().any(|(k, _)| k.starts_with('_')),
            "a sequence counter is not dollars"
        );
    }

    /// A counter that ever loses its underscore prefix must still not read as money.
    #[test]
    fn an_implausible_amount_is_omitted_rather_than_shown() {
        assert!(MAX_PLAUSIBLE_TOOL_SPEND_USD < 273_000.0);
        assert!(MAX_PLAUSIBLE_TOOL_SPEND_USD > 100.0, "a real month must never trip it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_long_strings_with_ellipsis() {
        let s = "a".repeat(300);
        let out = clip(&s, 220);
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= 220);
    }

    #[test]
    fn leaves_short_strings_untouched() {
        assert_eq!(clip("hello", 220), "hello");
    }

    #[test]
    fn extracts_open_now_bullets_only() {
        let doc = "# Header\n\n## 🔴 Open now\n\n- 🔜 `2026-07-02` **A**\n- ❓ `2026-07-02` **B**\nnot a bullet\n\n## Topics\n- other section\n";
        let lines = extract_open_now_lines(doc);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains('A'));
        assert!(lines[1].contains('B'));
    }

    #[test]
    fn window_runs_falls_back_to_most_recent_when_window_empty() {
        let old = BoardRun {
            ts: 1, // long ago - outside any 24h window from "now"
            goal: "old goal".to_string(),
            done: true,
            tools: vec!["claude".to_string()],
            ok_steps: 1,
            total_steps: 1,
        };
        let chosen = window_runs(&[old.clone()]);
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].goal, "old goal");
    }

    #[test]
    fn window_runs_caps_at_max_runs_in() {
        let many: Vec<BoardRun> = (0..(MAX_RUNS_IN as u64 + 10))
            .map(|i| BoardRun {
                ts: now_ms(), // all "now" so all fall inside the 24h window
                goal: format!("goal {i}"),
                done: true,
                tools: vec![],
                ok_steps: 1,
                total_steps: 1,
            })
            .collect();
        let chosen = window_runs(&many);
        assert_eq!(chosen.len(), MAX_RUNS_IN);
    }

    fn run_with_tools(goal: &str, tools: &[&str]) -> BoardRun {
        BoardRun {
            ts: now_ms(),
            goal: goal.to_string(),
            done: true,
            tools: tools.iter().map(|s| s.to_string()).collect(),
            ok_steps: 1,
            total_steps: 1,
        }
    }

    #[test]
    fn runs_for_tool_splits_forge_and_vega_by_step_tool() {
        let all = vec![
            run_with_tools("claude thing", &["claude"]),
            run_with_tools("codex thing", &["codex"]),
            run_with_tools("both", &["claude", "codex"]),
            run_with_tools("neither", &["cursor"]),
        ];
        let forge = runs_for_tool(&all, "claude");
        let vega = runs_for_tool(&all, "codex");
        assert_eq!(forge.len(), 2); // "claude thing" + "both"
        assert!(forge.iter().any(|r| r.goal == "claude thing"));
        assert!(forge.iter().any(|r| r.goal == "both"));
        assert_eq!(vega.len(), 2); // "codex thing" + "both"
        assert!(vega.iter().any(|r| r.goal == "codex thing"));
        assert!(vega.iter().any(|r| r.goal == "both"));
    }

    #[test]
    fn runs_for_tool_caps_at_max_agent_runs_in() {
        let many: Vec<BoardRun> = (0..(MAX_AGENT_RUNS_IN + 5))
            .map(|i| run_with_tools(&format!("goal {i}"), &["claude"]))
            .collect();
        let forge = runs_for_tool(&many, "claude");
        assert_eq!(forge.len(), MAX_AGENT_RUNS_IN);
    }

    #[test]
    fn vault_stats_default_is_absent_not_erroring() {
        let stats = VaultStats::default();
        assert!(!stats.present);
        assert_eq!(stats.total_nodes, 0);
        assert_eq!(stats.orphan_count, 0);
    }
}
pub fn spawn(app: tauri::AppHandle, running: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let last_run_path = match crate::praxis_dir() {
                Some(dir) => dir.join("board-last-run.txt"),
                None => return,
            };

            while running.load(std::sync::atomic::Ordering::SeqCst) {
                let (today, hour) = local_now();
                let ran_today = std::fs::read_to_string(&last_run_path)
                    .map(|last_run| last_run.trim() == today)
                    .unwrap_or(false);

                if hour >= 6 && !ran_today {
                    let _ = tauri::Emitter::emit(&app, "praxis://run-board-meeting", ());

                    if let Some(parent) = last_run_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }

                    let _ = std::fs::write(&last_run_path, format!("{today}\n"));
                }

                for _ in 0..30 {
                    if !running.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }

                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
        }));
    });
}

/// Local wall-clock date ("YYYY-MM-DD") + hour (0..23). This crate deliberately has no
/// `chrono`; on Windows the OS gives us DST-correct local time directly via `GetLocalTime`
/// (no timezone math), matching the raw-Win32 style already used in lib.rs. The non-Windows
/// branch falls back to UTC - fine, since Praxis only ships on Windows.
#[cfg(windows)]
fn local_now() -> (String, u32) {
    #[repr(C)]
    struct SYSTEMTIME {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    extern "system" {
        fn GetLocalTime(lp_system_time: *mut SYSTEMTIME);
    }
    let mut st = SYSTEMTIME {
        w_year: 1970,
        w_month: 1,
        w_day_of_week: 0,
        w_day: 1,
        w_hour: 0,
        w_minute: 0,
        w_second: 0,
        w_milliseconds: 0,
    };
    unsafe { GetLocalTime(&mut st) };
    (
        format!("{:04}-{:02}-{:02}", st.w_year, st.w_month, st.w_day),
        st.w_hour as u32,
    )
}

#[cfg(not(windows))]
fn local_now() -> (String, u32) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86_400;
    let hour = ((secs % 86_400) / 3_600) as u32;
    // Civil date from days-since-epoch (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (format!("{:04}-{:02}-{:02}", y, m, d), hour)
}
