use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Mutex, Once, OnceLock};

const RING_CAPACITY: usize = 400;
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const REPORT_WINDOW_MS: u64 = 60_000;
const REPORTS_PER_WINDOW: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiagEntry {
    pub ts_ms: u64,
    pub level: &'static str,
    pub source: String,
    pub msg: String,
}

#[derive(Default)]
struct DiagRing {
    entries: VecDeque<DiagEntry>,
}

impl DiagRing {
    fn push(&mut self, entry: DiagEntry) {
        if self.entries.len() == RING_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    fn recent(&self, limit: usize, level: Option<&str>) -> Vec<DiagEntry> {
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| level.map_or(true, |wanted| entry.level == wanted))
            .rev()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        entries.reverse();
        entries
    }
}

#[derive(Default)]
struct SourceRate {
    attempts: VecDeque<u64>,
    last_logged_by_message: HashMap<String, u64>,
}

#[derive(Default)]
struct ReportRateLimiter {
    sources: HashMap<String, SourceRate>,
}

impl ReportRateLimiter {
    fn should_log(&mut self, source: &str, message: &str, now_ms: u64) -> bool {
        let state = self.sources.entry(source.to_string()).or_default();
        while state
            .attempts
            .front()
            .is_some_and(|ts| now_ms.saturating_sub(*ts) >= REPORT_WINDOW_MS)
        {
            state.attempts.pop_front();
        }
        if state.attempts.len() >= REPORTS_PER_WINDOW {
            return false;
        }
        state.attempts.push_back(now_ms);

        let duplicate = state
            .last_logged_by_message
            .get(message)
            .is_some_and(|ts| now_ms.saturating_sub(*ts) < REPORT_WINDOW_MS);
        if duplicate {
            return false;
        }
        state
            .last_logged_by_message
            .insert(message.to_string(), now_ms);
        state
            .last_logged_by_message
            .retain(|_, ts| now_ms.saturating_sub(*ts) < REPORT_WINDOW_MS);
        true
    }
}

fn ring() -> &'static Mutex<DiagRing> {
    static RING: OnceLock<Mutex<DiagRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(DiagRing::default()))
}

fn report_limiter() -> &'static Mutex<ReportRateLimiter> {
    static LIMITER: OnceLock<Mutex<ReportRateLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| Mutex::new(ReportRateLimiter::default()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn append_to_log(entry: &DiagEntry) {
    // `cargo test` exercises failure paths on purpose (every TTS provider failing, a
    // timed-out agent tree, unknown fleet models). Written to the real log, those fake
    // errors made the next installed sweep red - 10-03 15:14 "elevenlabs failed; routing
    // to hume ... groq failed; routing to browser" was a test run, not Atlas's voice.
    if cfg!(test) {
        return;
    }
    static ROTATE_ONCE: Once = Once::new();
    let Some(dir) = crate::praxis_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("praxis-errors.log");
    ROTATE_ONCE.call_once(|| {
        if path
            .metadata()
            .map(|metadata| metadata.len() > LOG_ROTATE_BYTES)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&path, dir.join("praxis-errors.log.1"));
        }
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "[{}] [{}] [{}] {}",
            entry.ts_ms, entry.level, entry.source, entry.msg
        );
    }
}

pub(crate) fn emit(level: &'static str, source: &str, msg: String) {
    let entry = DiagEntry {
        ts_ms: now_ms(),
        level,
        source: source.to_string(),
        msg,
    };
    if let Ok(mut entries) = ring().lock() {
        entries.push(entry.clone());
    }
    append_to_log(&entry);
    #[cfg(debug_assertions)]
    std::eprintln!(
        "[{}] [{}] [{}] {}",
        entry.ts_ms,
        entry.level,
        entry.source,
        entry.msg
    );
}

#[macro_export]
macro_rules! elog {
    ($($arg:tt)*) => {{
        $crate::diag::emit("error", module_path!(), format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {{
        $crate::diag::emit("info", module_path!(), format!($($arg)*));
    }};
}

#[tauri::command]
pub fn diag_recent(limit: Option<usize>, level: Option<String>) -> Vec<DiagEntry> {
    let limit = limit.unwrap_or(100).min(RING_CAPACITY);
    let level = level.as_deref().map(str::to_ascii_lowercase);
    ring()
        .lock()
        .map(|entries| entries.recent(limit, level.as_deref()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn diag_report(source: String, message: String) {
    let now = now_ms();
    let should_log = report_limiter()
        .lock()
        .map(|mut limiter| limiter.should_log(&source, &message, now))
        .unwrap_or(false);
    if should_log {
        emit("error", &source, message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts_ms: u64, level: &'static str) -> DiagEntry {
        DiagEntry {
            ts_ms,
            level,
            source: "test".to_string(),
            msg: format!("message {ts_ms}"),
        }
    }

    #[test]
    fn ring_caps_at_400_and_preserves_order() {
        let mut ring = DiagRing::default();
        for index in 0..405 {
            ring.push(entry(index, "info"));
        }
        let recent = ring.recent(400, None);
        assert_eq!(recent.len(), 400);
        assert_eq!(recent.first().map(|item| item.ts_ms), Some(5));
        assert_eq!(recent.last().map(|item| item.ts_ms), Some(404));
        assert_eq!(
            ring.recent(3, None)
                .iter()
                .map(|item| item.ts_ms)
                .collect::<Vec<_>>(),
            vec![402, 403, 404]
        );
    }

    #[test]
    fn ring_filters_level_before_applying_limit() {
        let mut ring = DiagRing::default();
        ring.push(entry(1, "error"));
        ring.push(entry(2, "info"));
        ring.push(entry(3, "error"));
        assert_eq!(
            ring.recent(2, Some("error"))
                .iter()
                .map(|item| item.ts_ms)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
    }

    #[test]
    fn report_rate_limiter_counts_duplicates_without_relogging_them() {
        let mut limiter = ReportRateLimiter::default();
        assert!(limiter.should_log("main", "same", 1_000));
        for offset in 1..REPORTS_PER_WINDOW {
            assert!(!limiter.should_log("main", "same", 1_000 + offset as u64));
        }
        assert!(!limiter.should_log("main", "new", 2_000));
        assert!(limiter.should_log("other", "new", 2_000));
        assert!(limiter.should_log("main", "same", 61_000));
    }
}
