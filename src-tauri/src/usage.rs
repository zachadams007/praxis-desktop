//! Usage / cost tracking for Praxis tools.
//!
//! Three responsibilities:
//!
//!   1. **`usage_snapshot` (Tauri command)** - returns a `Vec<ToolUsage>` covering
//!      every tool Praxis delegates to. OpenRouter is queried live; Claude / Codex /
//!      Cursor come from a local running-total accumulator file. All network/file ops
//!      degrade gracefully - a row with `spent_usd = 0.0` is returned rather than
//!      panicking or blocking indefinitely.
//!
//!   2. **`record_cost` (pub helper)** - atomically bumps `usage.json` for a tool
//!      key. Called by `hermes_bridge` after each successful agent_delegate run.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// Praxis is enforced single-instance by the Tauri plugin in lib.rs. This mutex
// serializes every accumulator/rolling-ledger read and write within that process.
static USAGE_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static USAGE_HEALTH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static USAGE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static USAGE_PERSISTENCE_DEGRADED: AtomicBool = AtomicBool::new(false);
static USAGE_HEALTH_PERSISTED: AtomicBool = AtomicBool::new(false);
/// What is actually wrong, and which rails it legitimately applies to.
static USAGE_DEGRADED_DETAIL: OnceLock<Mutex<Option<Degradation>>> = OnceLock::new();
const APPLIED_LEDGER_SEQUENCE_KEY: &str = "_usage_ledger_applied_seq";

// ── What "degraded" is allowed to mean ───────────────────────────────────────
//
// A SINGLE GLOBAL BOOL WAS CAPTIONING SIX RAILS "ledger degraded".
//
// Measured on this machine 2026-09-12: usage-health.json held
// `degraded: true, failure_count: 6, last_failure_ms 09:20:36`, while the ledger
// it was supposedly describing was provably intact - 296 lines, 0 malformed,
// sequences contiguous 1..160, and the `openai` accumulator equal to its journal
// sum to the last decimal place. Nothing about persistence was broken.
//
// What had actually happened: an OpenAI Realtime turn ended without trustworthy
// usage totals (`realtime-accounting-session.json` still held the unreleased
// reservation `rt-1a095c51866-284172-1` from 09:18:37). That is a real and
// openai-specific uncertainty. It was being reported as a global ledger failure,
// so NVIDIA, Claude, Codex and Cursor - none of which the OpenAI Realtime lane
// touches - all said "ledger degraded" too.
//
// So a degradation now carries a SCOPE and a REASON:
//   * `Ledger` - the local accumulator/journal really is unreadable or
//     inconsistent. Every locally-metered rail is affected, and a later
//     successful write is proof it recovered.
//   * `Realtime` - one OpenAI Realtime turn could not be accounted. ONLY the
//     OpenAI rail is affected, and the Realtime admission guard keeps failing
//     closed (an unmetered paid session must not silently reopen). A ledger
//     write cannot clear this one, because a ledger write is not evidence that
//     the missing turn got accounted; its own startup reconcile clears it.
//
// "a local usage write failed" and "a voice turn went unmetered" are different
// facts with different blast radii. A caption that is always on tells nobody
// anything.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum DegradedScope {
    /// The shared accumulator/journal itself. Affects every locally-metered rail.
    Ledger,
    /// An OpenAI Realtime turn went unaccounted. Affects the OpenAI rail only.
    Realtime,
}

impl DegradedScope {
    fn as_str(self) -> &'static str {
        match self {
            DegradedScope::Ledger => "ledger",
            DegradedScope::Realtime => "realtime",
        }
    }

    fn from_str(raw: &str) -> Self {
        match raw {
            "realtime" => DegradedScope::Realtime,
            // An older usage-health.json predates the scope field. It was written
            // by the one-bool version, so the only safe reading is the wide one.
            _ => DegradedScope::Ledger,
        }
    }

    /// Does this degradation legitimately describe the named rail?
    fn affects(self, tool_key: &str) -> bool {
        match self {
            DegradedScope::Ledger => true,
            DegradedScope::Realtime => tool_key == "openai",
        }
    }
}

/// One live degradation: what scope it covers and a sentence naming the problem.
#[derive(Clone)]
pub(crate) struct Degradation {
    scope: DegradedScope,
    reason: String,
}

fn degraded_detail() -> &'static Mutex<Option<Degradation>> {
    USAGE_DEGRADED_DETAIL.get_or_init(|| Mutex::new(None))
}

/// Record the live degradation in-process. A `Ledger` problem outranks a
/// `Realtime` one (it is strictly wider), so it is never downgraded by a later
/// realtime marker.
fn set_degraded_detail(scope: DegradedScope, reason: &str) {
    if let Ok(mut slot) = degraded_detail().lock() {
        let keep_wider = matches!(
            slot.as_ref().map(|d| d.scope),
            Some(DegradedScope::Ledger)
        ) && scope == DegradedScope::Realtime;
        if keep_wider {
            return;
        }
        *slot = Some(Degradation {
            scope,
            reason: reason.to_string(),
        });
    }
}

fn usage_io_lock() -> &'static Mutex<()> {
    USAGE_IO_LOCK.get_or_init(|| Mutex::new(()))
}

fn mark_usage_persistence_degraded(reason: &str) {
    USAGE_PERSISTENCE_DEGRADED.store(true, Ordering::Relaxed);
    set_degraded_detail(DegradedScope::Ledger, reason);
    ensure_usage_health_persisted(DegradedScope::Ledger, reason);
}

/// Persist a sticky uncertainty marker for a paid operation whose authoritative
/// usage could not be recorded. The in-process flag flips before disk I/O so the
/// current process fails closed even when the sidecar itself cannot be written.
///
/// Scope is `Realtime`: this says a voice turn went unmetered, NOT that the
/// ledger is broken. Only the OpenAI rail and the Realtime admission guard are
/// entitled to act on it.
pub(crate) fn mark_usage_persistence_uncertain() -> Result<(), String> {
    const REASON: &str = "an OpenAI Realtime turn ended without usable usage totals; Realtime stays closed until the next restart re-validates it";
    USAGE_PERSISTENCE_DEGRADED.store(true, Ordering::Relaxed);
    set_degraded_detail(DegradedScope::Realtime, REASON);
    let _guard = USAGE_HEALTH_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "usage-health-lock-poisoned".to_string())?;
    let path = usage_health_path().ok_or_else(|| "usage-health-path-unavailable".to_string())?;
    record_usage_health_failure_to(&path, DegradedScope::Realtime, REASON)?;
    USAGE_HEALTH_PERSISTED.store(true, Ordering::Relaxed);
    Ok(())
}

fn ensure_usage_health_persisted(scope: DegradedScope, reason: &str) {
    if USAGE_HEALTH_PERSISTED.load(Ordering::Relaxed) {
        return;
    }
    let Ok(_guard) = USAGE_HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    if USAGE_HEALTH_PERSISTED.load(Ordering::Relaxed) {
        return;
    }
    let Some(path) = usage_health_path() else {
        return;
    };
    if record_usage_health_failure_to(&path, scope, reason).is_ok() {
        USAGE_HEALTH_PERSISTED.store(true, Ordering::Relaxed);
    }
}

/// The live degradation, hydrated from disk on first use so a marker written by a
/// previous run is honoured. `None` = everything is healthy.
fn usage_degradation() -> Option<Degradation> {
    if USAGE_PERSISTENCE_DEGRADED.load(Ordering::Relaxed) {
        if let Ok(slot) = degraded_detail().lock() {
            if let Some(live) = slot.as_ref() {
                return Some(live.clone());
            }
        }
        // Flagged with no detail recorded (e.g. the detail mutex was poisoned).
        // Report the wide scope rather than silently dropping the warning.
        return Some(Degradation {
            scope: DegradedScope::Ledger,
            reason: "a local usage read or write failed".to_string(),
        });
    }
    let Ok(_guard) = USAGE_HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return Some(Degradation {
            scope: DegradedScope::Ledger,
            reason: "the usage-health lock is poisoned".to_string(),
        });
    };
    let Some(path) = usage_health_path() else {
        return Some(Degradation {
            scope: DegradedScope::Ledger,
            reason: "the usage-health file path could not be resolved".to_string(),
        });
    };
    let found = usage_health_degradation_from(&path)?;
    USAGE_PERSISTENCE_DEGRADED.store(true, Ordering::Relaxed);
    USAGE_HEALTH_PERSISTED.store(true, Ordering::Relaxed);
    set_degraded_detail(found.scope, &found.reason);
    Some(found)
}

/// Is the named rail legitimately described by the current degradation, and if so
/// what should it say? `None` = this rail is fine.
fn usage_degraded_reason_for(tool_key: &str) -> Option<String> {
    let live = usage_degradation()?;
    live.scope.affects(tool_key).then_some(live.reason)
}

/// Whether anything at all is degraded (the Realtime admission guard's question -
/// it must fail closed on either scope).
fn usage_persistence_degraded() -> bool {
    usage_degradation().is_some()
}

/// Path to the running-total accumulator file.
/// Shape: `{ "claude": f64, "codex": f64, "cursor": f64 }`.
/// Missing file or missing key → treated as 0.0.
fn usage_file_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| {
        std::path::PathBuf::from(p)
            .join("Praxis")
            .join("usage.json")
    })
}

/// Hand-maintained local plan state that is allowed to differ from old observed logs.
fn usage_plan_config_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| {
        std::path::PathBuf::from(p)
            .join("Praxis")
            .join("usage-plan.json")
    })
}

/// Vault file that holds `OPENROUTER_API_KEY=<value>`.
/// Reuse the same path already established in hermes_bridge.
const SECRETS_PATH: &str = r"C:\Users\dev\.praxis\praxis-secrets.env";

/// Read a `KEY=value` line from the vault `.env` file.
/// Returns `None` if the file is missing or the key isn't present. Never panics.
fn read_vault_key(key: &str) -> Option<String> {
    let content = std::fs::read_to_string(SECRETS_PATH).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(val) = rest.strip_prefix('=') {
                let v = val.trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

// ── Local accumulator helpers ────────────────────────────────────────────────

/// Read one accumulator path. A missing file is a legitimate empty ledger;
/// malformed or unreadable data is an error so a writer cannot silently replace
/// the last totals with a new near-zero file.
fn read_accumulator_from(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Map::new())
        }
        Err(_) => return Err("usage-accumulator-read-failed".to_string()),
    };
    match serde_json::from_str::<Value>(&content) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err("usage-accumulator-invalid".to_string()),
    }
}

fn usage_health_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|dir| dir.join("usage-health.json"))
}

fn record_usage_health_failure_to(
    path: &Path,
    scope: DegradedScope,
    reason: &str,
) -> Result<u64, String> {
    let mut map = read_accumulator_from(path).unwrap_or_default();
    let failures = map
        .get("failure_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    // schema 2 adds `scope` + `reason`. Schema 1 files (one bare bool) still read
    // correctly - `DegradedScope::from_str` maps a missing scope to the wide one.
    map.insert("schema_version".to_string(), Value::from(2));
    map.insert("degraded".to_string(), Value::from(true));
    map.insert("scope".to_string(), Value::from(scope.as_str()));
    map.insert("reason".to_string(), Value::from(reason));
    map.insert("failure_count".to_string(), Value::from(failures));
    map.insert("last_failure_ms".to_string(), Value::from(now_ms()));
    write_accumulator_to(path, map)?;
    Ok(failures)
}

/// Re-validate the usage ledger at STARTUP and clear a stale degraded flag.
///
/// `usage_persistence_degraded` is a sticky fail-closed latch: any single failed
/// write flips it, it is persisted to usage-health.json, and NOTHING ever cleared
/// it. Once set, `cumulative_usage_cost` returns Err forever, which disables
/// OpenAI Realtime forever ("usage ledger unavailable") - so Atlas silently ran
/// on the local voice stack with no way for the owner to recover it. Found latched on
/// this machine with failure_count 2.
///
/// Failing closed DURING an operation is right; staying closed across a restart
/// when the files are provably fine is not. This proves the ledger is readable
/// and consistent by actually reading it, and only then clears the flag. If the
/// read still fails, the latch stays and the failure count keeps its history.
///
/// Returns true when a stale degraded flag was cleared.
pub fn reconcile_usage_health() -> bool {
    let Some(health_path) = usage_health_path() else {
        return false;
    };
    if !usage_health_degraded_from(&health_path) {
        return false;
    }
    // Prove the ledger works before trusting it again.
    let (Some(acc_path), Some(ledger_path)) = (usage_file_path(), usage_ledger_path()) else {
        return false;
    };
    if cumulative_usage_cost_from(&acc_path, &ledger_path, "openai").is_err() {
        crate::elog!("[usage] ledger still unreadable at startup; persistence stays degraded");
        return false;
    }
    let Ok(_guard) = USAGE_HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return false;
    };
    let mut map = read_accumulator_from(&health_path).unwrap_or_default();
    // Keep failure_count and last_failure_ms as history - only the live flag clears.
    map.insert("degraded".to_string(), Value::from(false));
    map.remove("scope");
    map.remove("reason");
    map.insert("last_recovered_ms".to_string(), Value::from(now_ms()));
    if write_accumulator_to(&health_path, map).is_err() {
        return false;
    }
    USAGE_PERSISTENCE_DEGRADED.store(false, Ordering::Relaxed);
    USAGE_HEALTH_PERSISTED.store(false, Ordering::Relaxed);
    if let Ok(mut slot) = degraded_detail().lock() {
        *slot = None;
    }
    crate::dlog!("[usage] ledger re-validated at startup; persistence degraded flag cleared");
    true
}

/// The persisted degradation, or `None` when the file says everything is healthy.
/// An unreadable health file is itself a ledger-scope problem.
fn usage_health_degradation_from(path: &Path) -> Option<Degradation> {
    let map = match read_accumulator_from(path) {
        Ok(map) => map,
        Err(_) => {
            return Some(Degradation {
                scope: DegradedScope::Ledger,
                reason: "the usage-health sidecar is unreadable".to_string(),
            })
        }
    };
    if !map
        .get("degraded")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let scope = DegradedScope::from_str(map.get("scope").and_then(Value::as_str).unwrap_or(""));
    let reason = map
        .get("reason")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match scope {
            DegradedScope::Realtime => {
                "an OpenAI Realtime turn ended without usable usage totals".to_string()
            }
            DegradedScope::Ledger => "a local usage read or write failed".to_string(),
        });
    Some(Degradation { scope, reason })
}

fn usage_health_degraded_from(path: &Path) -> bool {
    usage_health_degradation_from(path).is_some()
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| "usage-accumulator-replace-failed".to_string())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(source, destination).map_err(|_| "usage-accumulator-replace-failed".to_string())
}

/// Crash-safe replacement: fully write and sync a sibling temp file, then use an
/// OS-level replace. The previous accumulator remains intact if any earlier step
/// fails; temp files are removed on a failed replace.
fn write_accumulator_to(path: &Path, map: serde_json::Map<String, Value>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "usage-accumulator-parent-missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "usage-accumulator-mkdir-failed".to_string())?;
    let json = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|_| "usage-accumulator-serialize-failed".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("usage.json");
    let sequence = USAGE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "usage-accumulator-temp-open-failed".to_string())?;
        file.write_all(&json)
            .map_err(|_| "usage-accumulator-temp-write-failed".to_string())?;
        file.flush()
            .map_err(|_| "usage-accumulator-temp-flush-failed".to_string())?;
        file.sync_all()
            .map_err(|_| "usage-accumulator-temp-sync-failed".to_string())?;
        drop(file);
        replace_file(&temp, path)
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    write_result
}

/// Read the live accumulator under the same lock writers use. Read/parse errors
/// remain fail-soft for callers, but set a sticky degraded signal for the UI.
fn read_accumulator() -> serde_json::Map<String, Value> {
    let Ok(_guard) = usage_io_lock().lock() else {
        mark_usage_persistence_degraded("the usage-ledger lock is poisoned");
        return serde_json::Map::new();
    };
    let Some(path) = usage_file_path() else {
        mark_usage_persistence_degraded("usage.json's path could not be resolved");
        return serde_json::Map::new();
    };
    let mut map = match read_accumulator_from(&path) {
        Ok(map) => map,
        Err(_) => {
            mark_usage_persistence_degraded("usage.json is unreadable or not valid JSON");
            return serde_json::Map::new();
        }
    };
    if let Some(ledger_path) = usage_ledger_path() {
        match reconcile_accumulator_from_ledger(&mut map, &ledger_path) {
            Ok(true) => {
                if write_accumulator_to(&path, map.clone()).is_err() {
                    mark_usage_persistence_degraded("replaying usage.jsonl into usage.json failed");
                } else {
                    // The replay wrote cleanly - that is a completed write, and
                    // therefore proof the ledger works.
                    note_usage_write_succeeded();
                }
            }
            // A clean read that needed no replay is also proof the ledger is
            // consistent. Without this, a read path could only ever report bad
            // news: every failure latched and no success ever spoke up.
            Ok(false) => note_usage_write_succeeded(),
            Err(_) => mark_usage_persistence_degraded(
                "usage.jsonl could not be replayed into usage.json (inconsistent journal)",
            ),
        }
    }
    map
}

/// Read the f64 for a tool key from the accumulator (0.0 if absent).
fn accumulator_get(map: &serde_json::Map<String, Value>, tool: &str) -> f64 {
    map.get(tool).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// Update `usage.json`: add `delta` to the running total for `tool`.
/// Best-effort - all errors are silently ignored so callers never block or panic.
pub fn record_cost(tool: &str, delta: f64) {
    if !delta.is_finite() || delta <= 0.0 {
        return;
    }
    let result = (|| -> Result<(), String> {
        let _guard = usage_io_lock()
            .lock()
            .map_err(|_| "usage-io-lock-poisoned".to_string())?;
        let path = usage_file_path().ok_or_else(|| "usage-path-unavailable".to_string())?;
        let mut map = read_accumulator_from(&path)?;
        if let Some(ledger_path) = usage_ledger_path() {
            let _ = reconcile_accumulator_from_ledger(&mut map, &ledger_path)?;
        }
        let current = accumulator_get(&map, tool);
        map.insert(tool.to_string(), Value::from(current + delta));
        write_accumulator_to(&path, map)
    })();
    // A ONE-WAY WRITE PATH. `record_cost` marked degraded on failure and said
    // nothing on success, so a single transient failure here latched the flag
    // until a restart even as every subsequent write landed. `record_usage` right
    // below already had the success half; this one never did.
    if result.is_err() {
        mark_usage_persistence_degraded("a usage.json cost update could not be written");
    } else {
        note_usage_write_succeeded();
    }
}

// ── Per-model token accumulation ────────────────────────────────────────────

/// Per-model usage entry stored inside `usage.json` under `"models"`.
/// Shape: `{ "google/gemini-2.5-flash": { "calls": 3, "input_tokens": 1200, "output_tokens": 340, "cost_usd": 0.0012, "last_run_ms": 1735776000000 }, ... }`
///
/// `last_run_ms` is `#[serde(default)]` so existing `usage.json` files written before this
/// field existed still parse cleanly (they'll just show `0`, treated as "no data" by the UI).
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct ModelEntry {
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    #[serde(default)]
    pub last_run_ms: u64,
}

/// Milliseconds since the Unix epoch, for stamping the most recent run of a model/tool.
/// Falls back to 0 in the (practically impossible) case the system clock predates 1970.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Accumulate token + cost data for a specific model (e.g. from a `claude -p` response).
/// One serialized transaction journals the call, updates the parent total and
/// model breakdown, and records the applied journal sequence.
///
/// - `tool` - e.g. `"claude"`, `"codex"`, `"openrouter"`
/// - `model` - e.g. `"google/gemini-2.5-flash"` (pass `""` if unknown)
/// - `input_tokens` - prompt tokens for this call
/// - `output_tokens` - completion tokens for this call
/// - `cost_usd` - USD cost for this call (from the tool's own reporting)
pub fn record_usage(tool: &str, model: &str, input_tokens: u64, output_tokens: u64, cost_usd: f64) {
    let result = (|| -> Result<(), String> {
        let accumulator_path =
            usage_file_path().ok_or_else(|| "usage-path-unavailable".to_string())?;
        let ledger_path =
            usage_ledger_path().ok_or_else(|| "usage-ledger-path-unavailable".to_string())?;
        record_usage_to(
            &accumulator_path,
            &ledger_path,
            tool,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
        )
    })();
    if result.is_err() {
        mark_usage_persistence_degraded("a usage.jsonl journal entry could not be recorded");
    } else {
        note_usage_write_succeeded();
    }
}

/// A completed write is proof the ledger works. Clear the degraded latch.
///
/// `usage_persistence_degraded` was a ONE-WAY flag in practice: any single failed
/// write set it, and only a restart could clear it (`reconcile_usage_health`).
/// One transient failure - an antivirus scan holding the file for a moment, a
/// rename losing a race with a second instance - therefore painted "ledger
/// degraded" across every supply rail AND disabled OpenAI Realtime for the rest of
/// the session, which is how Atlas kept dropping to the local voice mid-sentence.
/// Measured on this machine 2026-09-09: `degraded: true`, `failure_count: 3`,
/// with the last recovery five days earlier.
///
/// Failing closed DURING an operation is right. Staying closed after the very next
/// operation succeeded is not - the flag was reporting the worst thing that had
/// ever happened rather than the current state. Same shape as the two Realtime
/// latches found on 2026-09-06, and worth suspecting anywhere a health flag has no
/// path back.
///
/// History is preserved: `failure_count` and `last_failure_ms` keep counting, so a
/// ledger that is genuinely flapping is still visible - only the live flag clears.
///
/// SCOPE MATTERS HERE. A successful ledger write proves the LEDGER works, so it
/// clears a `Ledger` degradation. It proves nothing about a Realtime turn that
/// went unmetered, so it must NOT clear a `Realtime` marker - that one exists to
/// stop an unaccounted paid voice session from silently reopening, and only its
/// own startup reconcile is allowed to retire it.
fn note_usage_write_succeeded() {
    if !USAGE_PERSISTENCE_DEGRADED.load(Ordering::Relaxed) {
        return; // hot path: nothing was wrong, do no I/O
    }
    // Only a ledger-scope problem is something a ledger write can disprove.
    match usage_degradation() {
        Some(live) if live.scope == DegradedScope::Ledger => {}
        _ => return,
    }
    let Some(health_path) = usage_health_path() else {
        return;
    };
    let Ok(_guard) = USAGE_HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let mut map = read_accumulator_from(&health_path).unwrap_or_default();
    map.insert("degraded".to_string(), Value::from(false));
    map.remove("scope");
    map.remove("reason");
    map.insert("last_recovered_ms".to_string(), Value::from(now_ms()));
    if write_accumulator_to(&health_path, map).is_err() {
        return; // could not even record the recovery - stay degraded, honestly
    }
    USAGE_PERSISTENCE_DEGRADED.store(false, Ordering::Relaxed);
    USAGE_HEALTH_PERSISTED.store(false, Ordering::Relaxed);
    if let Ok(mut slot) = degraded_detail().lock() {
        *slot = None;
    }
    crate::dlog!("[usage] a write succeeded; ledger degraded flag cleared");
}

// ── Append-only usage ledger (for rolling-window plan bars) ─────────────────

/// `%LOCALAPPDATA%\Praxis\usage.jsonl` - same home as usage.json / runs.jsonl.
/// One JSON line per recorded model call: `{"ts":<ms>,"tool":"claude","model":"opus","calls":1,"input_tokens":..,"output_tokens":..,"cost_usd":..}`.
fn usage_ledger_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("usage.jsonl"))
}

/// One line of the append-only ledger.
#[derive(serde::Serialize, serde::Deserialize)]
struct LedgerLine {
    /// Monotonic sequence used to reconcile a ledger append that reached disk just
    /// before the accumulator replacement did.
    #[serde(default)]
    sequence: u64,
    /// Unix ms when this call was recorded.
    ts: u64,
    tool: String,
    #[serde(default)]
    model: String,
    /// Always 1 - one call per line. Kept explicit (rather than implied by line
    /// count) so a future batch-import path can write pre-aggregated lines.
    #[serde(default = "one")]
    calls: u64,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cost_usd: f64,
}

fn one() -> u64 {
    1
}

fn read_ledger_lines_from(path: &Path) -> Result<(Vec<LedgerLine>, u64), String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(_) => return Err("usage-ledger-read-failed".to_string()),
    };
    let mut entries = Vec::new();
    let mut malformed = 0u64;
    for line in content.lines() {
        match serde_json::from_str::<LedgerLine>(line) {
            Ok(entry) => entries.push(entry),
            Err(_) => malformed = malformed.saturating_add(1),
        }
    }
    Ok((entries, malformed))
}

fn validate_ledger_sequences(entries: &[LedgerLine]) -> Result<u64, String> {
    let mut sequences: Vec<u64> = entries
        .iter()
        .map(|entry| entry.sequence)
        .filter(|sequence| *sequence > 0)
        .collect();
    sequences.sort_unstable();
    for (index, sequence) in sequences.iter().enumerate() {
        let expected = index as u64 + 1;
        if *sequence != expected {
            return Err("usage-ledger-sequence-gap-or-duplicate".to_string());
        }
    }
    Ok(sequences.last().copied().unwrap_or(0))
}

fn apply_ledger_line_to_accumulator(
    map: &mut serde_json::Map<String, Value>,
    entry: &LedgerLine,
) -> Result<(), String> {
    let safe_cost = if entry.cost_usd.is_finite() && entry.cost_usd > 0.0 {
        entry.cost_usd
    } else {
        0.0
    };
    if safe_cost > 0.0 {
        let current = accumulator_get(map, &entry.tool);
        map.insert(entry.tool.clone(), Value::from(current + safe_cost));
    }

    let model_key = if entry.model.is_empty() {
        entry.tool.as_str()
    } else {
        entry.model.as_str()
    };
    let mut models = map
        .get("models")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let existing: ModelEntry = models
        .get(model_key)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let updated = ModelEntry {
        calls: existing.calls.saturating_add(entry.calls),
        input_tokens: existing.input_tokens.saturating_add(entry.input_tokens),
        output_tokens: existing.output_tokens.saturating_add(entry.output_tokens),
        cost_usd: existing.cost_usd + safe_cost,
        last_run_ms: existing.last_run_ms.max(entry.ts),
    };
    models.insert(
        model_key.to_string(),
        serde_json::to_value(updated).map_err(|_| "usage-model-serialize-failed".to_string())?,
    );
    map.insert("models".to_string(), Value::Object(models));
    Ok(())
}

/// Reapply only sequenced ledger entries newer than the accumulator checkpoint.
/// Legacy lines (sequence 0) still feed rolling-window totals but are never
/// replayed because their accumulator state predates this checkpoint scheme.
fn reconcile_accumulator_from_ledger(
    map: &mut serde_json::Map<String, Value>,
    ledger_path: &Path,
) -> Result<bool, String> {
    let (entries, malformed) = read_ledger_lines_from(ledger_path)?;
    if malformed > 0 {
        mark_usage_persistence_degraded(&format!(
            "usage.jsonl has {malformed} unparseable line(s); those calls are missing from the totals"
        ));
    }
    let max_sequence = validate_ledger_sequences(&entries)?;
    let mut applied = map
        .get(APPLIED_LEDGER_SEQUENCE_KEY)
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut changed = false;
    if applied > max_sequence {
        return Err("usage-ledger-shorter-than-accumulator".to_string());
    }
    let mut pending: Vec<&LedgerLine> = entries
        .iter()
        .filter(|entry| entry.sequence > applied)
        .collect();
    pending.sort_by_key(|entry| entry.sequence);
    for entry in pending {
        apply_ledger_line_to_accumulator(map, entry)?;
        applied = applied.max(entry.sequence);
        changed = true;
    }
    if changed {
        map.insert(
            APPLIED_LEDGER_SEQUENCE_KEY.to_string(),
            Value::from(applied),
        );
    }
    Ok(changed)
}

fn ledger_append_needs_separator(path: &Path) -> Result<bool, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("usage-ledger-boundary-open-failed".to_string()),
    };
    let length = file
        .metadata()
        .map_err(|_| "usage-ledger-boundary-metadata-failed".to_string())?
        .len();
    if length == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|_| "usage-ledger-boundary-seek-failed".to_string())?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)
        .map_err(|_| "usage-ledger-boundary-read-failed".to_string())?;
    Ok(last[0] != b'\n')
}

fn append_ledger_line_durable(path: &Path, entry: &LedgerLine) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "usage-ledger-parent-missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "usage-ledger-mkdir-failed".to_string())?;
    let mut buffer =
        serde_json::to_vec(entry).map_err(|_| "usage-ledger-serialize-failed".to_string())?;
    buffer.push(b'\n');
    if ledger_append_needs_separator(path)? {
        buffer.insert(0, b'\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "usage-ledger-open-failed".to_string())?;
    file.write_all(&buffer)
        .map_err(|_| "usage-ledger-write-failed".to_string())?;
    file.flush()
        .map_err(|_| "usage-ledger-flush-failed".to_string())?;
    file.sync_data()
        .map_err(|_| "usage-ledger-sync-failed".to_string())
}

fn record_usage_to(
    accumulator_path: &Path,
    ledger_path: &Path,
    tool: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    let _guard = usage_io_lock()
        .lock()
        .map_err(|_| "usage-io-lock-poisoned".to_string())?;
    let mut map = read_accumulator_from(accumulator_path)?;
    let _ = reconcile_accumulator_from_ledger(&mut map, ledger_path)?;
    let (existing_entries, malformed) = read_ledger_lines_from(ledger_path)?;
    if malformed > 0 {
        mark_usage_persistence_degraded(&format!(
            "usage.jsonl has {malformed} unparseable line(s); those calls are missing from the totals"
        ));
    }
    let applied = map
        .get(APPLIED_LEDGER_SEQUENCE_KEY)
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let max_ledger_sequence = validate_ledger_sequences(&existing_entries)?;
    let entry = LedgerLine {
        sequence: applied.max(max_ledger_sequence).saturating_add(1),
        ts: now_ms(),
        tool: tool.to_string(),
        model: model.to_string(),
        calls: 1,
        input_tokens,
        output_tokens,
        cost_usd: if cost_usd.is_finite() && cost_usd > 0.0 {
            cost_usd
        } else {
            0.0
        },
    };

    // Journal first. If the app exits before the accumulator replacement, the
    // next locked read or write replays this sequence instead of losing the event.
    append_ledger_line_durable(ledger_path, &entry)?;
    apply_ledger_line_to_accumulator(&mut map, &entry)?;
    map.insert(
        APPLIED_LEDGER_SEQUENCE_KEY.to_string(),
        Value::from(entry.sequence),
    );
    write_accumulator_to(accumulator_path, map)
}

/// Aggregate the ledger for a single `tool` over a rolling window ending now.
/// Returns `(calls, input_tokens, output_tokens)` summed across all lines whose
/// `ts` falls within `[now_ms - window_ms, now_ms]`.
///
/// Reads the journal under the same mutex as writers. This runs at most once per
/// usage_summary poll (30s cadence from the frontend), so the simple scan keeps
/// rolling-window math deterministic and avoids a second mutable index.
fn ledger_window_totals(
    tool_match: impl Fn(&str, &str) -> bool,
    window_ms: u64,
) -> (u64, u64, u64) {
    let Ok(_guard) = usage_io_lock().lock() else {
        mark_usage_persistence_degraded("the usage-ledger lock is poisoned");
        return (0, 0, 0);
    };
    let path = match usage_ledger_path() {
        Some(p) => p,
        None => return (0, 0, 0),
    };
    let (entries, malformed) = match read_ledger_lines_from(&path) {
        Ok(result) => result,
        Err(_) => {
            mark_usage_persistence_degraded("usage.jsonl is unreadable");
            return (0, 0, 0);
        }
    };
    if malformed > 0 {
        mark_usage_persistence_degraded(&format!(
            "usage.jsonl has {malformed} unparseable line(s); those calls are missing from the totals"
        ));
    }
    let now = now_ms();
    let cutoff = now.saturating_sub(window_ms);

    let mut calls = 0u64;
    let mut input = 0u64;
    let mut output = 0u64;
    for entry in entries {
        if entry.ts < cutoff || entry.ts > now {
            continue;
        }
        if !tool_match(&entry.tool, &entry.model) {
            continue;
        }
        calls += entry.calls;
        input += entry.input_tokens;
        output += entry.output_tokens;
    }
    (calls, input, output)
}

fn cumulative_usage_cost_from(
    accumulator_path: &Path,
    ledger_path: &Path,
    tool: &str,
) -> Result<f64, String> {
    let ledger_exists = match std::fs::metadata(&ledger_path) {
        Ok(metadata) => metadata.is_file(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("usage-ledger-metadata-failed".to_string()),
    };
    let accumulator = read_accumulator_from(accumulator_path)?;
    let applied_sequence = accumulator
        .get(APPLIED_LEDGER_SEQUENCE_KEY)
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let accumulator_cost = accumulator_get(&accumulator, tool);
    if !ledger_exists && (applied_sequence > 0 || accumulator_cost > 0.0) {
        return Err("usage-ledger-missing-with-history".to_string());
    }

    let (entries, malformed) = read_ledger_lines_from(&ledger_path)?;
    if malformed > 0 {
        return Err("usage-ledger-malformed".to_string());
    }
    let max_sequence = validate_ledger_sequences(&entries)?;
    if applied_sequence > max_sequence {
        return Err("usage-ledger-shorter-than-accumulator".to_string());
    }
    let journal_cost: f64 = entries
        .iter()
        .filter(|entry| entry.tool == tool && entry.cost_usd.is_finite() && entry.cost_usd > 0.0)
        .map(|entry| entry.cost_usd)
        .sum();

    // ─────────────────────────────────────────────────────────────────────────
    // A JOURNAL BELOW THE ACCUMULATOR IS PRE-JOURNAL HISTORY, NOT CORRUPTION -
    // AND IT IS PERMANENT.
    //
    // This used to `Err("usage-ledger-cost-below-accumulator")`, which latched the
    // degraded flag with no recovery path, because the condition is not transient:
    // spend recorded by `record_cost` BEFORE the append-only journal existed sits
    // in usage.json with no line behind it, forever.
    //
    // Measured on this machine 2026-09-12 for tool "claude":
    //   accumulator 3.3523906, journal 1.9969626, difference 1.3554280 -
    // exactly the `models.claude` entry from a single June run that predates the
    // journal. `cumulative_usage_cost("claude")` was therefore a loaded gun: the
    // first caller would have disabled itself permanently over correct data.
    //
    // The invariant exists so a damaged journal can never be reinterpreted as
    // ZERO spend by a financial guard. Returning the LARGER of the two records
    // serves that purpose strictly better than erroring does: the cap still sees
    // every dollar either record knows about, and the feature keeps working.
    // Refusing to answer doesn't protect the cap - it just turns the feature off.
    //
    // The genuinely unrecoverable signals above (a missing ledger with history, a
    // sequence gap, an unparseable line) still fail closed. Those mean the file
    // is wrong. This one only means the file is younger than the spend.
    // ─────────────────────────────────────────────────────────────────────────
    Ok(journal_cost.max(accumulator_cost))
}

/// Spend recorded for `tool` in the last `window_ms`, from the durable journal.
/// Fails closed on an unreadable/malformed journal, like `cumulative_usage_cost`,
/// so a damaged file is never read as zero spend.
pub fn usage_cost_in_window(tool: &str, window_ms: u64) -> Result<f64, String> {
    let _guard = usage_io_lock()
        .lock()
        .map_err(|_| "usage-io-lock-poisoned".to_string())?;
    let ledger_path =
        usage_ledger_path().ok_or_else(|| "usage-ledger-path-unavailable".to_string())?;
    if !ledger_path.is_file() {
        return Ok(0.0);
    }
    let (entries, malformed) = read_ledger_lines_from(&ledger_path)?;
    if malformed > 0 {
        return Err("usage-ledger-malformed".to_string());
    }
    let now = now_ms();
    let cutoff = now.saturating_sub(window_ms);
    Ok(entries
        .iter()
        .filter(|e| e.tool == tool && e.ts >= cutoff && e.ts <= now)
        .filter(|e| e.cost_usd.is_finite() && e.cost_usd > 0.0)
        .map(|e| e.cost_usd)
        .sum())
}

/// Authoritative cumulative spend from the durable call journal. Any malformed
/// or unreadable ledger fails closed so financial guards never reinterpret a
/// damaged file as zero spend.
pub fn cumulative_usage_cost(tool: &str) -> Result<f64, String> {
    let _guard = usage_io_lock()
        .lock()
        .map_err(|_| "usage-io-lock-poisoned".to_string())?;
    if usage_persistence_degraded() {
        return Err("usage-persistence-degraded".to_string());
    }
    let accumulator_path = usage_file_path().ok_or_else(|| "usage-path-unavailable".to_string())?;
    let ledger_path =
        usage_ledger_path().ok_or_else(|| "usage-ledger-path-unavailable".to_string())?;
    let result = cumulative_usage_cost_from(&accumulator_path, &ledger_path, tool);
    if let Err(detail) = &result {
        mark_usage_persistence_degraded(&format!(
            "the {tool} spend journal failed its consistency check ({detail})"
        ));
        return result;
    }
    if usage_persistence_degraded() {
        return Err("usage-persistence-degraded".to_string());
    }
    result
}

// ── Plan limits (honest, hand-maintained - NOT from any API) ────────────────
//
// Every number below marked `estimated: true` is an observed BAND from real usage, not a
// published number - never present it as an exact quota. `window` distinguishes a rolling 5-hour
// window (Claude Max, Codex) from a rolling 7-day / weekly window (Claude Max weekly cap, Kimi
// weekly cap) or a free-tier request-rate cap (NVIDIA NIM).

const FIVE_HOURS_MS: u64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CURSOR_INCLUDED_API_USD: f64 = 20.0;

#[derive(serde::Deserialize, Clone, Default)]
struct UsagePlanConfig {
    claude_tier: Option<String>,
    claude_label: Option<String>,
    cursor_included_api_usd: Option<f64>,
}

impl UsagePlanConfig {
    fn claude_tier_key(&self) -> String {
        self.claude_tier
            .as_deref()
            .unwrap_or("unknown")
            .trim()
            .to_ascii_lowercase()
            .replace('-', "_")
            .replace(' ', "_")
    }

    fn claude_is_active(&self) -> bool {
        !matches!(
            self.claude_tier_key().as_str(),
            "expired" | "inactive" | "none" | "cancelled" | "canceled" | "off"
        )
    }

    fn claude_is_max(&self) -> bool {
        matches!(
            self.claude_tier_key().as_str(),
            "max" | "max_20x" | "max20x" | "max_5x" | "max5x"
        )
    }

    fn claude_label(&self) -> String {
        if let Some(label) = self
            .claude_label
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return label.to_string();
        }
        match self.claude_tier_key().as_str() {
            "expired" | "inactive" | "none" | "cancelled" | "canceled" | "off" => {
                "Claude (expired)".to_string()
            }
            "pro" => "Claude Pro".to_string(),
            "max" | "max_20x" | "max20x" | "max_5x" | "max5x" => "Claude Max".to_string(),
            _ => "Claude Pro/Max".to_string(),
        }
    }

    /// The DOLLAR row's caption.
    ///
    /// This used to say "quota not API-queryable", which was true of dollars and
    /// misleading about everything else - the quota IS measured. `usage_summary`
    /// carries a real 5h and weekly bar for both Pro and Max, built from observed
    /// throughput with learned caps, and it sits directly above this line.
    fn claude_status(&self) -> String {
        if !self.claude_is_active() {
            return "inactive (subscription expired; quota meter disabled)".to_string();
        }
        let tier = if self.claude_is_max() { "Max" } else { "Pro" };
        format!("on plan · {tier} · metered by quota, not dollars")
    }

    fn cursor_api_pool_usd(&self) -> f64 {
        self.cursor_included_api_usd
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(DEFAULT_CURSOR_INCLUDED_API_USD)
    }
}

fn usage_plan_config() -> UsagePlanConfig {
    let path = match usage_plan_config_path() {
        Some(p) => p,
        None => return UsagePlanConfig::default(),
    };
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return UsagePlanConfig::default(),
    };
    serde_json::from_str::<UsagePlanConfig>(&content).unwrap_or_default()
}

/// One plan-relative limit entry the frontend renders as a bar.
#[derive(serde::Serialize, Clone)]
pub struct PlanLimit {
    pub label: String,
    /// "5h" | "weekly" | "credits" | "rpm"
    pub window: String,
    pub used: f64,
    pub limit: f64,
    /// "msgs" | "tokens" | "credits" | "requests" | "percent"
    pub unit: String,
    /// Legacy flag kept for back-compat with the existing frontend: `true` unless
    /// the LIMIT is a published/queried real number. Derived from `basis` - a
    /// "real" or "learned" basis sets this false so the UI drops the bare "est."
    /// marker. Prefer `basis` for precise wording.
    pub estimated: bool,
    /// Precisely what the LIMIT figure is:
    ///   "real" - a live, authoritative number (Cursor's own count; Codex's
    ///                 own `used_percent`; a captured rate-limit header).
    ///   "learned" - empirically learned from a real signal (Claude Max cap
    ///                 ratcheted from real observed throughput - see claude_usage).
    ///   "estimated" - a hand-maintained observed band (last-resort fallback only).
    pub basis: &'static str,
    /// Fleet agent that OWNS keeping this source real (e.g. "Forge" owns Claude
    /// Max, "Vega" owns Codex, "Quill" owns Cursor). Attribution only - the UI can
    /// surface "kept real by <owner>". Empty for unattributed rows.
    pub owner: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
    /// Account the meter measures (email), when the source provides one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// When a blocking condition began (the `refused` sentinel row only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<u64>,
}

/// Static config for one plan-limit row: which window to aggregate, the cap, and
/// whether the cap is a published number or an observed estimate.
struct PlanLimitSpec {
    label: &'static str,
    window: &'static str,
    window_ms: u64,
    limit: f64,
    unit: &'static str,
    estimated: bool,
    /// "real" | "learned" | "estimated" - precise basis of the `limit` figure.
    basis: &'static str,
    /// Fleet agent that owns keeping this source real.
    owner: &'static str,
}

/// Claude Max: no public API for quota. Bands below are observed, not published - Anthropic's
/// actual Max limits vary by account tier and message length. `used` is the REAL local-session
/// count (see `claude_plan_limit()`); only this denominator is the estimate the UI marks "est."
/// - the caps sit comfortably above the highest usage measured without hitting a wall
/// while this was written.
const CLAUDE_MAX_5H: PlanLimitSpec = PlanLimitSpec {
    label: "Claude Max · 5h window",
    window: "5h",
    window_ms: FIVE_HOURS_MS,
    limit: 450.0, // seed only - real cap is LEARNED from observed throughput (claude_usage)
    unit: "msgs",
    estimated: true,
    basis: "learned",
    owner: "Forge",
};
const CLAUDE_MAX_WEEKLY: PlanLimitSpec = PlanLimitSpec {
    label: "Claude Max · weekly",
    window: "weekly",
    window_ms: SEVEN_DAYS_MS,
    limit: 9000.0, // seed only - real cap is LEARNED from observed throughput (claude_usage)
    unit: "msgs",
    estimated: true,
    basis: "learned",
    owner: "Forge",
};

// ── There is NO Codex ledger fallback, on purpose ────────────────────────────
//
// A "~45 msgs / 5h" band used to back-fill the Codex bars from Praxis's own
// delegation ledger whenever Codex's rollout logs couldn't be read. Measured
// 2026-09-12: usage.jsonl holds lines for `openrouter`, `claude` and `openai` and
// has NEVER held a single `codex` line, so that fallback could only ever resolve
// to 0 of 45 and 0 of 300 - a confident 0%.
//
// At that exact moment `codex exec -m gpt-6-astra` was answering:
//   "You've hit your usage limit ... try again at 2:02 PM."
//
// So the rail read EMPTY while the account was EXHAUSTED - the two readings that
// look identical on a meter and mean opposite things. A bar that cannot be
// measured has to say so, so `codex_plan_limit()` returns nothing when Codex's own
// signals are unavailable and the rail renders "NO METER" instead of a zero.

/// Kimi K3 (Moonshot) - used here via NVIDIA NIM (free) or OpenRouter (paid),
/// so this is a MODEL-level cap, not a `tool`-level one. NVIDIA NIM's own rate
/// limit is separate (see NVIDIA_NIM_RPM below); this row is Moonshot's weekly
/// message allowance on the assumption of their free/starter band.
const KIMI_WEEKLY: PlanLimitSpec = PlanLimitSpec {
    label: "Kimi K3 · weekly",
    window: "weekly",
    window_ms: SEVEN_DAYS_MS,
    limit: 500.0, // Moonshot does not publish a hard number for third-party API access - estimate
    unit: "msgs",
    estimated: true,
    basis: "estimated",
    owner: "Atlas",
};

/// NVIDIA NIM free tier - this one IS published: 40 requests/minute burst cap.
/// We show it as a request-rate gauge over the same 5h bucket as everything else
/// (not literally per-minute, since polling every 30s can't usefully show a
/// per-minute bar) - the "rpm" window tag tells the frontend to read it as a
/// rate cap rather than a quota, and the number is honest, not an estimate.
const NVIDIA_NIM_RPM: PlanLimitSpec = PlanLimitSpec {
    label: "NVIDIA NIM · free tier",
    window: "rpm",
    window_ms: FIVE_HOURS_MS,
    limit: 12_000.0, // 40 req/min x 300 min (5h) - a published rate cap projected over the window
    unit: "requests",
    estimated: false,
    basis: "real", // 40 req/min IS NVIDIA's published free-tier cap
    owner: "Atlas",
};

/// Resolve a `PlanLimitSpec` + a ledger-matching predicate into a rendered `PlanLimit`,
/// using `calls` as the "used" figure (all limits above are message/request counts,
/// not token counts - tokens are shown separately via the existing ModelUsage rows).
fn resolve_plan_limit(spec: &PlanLimitSpec, tool_match: impl Fn(&str, &str) -> bool) -> PlanLimit {
    let (calls, _input, _output) = ledger_window_totals(tool_match, spec.window_ms);
    PlanLimit {
        label: spec.label.to_string(),
        window: spec.window.to_string(),
        used: calls as f64,
        limit: spec.limit,
        unit: spec.unit.to_string(),
        estimated: spec.estimated,
        basis: spec.basis,
        owner: spec.owner,
        resets_at: None, // rolling windows have no fixed reset instant to report
        account: None,
        since_ms: None,
    }
}

/// Build the `plan` vec for a given source key. Sources with no modeled plan
/// limit (openrouter, hermes) get an empty vec - the frontend renders nothing
/// extra for those, same as today.
fn plan_limits_for(source_key: &str) -> Vec<PlanLimit> {
    match source_key {
        "claude" => {
            if !usage_plan_config().claude_is_max() {
                return vec![];
            }
            vec![
                resolve_plan_limit(&CLAUDE_MAX_5H, |t, _m| t == "claude"),
                resolve_plan_limit(&CLAUDE_MAX_WEEKLY, |t, _m| t == "claude"),
            ]
        }
        "nvidia" => {
            let mut out = vec![resolve_plan_limit(&NVIDIA_NIM_RPM, |t, _m| t == "nvidia")];
            // Kimi rides on the nvidia OR openrouter tool depending on which brain
            // provider the owner picked - match by model name across both.
            out.push(resolve_plan_limit(&KIMI_WEEKLY, |_t, m| m.contains("kimi")));
            out
        }
        "openrouter" => {
            // Kimi via the paid OpenRouter path also counts against the same
            // Moonshot weekly allowance - only show it here if that's where the
            // calls actually landed (avoids double-counting when nvidia already
            // rendered it: a given model's calls only ever land under one tool
            // per line, so this is mutually exclusive with the nvidia branch above).
            let kimi =
                resolve_plan_limit(&KIMI_WEEKLY, |t, m| t == "openrouter" && m.contains("kimi"));
            if kimi.used > 0.0 {
                vec![kimi]
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

/// On success → real 5H/WEEKLY percent bars. On other failure → learned local estimate clearly
/// labelled "est.". The last REAL Claude reading and when it was taken.
///
/// A reading from a few minutes ago is far truer than that, so it is shown (and says how old it
/// is) before any estimate is.
static LAST_REAL_CLAUDE: std::sync::Mutex<Option<(u64, Vec<PlanLimit>)>> = std::sync::Mutex::new(None);
const LAST_REAL_CLAUDE_MAX_AGE_MS: u64 = 90 * 60 * 1000;

/// A recent real reading, relabelled with its age; None when there is none this fresh.
/// After a restart this process has none of its own, so it falls back to the reading
/// claude_usage persisted (an install no longer drops the rail to the estimate).
fn recent_real_claude(now: u64) -> Option<Vec<PlanLimit>> {
    let (at, bars) = LAST_REAL_CLAUDE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| crate::claude_usage::last_live_reading().map(|(at, u)| (at, real_claude_bars(&u))))?;
    let age = now.saturating_sub(at);
    if age > LAST_REAL_CLAUDE_MAX_AGE_MS {
        return None;
    }
    let mins = (age / 60_000).max(1);
    Some(
        bars.iter()
            .cloned()
            .map(|mut b| {
                b.label = format!("{} · last read {mins} min ago", b.label);
                b
            })
            .collect(),
    )
}

/// An estimate may not claim more than the whole window: "3184%" of a weekly cap is a
/// count of tool messages, not a share of the owner's limit. Clamp and say it is unknown.
pub(crate) fn clamp_estimate(used: f64, limit: f64) -> (f64, bool) {
    if limit > 0.0 && used > limit {
        (limit, true)
    } else {
        (used.max(0.0), false)
    }
}

async fn claude_plan_limit() -> Option<Vec<PlanLimit>> {
    let cfg = usage_plan_config();
    if !cfg.claude_is_active() {
        return Some(vec![]);
    }

    // A refusal row leads whatever usage figure follows it.
    let mut lead: Vec<PlanLimit> = Vec::new();
    match crate::claude_usage::claude_oauth_usage().await {
        crate::claude_usage::ClaudeOauthResult::Live(u) => {
            let bars = real_claude_bars(&u);
            if let Ok(mut last) = LAST_REAL_CLAUDE.lock() {
                *last = Some((now_ms(), bars.clone()));
            }
            return Some(bars);
        }
        crate::claude_usage::ClaudeOauthResult::Refused(refusal) => {
            // The vendor is refusing Claude Code: Forge is benched and the
            // live meter cannot be read. The Supply rail shows this sentence and the
            // mission planner benches Forge on the `refused` window. Usage still matters
            // (the desktop app burns the same plan), so the best figure follows: a recent
            // real reading, else the local estimate.
            lead.push(PlanLimit {
                label: "The vendor is refusing Claude Code · Forge benched".to_string(),
                window: "refused".to_string(),
                used: 0.0,
                limit: 0.0,
                unit: "percent".to_string(),
                estimated: true,
                basis: "estimated",
                owner: "Forge",
                resets_at: None,
                account: None,
                since_ms: Some(refusal.since_ms),
            });
            if let Some(recent) = recent_real_claude(now_ms()) {
                lead.extend(recent);
                return Some(lead);
            }
        }
        crate::claude_usage::ClaudeOauthResult::AuthExpired => {
            // No bar pretending to be real - frontend note from this sentinel.
            return Some(vec![PlanLimit {
                label: "Claude sign-in expired - run claude /login".to_string(),
                window: "auth".to_string(),
                used: 0.0,
                limit: 0.0,
                unit: "percent".to_string(),
                estimated: true,
                basis: "estimated",
                owner: "Forge",
                resets_at: None,
                account: None,
                since_ms: None,
            }]);
        }
        crate::claude_usage::ClaudeOauthResult::Unavailable => {
            // A real reading from the last 90 minutes beats any estimate.
            if let Some(recent) = recent_real_claude(now_ms()) {
                return Some(recent);
            }
            // Anthropic paused the meter (429 + Retry-After, up to an hour): say so and
            // when it resumes, instead of a bare "est." that RELOAD seems unable to fix.
            if let Some(until) = crate::claude_usage::rate_limited_until(now_ms()) {
                lead.push(PlanLimit {
                    label: "The live meter is paused".to_string(),
                    window: "paused".to_string(),
                    used: 0.0,
                    limit: 0.0,
                    unit: "percent".to_string(),
                    estimated: true,
                    basis: "estimated",
                    owner: "Forge",
                    resets_at: Some(until),
                    account: None,
                    since_ms: None,
                });
            }
            // Otherwise fall through to the learned local estimate below.
        }
    }

    let plan_label = cfg.claude_label();
    // No local figure either: the refusal row (if any) is still the truth to show.
    let Some(usage) = crate::claude_usage::claude_usage(&cfg.claude_tier_key()).await else {
        return (!lead.is_empty()).then_some(lead);
    };
    let basis_5h = if usage.learned_5h {
        "learned"
    } else {
        "estimated"
    };
    let basis_wk = if usage.learned_weekly {
        "learned"
    } else {
        "estimated"
    };
    let (used_5h, over_5h) = clamp_estimate(usage.used_5h, usage.cap_5h);
    let (used_wk, over_wk) = clamp_estimate(usage.used_weekly, usage.cap_weekly);
    let over = |o: bool| if o { " · over the estimate — real reading unavailable" } else { "" };
    lead.extend(vec![
        PlanLimit {
            label: format!("{plan_label} · 5h window · est.{}", over(over_5h)),
            window: CLAUDE_MAX_5H.window.to_string(),
            used: used_5h,
            limit: usage.cap_5h,
            unit: CLAUDE_MAX_5H.unit.to_string(),
            estimated: true,
            basis: basis_5h,
            owner: CLAUDE_MAX_5H.owner,
            resets_at: None,
            account: None,
            since_ms: None,
        },
        PlanLimit {
            label: format!("{plan_label} · weekly · est.{}", over(over_wk)),
            window: CLAUDE_MAX_WEEKLY.window.to_string(),
            used: used_wk,
            limit: usage.cap_weekly,
            unit: CLAUDE_MAX_WEEKLY.unit.to_string(),
            estimated: true,
            basis: basis_wk,
            owner: CLAUDE_MAX_WEEKLY.owner,
            resets_at: None,
            account: None,
            since_ms: None,
        },
    ]);
    Some(lead)
}

fn real_claude_bars(u: &crate::claude_usage::ClaudeOauthUsage) -> Vec<PlanLimit> {
    let account = u.account_email.clone();
    let label_5h = if let Some(ref reason) = u.five_h.locked_reason {
        format!("{} · 5h window · locked: {reason}", u.plan_label)
    } else {
        format!("{} · 5h window", u.plan_label)
    };
    let label_wk = if let Some(ref reason) = u.weekly.locked_reason {
        format!("{} · weekly · locked: {reason}", u.plan_label)
    } else {
        format!("{} · weekly", u.plan_label)
    };
    vec![
        PlanLimit {
            label: label_5h,
            window: "5h".to_string(),
            used: u.five_h.utilization,
            limit: 100.0,
            unit: "percent".to_string(),
            estimated: false,
            basis: "real",
            owner: "Forge",
            resets_at: u.five_h.resets_at_ms,
            account: account.clone(),
            since_ms: None,
        },
        PlanLimit {
            label: label_wk,
            window: "weekly".to_string(),
            used: u.weekly.utilization,
            limit: 100.0,
            unit: "percent".to_string(),
            estimated: false,
            basis: "real",
            owner: "Forge",
            resets_at: u.weekly.resets_at_ms,
            account,
            since_ms: None,
        },
    ]
}

/// Codex's plan bars. Primary source is the live `/wham/usage` endpoint
/// (`codex_usage::codex_usage()`), the same numbers Codex `/status` shows.
/// Rollouts + a newer refusal are the fallback when that GET fails. Owner: Vega.
/// Returns an EMPTY vec when Codex's own signals say nothing - the rail then reads
/// "NO METER", which is the truthful rendering of "not measured".
async fn codex_plan_limit() -> Vec<PlanLimit> {
    let mut out: Vec<PlanLimit> = Vec::new();

    // Live `limit_reached` (or a refusal newer than the last snapshot) outranks
    // a stale percentage. A 95% snapshot alone still reads 95%.
    let quota_block = crate::codex_usage::codex_quota_state();
    let usage = crate::codex_usage::codex_usage().await;

    // Every label below is built through this ONE closure so the Supply rail can't say "Codex ·
    // Plus" in one place and a stale/bare "Codex" in another. `usage.as_ref()` only borrows, so
    // `usage` itself is still whole for the `let Some(usage) = usage else { .. }` unwrap further
    // down.
    let plan = usage.as_ref().and_then(|u| u.plan_type.clone());
    let codex_label = |suffix: &str| match &plan {
        Some(p) => format!("Codex · {p} · {suffix}"),
        None => format!("Codex · {suffix}"),
    };

    // ── Which window is actually full comes from Codex's own log ──────────────
    // `limit_hit` names the refused window from the last real reading. The
    // persisted block (a refusal Praxis itself observed) carries only the
    // CLI's reset text, so it is used only when the log cannot say which window
    // it was - and then it names no window rather than guessing "weekly".
    let limit_hit = usage.as_ref().and_then(|u| u.limit_hit);
    if let Some(hit) = limit_hit {
        let returns = hit
            .resets_at_ms
            .map(crate::codex_usage::fmt_local_clock_ms)
            .map(|t| format!(" - returns {t}"))
            .unwrap_or_default();
        out.push(PlanLimit {
            label: format!(
                "{} · LIMIT REACHED{returns}",
                codex_label(if hit.window == "5h" { "5h window" } else { "weekly" })
            ),
            window: hit.window.to_string(),
            // Not a guess and not an invented ceiling: Codex refused the run.
            used: 100.0,
            limit: 100.0,
            unit: "percent".to_string(),
            estimated: false,
            basis: "real",
            owner: "Vega",
            resets_at: hit.resets_at_ms,
            account: None,
            since_ms: None,
        });
    } else if let Some(block) = &quota_block {
        let label = block
            .reset_text
            .as_deref()
            .map(|t| format!("Codex · usage limit reached · returns {t}"))
            .unwrap_or_else(|| "Codex · usage limit reached".to_string());
        out.push(PlanLimit {
            label,
            window: "limit".to_string(),
            used: 100.0,
            limit: 100.0,
            unit: "percent".to_string(),
            estimated: false,
            basis: "real",
            owner: "Vega",
            resets_at: block.resets_at_ms,
            account: None,
            since_ms: None,
        });
    }

    let Some(usage) = usage else {
        return out;
    };
    if usage.is_empty() {
        // Codex answered but reported no window percentages (the 0.154.0 shape -
        // `primary: null, secondary: null`). Nothing measurable, so nothing drawn.
        crate::elog!(
            "[usage] codex reported no window percentages; rail shows NO METER rather than an estimate"
        );
        return out;
    }
    // used_percent is 0..100; we express it as used/limit with limit=100 so the
    // existing bar math (used/limit) renders the real percentage directly. Only
    // windows Codex actually reported get a bar.
    if let Some(five_h) = usage.five_h.filter(|_| limit_hit.map_or(true, |h| h.window != "5h")) {
        out.push(PlanLimit {
            label: codex_label("5h window"),
            window: "5h".to_string(),
            used: five_h.used_percent,
            limit: 100.0,
            unit: "percent".to_string(),
            estimated: false, // Codex's own reported percentage - real
            basis: "real",
            owner: "Vega",
            resets_at: five_h.resets_at_ms,
            account: None,
            since_ms: None,
        });
    }
    // Draw the weekly reading unless weekly IS the window already shown as full.
    // (This used to hide it whenever ANY block existed, which erased a real 15%
    // weekly reading behind a refusal that was actually the 5-hour window.)
    if limit_hit.map_or(true, |h| h.window != "weekly") {
        if let Some(weekly) = usage.weekly {
            out.push(PlanLimit {
                label: codex_label("weekly"),
                window: "weekly".to_string(),
                used: weekly.used_percent,
                limit: 100.0,
                unit: "percent".to_string(),
                estimated: false,
                basis: "real",
                owner: "Vega",
                resets_at: weekly.resets_at_ms,
                account: None,
                since_ms: None,
            });
        }
    }
    out
}

/// Cursor's plan bars from a LIVE fetch (`cursor_usage::cursor_usage()`).
/// TOTAL + API from `totalPercentUsed` / `apiPercentUsed` (never the saturated
/// legacy used/limit counter). Optional ON-DEMAND when enabled. Cache is 2 min.
async fn cursor_plan_limit() -> Vec<PlanLimit> {
    match crate::cursor_usage::cursor_usage().await {
        Some(u) => {
            let account = u.account_email.clone();
            // Membership rides on every bar label so the frontend can build
            // "pro · resets Oct 2 · email" without a parallel channel.
            let membership = u.membership_label.clone();
            u.bars
                .into_iter()
                .map(|b| {
                    let label = if b.label.starts_with("QUOTA") {
                        // used/limit fallback - keep the fallback wording visible.
                        format!("Cursor · {membership} · {}", b.label)
                    } else {
                        format!("Cursor · {membership} · {}", b.label)
                    };
                    PlanLimit {
                        label,
                        window: "credits".to_string(),
                        used: b.used,
                        limit: b.limit,
                        unit: b.unit,
                        estimated: b.estimated,
                        basis: b.basis,
                        // Cursor is QUILL's rail (fleetStore FLEET_AGENTS). Lens is visual
                        // QA on OpenRouter/NVIDIA and never spends a Cursor request, so the
                        // Supply rail was attributing the owner's Cursor usage to the wrong agent.
                        // Claude->Forge and Codex->Vega were already correct; only this one
                        // was wrong.
                        owner: "Quill",
                        resets_at: u.resets_at_ms,
                        account: account.clone(),
                        since_ms: None,
                    }
                })
                .collect()
        }
        None => vec![],
    }
}

/// `usage_summary` - plan-relative usage bars for the Command Center. Returns one
/// entry per source key that has at least one modeled plan limit; each entry
/// carries the same `key`/`label` as `usage_snapshot`'s `ToolUsage` rows plus a
/// `plan: Vec<PlanLimit>` the frontend merges onto its existing `UsageSource`.
#[derive(serde::Serialize)]
pub struct PlanUsage {
    pub key: String,
    pub plan: Vec<PlanLimit>,
}

#[tauri::command]
pub async fn usage_summary() -> Result<Vec<PlanUsage>, String> {
    // NVIDIA/OpenRouter stay ledger-derived (nobody exposes a live number for
    // those). Claude is resolved through local plan config; Codex comes from its
    // own persisted signal.
    let keys = ["nvidia", "openrouter"];
    let mut out: Vec<PlanUsage> = keys
        .iter()
        .map(|k| PlanUsage {
            key: k.to_string(),
            plan: plan_limits_for(k),
        })
        .filter(|p| !p.plan.is_empty())
        .collect();

    // Claude Max only: prefer the real local-session count + learned cap. Expired,
    // inactive, and Pro tiers return no plan bars.
    let claude_plan = match claude_plan_limit().await {
        Some(plan) => plan,
        None => plan_limits_for("claude"),
    };
    if !claude_plan.is_empty() {
        out.push(PlanUsage {
            key: "claude".to_string(),
            plan: claude_plan,
        });
    }

    // Codex: Codex CLI's OWN signals only - its persisted rate-limit percentages,
    // or the quota-exhausted state its CLI reported to us. No ledger fallback
    // (see the note above the plan specs): an unmeasurable rail says NO METER.
    let codex_plan = codex_plan_limit().await;
    if !codex_plan.is_empty() {
        out.push(PlanUsage {
            key: "codex".to_string(),
            plan: codex_plan,
        });
    }

    // Cursor's bar is live-fetched (async network call), unlike the ledger-derived
    // rows above - resolved separately so a slow/failed Cursor fetch never blocks
    // the other sources from returning promptly.
    let cursor_plan = cursor_plan_limit().await;
    if !cursor_plan.is_empty() {
        out.push(PlanUsage {
            key: "cursor".to_string(),
            plan: cursor_plan,
        });
    }

    Ok(out)
}

/// Live plan TIER only per provider (e.g. "Pro", "Plus", "Max") - never a full
/// "Claude Pro"-style label, since the one caller (Flight Deck's VIA badge)
/// already names the provider itself and just appends this. `None` means "not
/// known right now"; the deck must render the provider alone rather than guess.
#[derive(serde::Serialize)]
pub struct PlanNames {
    pub claude: Option<String>,
    pub codex: Option<String>,
    /// Always `None` today. Cursor's own label ("pro") doesn't fit the
    /// "PROVIDER TIER" shape the deck's VIA badge uses, and that badge's
    /// hardcoded "CURSOR PRO" is already correct - nothing consumes this yet.
    pub cursor: Option<String>,
}

/// `plan_names` - the cheap, non-blocking companion to `usage_summary` for
/// surfaces (Flight Deck's agent VIA badges) that need just the plan tier, not a
/// full rail bar. Reuses `usage_summary`'s own sources (`usage_plan_config` for
/// Claude, `codex_usage::codex_usage`'s 60s-cached read for Codex) so there is
/// exactly one place each provider's plan is resolved.
#[tauri::command]
pub async fn plan_names() -> Result<PlanNames, String> {
    let cfg = usage_plan_config();
    let claude = cfg
        .claude_is_active()
        .then(|| if cfg.claude_is_max() { "Max" } else { "Pro" }.to_string());
    let codex = crate::codex_usage::codex_usage()
        .await
        .and_then(|u| u.plan_type);
    Ok(PlanNames {
        claude,
        codex,
        cursor: None,
    })
}

// ── ToolUsage (the frontend contract) ───────────────────────────────────────

/// Per-model usage breakdown row sent to the frontend.
#[derive(serde::Serialize)]
pub struct ModelUsage {
    /// Model identifier (e.g. `"google/gemini-2.5-flash"`, `"codex"`).
    pub model: String,
    /// Total calls this session.
    pub calls: u64,
    /// Total input tokens.
    pub input_tokens: u64,
    /// Total output tokens.
    pub output_tokens: u64,
    pub cost_usd: f64,
    /// Unix ms timestamp of the most recent recorded run (0 = never / pre-dates this field).
    /// Lets the UI show "Forge · 12 runs · 4m ago" per named agent.
    pub last_run_ms: u64,
}

/// A single tool's usage snapshot. Field names are snake_case - the TypeScript
/// frontend reads them verbatim via `invoke("usage_snapshot")`.
#[derive(serde::Serialize)]
pub struct ToolUsage {
    /// Stable identifier (e.g. `"openrouter"`, `"claude"`, `"codex"`, `"cursor"`).
    pub key: String,
    /// Human-readable label shown in the UI (e.g. `"OpenRouter"`).
    pub label: String,
    /// Running spend in USD.
    pub spent_usd: f64,
    pub limit_usd: Option<f64>,
    pub status: String,
    /// `true` when this row reflects a live API query (not a local estimate).
    pub live: bool,
    /// Signal that THIS rail's own numbers are affected by a usage-system problem.
    /// Scoped: a ledger fault sets it on every locally-metered rail, while an
    /// OpenAI Realtime accounting fault sets it only on the OpenAI rail. Clears as
    /// soon as the fault is disproved (a completed write, or a startup revalidate).
    pub persistence_degraded: bool,
    /// The specific problem, in a sentence fit for the rail caption - e.g. "usage.jsonl
    /// has 2 unparseable line(s)". `None` whenever `persistence_degraded` is false.
    /// A caption that just says "degraded" on every rail tells nobody anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded_reason: Option<String>,
    /// When OpenAI last refused a paid call on this key for an empty wallet, Unix ms.
    /// `None` whenever nothing measured says the account is blocked. This is an
    /// OBSERVATION with a timestamp, never an inference from the spend tally - it is
    /// set only by a real 429 carrying `insufficient_quota`, and cleared by the next
    /// call that succeeds. The UI captions the rail from this instead of computing a
    /// "left of" figure an API key has no way to know.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_credit_since_ms: Option<u64>,
    /// Per-model breakdown (populated from the `models` key in usage.json).
    pub models: Vec<ModelUsage>,
}

// ── OpenRouter live fetch ────────────────────────────────────────────────────

/// GET `https://openrouter.ai/api/v1/key` and parse the usage fields.
/// Returns a row with `spent_usd = 0.0` / `live = false` on any error.
async fn fetch_openrouter() -> ToolUsage {
    let fallback = ToolUsage {
        key: "openrouter".to_string(),
        label: "OpenRouter".to_string(),
        spent_usd: 0.0,
        limit_usd: None,
        status: "unavailable".to_string(),
        live: false,
        persistence_degraded: false,
        degraded_reason: None,
        no_credit_since_ms: None,
        models: vec![],
    };

    let api_key = match read_vault_key("OPENROUTER_API_KEY") {
        Some(k) => k,
        None => {
            crate::elog!("[usage] OPENROUTER_API_KEY not in vault — OpenRouter row will show 0");
            return fallback;
        }
    };

    // Build a one-shot reqwest client with a short timeout so we never block the UI.
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            crate::elog!("[usage] reqwest build error: {e}");
            return fallback;
        }
    };

    let resp = match client
        .get("https://openrouter.ai/api/v1/key")
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::elog!("[usage] OpenRouter GET error: {e}");
            return fallback;
        }
    };

    if !resp.status().is_success() {
        crate::elog!("[usage] OpenRouter returned HTTP {}", resp.status());
        return fallback;
    }

    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::elog!("[usage] OpenRouter JSON parse error: {e}");
            return fallback;
        }
    };

    // Response shape: `{ "data": { "usage": <f64>, "limit": <f64|null>, ... } }`
    let data = match body.get("data") {
        Some(d) => d,
        None => {
            crate::elog!("[usage] OpenRouter response missing 'data' field");
            return fallback;
        }
    };

    let spent_usd = data.get("usage").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let limit_usd = data.get("limit").and_then(|v| v.as_f64()); // None when null/missing

    // Also pull any per-model breakdown we've accumulated locally for OpenRouter models.
    let or_models = read_models_for_provider("openrouter");

    ToolUsage {
        key: "openrouter".to_string(),
        label: "OpenRouter".to_string(),
        spent_usd,
        limit_usd,
        status: "live".to_string(),
        live: true,
        // OpenRouter's spend comes straight off their API, not the local ledger,
        // so a local ledger fault genuinely does not affect this row.
        persistence_degraded: false,
        degraded_reason: None,
        no_credit_since_ms: None,
        models: or_models,
    }
}

// ── Model breakdown helpers ──────────────────────────────────────────────────

/// Read the accumulated `models` map from usage.json and filter to entries whose
/// key contains `provider_hint` (e.g. `"openrouter"` matches `"google/gemini-2.5-flash"`
/// only when that model was recorded under the openrouter tool - we key by model id,
/// so here we just return ALL model entries not prefixed with a tool name).
///
/// `"claude/claude-opus-4"` or just the raw model name from `claude -p`.
fn models_for_provider_from_map(
    map: &serde_json::Map<String, Value>,
    provider_hint: &str,
) -> Vec<ModelUsage> {
    let models_obj = match map.get("models").and_then(|v| v.as_object()) {
        Some(o) => o.clone(),
        None => return vec![],
    };
    let mut out = Vec::new();
    for (model_id, val) in &models_obj {
        // "openai" is deliberately NOT a `starts_with` match: OpenRouter hosts several
        // `openai/...`-prefixed model ids (e.g. `openai/gpt-4.1-mini`, Lens's QA vision
        // model) that must stay attributed to the "openrouter" row, not this one. The
        // OpenAI-platform-API row (realtime voice credits) only ever records raw model
        // names with no "/" (e.g. "gpt-4o-realtime-preview"), same convention as
        // claude/codex/cursor - so it matches via the exact-equality arm only.
        let matches = match provider_hint {
            "openrouter" => {
                model_id.contains('/')
                    && !model_id.starts_with("claude")
                    && !model_id.starts_with("codex")
                    && !model_id.starts_with("cursor")
            }
            "openai" => {
                !model_id.contains('/')
                    && (model_id == "openai"
                        || model_id.starts_with("gpt-5.6-")
                        || model_id.starts_with("gpt-4.1")
                        || model_id.starts_with("gpt-4o-realtime")
                        || model_id.starts_with("gpt-realtime"))
            }
            other => model_id.starts_with(other) || (!model_id.contains('/') && model_id == other),
        };
        if !matches {
            continue;
        }
        if let Ok(entry) = serde_json::from_value::<ModelEntry>(val.clone()) {
            out.push(ModelUsage {
                model: model_id.clone(),
                calls: entry.calls,
                input_tokens: entry.input_tokens,
                output_tokens: entry.output_tokens,
                cost_usd: entry.cost_usd,
                last_run_ms: entry.last_run_ms,
            });
        }
    }
    // Sort by descending cost so the most-used model appears first.
    out.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn read_models_for_provider(provider_hint: &str) -> Vec<ModelUsage> {
    let map = read_accumulator();
    models_for_provider_from_map(&map, provider_hint)
}


// It was never a balance:
//
//   * The subtraction between them is arithmetic on two numbers OpenAI never sent.
//
// What Praxis CAN prove is the outcome of the last call it made, which is exactly what
// `openai_credit` records. So the row now reports two honest things and nothing else:
// the running total Praxis itself spent, captioned as its own ledger, and - when one
// has actually been observed - a refusal with the time it happened.

/// The OpenAI rail's caption. Two states, both statements about what was measured:
fn openai_row_status(refusal: Option<&crate::openai_credit::OpenAiCreditState>) -> String {
    match refusal {
        Some(state) => format!(
            "NO CREDIT · calls refused since {}",
            crate::codex_usage::fmt_local_clock_ms(state.detected_ms)
        ),
        None => "live · Praxis's own spend ledger, not an OpenAI balance".to_string(),
    }
}

fn subscription_rows() -> Vec<ToolUsage> {
    let map = read_accumulator();
    // NOT "est". The real meter for both is the quota bar, which `usage_summary` fills from
    // Codex's own rate-limit records and Cursor's backend, and which has been live all along.
    let status = "on plan · metered by quota, not dollars".to_string();
    let usage_plan = usage_plan_config();
    // PER-RAIL, NOT ONE BOOL FOR ALL FIVE. Each row now asks whether the live fault actually
    // describes it.
    let reason_for = |key: &str| usage_degraded_reason_for(key);
    // Read once per build: the OpenAI row's caption depends on a real observation,
    // not on the spend tally. `None` means nothing measured says the key is blocked.
    let openai_refusal = crate::openai_credit::openai_credit_state();

    vec![
        ToolUsage {
            key: "nvidia".to_string(),
            label: "NVIDIA NIM".to_string(),
            spent_usd: 0.0,
            limit_usd: None,
            status: "free · NVIDIA NIM (40 req/min)".to_string(),
            live: false,
            persistence_degraded: reason_for("nvidia").is_some(),
            degraded_reason: reason_for("nvidia"),
            no_credit_since_ms: None,
            models: models_for_provider_from_map(&map, "nvidia"),
        },
        ToolUsage {
            key: "openai".to_string(),
            label: "OpenAI API".to_string(),
            spent_usd: accumulator_get(&map, "openai"),
            // No ceiling, because no ceiling is knowable from an API key. The rail
            // draws a running total, not a bar against an invented maximum.
            limit_usd: None,
            status: openai_row_status(openai_refusal.as_ref()),
            live: true,
            persistence_degraded: reason_for("openai").is_some(),
            degraded_reason: reason_for("openai"),
            no_credit_since_ms: openai_refusal.as_ref().map(|r| r.detected_ms),
            models: models_for_provider_from_map(&map, "openai"),
        },
        ToolUsage {
            key: "claude".to_string(),
            label: usage_plan.claude_label(),
            spent_usd: accumulator_get(&map, "claude"),
            limit_usd: None,
            status: usage_plan.claude_status(),
            live: false,
            persistence_degraded: reason_for("claude").is_some(),
            degraded_reason: reason_for("claude"),
            no_credit_since_ms: None,
            models: models_for_provider_from_map(&map, "claude"),
        },
        ToolUsage {
            key: "codex".to_string(),
            label: "Codex CLI".to_string(),
            spent_usd: accumulator_get(&map, "codex"),
            limit_usd: None,
            status: status.clone(),
            live: false,
            persistence_degraded: reason_for("codex").is_some(),
            degraded_reason: reason_for("codex"),
            no_credit_since_ms: None,
            models: models_for_provider_from_map(&map, "codex"),
        },
        ToolUsage {
            // Base row stays "on plan" (no $ meter - Cursor is a flat sub, same as
            // Claude/Codex). The REAL number - used/limit premium requests, live from
            // Cursor's own backend - rides in separately via `usage_summary`'s `plan`
            // vec (see `cursor_plan_limit()` below), which the frontend merges onto
            // this row by `key`. If that live fetch fails for any reason, `plan` is
            // simply empty and this row still renders fine on its own - no error state.
            key: "cursor".to_string(),
            label: "Cursor".to_string(),
            spent_usd: accumulator_get(&map, "cursor"),
            limit_usd: None,
            status,
            live: false,
            persistence_degraded: reason_for("cursor").is_some(),
            degraded_reason: reason_for("cursor"),
            no_credit_since_ms: None,
            models: models_for_provider_from_map(&map, "cursor"),
        },
    ]
}

// ── Tauri command ────────────────────────────────────────────────────────────

/// Return a snapshot of all tool usage/cost data.
///
/// - OpenRouter: live GET to `/api/v1/key` (key from vault).
/// - Claude / Codex / Cursor: read `%LOCALAPPDATA%\Praxis\usage.json` (local running totals).
///
/// All network and file operations degrade gracefully - the command always returns
/// a full Vec, never panics, never blocks longer than ~8 s (OpenRouter timeout).
#[tauri::command]
pub async fn usage_snapshot() -> Result<Vec<ToolUsage>, String> {
    // Fire the live fetch and the local reads concurrently (local reads are synchronous
    // and cheap, so we run them first while the HTTP request is in flight).
    let or_future = fetch_openrouter();
    let local = subscription_rows();
    let or_row = or_future.await;

    let mut rows = Vec::with_capacity(5);
    rows.push(or_row);
    rows.extend(local);
    Ok(rows)
}

#[cfg(test)]
mod claude_rail_tests {
    use super::*;

    /// An estimate never claims more than the whole window.
    #[test]
    fn an_estimate_never_exceeds_the_window() {
        assert_eq!(clamp_estimate(1080.0, 450.0), (450.0, true));
        assert_eq!(clamp_estimate(120.0, 450.0), (120.0, false));
        assert_eq!(clamp_estimate(-3.0, 450.0), (0.0, false));
    }

    #[test]
    fn a_recent_real_reading_is_preferred_and_says_its_age() {
        let bar = PlanLimit {
            label: "Claude Pro · 5h window".into(),
            window: "5h".into(),
            used: 36.0,
            limit: 100.0,
            unit: "percent".into(),
            estimated: false,
            basis: "real",
            owner: "Forge",
            resets_at: None,
            account: None,
            since_ms: None,
        };
        let t0 = 10_000_000_u64;
        *LAST_REAL_CLAUDE.lock().unwrap() = Some((t0, vec![bar]));
        let recent = recent_real_claude(t0 + 12 * 60_000).expect("12 minutes old is recent");
        assert_eq!(recent[0].used, 36.0);
        assert!(recent[0].label.ends_with("last read 12 min ago"), "{}", recent[0].label);
        assert!(recent_real_claude(t0 + 2 * 60 * 60_000).is_none(), "two hours old is too stale");
        *LAST_REAL_CLAUDE.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    /// The rail must never again render a "left of" figure, in either direction.
    /// This is the regression that cost a real spending decision on 2026-09-15.
    #[test]
    fn openai_row_never_claims_a_balance() {
        let clear = openai_row_status(None);
        assert!(
            clear.contains("own spend ledger") && clear.contains("not an OpenAI balance"),
            "the spend total must be named as Praxis's own ledger, got {clear:?}"
        );
        for text in [&clear, &openai_row_status(Some(&crate::openai_credit::OpenAiCreditState {
            schema_version: 1,
            refused: true,
            detected_ms: 1_757_970_000_000,
            consecutive: 1,
            source: "brain".into(),
        }))] {
            assert!(!text.contains("left of"), "no balance arithmetic: {text:?}");
            assert!(!text.contains('$'), "no dollar ceiling in the caption: {text:?}");
        }
    }

    /// A recorded refusal captions the rail with WHEN it happened, so the claim is
    /// about a measurement and ages honestly.
    #[test]
    fn a_recorded_refusal_captions_no_credit_with_a_time() {
        let status = openai_row_status(Some(&crate::openai_credit::OpenAiCreditState {
            schema_version: 1,
            refused: true,
            detected_ms: 1_757_970_000_000,
            consecutive: 2,
            source: "realtime mint".into(),
        }));
        assert!(status.starts_with("NO CREDIT"), "got {status:?}");
        assert!(status.contains("refused since"), "must timestamp the observation: {status:?}");
    }

    /// The fabricated ceiling is gone: the OpenAI row must carry no `limit_usd`, or the
    /// UI can compute a remaining balance again.
    #[test]
    fn openai_row_publishes_no_spend_ceiling() {
        let openai = subscription_rows()
            .into_iter()
            .find(|r| r.key == "openai")
            .expect("openai row exists");
        assert_eq!(
            openai.limit_usd, None,
            "an API key cannot read a credit balance, so no ceiling may be published"
        );
    }

    /// Diagnostic against the REAL files on this machine:
    ///   cargo test -p praxis usage::tests::diag_real_ledger -- --nocapture --ignored
    #[test]
    #[ignore]
    fn diag_real_ledger() {
        let acc = usage_file_path().unwrap();
        let led = usage_ledger_path().unwrap();
        eprintln!("accumulator: {}", acc.display());
        eprintln!("ledger     : {}", led.display());
        match read_accumulator_from(&acc) {
            Ok(m) => eprintln!("accumulator OK, keys={}", m.len()),
            Err(e) => eprintln!("accumulator ERR: {e}"),
        }
        match read_ledger_lines_from(&led) {
            Ok((entries, malformed)) => {
                eprintln!("ledger entries={} malformed={}", entries.len(), malformed);
                match validate_ledger_sequences(&entries) {
                    Ok(max) => eprintln!("sequences OK, max={max}"),
                    Err(e) => eprintln!("sequences ERR: {e}"),
                }
            }
            Err(e) => eprintln!("ledger ERR: {e}"),
        }
        match cumulative_usage_cost_from(&acc, &led, "openai") {
            Ok(v) => eprintln!("cumulative openai = {v}"),
            Err(e) => eprintln!("cumulative ERR: {e}"),
        }
    }

    use super::*;
    use std::sync::{Arc, Barrier};

    fn test_paths(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let sequence = USAGE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "praxis-usage-test-{}-{}-{name}",
            std::process::id(),
            sequence
        ));
        let accumulator = dir.join("usage.json");
        let ledger = dir.join("usage.jsonl");
        (dir, accumulator, ledger)
    }

    fn model_entry(map: &serde_json::Map<String, Value>, model: &str) -> ModelEntry {
        serde_json::from_value(
            map.get("models")
                .and_then(Value::as_object)
                .and_then(|models| models.get(model))
                .cloned()
                .expect("model entry"),
        )
        .expect("valid model entry")
    }

    #[test]
    fn concurrent_record_usage_preserves_every_total_and_model_call() {
        let (dir, accumulator, ledger) = test_paths("concurrent");
        let workers = 32u64;
        let barrier = Arc::new(Barrier::new(workers as usize));
        let mut handles = Vec::new();
        for index in 0..workers {
            let worker_accumulator = accumulator.clone();
            let worker_ledger = ledger.clone();
            let worker_barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                worker_barrier.wait();
                record_usage_to(
                    &worker_accumulator,
                    &worker_ledger,
                    "openai",
                    "gpt-test",
                    index + 1,
                    2,
                    0.25,
                )
                .expect("record usage");
            }));
        }
        for handle in handles {
            handle.join().expect("worker should not panic");
        }

        let map = read_accumulator_from(&accumulator).expect("read accumulator");
        assert!((accumulator_get(&map, "openai") - 8.0).abs() < f64::EPSILON);
        let model = model_entry(&map, "gpt-test");
        assert_eq!(model.calls, workers);
        assert_eq!(model.input_tokens, (1..=workers).sum::<u64>());
        assert_eq!(model.output_tokens, workers * 2);
        assert!((model.cost_usd - 8.0).abs() < f64::EPSILON);
        assert_eq!(
            map.get(APPLIED_LEDGER_SEQUENCE_KEY).and_then(Value::as_u64),
            Some(workers)
        );

        let (entries, malformed) = read_ledger_lines_from(&ledger).expect("read ledger");
        assert_eq!(malformed, 0);
        assert_eq!(entries.len(), workers as usize);
        let mut sequences: Vec<u64> = entries.iter().map(|entry| entry.sequence).collect();
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=workers).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn append_separates_a_partial_tail_so_the_next_entry_remains_parseable() {
        let (dir, _accumulator, ledger) = test_paths("partial-tail");
        std::fs::create_dir_all(&dir).expect("create test directory");
        std::fs::write(&ledger, b"{\"sequence\":").expect("write interrupted tail");
        let entry = LedgerLine {
            sequence: 1,
            ts: 100,
            tool: "openai".to_string(),
            model: "gpt-test".to_string(),
            calls: 1,
            input_tokens: 2,
            output_tokens: 3,
            cost_usd: 0.5,
        };
        append_ledger_line_durable(&ledger, &entry).expect("append after partial tail");

        let (entries, malformed) = read_ledger_lines_from(&ledger).expect("read split ledger");
        assert_eq!(malformed, 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].sequence, 1);
        let raw = std::fs::read_to_string(&ledger).expect("read raw ledger");
        assert!(raw.starts_with("{\"sequence\":\n{"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn journal_replays_an_entry_missing_from_the_accumulator() {
        let (dir, accumulator, ledger) = test_paths("reconcile");
        let interrupted = LedgerLine {
            sequence: 1,
            ts: 100,
            tool: "openai".to_string(),
            model: "gpt-test".to_string(),
            calls: 1,
            input_tokens: 3,
            output_tokens: 4,
            cost_usd: 1.25,
        };
        append_ledger_line_durable(&ledger, &interrupted).expect("append journal entry");
        record_usage_to(&accumulator, &ledger, "openai", "gpt-test", 5, 6, 0.75)
            .expect("record after interrupted replace");

        let map = read_accumulator_from(&accumulator).expect("read reconciled accumulator");
        assert!((accumulator_get(&map, "openai") - 2.0).abs() < f64::EPSILON);
        let model = model_entry(&map, "gpt-test");
        assert_eq!(model.calls, 2);
        assert_eq!(model.input_tokens, 8);
        assert_eq!(model.output_tokens, 10);
        assert_eq!(
            map.get(APPLIED_LEDGER_SEQUENCE_KEY).and_then(Value::as_u64),
            Some(2)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_accumulator_fails_without_destructive_reset() {
        let (dir, accumulator, ledger) = test_paths("corrupt");
        std::fs::create_dir_all(&dir).expect("create test dir");
        let original = b"{not-valid-json";
        std::fs::write(&accumulator, original).expect("write corrupt accumulator");
        let result = record_usage_to(&accumulator, &ledger, "openai", "gpt-test", 1, 1, 0.5);
        assert_eq!(result, Err("usage-accumulator-invalid".to_string()));
        assert_eq!(
            std::fs::read(&accumulator).expect("read original"),
            original
        );
        assert!(!ledger.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_accumulator_replacement_leaves_only_valid_destination() {
        let (dir, accumulator, _ledger) = test_paths("replace");
        let mut first = serde_json::Map::new();
        first.insert("openai".to_string(), Value::from(1.0));
        write_accumulator_to(&accumulator, first).expect("write first accumulator");
        let mut second = serde_json::Map::new();
        second.insert("openai".to_string(), Value::from(2.0));
        write_accumulator_to(&accumulator, second).expect("replace accumulator");

        let map = read_accumulator_from(&accumulator).expect("read replaced accumulator");
        assert_eq!(accumulator_get(&map, "openai"), 2.0);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read test dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persistence_health_is_sticky_across_file_reloads() {
        let (dir, _accumulator, _ledger) = test_paths("health");
        let health = dir.join("usage-health.json");
        assert!(!usage_health_degraded_from(&health));
        assert_eq!(
            record_usage_health_failure_to(&health, DegradedScope::Ledger, "test write failure"),
            Ok(1)
        );
        assert!(usage_health_degraded_from(&health));
        assert_eq!(
            record_usage_health_failure_to(&health, DegradedScope::Ledger, "test write failure"),
            Ok(2)
        );
        let map = read_accumulator_from(&health).expect("read health file");
        assert_eq!(map.get("failure_count").and_then(Value::as_u64), Some(2));
        assert_eq!(map.get("degraded").and_then(Value::as_bool), Some(true));
        // Schema 2 persists WHICH rails are affected, so one Realtime accounting
        // slip no longer paints "ledger degraded" across every supply rail.
        assert_eq!(map.get("scope").and_then(Value::as_str), Some("ledger"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fresh_missing_accumulator_and_ledger_mean_zero_spend() {
        let (dir, accumulator, ledger) = test_paths("fresh-cost");
        assert_eq!(
            cumulative_usage_cost_from(&accumulator, &ledger, "openai"),
            Ok(0.0)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_ledger_with_accumulator_history_fails_closed() {
        let (dir, accumulator, ledger) = test_paths("missing-ledger");
        let mut map = serde_json::Map::new();
        map.insert("openai".to_string(), Value::from(1.0));
        map.insert(APPLIED_LEDGER_SEQUENCE_KEY.to_string(), Value::from(1));
        write_accumulator_to(&accumulator, map).expect("write accumulator");
        assert_eq!(
            cumulative_usage_cost_from(&accumulator, &ledger, "openai"),
            Err("usage-ledger-missing-with-history".to_string())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sequence_gap_or_truncated_tail_fails_closed() {
        let (dir, accumulator, ledger) = test_paths("sequence-gap");
        let gap = LedgerLine {
            sequence: 2,
            ts: 100,
            tool: "openai".to_string(),
            model: "gpt-test".to_string(),
            calls: 1,
            input_tokens: 1,
            output_tokens: 1,
            cost_usd: 1.0,
        };
        append_ledger_line_durable(&ledger, &gap).expect("append gap entry");
        let mut map = serde_json::Map::new();
        map.insert("openai".to_string(), Value::from(1.0));
        map.insert(APPLIED_LEDGER_SEQUENCE_KEY.to_string(), Value::from(2));
        write_accumulator_to(&accumulator, map).expect("write accumulator");
        assert_eq!(
            cumulative_usage_cost_from(&accumulator, &ledger, "openai"),
            Err("usage-ledger-sequence-gap-or-duplicate".to_string())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Taking the maximum keeps that and keeps the feature alive. Genuinely corrupt journals
    /// (gap, malformed, missing with history) still fail closed - see the neighbouring tests.
    #[test]
    fn accumulator_above_journal_reports_the_larger_record_never_less() {
        let (dir, accumulator, ledger) = test_paths("cost-mismatch");
        let entry = LedgerLine {
            sequence: 1,
            ts: 100,
            tool: "openai".to_string(),
            model: "gpt-test".to_string(),
            calls: 1,
            input_tokens: 1,
            output_tokens: 1,
            cost_usd: 1.0,
        };
        append_ledger_line_durable(&ledger, &entry).expect("append entry");
        let mut map = serde_json::Map::new();
        map.insert("openai".to_string(), Value::from(2.0));
        map.insert(APPLIED_LEDGER_SEQUENCE_KEY.to_string(), Value::from(1));
        write_accumulator_to(&accumulator, map).expect("write accumulator");
        let reported = cumulative_usage_cost_from(&accumulator, &ledger, "openai")
            .expect("pre-journal spend is history, not corruption");
        // The cap must see every dollar EITHER record knows about.
        assert!(reported >= 2.0, "never less than the accumulator: got {reported}");
        assert!(reported >= 1.0, "never less than the journal: got {reported}");
        assert_eq!(reported, 2.0);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Hit the REAL Cursor / Claude / Codex sources on this machine and print one
    /// line per bar: label, used, limit, unit, basis, resets, account.
    /// Numbers and emails only - never tokens.
    ///
    ///   cd src-tauri; cargo test --lib live_usage_print -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_usage_print() {
        eprintln!("=== live_usage_print ===");

        // Cursor
        match crate::cursor_usage::cursor_usage().await {
            Some(u) => {
                let resets = u
                    .resets_at_ms
                    .map(|ms| crate::cursor_usage::fmt_reset_short(ms))
                    .unwrap_or_else(|| "-".into());
                let acct = u.account_email.as_deref().unwrap_or("-");
                for b in &u.bars {
                    eprintln!(
                        "CURSOR\tlabel={}\tused={}\tlimit={}\tunit={}\tbasis={}\tresets={}\taccount={}",
                        b.label, b.used, b.limit, b.unit, b.basis, resets, acct
                    );
                }
                if u.bars.is_empty() {
                    eprintln!("CURSOR\t(no bars)\taccount={acct}");
                }
            }
            None => eprintln!("CURSOR\t(unavailable)"),
        }

        match crate::claude_usage::claude_oauth_usage().await {
            crate::claude_usage::ClaudeOauthResult::Live(u) => {
                let acct = u.account_email.as_deref().unwrap_or("-");
                for (label, w) in [("5H", &u.five_h), ("WEEKLY", &u.weekly)] {
                    let resets = w
                        .resets_at_ms
                        .map(|ms| format!("{ms}"))
                        .unwrap_or_else(|| "-".into());
                    eprintln!(
                        "CLAUDE\tlabel={} · {}\tused={}\tlimit=100\tunit=percent\tbasis=real\tresets={}\taccount={}",
                        u.plan_label, label, w.utilization, resets, acct
                    );
                }
            }
            crate::claude_usage::ClaudeOauthResult::AuthExpired => {
                eprintln!("CLAUDE\t(auth expired — run claude /login)");
            }
            crate::claude_usage::ClaudeOauthResult::Refused(r) => {
                eprintln!("CLAUDE\t(refused by Anthropic: {} — {})", r.code, r.message);
            }
            crate::claude_usage::ClaudeOauthResult::Unavailable => {
                eprintln!("CLAUDE\t(oauth unavailable — estimate path would apply)");
            }
        }

        // Codex (source unchanged)
        match crate::codex_usage::codex_usage().await {
            Some(u) => {
                if let Some(five) = u.five_h {
                    eprintln!(
                        "CODEX\tlabel=5h\tused={}\tlimit=100\tunit=percent\tbasis=real\tresets={:?}\taccount=-",
                        five.used_percent, five.resets_at_ms
                    );
                }
                if let Some(wk) = u.weekly {
                    eprintln!(
                        "CODEX\tlabel=weekly\tused={}\tlimit=100\tunit=percent\tbasis=real\tresets={:?}\taccount=-",
                        wk.used_percent, wk.resets_at_ms
                    );
                }
                if u.five_h.is_none() && u.weekly.is_none() {
                    eprintln!("CODEX\t(no window percentages)");
                }
            }
            None => eprintln!("CODEX\t(unavailable)"),
        }

        eprintln!("=== end live_usage_print ===");
    }
}
