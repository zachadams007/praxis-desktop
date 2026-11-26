//! Claude Code usage, read from Claude Code's own local session logs so the Command
//! Center's rail reflects the whole rolling window, not only the runs Praxis delegates.
//!
//! ── Method ───────────────────────────────────────────────────────────────────
//! Claude Code appends one JSON line per event to
//! `~/.claude/projects/<slug>/<session-uuid>.jsonl`. Each distinct `requestId` on a real
//! model (`claude-*`) is one message, counted when its `timestamp` falls in the window.
//!
//! ── Performance ──────────────────────────────────────────────────────────────
//! There can be tens of thousands of these files. Two guards keep the scan cheap:
//!   1. mtime prefilter: a file whose mtime predates the window cannot contain an
//!      in-window message, so it is skipped without being opened.
//!   2. model filter: only `claude-*` models count, which drops synthetic sessions.
//! The result is cached for 60s so back-to-back calls do not re-walk the tree.
//!
//! Its types and entry points are kept so every caller compiles unchanged, and
//! `claude_oauth_usage()` always answers `Unavailable`, which selects the local estimate.

use crate::iso8601::parse_iso8601_ms;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};

const FIVE_HOURS_MS: u64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Rides the 30s frontend poll; refetch at most once a minute.
const CACHE_TTL_MS: u64 = 60 * 1000;

#[derive(Clone, Copy, Default)]
pub struct ClaudeUsage {
    pub used_5h: f64,
    pub used_weekly: f64,
    /// Empirically-LEARNED cap for the 5h window (see `learn_cap`). This is NOT a
    /// hardcoded guess: it's the highest real `used_5h` ever observed, ratcheted
    /// up over time toward the true (never-published) Max ceiling, plus headroom.
    pub cap_5h: f64,
    /// Empirically-learned cap for the weekly window (same mechanism).
    pub cap_weekly: f64,
    /// `true` once the cap has been raised above its seed by a real observation -
    /// i.e. the denominator is anchored to the owner's real throughput, not just the
    /// initial seed. Lets the UI mark caps precisely as "learned" vs "seed".
    pub learned_5h: bool,
    pub learned_weekly: bool,
}

// Cache key includes the tier: a plan change must not be answered from a cache
// entry computed against the previous plan's learned caps.
static CACHE: std::sync::Mutex<Option<(u64, String, ClaudeUsage)>> = std::sync::Mutex::new(None);

pub(crate) fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ClaudeOauthWindow {
    pub utilization: f64,
    pub resets_at_ms: Option<u64>,
    pub locked_reason: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ClaudeOauthUsage {
    pub plan_label: String,
    pub account_email: Option<String>,
    pub five_h: ClaudeOauthWindow,
    pub weekly: ClaudeOauthWindow,
}

#[derive(Clone, Debug)]
pub enum ClaudeOauthResult {
    Live(ClaudeOauthUsage),
    /// HTTP 401/403 - token expired; UI must not pretend a bar is real.
    AuthExpired,
    /// The vendor refused the request. Forge cannot run; see ClaudeRefusal.
    Refused(ClaudeRefusal),
    /// Any other failure (network, missing creds, bad JSON). Caller may fall
    /// back to the learned local estimate, clearly labelled "est.".
    Unavailable,
}

// ── Empirically-learned Max caps ─────────────────────────────────────────────
//
// So the honest cap is LEARNED from the one real signal we do have: the actual observed message
// count. We persist a high-water mark that ratchets up whenever real usage exceeds the previous
// mark, then present the cap as that mark plus a headroom margin (the true wall is at or above
// the highest point the owner ever reached without being blocked). This can only converge UP toward
// the real ceiling; it never fabricates a number below what's been proven reachable.
//
// If a future Claude Code build ever persists the real unified-5h header (see the
// referenced issue), swap the seed/learn logic for that exact value - the caller
// contract (cap_5h/cap_weekly + learned flags) already matches.

/// Seed caps - the STARTING denominator before any real observation raises them.
/// Sized ABOVE the peaks measured while this was written, for a large plan
/// class, so the bar is informative from cold start, then self-corrects
/// upward via `learn_cap`. Deliberately conservative: a real observation always
/// wins over the seed.
const SEED_CAP_5H: f64 = 450.0;
const SEED_CAP_WEEKLY: f64 = 9000.0;

/// Headroom applied to the observed high-water mark to estimate the true wall.
/// If the owner reached N messages without being blocked, the real cap is ≥ N; we show
/// N × this so the bar doesn't pin at 100% the instant he revisits his own peak.
const LEARN_HEADROOM: f64 = 1.15;

/// `%LOCALAPPDATA%\Praxis\claude-limits.json` - persisted high-water marks.
/// Shape: `{"hwm_5h":<f64>,"hwm_weekly":<f64>,"tier":"pro"}`. Sibling of usage.json.
/// The `tier` stamp is what stops marks learned on one plan sizing another's bar.
fn limits_file_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| {
        std::path::PathBuf::from(p)
            .join("Praxis")
            .join("claude-limits.json")
    })
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct LimitMarks {
    #[serde(default)]
    hwm_5h: f64,
    #[serde(default)]
    hwm_weekly: f64,
    /// WHICH PLAN these marks were learned on.
    ///
    /// The mark also only ever ratchets UP (`if used > hwm`), so a downgrade could
    /// never be walked back - the same one-way-flag shape that keeps biting here.
    /// Marks are now stamped with their tier and ignored when the tier changes,
    /// which makes the cap re-learn from scratch and report "estimated" until it
    /// has real evidence about the CURRENT plan.
    #[serde(default)]
    tier: String,
}

fn read_marks(tier: &str) -> LimitMarks {
    let path = match limits_file_path() {
        Some(p) => p,
        None => return LimitMarks::default(),
    };
    let stored: LimitMarks = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(marks) => marks,
        None => return LimitMarks::default(),
    };
    if stored.tier.trim().eq_ignore_ascii_case(tier) {
        return stored;
    }
    // Either the marks predate this field (written before tiers were tracked, so
    // we cannot know which plan they describe) or the plan really did change.
    // Both mean the same thing: they are not evidence about the plan in force now.
    crate::dlog!(
        "[claude_usage] discarding learned caps from tier {:?} - current tier is {:?}; relearning",
        stored.tier, tier
    );
    LimitMarks {
        tier: tier.to_string(),
        ..LimitMarks::default()
    }
}

fn write_marks(m: &LimitMarks) {
    let _ = (|| -> Option<()> {
        let path = limits_file_path()?;
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, serde_json::to_string_pretty(m).ok()?).ok()?;
        Some(())
    })();
}

/// Ratchet the persisted high-water marks with the freshly observed real usage,
/// then compute the learned caps. Returns `(cap_5h, cap_weekly, learned_5h,
/// learned_weekly)`. A mark only ever moves UP; `learned_*` is true once real
/// usage has pushed the mark past the seed (so the cap is anchored to the owner's own
/// throughput, not just the initial guess).
fn learn_cap(used_5h: f64, used_weekly: f64, tier: &str) -> (f64, f64, bool, bool) {
    let mut marks = read_marks(tier);
    let mut dirty = marks.tier != tier;
    marks.tier = tier.to_string();
    if used_5h > marks.hwm_5h {
        marks.hwm_5h = used_5h;
        dirty = true;
    }
    if used_weekly > marks.hwm_weekly {
        marks.hwm_weekly = used_weekly;
        dirty = true;
    }
    if dirty {
        write_marks(&marks);
    }

    // Cap = max(seed, observed-mark × headroom). Once the mark×headroom clears the
    // seed, the cap is genuinely learned from real data.
    let learned_5h_cap = marks.hwm_5h * LEARN_HEADROOM;
    let learned_week_cap = marks.hwm_weekly * LEARN_HEADROOM;
    (
        learned_5h_cap.max(SEED_CAP_5H),
        learned_week_cap.max(SEED_CAP_WEEKLY),
        learned_5h_cap > SEED_CAP_5H,
        learned_week_cap > SEED_CAP_WEEKLY,
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `~/.claude/projects` - Claude Code's per-project session-log root.
fn projects_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects"),
    )
}

/// File mtime in Unix ms, or None if unreadable.
fn mtime_ms(p: &std::path::Path) -> Option<u64> {
    let md = std::fs::metadata(p).ok()?;
    let m = md.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// One assistant line. Only the fields we need - everything else is ignored so
/// this stays cheap and tolerant of Claude Code's evolving log shape.
#[derive(serde::Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<LineMessage>,
}

#[derive(serde::Deserialize)]
struct LineMessage {
    model: Option<String>,
}

/// Scan one session file, adding each distinct in-window assistant `requestId`
/// (on a real `claude-*` model) to the appropriate window set. A request can emit
/// several lines (thinking + text); dedup by requestId so it counts once.
fn scan_file(
    path: &std::path::Path,
    now: u64,
    cutoff_5h: u64,
    cutoff_week: u64,
    ids_5h: &mut HashSet<String>,
    ids_week: &mut HashSet<String>,
) {
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let reader = BufReader::new(f);
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        // Cheap prefilter: only assistant lines matter, and every one carries
        // "requestId" - skip the JSON parse for lines that obviously aren't ours.
        if !line.contains("\"requestId\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let entry: Line = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.kind.as_deref() != Some("assistant") {
            continue;
        }
        let is_claude = entry
            .message
            .as_ref()
            .and_then(|m| m.model.as_deref())
            .map(|m| m.starts_with("claude-"))
            .unwrap_or(false);
        if !is_claude {
            continue;
        }
        let (ts, rid) = match (entry.timestamp, entry.request_id) {
            (Some(ts), Some(rid)) => (ts, rid),
            _ => continue,
        };
        let ms = match parse_iso8601_ms(&ts) {
            Some(ms) => ms,
            None => continue,
        };
        if ms > now {
            continue;
        }
        if ms >= cutoff_week {
            ids_week.insert(rid.clone());
            if ms >= cutoff_5h {
                ids_5h.insert(rid);
            }
        }
    }
}

/// Walk every project dir, scanning only files whose mtime lands inside the
/// 7-day window. Synchronous + potentially touching many files, so callers should
/// run it off the critical path (we do - behind the 60s cache, from an async
/// command). Never panics; unreadable dirs/files are skipped.
fn scan_all(now: u64, cutoff_5h: u64, cutoff_week: u64, tier: &str) -> ClaudeUsage {
    let root = match projects_dir() {
        Some(r) => r,
        None => return ClaudeUsage::default(),
    };
    let mut ids_5h: HashSet<String> = HashSet::new();
    let mut ids_week: HashSet<String> = HashSet::new();

    let project_dirs = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        Err(_) => return ClaudeUsage::default(),
    };
    for pd in project_dirs.flatten() {
        let pdir = pd.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for fe in files.flatten() {
            let fpath = fe.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // mtime prefilter: a file last written before the 7-day cutoff cannot
            // hold an in-window message. This is what keeps the scan bounded even
            // with tens of thousands of historical session files present.
            match mtime_ms(&fpath) {
                Some(mt) if mt < cutoff_week => continue,
                None => continue,
                _ => {}
            }
            scan_file(
                &fpath,
                now,
                cutoff_5h,
                cutoff_week,
                &mut ids_5h,
                &mut ids_week,
            );
        }
    }

    let used_5h = ids_5h.len() as f64;
    let used_weekly = ids_week.len() as f64;
    // Learn the true cap from this real observation (ratchets the persisted mark,
    // but only against marks learned on the SAME plan tier).
    let (cap_5h, cap_weekly, learned_5h, learned_weekly) = learn_cap(used_5h, used_weekly, tier);

    ClaudeUsage {
        used_5h,
        used_weekly,
        cap_5h,
        cap_weekly,
        learned_5h,
        learned_weekly,
    }
}

/// Public entry: cached (60s), best-effort. Returns real message counts for the
/// two Max windows, or `None` if the projects dir can't be read at all (in which
/// case `usage.rs` falls back to its local-ledger estimate).
pub async fn claude_usage(tier: &str) -> Option<ClaudeUsage> {
    if let Ok(guard) = CACHE.lock() {
        if let Some((ts, cached_tier, cached)) = guard.as_ref() {
            if now_ms().saturating_sub(*ts) < CACHE_TTL_MS && cached_tier == tier {
                return Some(*cached);
            }
        }
    }

    // Do the (blocking) filesystem walk on a worker thread so the async runtime
    // isn't stalled while we stat/read potentially hundreds of files.
    let owned_tier = tier.to_string();
    let usage = tokio::task::spawn_blocking(move || {
        let now = now_ms();
        scan_all(
            now,
            now.saturating_sub(FIVE_HOURS_MS),
            now.saturating_sub(SEVEN_DAYS_MS),
            &owned_tier,
        )
    })
    .await
    .ok()?;

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((now_ms(), tier.to_string(), usage));
    }
    Some(usage)
}

// ── Live meter (withheld from the public copy) ───────────────────────────────

/// A vendor refusal that pauses Forge until it clears.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ClaudeRefusal {
    pub since_ms: u64,
    pub checked_ms: u64,
    pub code: String,
    pub message: String,
}

pub async fn claude_oauth_usage() -> ClaudeOauthResult {
    ClaudeOauthResult::Unavailable
}

pub fn last_live_reading() -> Option<(u64, ClaudeOauthUsage)> {
    None
}

pub fn rate_limited_until(_now: u64) -> Option<u64> {
    None
}

pub fn claude_refusal() -> Option<ClaudeRefusal> {
    None
}

pub fn record_claude_refusal(code: &str, message: &str) -> ClaudeRefusal {
    let now = now_ms();
    ClaudeRefusal { since_ms: now, checked_ms: now, code: code.into(), message: message.into() }
}

pub fn clear_claude_refusal() {}

pub fn refusal_probe_in_flight() -> bool {
    false
}

pub fn refusal_in_text(_text: &str) -> Option<(&'static str, &'static str)> {
    None
}
