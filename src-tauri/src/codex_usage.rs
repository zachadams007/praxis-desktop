//! Codex usage.
//!
//! Source: Codex CLI rollout JSONL (a SNAPSHOT of the last successful request) plus a
//! usage-limit refusal that is newer than that snapshot. Rollouts do not update while
//! Codex is blocked, and the CLI often does not write the refusal into the rollout, so
//! neither record is complete on its own.
//!
//! Owner: **Vega**. Never invent a 100% from a 95% snapshot alone.
//!
//! `fetch_live_usage()` answers `None`, which selects the rollout path. The payload parser and
//! its tests are kept.

use serde_json::Value;

const CACHE_TTL_MS: u64 = 60 * 1000; // rides the 30s frontend poll; refetch at most 1/min

static CACHE: std::sync::Mutex<Option<(u64, CodexUsage)>> = std::sync::Mutex::new(None);

/// Forget the cached reading so the next call re-reads from source. Used by
/// Restore (restore.rs); a no-op when nothing is cached.
pub(crate) fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// One real Codex window (5h primary or weekly secondary). `used_percent` is the
/// authoritative fill straight from OpenAI's response; `resets_at_ms` is the real
/// reset instant. There is no "limit count" because Codex reports a percentage -
/// the limit IS 100%.
#[derive(Clone, Copy)]
pub struct CodexWindow {
    /// 0..100, real - OpenAI's own `used_percent` for this window.
    pub used_percent: f64,
    /// Real reset instant (Unix ms), from Codex's `resets_at` (seconds → ms).
    pub resets_at_ms: Option<u64>,
}

/// The Codex windows that could actually be read. Either may be `None`.
///
/// ── THESE BECAME OPTIONAL BECAUSE THE NEW CLI STOPPED FILLING THEM ───────────
/// Both fields used to be required, and `read_rate_limits` dropped any snapshot
/// whose `primary` would not parse. Measured 2026-09-12 on Codex CLI **0.154.0**
/// (upgraded from 0.144.4 earlier the same day), the freshest rollout carries:
///   {"limit_id":"premium","primary":null,"secondary":null,
///    "credits":{"has_credits":false,"unlimited":false,"balance":"0"},...}
/// - a `rate_limits` record that is present and well-formed but carries no window
/// percentages at all. Under the old shape that parsed as "nothing readable", so
/// `codex_usage()` returned None and the rail fell back to a fabricated estimate.
/// Recording "the record exists, the windows are absent" lets the caller say
/// "not measured" instead of inventing a number.
/// NOT `Copy` - `plan_type` is a heap `String`, so callers that need a second copy
/// (the 60s CACHE below) call `.clone()` explicitly rather than getting one for free.
#[derive(Clone, Default)]
pub struct CodexUsage {
    /// Rolling 5-hour window (Codex `primary`, window_minutes 300).
    pub five_h: Option<CodexWindow>,
    /// Weekly window (Codex `secondary`, window_minutes 10080 = 7d).
    pub weekly: Option<CodexWindow>,
    /// Codex's OWN log says a run was refused for usage, and no successful request
    /// has happened since. `None` once the refused window has reopened.
    pub limit_hit: Option<CodexLimitHit>,
    /// Human display name for the live payload's `plan_type` (e.g. "Plus"), from
    /// `codex_plan_name`. `None` when the source can't say (rollout fallback, or a
    /// live payload with no `plan_type`) - the UI must render the provider alone
    /// ("VIA CHATGPT") rather than fall back to a guessed tier.
    pub plan_type: Option<String>,
}

/// Which window refused the run, and when it reopens.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// DERIVED FROM THE DATA, NEVER ASSUMED. The first version of this rail labelled
/// every refusal "weekly exhausted" and then hid the weekly bar so the two would
/// not contradict each other. Codex's rollout for the actual refusal (2026-09-12)
/// says otherwise: the last reading before it was **5h = 99%, resets 14:02** and
/// **weekly = 15%**, and the refusal text itself reads "try again at 2:02 PM" -
/// the 5-hour reset to the minute. Labelling that "weekly" would have painted a
/// false 100% weekly bar over a real 15% one.
///
/// So the refused window is whichever was fullest in the last real reading, and
/// the reopen instant is THAT window's own `resets_at`: an exact Unix timestamp
/// Codex wrote, with no clock-text parsing and no timezone guessing.
/// ─────────────────────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
pub struct CodexLimitHit {
    /// "5h" or "weekly".
    pub window: &'static str,
    /// When that window reopens, if Codex reported it.
    pub resets_at_ms: Option<u64>,
}

impl CodexUsage {
    /// True when the newest rollout gave us no window percentage at all, so there
    /// is nothing honest to draw.
    pub fn is_empty(&self) -> bool {
        self.five_h.is_none() && self.weekly.is_none()
    }
}

// ── The quota block the CLI itself reports ───────────────────────────────────
//
// Codex's rollout logs are a SNAPSHOT of the last successful request. When the
// account is out of quota there is no successful request, so the logs go quiet -
// and the one place the truth exists is the CLI's own refusal:
//
//   ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro),
//   visit https://chatgpt.com/codex/settings/usage to purchase more credits or try
//   again at 2:02 PM.
//
// (Reproduced verbatim 2026-09-12 via `codex exec -m gpt-6-astra`, exit code 1,
// message on STDOUT as {"type":"error","message":...} + {"type":"turn.failed",...}.)
//
// `hermes_bridge::explain_codex_failure` parses that and calls
// `record_codex_quota_exhausted` here, so the Command Center can report the real
// state - out of usage, returning at 2:02 PM - without re-running a refused
// command. A successful run calls `clear_codex_quota_block`, so this is evidence
// with an expiry, not a latch.

/// `%LOCALAPPDATA%\Praxis\codex-quota.json` - sibling of usage.json.
fn quota_state_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("codex-quota.json"))
}

/// What the CLI last told us about the account's quota.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct CodexQuotaState {
    #[serde(default)]
    pub schema_version: u32,
    /// True when the CLI refused a run for usage limits.
    #[serde(default)]
    pub exhausted: bool,
    /// When the window reopens, as Unix ms - derived from `reset_text` at the
    /// moment of detection (a relative offset from "now", so no timezone math).
    #[serde(default)]
    pub resets_at_ms: Option<u64>,
    /// The reset as the CLI actually wrote it ("2:02 PM"). Shown verbatim so the
    /// UI never has to reformat - and never has to guess - a wall-clock time.
    #[serde(default)]
    pub reset_text: Option<String>,
    /// When Praxis observed the refusal.
    #[serde(default)]
    pub detected_ms: u64,
}

/// Read the persisted quota block. Returns `None` when there is no block, when the
/// file is unreadable, or when the recorded reset instant has already passed -
/// an elapsed block is spent evidence, exactly like an elapsed rollout window.
pub fn codex_quota_state() -> Option<CodexQuotaState> {
    codex_quota_state_from(&quota_state_path()?)
}

/// Path-parameterized core, so tests never touch the real state directory.
pub(crate) fn codex_quota_state_from(path: &std::path::Path) -> Option<CodexQuotaState> {
    let raw = std::fs::read_to_string(path).ok()?;
    let state: CodexQuotaState = serde_json::from_str(&raw).ok()?;
    if !state.exhausted {
        return None;
    }
    // An elapsed block is spent evidence: the window it described has reopened
    // whether or not anything was running to write that down - the same rule
    // `parse_window` applies to an elapsed rollout window.
    if state.resets_at_ms.is_some_and(|reset| now_ms() >= reset) {
        return None;
    }
    // No parseable reset means no expiry at all - a latch. No Codex window is
    // longer than a week, so a block older than that is spent whatever it says.
    const LONGEST_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
    if state.resets_at_ms.is_none() && now_ms().saturating_sub(state.detected_ms) >= LONGEST_WINDOW_MS {
        return None;
    }
    Some(state)
}

pub(crate) fn write_quota_state_to(path: &std::path::Path, state: &CodexQuotaState) {
    let _ = (|| -> Option<()> {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(path, serde_json::to_string_pretty(state).ok()?).ok()?;
        Some(())
    })();
}

/// The block a refusal should persist. Pure, so it can be asserted on directly.
pub(crate) fn exhausted_quota_state(reset_text: Option<&str>) -> CodexQuotaState {
    CodexQuotaState {
        schema_version: 1,
        exhausted: true,
        resets_at_ms: reset_text.and_then(next_local_clock_time_ms),
        reset_text: reset_text.map(str::to_string),
        detected_ms: now_ms(),
    }
}

/// Persist "the CLI says we are out of usage, and it reopens at `reset_text`".
/// `reset_text` is stored verbatim; `resets_at_ms` is computed as an offset from
/// now so no timezone conversion is involved.
pub fn record_codex_quota_exhausted(reset_text: Option<&str>) {
    if let Some(path) = quota_state_path() {
        write_quota_state_to(&path, &exhausted_quota_state(reset_text));
    }
}

/// A run completed, so the account is demonstrably not blocked. Retire the block
/// immediately rather than waiting for its reset instant - evidence with an
/// expiry, not a latch.
pub fn clear_codex_quota_block() {
    let Some(path) = quota_state_path() else {
        return;
    };
    if !path.exists() {
        return;
    }
    write_quota_state_to(
        &path,
        &CodexQuotaState {
            schema_version: 1,
            exhausted: false,
            resets_at_ms: None,
            reset_text: None,
            detected_ms: now_ms(),
        },
    );
}

/// Local wall-clock hour/minute right now. `GetLocalTime` is DST-correct and this
/// crate deliberately carries no `chrono` (same approach as board_meeting.rs).
#[cfg(windows)]
pub(crate) fn local_hour_minute() -> (u32, u32) {
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
    (st.w_hour as u32, st.w_minute as u32)
}

#[cfg(not(windows))]
pub(crate) fn local_hour_minute() -> (u32, u32) {
    let secs = now_ms() / 1000;
    (((secs % 86_400) / 3_600) as u32, ((secs % 3_600) / 60) as u32)
}

/// Parse a wall-clock time as Codex writes it ("2:02 PM", "9:15am", "14:02") and
/// return the next instant it occurs, in Unix ms.
///
/// Computed as a RELATIVE OFFSET from the current local time-of-day, so the result
/// is correct without converting between zones: if the target time-of-day is
/// already behind us today, it must be tomorrow's.
pub(crate) fn next_local_clock_time_ms(text: &str) -> Option<u64> {
    let (target_hour, target_minute) = parse_clock_time(text)?;
    let (now_hour, now_minute) = local_hour_minute();
    let target = target_hour as i64 * 60 + target_minute as i64;
    let current = now_hour as i64 * 60 + now_minute as i64;
    let mut delta = target - current;
    if delta <= 0 {
        delta += 24 * 60; // already past today - it means tomorrow
    }
    Some(now_ms().saturating_add(delta as u64 * 60_000))
}

/// "2:02 PM" → (14, 2). Accepts an optional am/pm suffix with or without a space
/// and with or without periods; a bare "14:02" is read as 24-hour.
fn parse_clock_time(text: &str) -> Option<(u32, u32)> {
    let cleaned = text.trim().trim_end_matches('.').to_ascii_lowercase();
    let cleaned = cleaned.replace("a.m", "am").replace("p.m", "pm");
    let is_pm = cleaned.contains("pm");
    let is_am = cleaned.contains("am");
    let digits: String = cleaned
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    let (hour_text, minute_text) = digits.split_once(':')?;
    let mut hour: u32 = hour_text.parse().ok()?;
    let minute: u32 = minute_text.parse().ok()?;
    if minute > 59 {
        return None;
    }
    if is_pm || is_am {
        if hour == 0 || hour > 12 {
            return None;
        }
        if is_pm && hour != 12 {
            hour += 12;
        }
        if is_am && hour == 12 {
            hour = 0;
        }
    } else if hour > 23 {
        return None;
    }
    Some((hour, minute))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn json_u64(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| {
            v.as_f64().and_then(|n| {
                if n >= 0.0 && n.fract() == 0.0 {
                    Some(n as u64)
                } else {
                    None
                }
            })
        })
}

fn json_f64(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// 12-hour clock ("2:59 PM") for the rail's LIMIT REACHED caption.
pub(crate) fn fmt_12h(hour24: u32, minute: u32) -> String {
    let ap = if hour24 >= 12 { "PM" } else { "AM" };
    let mut h = hour24 % 12;
    if h == 0 {
        h = 12;
    }
    format!("{h}:{minute:02} {ap}")
}

/// Local wall-clock for a Unix-ms instant. Windows uses FILETIME so DST is correct.
pub(crate) fn fmt_local_clock_ms(at_ms: u64) -> String {
    let (h, m) = unix_ms_to_local_hm(at_ms).unwrap_or_else(|| {
        let (now_h, now_m) = local_hour_minute();
        let now = now_ms();
        let delta_min = if at_ms > now {
            (at_ms - now) / 60_000
        } else {
            0
        };
        let total = now_h as u64 * 60 + now_m as u64 + delta_min;
        let minutes_in_day = total % (24 * 60);
        ((minutes_in_day / 60) as u32, (minutes_in_day % 60) as u32)
    });
    fmt_12h(h, m)
}

#[cfg(windows)]
fn unix_ms_to_local_hm(ms: u64) -> Option<(u32, u32)> {
    #[repr(C)]
    struct FILETIME {
        dw_low_date_time: u32,
        dw_high_date_time: u32,
    }
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
        fn FileTimeToLocalFileTime(
            lp_file_time: *const FILETIME,
            lp_local_file_time: *mut FILETIME,
        ) -> i32;
        fn FileTimeToSystemTime(lp_file_time: *const FILETIME, lp_system_time: *mut SYSTEMTIME) -> i32;
    }
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000; // 100-ns from 1601-01-01 to Unix epoch
    let ft100 = EPOCH_DIFF.saturating_add(ms.saturating_mul(10_000));
    let utc = FILETIME {
        dw_low_date_time: ft100 as u32,
        dw_high_date_time: (ft100 >> 32) as u32,
    };
    let mut local = FILETIME {
        dw_low_date_time: 0,
        dw_high_date_time: 0,
    };
    if unsafe { FileTimeToLocalFileTime(&utc, &mut local) } == 0 {
        return None;
    }
    let mut st = SYSTEMTIME {
        w_year: 0,
        w_month: 0,
        w_day_of_week: 0,
        w_day: 0,
        w_hour: 0,
        w_minute: 0,
        w_second: 0,
        w_milliseconds: 0,
    };
    if unsafe { FileTimeToSystemTime(&local, &mut st) } == 0 {
        return None;
    }
    Some((st.w_hour as u32, st.w_minute as u32))
}

#[cfg(not(windows))]
fn unix_ms_to_local_hm(ms: u64) -> Option<(u32, u32)> {
    let secs = ms / 1000;
    Some((
        ((secs % 86_400) / 3_600) as u32,
        ((secs % 3_600) / 60) as u32,
    ))
}

fn live_window_object(v: Option<&Value>) -> Option<Value> {
    let v = v.filter(|x| x.is_object())?;
    let used = json_f64(v.get("used_percent")?)?;
    let mut obj = serde_json::Map::new();
    obj.insert("used_percent".into(), serde_json::json!(used));
    if let Some(reset) = v.get("reset_at").and_then(json_u64) {
        obj.insert("resets_at".into(), serde_json::json!(reset));
    }
    Some(Value::Object(obj))
}

fn live_raw_window(v: Option<&Value>) -> Option<(f64, Option<u64>)> {
    let v = v.filter(|x| x.is_object())?;
    let used = json_f64(v.get("used_percent")?)?;
    let reset = v
        .get("reset_at")
        .and_then(json_u64)
        .map(|secs| secs.saturating_mul(1000));
    Some((used, reset))
}

fn rate_limit_reached_type_is_hit(body: &Value) -> bool {
    let t = match body.get("rate_limit_reached_type") {
        Some(v) if v.is_object() => v,
        _ => return false,
    };
    let kind = t
        .get("type")
        .or_else(|| t.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    kind == "rate_limit_reached" || kind.ends_with("usage_limit_reached")
}

/// Human display name for the live payload's top-level `plan_type` (e.g. "plus" → "Plus").
/// Missing, empty, or non-string `plan_type` yields `None`: the UI must show the provider alone
/// ("VIA CHATGPT") rather than fall back to a guessed tier.
pub(crate) fn codex_plan_name(body: &Value) -> Option<String> {
    let raw = body.get("plan_type")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut chars = raw.chars();
    let first = chars.next()?.to_uppercase().to_string();
    Some(format!("{first}{}", chars.as_str()))
}

/// Pure parse of Codex's live `GET /wham/usage` JSON. Fixtures in tests.
pub(crate) fn parse_live_usage_payload(body: &Value, now: u64) -> Option<CodexUsage> {
    let rl = body.get("rate_limit").filter(|v| v.is_object())?;
    let plan_type = codex_plan_name(body);
    let primary = live_window_object(rl.get("primary_window"));
    let secondary = live_window_object(rl.get("secondary_window"));
    let five_h = primary.as_ref().and_then(parse_window);
    let weekly = secondary.as_ref().and_then(parse_window);
    let raw5 = live_raw_window(rl.get("primary_window"));
    let raw_w = live_raw_window(rl.get("secondary_window"));
    if five_h.is_none() && weekly.is_none() && raw5.is_none() && raw_w.is_none() {
        // A well-formed record with null windows is still an observation.
        return Some(CodexUsage {
            plan_type,
            ..CodexUsage::default()
        });
    }
    let limit_reached = rl.get("limit_reached").and_then(Value::as_bool).unwrap_or(false)
        || rate_limit_reached_type_is_hit(body);
    let limit_hit = if limit_reached {
        limit_hit_from(Some((raw5, raw_w)), now)
    } else {
        None
    };
    Some(CodexUsage {
        five_h,
        weekly,
        limit_hit,
        plan_type,
    })
}

/// A usage-limit refusal recorded outside a rollout (Praxis's own quota file, written
/// when a `codex exec` it ran was refused). `detected_ms` is when that happened.
#[derive(Clone, Copy)]
pub(crate) struct RefusalEvidence {
    pub detected_ms: u64,
    pub resets_at_ms: Option<u64>,
}

/// Overlay a refusal that is NEWER than the snapshot. A 95% snapshot alone stays
/// 95%. Never invent LIMIT REACHED without a newer refusal whose reset is future.
pub(crate) fn apply_newer_refusal(
    usage: Option<CodexUsage>,
    snapshot_ms: u64,
    refusal: Option<RefusalEvidence>,
    now: u64,
) -> Option<CodexUsage> {
    let mut usage = usage?;
    let Some(refusal) = refusal else {
        return Some(usage);
    };
    if refusal.detected_ms <= snapshot_ms {
        return Some(usage);
    }
    if refusal.resets_at_ms.is_some_and(|reset| now >= reset) {
        return Some(usage);
    }
    let last_raw = Some((
        usage.five_h.map(|w| (w.used_percent, w.resets_at_ms.or(refusal.resets_at_ms))),
        usage.weekly.map(|w| (w.used_percent, w.resets_at_ms)),
    ));
    if let Some(hit) = limit_hit_from(last_raw, now) {
        usage.limit_hit = Some(CodexLimitHit {
            window: hit.window,
            resets_at_ms: hit.resets_at_ms.or(refusal.resets_at_ms),
        });
    }
    Some(usage)
}

/// The newest usage-limit refusal Praxis itself recorded (its own quota file, stamped
/// the moment a `codex exec` it ran was refused). Rollouts are handled separately.
///
/// Deliberately NOT a scan of `~/.codex/log` for "hit your usage limit": a log file's
/// mtime moves with every later line, and "try again at 2:59 PM" resolves to the NEXT
/// 2:59 PM, so a refusal from last week in a log touched this morning would read as a
/// fresh, still-future LIMIT REACHED - every day, forever. Evidence has to carry the
/// time it happened.
fn newest_refusal_outside_rollout() -> Option<RefusalEvidence> {
    codex_quota_state().map(|state| RefusalEvidence {
        detected_ms: state.detected_ms,
        resets_at_ms: state.resets_at_ms,
    })
}

async fn fetch_live_usage() -> Option<CodexUsage> {
    None
}

/// `~/.codex` - Codex CLI's config/session root.
fn codex_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(home).join(".codex"))
}

/// File mtime in Unix ms, or None if unreadable.
fn mtime_ms(p: &std::path::Path) -> Option<u64> {
    let md = std::fs::metadata(p).ok()?;
    let m = md.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Find the most-recently-modified `rollout-*.jsonl` across Codex's live
/// `sessions/YYYY/MM/DD/` tree and the flat `archived_sessions/` dir. Returns the
/// freshest rollout - that's where the current account window state was last
/// written. Bounded: we only recurse the `sessions` date tree (a handful of
/// day-dirs) plus one flat archive dir; no unbounded whole-home walk.
#[allow(dead_code)]
fn newest_rollout() -> Option<std::path::PathBuf> {
    recent_rollouts(1).into_iter().next()
}

/// The most recent rollouts, newest first.
///
/// One file is not enough evidence. When Codex refuses a run for usage it writes a
/// short rollout containing ONLY the refusal and a null-window record - the last
/// real percentages live in an OLDER file. Measured 2026-09-12: the refusal was in
/// the 10:43 rollout, the last reading (5h 99%, weekly 15%) in the 09:21 one.
/// Reading only the newest file therefore saw "no windows, no reading" and could
/// never say which window was full.
fn recent_rollouts(limit: usize) -> Vec<std::path::PathBuf> {
    let Some(root) = codex_dir() else {
        return Vec::new();
    };
    let mut all: Vec<(u64, std::path::PathBuf)> = Vec::new();

    let mut consider = |p: std::path::PathBuf| {
        let is_rollout = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            .unwrap_or(false);
        if !is_rollout {
            return;
        }
        if let Some(mt) = mtime_ms(&p) {
            all.push((mt, p));
        }
    };

    // Live sessions: sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl - recurse 3 levels.
    let sessions = root.join("sessions");
    if let Ok(years) = std::fs::read_dir(&sessions) {
        for y in years.flatten() {
            if !y.path().is_dir() {
                continue;
            }
            if let Ok(months) = std::fs::read_dir(y.path()) {
                for m in months.flatten() {
                    if !m.path().is_dir() {
                        continue;
                    }
                    if let Ok(days) = std::fs::read_dir(m.path()) {
                        for d in days.flatten() {
                            if !d.path().is_dir() {
                                continue;
                            }
                            if let Ok(files) = std::fs::read_dir(d.path()) {
                                for f in files.flatten() {
                                    consider(f.path());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Archived (flat) sessions - only matters when there's no live session today.
    if let Ok(files) = std::fs::read_dir(root.join("archived_sessions")) {
        for f in files.flatten() {
            consider(f.path());
        }
    }

    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// Parse one window object (`{"used_percent":7.0,"window_minutes":300,"resets_at":..}`).
fn parse_window(v: &Value) -> Option<CodexWindow> {
    let used_percent = v.get("used_percent").and_then(|x| x.as_f64())?;
    let resets_at_ms = v
        .get("resets_at")
        .and_then(|x| x.as_u64())
        .map(|secs| secs.saturating_mul(1000));

    // ─────────────────────────────────────────────────────────────────────────
    // A RATE LIMIT IS A SNAPSHOT, AND SNAPSHOTS EXPIRE.
    //
    // These numbers are whatever Codex last wrote into a rollout file. If the
    // newest rollout is from last night, the percentage in it is from last night
    // - but the window it describes has since rolled over and started empty.
    //
    // Past that, the only honest reading is zero, because the quota really did reset whether or
    // not anything wrote it down.
    //
    // Deliberately NOT clamped to "unknown": the reset is a fact of the billing
    // window, not a guess. What would be a guess is carrying the old number
    // forward, which is what this did.
    // ─────────────────────────────────────────────────────────────────────────
    let expired = resets_at_ms.is_some_and(|reset| now_ms() >= reset);
    if expired {
        return Some(CodexWindow {
            used_percent: 0.0,
            // The next reset is unknown until Codex runs again and writes one.
            // Reporting the elapsed one would put a past timestamp on a live bar.
            resets_at_ms: None,
        });
    }

    Some(CodexWindow {
        used_percent,
        resets_at_ms,
    })
}

/// Scan the given rollout file for the LAST `rate_limits` object and parse its
/// `primary` (5h) + `secondary` (weekly) windows. Reads line-by-line so a large
/// rollout doesn't have to be held in memory all at once; keeps the last match.
/// What one rollout file proves on its own.
struct FileEvidence {
    /// Windows from this file's latest REAL reading, if it had one.
    usage: Option<CodexUsage>,
    /// That reading's raw (pre-expiry) values, for attributing a refusal.
    last_raw: Option<(Option<(f64, Option<u64>)>, Option<(f64, Option<u64>)>)>,
    /// A usage refusal appears after this file's last real reading (or anywhere,
    /// if it has none).
    refused_after_reading: bool,
}

fn read_file_evidence(path: &std::path::Path) -> Option<FileEvidence> {
    let usage = read_rate_limits(path);
    // `read_rate_limits` folds the in-file refusal into `limit_hit`, but a file
    // holding ONLY a refusal has no reading to attribute it to - so re-derive the
    // two facts the cross-file walk needs.
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(path).ok()?;
    let mut last_raw = None;
    let mut refused = false;
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if line.contains("hit your usage limit") {
            refused = true;
            continue;
        }
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(rl) = entry.pointer("/payload/rate_limits").or_else(|| entry.get("rate_limits")) else { continue };
        let raw = |v: Option<&Value>| -> Option<(f64, Option<u64>)> {
            let v = v?;
            let used = v.get("used_percent").and_then(Value::as_f64)?;
            Some((used, v.get("resets_at").and_then(Value::as_u64).map(|x| x.saturating_mul(1000))))
        };
        let (a, b) = (raw(rl.get("primary")), raw(rl.get("secondary")));
        if a.is_some() || b.is_some() {
            last_raw = Some((a, b));
            refused = false;
        }
    }
    Some(FileEvidence {
        usage: usage.filter(|u| !u.is_empty()),
        last_raw,
        refused_after_reading: refused,
    })
}

/// Walk rollouts newest -> oldest and combine them: the windows come from the
/// newest file that has a real reading, and a refusal counts if it appears in ANY
/// newer file or after that reading in the same file.
fn usage_across_rollouts(paths: &[std::path::PathBuf], now: u64) -> Option<CodexUsage> {
    let mut refused_since = false;
    let mut saw_any_record = false;
    for path in paths {
        let Some(ev) = read_file_evidence(path) else { continue };
        if let Some(mut usage) = ev.usage {
            let refused = refused_since || ev.refused_after_reading;
            usage.limit_hit = if refused { limit_hit_from(ev.last_raw, now) } else { None };
            return Some(usage);
        }
        saw_any_record = true;
        if ev.refused_after_reading {
            refused_since = true;
        }
    }
    // Rollouts exist but none carried a real reading: honest "not measured".
    saw_any_record.then(CodexUsage::default)
}

fn read_rate_limits(path: &std::path::Path) -> Option<CodexUsage> {
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(f);

    let mut latest: Option<CodexUsage> = None;
    // The last record that actually carried percentages, with RAW reset instants
    // (pre-expiry), so a refusal can be attributed to the window that was full.
    let mut last_raw: Option<(Option<(f64, Option<u64>)>, Option<(f64, Option<u64>)>)> = None;
    // True from a usage refusal until the next successful (numeric) reading.
    let mut refused = false;
    for line in reader.lines().map_while(Result::ok) {
        // A refusal is a terminal event, not a token_count, so check it first.
        // Codex writes the same sentence wherever it surfaces the error.
        if line.contains("hit your usage limit") {
            refused = true;
            continue;
        }
        // Cheap prefilter - only `token_count` events carry rate_limits.
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let entry: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // rate_limits lives at payload.rate_limits (event_msg / token_count shape).
        let rl = entry
            .pointer("/payload/rate_limits")
            .or_else(|| entry.get("rate_limits"));
        let rl = match rl {
            Some(v) if v.is_object() => v,
            _ => continue,
        };
        let five_h = rl.get("primary").and_then(parse_window);
        let weekly = rl.get("secondary").and_then(parse_window);
        let raw = |v: Option<&Value>| -> Option<(f64, Option<u64>)> {
            let v = v?;
            let used = v.get("used_percent").and_then(Value::as_f64)?;
            let reset = v.get("resets_at").and_then(Value::as_u64).map(|x| x.saturating_mul(1000));
            Some((used, reset))
        };
        let (raw5, raw_w) = (raw(rl.get("primary")), raw(rl.get("secondary")));
        if raw5.is_some() || raw_w.is_some() {
            // A request that returned real percentages SUCCEEDED, so any earlier
            // refusal in this file is over. Evidence, not a latch.
            last_raw = Some((raw5, raw_w));
            refused = false;
        }
        // Keep whichever windows parsed, independently.
        //
        // This used to require `primary` and silently substitute a FABRICATED
        // `weekly: 0%` when `secondary` was absent - so a response carrying no
        // weekly figure rendered a confident empty weekly bar. A window that was
        // not reported is now `None`, and the caller draws no bar for it.
        // Null-window records (the refusal shape) must not erase the last real
        // reading, or a blocked account would draw no bars at all.
        if five_h.is_some() || weekly.is_some() || latest.is_none() {
            // Rollout files don't carry a reliable top-level plan_type the way the
            // live /wham/usage payload does - this fallback path stays honest about
            // not knowing, rather than guessing a tier from stale file contents.
            latest = Some(CodexUsage { five_h, weekly, limit_hit: None, plan_type: None });
        }
    }
    if let (Some(usage), true) = (latest.as_mut(), refused) {
        usage.limit_hit = limit_hit_from(last_raw, now_ms());
    }
    // A record whose windows were all null is still a real observation ("Codex
    // reported no window figures"), so it is returned rather than discarded -
    // `CodexUsage::is_empty()` lets the caller tell it apart from real numbers.
    latest
}

/// Attribute a refusal to the fullest window in the last real reading.
/// Pure, so the whole decision is unit-testable without a rollout on disk.
pub(crate) fn limit_hit_from(
    last_raw: Option<(Option<(f64, Option<u64>)>, Option<(f64, Option<u64>)>)>,
    now: u64,
) -> Option<CodexLimitHit> {
    let (five, weekly) = last_raw?;
    // Fullest window wins; on a tie the weekly one, which is the longer outage.
    let pick = match (five, weekly) {
        (Some(f), Some(w)) => {
            if f.0 > w.0 {
                ("5h", f)
            } else {
                ("weekly", w)
            }
        }
        (Some(f), None) => ("5h", f),
        (None, Some(w)) => ("weekly", w),
        (None, None) => return None,
    };
    let (window, (_used, resets_at_ms)) = pick;
    // The window has reopened: the refusal is spent evidence.
    if resets_at_ms.is_some_and(|reset| now >= reset) {
        return None;
    }
    Some(CodexLimitHit { window, resets_at_ms })
}

/// Public entry: cached (60s), best-effort. Prefers the live `/wham/usage`
/// endpoint (what Codex `/status` uses). Falls back to rollouts + a newer
/// refusal. `refresh_live_state` / Restore call `clear_cache()` so RELOAD
/// re-reads this source instead of replaying the 60s cache.
pub async fn codex_usage() -> Option<CodexUsage> {
    if let Ok(guard) = CACHE.lock() {
        if let Some((ts, cached)) = guard.as_ref() {
            if now_ms().saturating_sub(*ts) < CACHE_TTL_MS {
                return Some(cached.clone());
            }
        }
    }

    let usage = if let Some(live) = fetch_live_usage().await {
        live
    } else {
        // Filesystem walk + line scan is blocking - run it off the async runtime.
        tokio::task::spawn_blocking(|| {
            let paths = recent_rollouts(8);
            let snapshot_ms = paths.first().and_then(|p| mtime_ms(p)).unwrap_or(0);
            let usage = usage_across_rollouts(&paths, now_ms());
            apply_newer_refusal(usage, snapshot_ms, newest_refusal_outside_rollout(), now_ms())
        })
        .await
        .ok()?
        ?
    };

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((now_ms(), usage.clone()));
    }
    Some(usage)
}

#[cfg(test)]
mod reset_tests {
    use super::*;

    fn window(used: f64, resets_at_secs: u64) -> Value {
        serde_json::json!({ "used_percent": used, "resets_at": resets_at_secs })
    }

    #[test]
    fn an_open_window_reports_what_the_file_says() {
        let future = now_ms() / 1000 + 3600;
        let w = parse_window(&window(15.0, future)).expect("parses");
        assert_eq!(w.used_percent, 15.0);
        assert!(w.resets_at_ms.is_some());
    }

    #[test]
    fn an_elapsed_window_reads_zero_not_the_stale_number() {
        // The owner's exact complaint: a 5-hour bar still reading full twelve hours
        // after the work finished. The window emptied at `resets_at` whether or
        // not anything was running to write that down.
        let twelve_hours_ago = now_ms() / 1000 - 12 * 3600;
        let w = parse_window(&window(100.0, twelve_hours_ago)).expect("parses");
        assert_eq!(w.used_percent, 0.0, "an elapsed window must not carry its old fill forward");
    }

    #[test]
    fn an_elapsed_window_reports_no_reset_rather_than_a_past_one() {
        let past = now_ms() / 1000 - 60;
        let w = parse_window(&window(88.0, past)).expect("parses");
        assert!(
            w.resets_at_ms.is_none(),
            "a past reset instant on a live bar would render as an already-happened countdown"
        );
    }

    #[test]
    fn a_window_with_no_reset_is_left_alone() {
        // Nothing to expire against, so the file's number is the best available.
        let v = serde_json::json!({ "used_percent": 42.0 });
        let w = parse_window(&v).expect("parses");
        assert_eq!(w.used_percent, 42.0);
        assert!(w.resets_at_ms.is_none());
    }
}

#[cfg(test)]
mod quota_tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "praxis-codex-quota-{}-{name}-{}",
            std::process::id(),
            now_ms()
        ));
        dir.join("codex-quota.json")
    }

    // ── The 0.154.0 rollout shape ────────────────────────────────────────────

    /// The record shape Codex CLI 0.154.0 writes to a rollout once the weekly
    /// window is used up (2026-09-12).
    const NULL_WINDOW_RECORD: &str = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}"#;

    #[test]
    fn a_record_with_null_windows_is_read_as_not_measured() {
        let dir = std::env::temp_dir().join(format!("praxis-codex-null-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("rollout-test.jsonl");
        std::fs::write(&path, format!("{NULL_WINDOW_RECORD}\n")).expect("write rollout");

        let usage = read_rate_limits(&path).expect("the record itself is a real observation");
        assert!(
            usage.is_empty(),
            "null primary/secondary must read as 'no window measured', never as 0%"
        );
        assert!(usage.five_h.is_none());
        assert!(usage.weekly.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_secondary_no_longer_invents_a_zero_weekly_bar() {
        let dir = std::env::temp_dir().join(format!("praxis-codex-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("rollout-test.jsonl");
        let future = now_ms() / 1000 + 3600;
        let line = serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "token_count", "rate_limits": {
                "primary": { "used_percent": 34.0, "window_minutes": 300, "resets_at": future }
            }}
        });
        std::fs::write(&path, format!("{line}\n")).expect("write rollout");

        let usage = read_rate_limits(&path).expect("primary parsed");
        assert_eq!(usage.five_h.expect("5h window").used_percent, 34.0);
        assert!(
            usage.weekly.is_none(),
            "an unreported weekly window must be absent, not a confident 0%"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── The reset time out of the CLI's own refusal ───────────────────────────

    #[test]
    fn clock_times_parse_in_the_shapes_codex_writes() {
        assert_eq!(parse_clock_time("2:02 PM"), Some((14, 2)));
        assert_eq!(parse_clock_time("2:02PM"), Some((14, 2)));
        assert_eq!(parse_clock_time("9:15am"), Some((9, 15)));
        assert_eq!(parse_clock_time("12:30 AM"), Some((0, 30)));
        assert_eq!(parse_clock_time("12:30 PM"), Some((12, 30)));
        assert_eq!(parse_clock_time("14:02"), Some((14, 2)));
    }

    #[test]
    fn nonsense_clock_times_are_refused_rather_than_guessed() {
        assert_eq!(parse_clock_time("soon"), None);
        assert_eq!(parse_clock_time("25:00"), None);
        assert_eq!(parse_clock_time("2:99 PM"), None);
        assert_eq!(parse_clock_time("13:00 PM"), None);
    }

    #[test]
    fn a_reset_time_resolves_to_a_future_instant() {
        let at = next_local_clock_time_ms("2:02 PM").expect("resolves");
        assert!(at > now_ms(), "a reset must be in the future, never behind us");
        // Never more than 24h out: it is the NEXT occurrence of that wall clock.
        assert!(at - now_ms() <= 24 * 60 * 60 * 1000 + 60_000);
    }

    // ── The persisted quota block ─────────────────────────────────────────────

    #[test]
    fn an_exhausted_block_round_trips_with_its_reset_text_verbatim() {
        let path = temp_path("roundtrip");
        write_quota_state_to(&path, &exhausted_quota_state(Some("2:02 PM")));
        let state = codex_quota_state_from(&path).expect("block is live");
        assert!(state.exhausted);
        assert_eq!(
            state.reset_text.as_deref(),
            Some("2:02 PM"),
            "the reset is shown exactly as the CLI wrote it — no reformatting, no guessing"
        );
        assert!(state.resets_at_ms.expect("derived instant") > now_ms());
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn an_elapsed_block_stops_being_reported() {
        // THIS IS THE ANTI-LATCH PROPERTY. A quota block that outlived its window
        // would pin the Codex rail at 100% forever - the exact failure mode this
        // codebase keeps hitting. An elapsed block reads as nothing.
        let path = temp_path("elapsed");
        write_quota_state_to(
            &path,
            &CodexQuotaState {
                schema_version: 1,
                exhausted: true,
                resets_at_ms: Some(now_ms().saturating_sub(60_000)),
                reset_text: Some("2:02 PM".to_string()),
                detected_ms: now_ms().saturating_sub(3_600_000),
            },
        );
        assert!(
            codex_quota_state_from(&path).is_none(),
            "a block whose reset has passed must not keep the rail pinned"
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn a_cleared_block_reports_nothing() {
        let path = temp_path("cleared");
        write_quota_state_to(&path, &exhausted_quota_state(Some("2:02 PM")));
        assert!(codex_quota_state_from(&path).is_some());
        write_quota_state_to(
            &path,
            &CodexQuotaState {
                schema_version: 1,
                exhausted: false,
                resets_at_ms: None,
                reset_text: None,
                detected_ms: now_ms(),
            },
        );
        assert!(
            codex_quota_state_from(&path).is_none(),
            "a successful run must retire the block immediately"
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn a_missing_block_file_is_not_a_block() {
        let path = temp_path("absent");
        assert!(codex_quota_state_from(&path).is_none());
    }
}

#[cfg(test)]
mod limit_attribution_tests {
    use super::*;

    const H: u64 = 3_600_000;

    #[test]
    fn the_real_2026_09_12_refusal_is_the_five_hour_window() {
        // Refusal said "2:02 PM".
        let now = 1_000 * H;
        let five = (99.0, Some(now + 3 * H));
        let weekly = (15.0, Some(now + 150 * H));
        let hit = limit_hit_from(Some((Some(five), Some(weekly))), now).expect("refused");
        assert_eq!(hit.window, "5h", "labelling this weekly would paint a false 100% over a real 15%");
        assert_eq!(hit.resets_at_ms, Some(now + 3 * H));
    }

    #[test]
    fn a_full_weekly_window_is_attributed_to_weekly() {
        let now = 1_000 * H;
        let hit = limit_hit_from(Some((Some((40.0, Some(now + H))), Some((100.0, Some(now + 90 * H))))), now)
            .expect("refused");
        assert_eq!(hit.window, "weekly");
    }

    #[test]
    fn a_refusal_whose_window_has_reopened_is_spent() {
        let now = 1_000 * H;
        assert!(limit_hit_from(Some((Some((99.0, Some(now - 60_000))), Some((15.0, Some(now + 100 * H))))), now).is_none());
    }

    #[test]
    fn a_refusal_with_no_prior_reading_is_not_attributed_to_a_guessed_window() {
        assert!(limit_hit_from(None, 1).is_none());
        assert!(limit_hit_from(Some((None, None)), 1).is_none());
    }
}

#[cfg(test)]
mod live_usage_tests {
    use super::*;
    use serde_json::json;

    /// Shape measured live 2026-09-15 against GET /backend-api/wham/usage
    /// (ChatGPT auth). Integers, `reset_at` (not `resets_at`), `limit_reached`.
    fn live_fixture(primary_pct: i64, primary_reset: u64, weekly_pct: i64, weekly_reset: u64, limit_reached: bool) -> Value {
        json!({
            "plan_type": "plus",
            "rate_limit": {
                "allowed": !limit_reached,
                "limit_reached": limit_reached,
                "primary_window": {
                    "used_percent": primary_pct,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 9306,
                    "reset_at": primary_reset
                },
                "secondary_window": {
                    "used_percent": weekly_pct,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 333500,
                    "reset_at": weekly_reset
                }
            },
            "rate_limit_reached_type": if limit_reached {
                json!({ "type": "rate_limit_reached", "details": "default" })
            } else {
                Value::Null
            },
            "credits": { "has_credits": false, "unlimited": false, "balance": "0" }
        })
    }

    #[test]
    fn plan_type_plus_becomes_the_plus_plan_name() {
        let body = live_fixture(10, now_ms() / 1000 + 3600, 5, now_ms() / 1000 + 86_400, false);
        assert_eq!(codex_plan_name(&body).as_deref(), Some("Plus"));
    }

    #[test]
    fn a_missing_plan_type_yields_no_guessed_plan() {
        let mut body = live_fixture(10, now_ms() / 1000 + 3600, 5, now_ms() / 1000 + 86_400, false);
        body.as_object_mut().expect("object").remove("plan_type");
        assert!(
            codex_plan_name(&body).is_none(),
            "a missing plan_type must never fall back to a guessed tier"
        );
    }

    #[test]
    fn parse_live_usage_payload_surfaces_the_plan_name_on_codexusage() {
        let body = live_fixture(10, now_ms() / 1000 + 3600, 5, now_ms() / 1000 + 86_400, false);
        let u = parse_live_usage_payload(&body, now_ms()).expect("parses");
        assert_eq!(u.plan_type.as_deref(), Some("Plus"));
    }

    #[test]
    fn live_endpoint_shape_limit_reached_is_five_hour_full() {
        // Shape measured live 2026-09-15: integer percents, `reset_at` seconds,
        // `limit_reached: true`, `rate_limit_reached_type.type = rate_limit_reached`.
        // Timestamps are relative so the fixture does not depend on wall-clock.
        let now = now_ms();
        let primary_reset = now / 1000 + 3600;
        let weekly_reset = now / 1000 + 86_400;
        let body = live_fixture(100, primary_reset, 48, weekly_reset, true);
        let u = parse_live_usage_payload(&body, now).expect("parses");
        assert_eq!(u.five_h.expect("5h").used_percent, 100.0);
        assert_eq!(u.weekly.expect("weekly").used_percent, 48.0);
        let hit = u.limit_hit.expect("LIMIT REACHED");
        assert_eq!(hit.window, "5h");
        assert_eq!(hit.resets_at_ms, Some(primary_reset * 1000));
    }

    #[test]
    fn live_95_percent_without_limit_reached_stays_95() {
        let future = now_ms() / 1000 + 3600;
        let body = live_fixture(95, future, 47, future + 86_400, false);
        let u = parse_live_usage_payload(&body, now_ms()).expect("parses");
        assert_eq!(u.five_h.expect("5h").used_percent, 95.0);
        assert_eq!(u.weekly.expect("weekly").used_percent, 47.0);
        assert!(u.limit_hit.is_none(), "95% alone must not become LIMIT REACHED");
    }

    #[test]
    fn live_95_percent_with_limit_reached_is_limit_reached() {
        let future = now_ms() / 1000 + 3600;
        let body = live_fixture(95, future, 47, future + 86_400, true);
        let u = parse_live_usage_payload(&body, now_ms()).expect("parses");
        assert_eq!(u.five_h.expect("5h").used_percent, 95.0);
        let hit = u.limit_hit.expect("API said limit_reached");
        assert_eq!(hit.window, "5h");
    }

    #[test]
    fn snapshot_95_plus_newer_refusal_with_future_reset_is_limit_reached() {
        let now = now_ms();
        let snapshot_ms = now.saturating_sub(60_000);
        let usage = CodexUsage {
            five_h: Some(CodexWindow {
                used_percent: 95.0,
                resets_at_ms: Some(now + 3_600_000),
            }),
            weekly: Some(CodexWindow {
                used_percent: 47.0,
                resets_at_ms: Some(now + 86_400_000),
            }),
            limit_hit: None,
            plan_type: None,
        };
        let refusal = RefusalEvidence {
            detected_ms: snapshot_ms + 1_000,
            resets_at_ms: Some(now + 3_600_000),
        };
        let out = apply_newer_refusal(Some(usage), snapshot_ms, Some(refusal), now).expect("merged");
        let hit = out.limit_hit.expect("LIMIT REACHED");
        assert_eq!(hit.window, "5h");
        assert_eq!(out.five_h.expect("keep snapshot").used_percent, 95.0);
    }

    #[test]
    fn snapshot_95_with_no_refusal_stays_95() {
        let now = now_ms();
        let usage = CodexUsage {
            five_h: Some(CodexWindow {
                used_percent: 95.0,
                resets_at_ms: Some(now + 3_600_000),
            }),
            weekly: Some(CodexWindow {
                used_percent: 47.0,
                resets_at_ms: Some(now + 86_400_000),
            }),
            limit_hit: None,
            plan_type: None,
        };
        let out = apply_newer_refusal(Some(usage), now.saturating_sub(60_000), None, now).expect("kept");
        assert_eq!(out.five_h.expect("5h").used_percent, 95.0);
        assert!(out.limit_hit.is_none(), "a 95% snapshot alone must still read 95%");
    }

    #[test]
    fn live_window_whose_reset_has_passed_reads_zero() {
        let past = now_ms() / 1000 - 60;
        let future = now_ms() / 1000 + 86_400;
        let body = live_fixture(100, past, 47, future, true);
        let u = parse_live_usage_payload(&body, now_ms()).expect("parses");
        assert_eq!(
            u.five_h.expect("5h").used_percent,
            0.0,
            "an elapsed window must read as reset, not the stale 100%"
        );
        assert!(u.five_h.expect("5h").resets_at_ms.is_none());
        assert!(
            u.limit_hit.is_none(),
            "a limit_reached whose window already reopened is spent evidence"
        );
        assert_eq!(u.weekly.expect("weekly").used_percent, 47.0);
    }

    #[test]
    fn fmt_12h_matches_the_cli_clock() {
        assert_eq!(fmt_12h(14, 59), "2:59 PM");
        assert_eq!(fmt_12h(2, 2), "2:02 AM");
        assert_eq!(fmt_12h(0, 15), "12:15 AM");
        assert_eq!(fmt_12h(12, 0), "12:00 PM");
    }

    #[test]
    fn clear_cache_drops_the_reading_reload_would_refetch() {
        let usage = CodexUsage {
            five_h: Some(CodexWindow {
                used_percent: 95.0,
                resets_at_ms: None,
            }),
            weekly: None,
            limit_hit: None,
            plan_type: None,
        };
        {
            let mut guard = CACHE.lock().expect("cache");
            *guard = Some((now_ms(), usage));
        }
        assert!(CACHE.lock().expect("cache").is_some());
        clear_cache();
        assert!(
            CACHE.lock().expect("cache").is_none(),
            "refresh_live_state must empty this cache so RELOAD re-hits /wham/usage"
        );
    }

}
