//! Global Prompt Vault - Praxis-wide active memory of prompts.
//!
//! Today the prompt vault is Flight-Deck-local: `fd_read_vault` / `fd_write_vault`
//! (in flightdeck.rs) persist per-LANE entries `{id, prompt, model, effort}` under a
//! single JSON keyed by lane id. The owner's locked intent is a vault that is:
//!
//!   • GLOBAL - every prompt sent anywhere in Praxis (Flight Deck, Mission voice,
//!     Atlas voice, Command Center, or a manual save) can be stored + searched from
//!     one place, not siloed per lane.
//!   • ACTIVE - when an agent RUNS a stored prompt, the outcome (done/failed/
//!     interrupted + a short result snippet) is written back into that entry's
//!     `history`, so the vault accrues a real track record per prompt.
//!
//! ── STORE ─────────────────────────────────────────────────────────────────────
//!   %LOCALAPPDATA%\Praxis\prompt-vault.json  (via `crate::praxis_dir()`, which is
//!   `Option<PathBuf>` - a missing LOCALAPPDATA yields an honest empty/Err, never a
//!   panic). Writes are atomic (tmp + rename), mirroring `flow_runner::persist`.
//!
//! ── SCHEMA (camelCase on the wire - the frontend lane consumes this) ────────────
//!   { version, entries: [ {
//!       id, text, model?, effort?, tags: [], laneHint?,
//!       source ("flightdeck"|"mission"|"voice"|"cc"|"manual"),
//!       createdAt, updatedAt,
//!       history: [ { firedAt, driver, agent?, cwd?,
//!                    outcome ("done"|"failed"|"interrupted"), resultSnippet } ]
//!   } ] }
//!
//! ── MIGRATION (non-destructive) ────────────────────────────────────────────────
//!   On the FIRST load (no prompt-vault.json yet) we import every lane entry from the
//!   existing Flight Deck vault (`app_data_dir()/flight-deck-vault.json` - the exact
//!   file `fd_read_vault` reads) as global entries with source "flightdeck" and
//!   laneHint = the lane id. The FD vault file is left UNTOUCHED, so `fd_read_vault`/
//!   `fd_write_vault` keep working unchanged until the new global UI fully lands.
//!
//! Every mutating command emits `praxis://pv-update` so any window live-refreshes.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

const VAULT_VERSION: u32 = 1;
const SNIPPET_MAX: usize = 500;

// ── Schema ─────────────────────────────────────────────────────────────────────

/// One run of a stored prompt written back after the agent finishes - this is what
/// makes the vault "active" rather than a dead prompt list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub fired_at: u64,
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// "done" | "failed" | "interrupted".
    pub outcome: String,
    /// ≤ 500 chars; longer snippets are truncated on the way in.
    #[serde(default)]
    pub result_snippet: String,
}

impl HistoryItem {
    /// Clamp the snippet to SNIPPET_MAX chars (char-boundary safe) so a giant agent
    /// transcript never bloats the vault file.
    fn sanitized(mut self) -> Self {
        self.result_snippet = truncate_chars(&self.result_snippet, SNIPPET_MAX);
        if self.outcome.trim().is_empty() {
            self.outcome = "done".to_string();
        }
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_hint: Option<String>,
    /// "flightdeck" | "mission" | "voice" | "cc" | "manual".
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub history: Vec<HistoryItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub version: u32,
    pub entries: Vec<VaultEntry>,
}

impl Vault {
    fn empty() -> Self {
        Vault {
            version: VAULT_VERSION,
            entries: Vec::new(),
        }
    }
}

// ── Time + ids ───────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Monotonic-ish unique id without pulling a uuid/rand crate: epoch-ms + a process
/// counter, so two adds in the same millisecond still differ.
fn gen_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("pv-{}-{}", now_ms(), n)
}

/// Truncate to `max` CHARS (not bytes) so we never split a UTF-8 codepoint.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// %LOCALAPPDATA%\Praxis\prompt-vault.json - the global store. `None` when
/// LOCALAPPDATA is unset (`crate::praxis_dir()` is `Option`), which every caller
/// degrades to empty/Err rather than panicking on.
fn vault_path() -> Option<PathBuf> {
    let dir = crate::praxis_dir()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("prompt-vault.json"))
}

/// The EXACT file `flightdeck::fd_read_vault` reads: `app_data_dir()/flight-deck-vault.json`.
/// Used read-only for the one-time migration; never written here.
fn fd_vault_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("flight-deck-vault.json"))
}

// ── Disk I/O (pure - unit-testable without an AppHandle) ──────────────────────

fn load_from(path: &PathBuf) -> Option<Vault> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Vault>(&raw).ok()
}

/// Atomic write: serialize → tmp → rename, mirroring `flow_runner::persist` so a
/// crash mid-write never leaves a truncated prompt-vault.json.
fn save_to(path: &PathBuf, vault: &Vault) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(vault).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ── Migration (pure - takes the parsed FD vault Value) ────────────────────────

/// Convert the Flight Deck vault JSON (`{ lanes: { <laneId>: VaultEntry[] } }`) into
/// global entries. Each FD lane entry `{id, title, prompt, model, effort, createdAt,
/// firedAt?, fireResult?, fireError?}` becomes one global entry with source
/// "flightdeck" and laneHint = its lane id. If the FD entry was already fired once,
/// that outcome is seeded as the first `history` item so the track record carries
/// over. Best-effort + tolerant: malformed lanes/entries are skipped, never fatal.
fn migrate_fd_value(fd: &Value) -> Vec<VaultEntry> {
    let now = now_ms();
    let mut out = Vec::new();
    let Some(lanes) = fd.get("lanes").and_then(|v| v.as_object()) else {
        return out;
    };
    for (lane_id, entries) in lanes {
        let Some(arr) = entries.as_array() else {
            continue;
        };
        for e in arr {
            let prompt = e
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if prompt.is_empty() {
                continue;
            }
            let id = e
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(gen_id);
            let model = e
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let effort = e
                .get("effort")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            // Preserve the FD entry's title as a searchable tag when present.
            let tags: Vec<String> = e
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| vec![s.trim().to_string()])
                .unwrap_or_default();
            let created_at = e.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(now);

            // Seed one history item if the FD prompt was already fired.
            let mut history = Vec::new();
            if let Some(fired_at) = e.get("firedAt").and_then(|v| v.as_u64()) {
                let err = e.get("fireError").and_then(|v| v.as_str()).unwrap_or("");
                let res = e.get("fireResult").and_then(|v| v.as_str()).unwrap_or("");
                let (outcome, snippet) = if !err.is_empty() {
                    ("failed", err)
                } else if !res.is_empty() {
                    ("done", res)
                } else {
                    ("done", "")
                };
                history.push(
                    HistoryItem {
                        fired_at,
                        driver: "flightdeck".to_string(),
                        agent: None,
                        cwd: None,
                        outcome: outcome.to_string(),
                        result_snippet: snippet.to_string(),
                    }
                    .sanitized(),
                );
            }

            out.push(VaultEntry {
                id,
                text: prompt.to_string(),
                model,
                effort,
                tags,
                lane_hint: Some(lane_id.clone()),
                source: "flightdeck".to_string(),
                created_at,
                updated_at: now,
                history,
            });
        }
    }
    out
}

// ── Entry normalization + search (pure) ───────────────────────────────────────

/// Coerce a caller-supplied `entry` Value into a well-formed VaultEntry, filling any
/// missing id/timestamps/source so the frontend can send a partial draft and still
/// get a valid, persisted entry back.
fn normalize_incoming(v: &Value) -> VaultEntry {
    let now = now_ms();
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(gen_id);
    let text = v
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let model = v
        .get("model")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let effort = v
        .get("effort")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let tags = v
        .get("tags")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let lane_hint = v
        .get("laneHint")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let source = v
        .get("source")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("manual")
        .to_string();
    let created_at = v.get("createdAt").and_then(|x| x.as_u64()).unwrap_or(now);
    let history = v
        .get("history")
        .and_then(|x| serde_json::from_value::<Vec<HistoryItem>>(x.clone()).ok())
        .unwrap_or_default()
        .into_iter()
        .map(HistoryItem::sanitized)
        .collect();
    VaultEntry {
        id,
        text,
        model,
        effort,
        tags,
        lane_hint,
        source,
        created_at,
        updated_at: now,
        history,
    }
}

/// Merge a JSON `patch` onto an existing entry (only present keys change). `id`,
/// `createdAt`, and `history` are NOT patchable here - history flows through
/// `pv_record_outcome`, and id/createdAt are stable identity. `updatedAt` is bumped.
fn apply_patch(entry: &mut VaultEntry, patch: &Value) {
    if let Some(t) = patch.get("text").and_then(|v| v.as_str()) {
        entry.text = t.to_string();
    }
    if patch.get("model").is_some() {
        entry.model = patch
            .get("model")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }
    if patch.get("effort").is_some() {
        entry.effort = patch
            .get("effort")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }
    if let Some(arr) = patch.get("tags").and_then(|v| v.as_array()) {
        entry.tags = arr
            .iter()
            .filter_map(|t| t.as_str().map(|s| s.to_string()))
            .collect();
    }
    if patch.get("laneHint").is_some() {
        entry.lane_hint = patch
            .get("laneHint")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }
    if let Some(s) = patch
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        entry.source = s.to_string();
    }
    entry.updated_at = now_ms();
}

/// Case-insensitive substring match over `text` + every tag.
fn search_entries(entries: &[VaultEntry], query: &str) -> Vec<VaultEntry> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return entries.to_vec();
    }
    entries
        .iter()
        .filter(|e| {
            e.text.to_lowercase().contains(&q)
                || e.tags.iter().any(|t| t.to_lowercase().contains(&q))
        })
        .cloned()
        .collect()
}

// ── Load with first-run migration (needs app for the FD path) ─────────────────

/// Load the global vault. On the very first load (no prompt-vault.json yet) this
/// imports the Flight Deck vault non-destructively and persists the result, so the
/// migration runs exactly once. A missing LOCALAPPDATA degrades to an empty vault.
fn load_or_migrate(app: &AppHandle) -> Vault {
    let Some(path) = vault_path() else {
        return Vault::empty();
    };
    if let Some(v) = load_from(&path) {
        return v;
    }
    // First run: seed from the Flight Deck vault (read-only), then persist.
    let mut vault = Vault::empty();
    if let Some(fd_path) = fd_vault_path(app) {
        if let Ok(raw) = fs::read_to_string(&fd_path) {
            if let Ok(fd_val) = serde_json::from_str::<Value>(&raw) {
                vault.entries = migrate_fd_value(&fd_val);
            }
        }
    }
    let _ = save_to(&path, &vault);
    vault
}

fn persist_and_emit(app: &AppHandle, vault: &Vault) -> Result<(), String> {
    let path = vault_path()
        .ok_or_else(|| "LOCALAPPDATA not set; cannot write prompt vault".to_string())?;
    save_to(&path, vault)?;
    let _ = app.emit("praxis://pv-update", vault.clone());
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Full global vault (runs the one-time FD migration on first ever call).
#[tauri::command]
pub fn pv_list(app: AppHandle) -> Vault {
    load_or_migrate(&app)
}

/// Add a new entry. Accepts a partial draft (missing id/timestamps/source are filled).
/// Returns the stored entry.
#[tauri::command]
pub fn pv_add(app: AppHandle, entry: Value) -> Result<VaultEntry, String> {
    let mut vault = load_or_migrate(&app);
    let e = normalize_incoming(&entry);
    vault.entries.push(e.clone());
    persist_and_emit(&app, &vault)?;
    Ok(e)
}

/// Patch an existing entry by id (only present keys change). Errors if id is unknown.
#[tauri::command]
pub fn pv_update(app: AppHandle, id: String, patch: Value) -> Result<VaultEntry, String> {
    let mut vault = load_or_migrate(&app);
    let Some(entry) = vault.entries.iter_mut().find(|e| e.id == id) else {
        return Err(format!("prompt vault: no entry with id '{id}'"));
    };
    apply_patch(entry, &patch);
    let updated = entry.clone();
    persist_and_emit(&app, &vault)?;
    Ok(updated)
}

/// Remove an entry by id. Returns true if something was removed.
#[tauri::command]
pub fn pv_remove(app: AppHandle, id: String) -> Result<bool, String> {
    let mut vault = load_or_migrate(&app);
    let before = vault.entries.len();
    vault.entries.retain(|e| e.id != id);
    let removed = vault.entries.len() != before;
    if removed {
        persist_and_emit(&app, &vault)?;
    }
    Ok(removed)
}

/// Append a run outcome to an entry's history - the "active" write-back. `updatedAt`
/// is bumped so a live view floats recently-run prompts. Errors if id is unknown.
#[tauri::command]
pub fn pv_record_outcome(
    app: AppHandle,
    id: String,
    history_item: HistoryItem,
) -> Result<VaultEntry, String> {
    let mut vault = load_or_migrate(&app);
    let Some(entry) = vault.entries.iter_mut().find(|e| e.id == id) else {
        return Err(format!("prompt vault: no entry with id '{id}'"));
    };
    entry.history.push(history_item.sanitized());
    entry.updated_at = now_ms();
    let updated = entry.clone();
    persist_and_emit(&app, &vault)?;
    Ok(updated)
}

/// Case-insensitive substring search over text + tags. Empty query returns all.
#[tauri::command]
pub fn pv_search(app: AppHandle, query: String) -> Vec<VaultEntry> {
    let vault = load_or_migrate(&app);
    search_entries(&vault.entries, &query)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("praxis-pv-test-{}-{}.json", name, now_ms()));
        p
    }

    fn sample_entry(id: &str, text: &str, tags: &[&str]) -> VaultEntry {
        let now = now_ms();
        VaultEntry {
            id: id.to_string(),
            text: text.to_string(),
            model: Some("Opus 4.8".to_string()),
            effort: Some("high".to_string()),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            lane_hint: None,
            source: "manual".to_string(),
            created_at: now,
            updated_at: now,
            history: Vec::new(),
        }
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = tmp_path("roundtrip");
        let mut v = Vault::empty();
        v.entries
            .push(sample_entry("a", "build the brain window", &["ui"]));
        v.entries.push(sample_entry(
            "b",
            "wire the flow runner",
            &["backend", "rust"],
        ));
        save_to(&path, &v).expect("save");
        let loaded = load_from(&path).expect("load");
        assert_eq!(loaded.version, VAULT_VERSION);
        assert_eq!(loaded.entries.len(), 2);
        assert_eq!(loaded.entries[0].id, "a");
        assert_eq!(loaded.entries[1].tags, vec!["backend", "rust"]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_missing_file_is_none() {
        let path = tmp_path("missing");
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn migrate_imports_every_lane_entry_with_lane_hint() {
        // Mirrors the real FD vault shape: lanes keyed by lane id → VaultEntry[].
        let fd = json!({
            "version": 1,
            "lanes": {
                "laneA": [
                    { "id": "e1", "title": "Dark mode", "prompt": "add dark mode",
                      "model": "Opus 4.8", "effort": "high", "createdAt": 111 },
                    { "id": "e2", "title": "", "prompt": "fix the crash",
                      "model": "Sonnet 4.6", "effort": "medium", "createdAt": 222,
                      "firedAt": 999, "fireResult": "all green" }
                ],
                "laneB": [
                    { "id": "e3", "prompt": "write tests", "model": "", "effort": "" }
                ]
            },
            "config": { "readOnlyLanes": [], "laneOrder": [] }
        });
        let entries = migrate_fd_value(&fd);
        assert_eq!(entries.len(), 3, "every lane entry imported");
        // All carry their lane id as laneHint + source flightdeck.
        assert!(entries.iter().all(|e| e.source == "flightdeck"));
        assert!(entries.iter().all(|e| e.lane_hint.is_some()));
        // Title preserved as a tag; empty title → no tag.
        let e1 = entries.iter().find(|e| e.id == "e1").unwrap();
        assert_eq!(e1.tags, vec!["Dark mode"]);
        assert_eq!(e1.lane_hint.as_deref(), Some("laneA"));
        assert_eq!(e1.created_at, 111);
        // A previously-fired FD entry seeds one history item.
        let e2 = entries.iter().find(|e| e.id == "e2").unwrap();
        assert_eq!(e2.history.len(), 1);
        assert_eq!(e2.history[0].outcome, "done");
        assert_eq!(e2.history[0].result_snippet, "all green");
        // Empty model/effort strings become None.
        let e3 = entries.iter().find(|e| e.id == "e3").unwrap();
        assert!(e3.model.is_none() && e3.effort.is_none());
    }

    #[test]
    fn migrate_skips_blank_prompts_and_tolerates_junk() {
        let fd = json!({
            "lanes": {
                "laneA": [
                    { "id": "x", "prompt": "   " },   // blank → skipped
                    { "id": "y", "prompt": "keep me" }
                ]
            }
        });
        let entries = migrate_fd_value(&fd);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "keep me");
        // No `lanes` key at all → empty, not a panic.
        assert!(migrate_fd_value(&json!({ "nope": true })).is_empty());
    }

    #[test]
    fn search_is_case_insensitive_over_text_and_tags() {
        let entries = vec![
            sample_entry("a", "Build the BRAIN window", &["ui"]),
            sample_entry("b", "wire flow runner", &["Backend"]),
            sample_entry("c", "unrelated", &[]),
        ];
        // Matches text regardless of case.
        let by_text = search_entries(&entries, "brain");
        assert_eq!(by_text.len(), 1);
        assert_eq!(by_text[0].id, "a");
        // Matches a tag regardless of case.
        let by_tag = search_entries(&entries, "backend");
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].id, "b");
        // Empty query returns everything.
        assert_eq!(search_entries(&entries, "  ").len(), 3);
        // No match → empty.
        assert!(search_entries(&entries, "zzz").is_empty());
    }

    #[test]
    fn patch_only_changes_present_keys_and_bumps_updated_at() {
        let mut e = sample_entry("a", "original", &["one"]);
        e.updated_at = 1; // force a low baseline so the bump is observable
        apply_patch(
            &mut e,
            &json!({ "text": "changed", "tags": ["two", "three"] }),
        );
        assert_eq!(e.text, "changed");
        assert_eq!(e.tags, vec!["two", "three"]);
        // model was NOT in the patch → untouched.
        assert_eq!(e.model.as_deref(), Some("Opus 4.8"));
        assert!(e.updated_at > 1);
    }

    #[test]
    fn record_outcome_truncates_snippet_to_500_chars() {
        let long = "x".repeat(1200);
        let item = HistoryItem {
            fired_at: now_ms(),
            driver: "claude".to_string(),
            agent: Some("Forge".to_string()),
            cwd: Some("C:/app".to_string()),
            outcome: "done".to_string(),
            result_snippet: long,
        }
        .sanitized();
        assert_eq!(item.result_snippet.chars().count(), SNIPPET_MAX);
    }

    #[test]
    fn normalize_incoming_fills_defaults() {
        // A bare draft with just text still yields a valid, persistable entry.
        let e = normalize_incoming(&json!({ "text": "quick save" }));
        assert!(!e.id.is_empty());
        assert_eq!(e.source, "manual");
        assert!(e.created_at > 0);
        assert_eq!(e.text, "quick save");
    }
}
