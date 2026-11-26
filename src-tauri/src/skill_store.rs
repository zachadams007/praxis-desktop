//! skill_store.rs - the Learning-loop's seed: persist reusable "skills" Praxis
//! successfully performed so it can re-run them later (compounding, not one-shot).
//!
//! Two Tauri commands over `%LOCALAPPDATA%\Praxis\skills.jsonl`:
//!   • `skill_save(entry)` - append one skill as a JSON line.
//!   • `skill_list()` - read them all back, DEDUPED BY NAME (newest wins).
//!
//! A "skill" is derived by the frontend after a genuinely-done orchestrate() run:
//!
//! ```json
//! {"name":"deploy the site","goal":"deploy the site to prod",
//!  "steps":[{"tool":"claude","model":"opus","prompt":"…"}],
//!  "summary":"shipped","ts":1751446800000}
//! ```
//!
//! JSONL on purpose (mirrors run_ledger.rs): append-only, crash-safe per line,
//! trivially greppable, no DB. The schema is DELIBERATELY LOOSE - each line is a
//! raw `serde_json::Value`, so the frontend owns the shape and can add fields
//! (like a future `runs` count) without a Rust migration. File handling mirrors
//! run_ledger.rs / usage.rs: create the dir, append, never panic.

use std::io::{BufRead, Write};

/// `%LOCALAPPDATA%\Praxis\skills.jsonl` - same home as runs.jsonl / usage.json.
fn skills_file_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("skills.jsonl"))
}

/// Append one skill entry as a JSON line. Errors are RETURNED (not panicked) so
/// the frontend's best-effort capture path can swallow them without crashing.
///
/// `entry` is schema-loose (raw JSON) so the frontend owns the shape; we only
/// require it to be a JSON object with a non-empty string `name` (the dedupe
/// key `skill_list` uses) - a nameless skill can never be re-invoked, so it is
/// rejected rather than silently orphaned.
#[tauri::command]
pub fn skill_save(entry: serde_json::Value) -> Result<(), String> {
    // A nameless skill can never be re-invoked, so reject it rather than silently
    // orphaning it. `name` is validation-only here (skill_list dedupes by it on read).
    entry
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "skill entry missing a non-empty `name`".to_string())?;

    let path = skills_file_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("skill store mkdir: {e}"))?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| format!("skill store serialize: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("skill store open: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("skill store write: {e}"))?;
    Ok(())
}

/// Read every saved skill back, DEDUPED BY NAME with NEWEST WINS.
///
/// The file is append-only, so re-saving a skill of the same name simply appends
/// a fresher line; on read we walk newest-last and keep the LAST occurrence of
/// each name, then return them in the file's order (stable, oldest-first among
/// the survivors). A missing file (never saved yet) is not an error - returns [].
/// Corrupt/blank lines are skipped so one bad append can't poison the list.
#[tauri::command]
pub fn skill_list() -> Result<Vec<serde_json::Value>, String> {
    let path = skills_file_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        // No file yet = no skills captured. Not an error.
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("skill store open: {e}")),
    };

    // Parse every valid line into (name, value), preserving file order.
    let mut parsed: Vec<(String, serde_json::Value)> = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue, // unreadable line - skip, don't fail the whole list
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // corrupt JSON line - skip
        };
        let name = match value.get("name").and_then(|v| v.as_str()).map(str::trim) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue, // nameless - can't dedupe or re-invoke, skip
        };
        parsed.push((name, value));
    }

    // Dedupe by name, newest wins: for each name remember the LAST index seen.
    use std::collections::HashMap;
    let mut last_idx: HashMap<&str, usize> = HashMap::new();
    for (i, (name, _)) in parsed.iter().enumerate() {
        last_idx.insert(name.as_str(), i);
    }

    // Emit survivors in file order (stable), keeping only the winning index.
    let out: Vec<serde_json::Value> = parsed
        .iter()
        .enumerate()
        .filter(|(i, (name, _))| last_idx.get(name.as_str()) == Some(i))
        .map(|(_, (_, value))| value.clone())
        .collect();

    Ok(out)
}
