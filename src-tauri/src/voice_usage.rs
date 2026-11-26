//! Privacy-safe usage telemetry for provider-backed text-to-speech.
//!
//! The ledger deliberately stores only routing metadata. It never receives or
//! persists utterance text, API keys, provider response bodies, or audio bytes.
//! Provider cost is currently unavailable, so every event serializes
//! `cost_usd: null` and the frontend labels cost as unknown rather than zero.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const SCHEMA_VERSION: u8 = 1;
const CHECKPOINT_RECORD_TYPE: &str = "voice_usage_checkpoint";
const COMPACTION_THRESHOLD_BYTES: u64 = 512 * 1024;
const STALE_PENDING_MS: u64 = 5 * 60 * 1000;
const RECENT_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_FALLBACK_PENDING_IDENTITIES: usize = 64;
static LEDGER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HEALTH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LEDGER_WRITE_FAILURES: AtomicU64 = AtomicU64::new(0);
static LEDGER_MAINTENANCE_FAILURES: AtomicU64 = AtomicU64::new(0);
static VOICE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static VOICE_SESSION_ID: OnceLock<String> = OnceLock::new();

fn ledger_lock() -> &'static Mutex<()> {
    LEDGER_LOCK.get_or_init(|| Mutex::new(()))
}

fn voice_usage_path() -> Option<PathBuf> {
    crate::praxis_dir().map(|dir| dir.join("voice-usage.jsonl"))
}

fn voice_usage_health_path() -> Option<PathBuf> {
    crate::praxis_dir().map(|dir| dir.join("voice-usage-health.json"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn voice_session_id() -> &'static str {
    VOICE_SESSION_ID.get_or_init(|| {
        let created_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let stack_marker = &created_ns as *const u128 as usize;
        let mut hasher = DefaultHasher::new();
        created_ns.hash(&mut hasher);
        std::process::id().hash(&mut hasher);
        stack_marker.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    })
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct VoiceUsageHealth {
    schema_version: u8,
    degraded: bool,
    #[serde(default)]
    failure_count: u64,
    #[serde(default)]
    write_failure_count: u64,
    #[serde(default)]
    maintenance_failure_count: u64,
    last_failure_ms: u64,
    last_failure_kind: String,
}

#[derive(Debug, Clone, Copy)]
enum HealthFailureKind {
    Write,
    Maintenance,
}

impl HealthFailureKind {
    fn label(self) -> &'static str {
        match self {
            Self::Write => "ledger_write_failed",
            Self::Maintenance => "ledger_maintenance_failed",
        }
    }
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
    .map_err(|_| "voice-usage-replace-failed".to_string())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(source, destination).map_err(|_| "voice-usage-replace-failed".to_string())
}

fn atomic_replace_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "voice-usage-parent-missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "voice-usage-mkdir-failed".to_string())?;
    let sequence = VOICE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("voice-usage.jsonl");
    let temp = parent.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "voice-usage-temp-open-failed".to_string())?;
        file.write_all(bytes)
            .map_err(|_| "voice-usage-temp-write-failed".to_string())?;
        file.flush()
            .map_err(|_| "voice-usage-temp-flush-failed".to_string())?;
        file.sync_all()
            .map_err(|_| "voice-usage-temp-sync-failed".to_string())?;
        drop(file);
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn read_health_from(path: &Path) -> VoiceUsageHealth {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(VoiceUsageHealth {
            schema_version: SCHEMA_VERSION,
            degraded: true,
            failure_count: 1,
            maintenance_failure_count: 1,
            last_failure_ms: now_ms(),
            last_failure_kind: "health_file_invalid".to_string(),
            ..VoiceUsageHealth::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => VoiceUsageHealth::default(),
        Err(_) => VoiceUsageHealth {
            schema_version: SCHEMA_VERSION,
            degraded: true,
            failure_count: 1,
            maintenance_failure_count: 1,
            last_failure_ms: now_ms(),
            last_failure_kind: "health_file_unreadable".to_string(),
            ..VoiceUsageHealth::default()
        },
    }
}

fn record_health_failure_to(
    path: &Path,
    kind: HealthFailureKind,
) -> Result<VoiceUsageHealth, String> {
    let mut health = read_health_from(path);
    health.schema_version = SCHEMA_VERSION;
    health.degraded = true;
    health.failure_count = health.failure_count.saturating_add(1);
    match kind {
        HealthFailureKind::Write => {
            health.write_failure_count = health.write_failure_count.saturating_add(1)
        }
        HealthFailureKind::Maintenance => {
            health.maintenance_failure_count = health.maintenance_failure_count.saturating_add(1)
        }
    }
    health.last_failure_ms = now_ms();
    health.last_failure_kind = kind.label().to_string();
    let bytes = serde_json::to_vec_pretty(&health)
        .map_err(|_| "voice-usage-health-serialize-failed".to_string())?;
    atomic_replace_bytes(path, &bytes)?;
    Ok(health)
}

fn record_health_failure(kind: HealthFailureKind) {
    let local = match kind {
        HealthFailureKind::Write => LEDGER_WRITE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1,
        HealthFailureKind::Maintenance => {
            LEDGER_MAINTENANCE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1
        }
    };
    let Ok(_guard) = HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Some(path) = voice_usage_health_path() else {
        return;
    };
    if let Ok(persisted) = record_health_failure_to(&path, kind) {
        match kind {
            HealthFailureKind::Write => {
                LEDGER_WRITE_FAILURES
                    .fetch_max(local.max(persisted.write_failure_count), Ordering::Relaxed);
            }
            HealthFailureKind::Maintenance => {
                LEDGER_MAINTENANCE_FAILURES.fetch_max(
                    local.max(persisted.maintenance_failure_count),
                    Ordering::Relaxed,
                );
            }
        }
    }
}

fn current_health_failures() -> (u64, u64) {
    let local_write = LEDGER_WRITE_FAILURES.load(Ordering::Relaxed);
    let local_maintenance = LEDGER_MAINTENANCE_FAILURES.load(Ordering::Relaxed);
    let Ok(_guard) = HEALTH_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return (local_write.max(1), local_maintenance.max(1));
    };
    let persisted = voice_usage_health_path()
        .map(|path| read_health_from(&path))
        .unwrap_or_default();
    let legacy_maintenance = if persisted.degraded
        && persisted.write_failure_count == 0
        && persisted.maintenance_failure_count == 0
    {
        persisted.failure_count.max(1)
    } else {
        0
    };
    (
        local_write.max(persisted.write_failure_count),
        local_maintenance.max(persisted.maintenance_failure_count.max(legacy_maintenance)),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceUsageKind {
    Attempt,
    Success,
    Failure,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct VoiceUsageEvent {
    pub schema_version: u8,
    pub timestamp_ms: u64,
    #[serde(default)]
    pub session_id: String,
    pub request_id: String,
    pub backend: String,
    pub model: String,
    pub event: VoiceUsageKind,
    pub character_count: u64,
    pub fallback_to: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    pub cost_usd: Option<f64>,
}

impl VoiceUsageEvent {
    pub(crate) fn new(
        request_id: &str,
        backend: &str,
        model: &str,
        event: VoiceUsageKind,
        character_count: u64,
        fallback_to: Option<&str>,
        reason: Option<&str>,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            timestamp_ms: now_ms(),
            session_id: voice_session_id().to_string(),
            request_id: request_id.to_string(),
            backend: backend.to_string(),
            model: model.to_string(),
            event,
            character_count,
            fallback_to: fallback_to.map(str::to_string),
            reason: reason.map(str::to_string),
            cost_usd: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VoiceUsageAggregate {
    logical_requests: u64,
    provider_attempts: u64,
    successes: u64,
    failures: u64,
    fallback_transitions: u64,
    logical_characters: u64,
    provider_characters: u64,
    last_event_ms: Option<u64>,
    backends: Vec<VoiceBackendUsage>,
    #[serde(default)]
    malformed_lines: u64,
    /// Current-process request IDs already folded into the checkpoint while
    /// still pending. Prior-process IDs are deliberately discarded: that
    /// process can no longer emit a result, while retaining them forever would
    /// make the otherwise bounded checkpoint grow on every crash/restart.
    #[serde(default)]
    pending_requests: BTreeMap<String, PendingVoiceRequest>,
    /// Exact, bounded identity for production `tts-<session>-<sequence>` IDs.
    /// A watermark replaces one checkpoint entry per abandoned request while
    /// still preventing a late terminal event from double-counting the request.
    #[serde(default)]
    compacted_request_sequences: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum PendingVoiceRequest {
    Current {
        character_count: u64,
        session_id: String,
    },
    /// Compatibility with the first local checkpoint prototype. It carried no
    /// session identity, so it is safe to read for totals but never retain.
    Legacy(u64),
}

impl PendingVoiceRequest {
    fn character_count(&self) -> u64 {
        match self {
            Self::Current {
                character_count, ..
            }
            | Self::Legacy(character_count) => *character_count,
        }
    }

    fn belongs_to_session(&self, session_id: &str) -> bool {
        matches!(self, Self::Current { session_id: stored, .. } if stored == session_id)
    }
}

fn request_sequence(request_id: &str, session_id: &str) -> Option<u64> {
    request_id
        .strip_prefix(&format!("tts-{session_id}-"))?
        .parse()
        .ok()
}

fn request_was_compacted(aggregate: &VoiceUsageAggregate, event: &VoiceUsageEvent) -> bool {
    aggregate.pending_requests.contains_key(&event.request_id)
        || request_sequence(&event.request_id, &event.session_id)
            .and_then(|sequence| {
                aggregate
                    .compacted_request_sequences
                    .get(&event.session_id)
                    .map(|watermark| sequence <= *watermark)
            })
            .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VoiceUsageCheckpoint {
    record_type: String,
    schema_version: u8,
    aggregate: VoiceUsageAggregate,
}

pub(crate) trait VoiceUsageSink {
    fn record(&self, event: VoiceUsageEvent);
}

pub(crate) struct FileVoiceUsageSink;

#[derive(Debug, Default)]
struct AppendOutcome {
    maintenance_error: Option<String>,
}

impl VoiceUsageSink for FileVoiceUsageSink {
    fn record(&self, event: VoiceUsageEvent) {
        let Some(path) = voice_usage_path() else {
            record_health_failure(HealthFailureKind::Write);
            crate::elog!("[voice] usage ledger unavailable: no Praxis data directory");
            return;
        };
        match append_event_to(&path, &event) {
            Ok(outcome) => {
                if let Some(error) = outcome.maintenance_error {
                    record_health_failure(HealthFailureKind::Maintenance);
                    crate::elog!("[voice] usage ledger maintenance failed: {error}");
                }
            }
            Err(error) => {
                // A later successful append cannot recover a lost event, so this
                // write-failure signal remains sticky across the process/restart.
                record_health_failure(HealthFailureKind::Write);
                crate::elog!("[voice] usage ledger write failed: {error}");
            }
        }
    }
}

fn append_event_to(path: &Path, event: &VoiceUsageEvent) -> Result<AppendOutcome, String> {
    append_event_to_with_threshold(path, event, COMPACTION_THRESHOLD_BYTES)
}

fn append_needs_separator(path: &Path) -> Result<bool, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("ledger boundary open failed".to_string()),
    };
    let length = file
        .metadata()
        .map_err(|_| "ledger boundary metadata failed".to_string())?
        .len();
    if length == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|_| "ledger boundary seek failed".to_string())?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)
        .map_err(|_| "ledger boundary read failed".to_string())?;
    Ok(last[0] != b'\n')
}

fn append_event_to_with_threshold(
    path: &Path,
    event: &VoiceUsageEvent,
    compaction_threshold_bytes: u64,
) -> Result<AppendOutcome, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "ledger lock poisoned".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "ledger path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    let needs_separator = append_needs_separator(path)?;
    let mut line = serde_json::to_vec(event).map_err(|error| format!("serialize: {error}"))?;
    line.push(b'\n');
    if needs_separator {
        line.insert(0, b'\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open: {error}"))?;
    file.write_all(&line)
        .map_err(|error| format!("append: {error}"))?;
    file.flush().map_err(|error| format!("flush: {error}"))?;
    file.sync_data().map_err(|error| format!("sync: {error}"))?;
    drop(file);
    let maintenance_error =
        maintenance_after_append(path, compaction_threshold_bytes, compact_ledger_unlocked);
    Ok(AppendOutcome { maintenance_error })
}

fn maintenance_after_append(
    path: &Path,
    compaction_threshold_bytes: u64,
    compact: impl FnOnce(&Path) -> Result<(), String>,
) -> Option<String> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() > compaction_threshold_bytes => compact(path).err(),
        Ok(_) => None,
        Err(_) => Some("ledger metadata failed after durable append".to_string()),
    }
}

#[derive(Default)]
struct LedgerRead {
    checkpoint: VoiceUsageAggregate,
    events: Vec<VoiceUsageEvent>,
    malformed_lines: u64,
    read_error: bool,
}

fn read_events_from(path: &Path) -> LedgerRead {
    let Ok(_guard) = ledger_lock().lock() else {
        return LedgerRead {
            read_error: true,
            ..LedgerRead::default()
        };
    };
    read_events_from_unlocked(path)
}

fn read_events_from_unlocked(path: &Path) -> LedgerRead {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LedgerRead::default(),
        Err(_) => {
            return LedgerRead {
                read_error: true,
                ..LedgerRead::default()
            }
        }
    };
    let mut result = LedgerRead::default();
    let mut reader = BufReader::new(file);
    loop {
        let mut record = Vec::new();
        match reader.read_until(b'\n', &mut record) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => {
                result.read_error = true;
                break;
            }
        }
        while matches!(record.last(), Some(b'\n' | b'\r')) {
            record.pop();
        }
        if record.is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<VoiceUsageEvent>(&record) {
            if event.schema_version == SCHEMA_VERSION {
                result.events.push(event);
                continue;
            }
        }
        match serde_json::from_slice::<VoiceUsageCheckpoint>(&record) {
            Ok(checkpoint)
                if checkpoint.schema_version == SCHEMA_VERSION
                    && checkpoint.record_type == CHECKPOINT_RECORD_TYPE =>
            {
                merge_aggregate(&mut result.checkpoint, checkpoint.aggregate);
            }
            _ => result.malformed_lines = result.malformed_lines.saturating_add(1),
        }
    }
    result
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VoiceUsageCounts {
    pub attempts: u64,
    pub successes: u64,
    pub failures: u64,
    pub fallback_departures: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VoiceBackendUsage {
    pub backend: String,
    pub model: String,
    pub attempts: u64,
    pub successes: u64,
    pub failures: u64,
    pub fallback_departures: u64,
    /// Characters sent to this provider. A fallback retry intentionally counts
    /// the same logical utterance again for the next provider.
    pub characters_sent: u64,
    pub last_event_ms: u64,
    #[serde(default)]
    pub recent: VoiceUsageCounts,
    #[serde(default)]
    pub last_failure_ms: Option<u64>,
    #[serde(default)]
    pub last_failure_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceUsageSnapshot {
    /// Distinct logical utterance requests. One request may make multiple provider
    /// attempts when the fallback chain advances.
    pub logical_requests: u64,
    pub provider_attempts: u64,
    /// Attempts with no recorded success/failure result, usually caused by an app
    /// interruption between the outbound request and its result event.
    pub pending_attempts: u64,
    pub successes: u64,
    pub failures: u64,
    pub fallback_transitions: u64,
    /// Characters in distinct logical requests (counted once per request).
    pub logical_characters: u64,
    /// Characters actually submitted across provider attempts. This can exceed
    /// logical_characters when the same request advances through fallbacks.
    pub provider_characters: u64,
    pub last_event_ms: Option<u64>,
    pub cost_usd: Option<f64>,
    pub cost_basis: &'static str,
    /// "empty" | "ready" | "degraded" | "unavailable".
    pub ledger_status: &'static str,
    pub malformed_lines: u64,
    pub write_failures: u64,
    pub maintenance_failures: u64,
    pub backends: Vec<VoiceBackendUsage>,
}

impl Default for VoiceUsageSnapshot {
    fn default() -> Self {
        Self {
            logical_requests: 0,
            provider_attempts: 0,
            pending_attempts: 0,
            successes: 0,
            failures: 0,
            fallback_transitions: 0,
            logical_characters: 0,
            provider_characters: 0,
            last_event_ms: None,
            cost_usd: None,
            cost_basis: "unknown",
            ledger_status: "empty",
            malformed_lines: 0,
            write_failures: 0,
            maintenance_failures: 0,
            backends: Vec::new(),
        }
    }
}

fn summarize(events: &[VoiceUsageEvent]) -> VoiceUsageSnapshot {
    let mut snapshot = VoiceUsageSnapshot::default();
    let mut backends: BTreeMap<(String, String), VoiceBackendUsage> = BTreeMap::new();
    let mut request_ids = BTreeSet::new();
    let mut request_characters = BTreeMap::new();
    let recent_cutoff_ms = now_ms().saturating_sub(RECENT_WINDOW_MS);

    for event in events {
        request_ids.insert(event.request_id.as_str());
        request_characters
            .entry(event.request_id.as_str())
            .or_insert(event.character_count);
        snapshot.last_event_ms = Some(snapshot.last_event_ms.unwrap_or(0).max(event.timestamp_ms));
        let row = backends
            .entry((event.backend.clone(), event.model.clone()))
            .or_insert_with(|| VoiceBackendUsage {
                backend: event.backend.clone(),
                model: event.model.clone(),
                ..VoiceBackendUsage::default()
            });
        row.last_event_ms = row.last_event_ms.max(event.timestamp_ms);
        let is_recent = event.timestamp_ms >= recent_cutoff_ms;

        match event.event {
            VoiceUsageKind::Attempt => {
                snapshot.provider_attempts += 1;
                snapshot.provider_characters += event.character_count;
                row.attempts += 1;
                row.characters_sent += event.character_count;
                if is_recent {
                    row.recent.attempts += 1;
                }
            }
            VoiceUsageKind::Success => {
                snapshot.successes += 1;
                row.successes += 1;
                if is_recent {
                    row.recent.successes += 1;
                }
            }
            VoiceUsageKind::Failure => {
                snapshot.failures += 1;
                row.failures += 1;
                if is_recent {
                    row.recent.failures += 1;
                }
                if event.timestamp_ms >= row.last_failure_ms.unwrap_or(0) {
                    row.last_failure_ms = Some(event.timestamp_ms);
                    row.last_failure_reason = event.reason.clone();
                }
            }
            VoiceUsageKind::Fallback => {
                snapshot.fallback_transitions += 1;
                row.fallback_departures += 1;
                if is_recent {
                    row.recent.fallback_departures += 1;
                }
            }
        }
    }

    snapshot.logical_requests = request_ids.len() as u64;
    snapshot.logical_characters = request_characters.into_values().sum();
    snapshot.pending_attempts = snapshot
        .provider_attempts
        .saturating_sub(snapshot.successes + snapshot.failures);
    if !events.is_empty() {
        snapshot.ledger_status = "ready";
    }
    snapshot.backends = backends.into_values().collect();
    snapshot
}

fn merge_backend_rows(target: &mut Vec<VoiceBackendUsage>, incoming: Vec<VoiceBackendUsage>) {
    let mut rows: BTreeMap<(String, String), VoiceBackendUsage> = target
        .drain(..)
        .map(|row| ((row.backend.clone(), row.model.clone()), row))
        .collect();
    for row in incoming {
        let existing = rows
            .entry((row.backend.clone(), row.model.clone()))
            .or_insert_with(|| VoiceBackendUsage {
                backend: row.backend.clone(),
                model: row.model.clone(),
                ..VoiceBackendUsage::default()
            });
        existing.attempts = existing.attempts.saturating_add(row.attempts);
        existing.successes = existing.successes.saturating_add(row.successes);
        existing.failures = existing.failures.saturating_add(row.failures);
        existing.fallback_departures = existing
            .fallback_departures
            .saturating_add(row.fallback_departures);
        existing.characters_sent = existing.characters_sent.saturating_add(row.characters_sent);
        existing.last_event_ms = existing.last_event_ms.max(row.last_event_ms);
        existing.recent.attempts = existing.recent.attempts.saturating_add(row.recent.attempts);
        existing.recent.successes = existing
            .recent
            .successes
            .saturating_add(row.recent.successes);
        existing.recent.failures = existing.recent.failures.saturating_add(row.recent.failures);
        existing.recent.fallback_departures = existing
            .recent
            .fallback_departures
            .saturating_add(row.recent.fallback_departures);
        if row.last_failure_ms.unwrap_or(0) >= existing.last_failure_ms.unwrap_or(0)
            && row.last_failure_ms.is_some()
        {
            existing.last_failure_ms = row.last_failure_ms;
            existing.last_failure_reason = row.last_failure_reason;
        }
    }
    *target = rows.into_values().collect();
}

fn merge_aggregate(target: &mut VoiceUsageAggregate, incoming: VoiceUsageAggregate) {
    target.logical_requests = target
        .logical_requests
        .saturating_add(incoming.logical_requests);
    target.provider_attempts = target
        .provider_attempts
        .saturating_add(incoming.provider_attempts);
    target.successes = target.successes.saturating_add(incoming.successes);
    target.failures = target.failures.saturating_add(incoming.failures);
    target.fallback_transitions = target
        .fallback_transitions
        .saturating_add(incoming.fallback_transitions);
    target.logical_characters = target
        .logical_characters
        .saturating_add(incoming.logical_characters);
    target.provider_characters = target
        .provider_characters
        .saturating_add(incoming.provider_characters);
    target.last_event_ms = match (target.last_event_ms, incoming.last_event_ms) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    };
    target.malformed_lines = target
        .malformed_lines
        .saturating_add(incoming.malformed_lines);
    for (request_id, characters) in incoming.pending_requests {
        target
            .pending_requests
            .entry(request_id)
            .or_insert(characters);
    }
    for (session_id, sequence) in incoming.compacted_request_sequences {
        target
            .compacted_request_sequences
            .entry(session_id)
            .and_modify(|watermark| *watermark = (*watermark).max(sequence))
            .or_insert(sequence);
    }
    merge_backend_rows(&mut target.backends, incoming.backends);
}

fn aggregate_from_snapshot(snapshot: VoiceUsageSnapshot) -> VoiceUsageAggregate {
    VoiceUsageAggregate {
        logical_requests: snapshot.logical_requests,
        provider_attempts: snapshot.provider_attempts,
        successes: snapshot.successes,
        failures: snapshot.failures,
        fallback_transitions: snapshot.fallback_transitions,
        logical_characters: snapshot.logical_characters,
        provider_characters: snapshot.provider_characters,
        last_event_ms: snapshot.last_event_ms,
        backends: snapshot.backends,
        malformed_lines: snapshot.malformed_lines,
        pending_requests: BTreeMap::new(),
        compacted_request_sequences: BTreeMap::new(),
    }
}

fn snapshot_from_aggregate_and_events(
    aggregate: VoiceUsageAggregate,
    events: &[VoiceUsageEvent],
) -> VoiceUsageSnapshot {
    let mut merged = aggregate;
    let mut tail = summarize(events);
    let repeated_pending: BTreeSet<&str> = events
        .iter()
        .filter(|event| request_was_compacted(&merged, event))
        .map(|event| event.request_id.as_str())
        .collect();
    for request_id in repeated_pending {
        tail.logical_requests = tail.logical_requests.saturating_sub(1);
        let characters = merged
            .pending_requests
            .get(request_id)
            .map(PendingVoiceRequest::character_count)
            .or_else(|| {
                events
                    .iter()
                    .find(|event| event.request_id == request_id)
                    .map(|event| event.character_count)
            })
            .unwrap_or(0);
        tail.logical_characters = tail.logical_characters.saturating_sub(characters);
    }
    merge_aggregate(&mut merged, aggregate_from_snapshot(tail));
    let has_data = merged.logical_requests > 0
        || merged.provider_attempts > 0
        || merged.fallback_transitions > 0;
    VoiceUsageSnapshot {
        logical_requests: merged.logical_requests,
        provider_attempts: merged.provider_attempts,
        pending_attempts: merged
            .provider_attempts
            .saturating_sub(merged.successes.saturating_add(merged.failures)),
        successes: merged.successes,
        failures: merged.failures,
        fallback_transitions: merged.fallback_transitions,
        logical_characters: merged.logical_characters,
        provider_characters: merged.provider_characters,
        last_event_ms: merged.last_event_ms,
        cost_usd: None,
        cost_basis: "unknown",
        ledger_status: if has_data { "ready" } else { "empty" },
        malformed_lines: merged.malformed_lines,
        write_failures: 0,
        maintenance_failures: 0,
        backends: merged.backends,
    }
}

fn snapshot_from_read(
    read: LedgerRead,
    write_failures: u64,
    maintenance_failures: u64,
) -> VoiceUsageSnapshot {
    if read.read_error {
        return VoiceUsageSnapshot {
            ledger_status: "unavailable",
            write_failures,
            maintenance_failures,
            ..VoiceUsageSnapshot::default()
        };
    }
    let mut snapshot = snapshot_from_aggregate_and_events(read.checkpoint, &read.events);
    snapshot.malformed_lines = snapshot
        .malformed_lines
        .saturating_add(read.malformed_lines);
    snapshot.write_failures = write_failures;
    snapshot.maintenance_failures = maintenance_failures;
    if snapshot.malformed_lines > 0 || write_failures > 0 || maintenance_failures > 0 {
        snapshot.ledger_status = "degraded";
    }
    snapshot
}

fn compact_ledger_unlocked(path: &Path) -> Result<(), String> {
    compact_ledger_unlocked_at(path, now_ms())
}

fn request_is_terminal(events: &[VoiceUsageEvent]) -> bool {
    events.iter().any(|event| {
        event.event == VoiceUsageKind::Success
            || (event.event == VoiceUsageKind::Fallback
                && event.fallback_to.as_deref() == Some("browser"))
    })
}

fn request_is_stale(events: &[VoiceUsageEvent], compacted_at_ms: u64) -> bool {
    let latest_event_ms = events
        .iter()
        .map(|event| event.timestamp_ms)
        .max()
        .unwrap_or(0);
    let belongs_to_current_session = events
        .iter()
        .all(|event| event.session_id == voice_session_id());
    !belongs_to_current_session
        || compacted_at_ms.saturating_sub(latest_event_ms) > STALE_PENDING_MS
}

fn request_is_recent(events: &[VoiceUsageEvent], compacted_at_ms: u64) -> bool {
    let cutoff = compacted_at_ms.saturating_sub(RECENT_WINDOW_MS);
    events.iter().any(|event| event.timestamp_ms >= cutoff)
}

fn fold_request_events(
    aggregate: &mut VoiceUsageAggregate,
    events: &[VoiceUsageEvent],
    already_counted: bool,
) {
    let mut delta = summarize(events);
    if already_counted {
        delta.logical_requests = 0;
        delta.logical_characters = 0;
    }
    merge_aggregate(aggregate, aggregate_from_snapshot(delta));
}

fn compact_ledger_unlocked_at(path: &Path, compacted_at_ms: u64) -> Result<(), String> {
    let read = read_events_from_unlocked(path);
    if read.read_error {
        return Err("voice-usage-compaction-read-failed".to_string());
    }
    let mut aggregate = read.checkpoint;
    let current_session_id = voice_session_id();
    aggregate
        .compacted_request_sequences
        .retain(|session_id, _| session_id == current_session_id);
    let mut frontier = aggregate
        .compacted_request_sequences
        .get(current_session_id)
        .copied()
        .unwrap_or(0);
    let mut production_pending = BTreeMap::new();
    let prior_pending = std::mem::take(&mut aggregate.pending_requests);
    for (request_id, pending) in prior_pending {
        if !pending.belongs_to_session(current_session_id) {
            continue;
        }
        if let Some(sequence) = request_sequence(&request_id, current_session_id) {
            if sequence > frontier {
                production_pending.insert(sequence, (request_id, pending));
            }
        } else {
            aggregate.pending_requests.insert(request_id, pending);
        }
    }
    aggregate.malformed_lines = aggregate
        .malformed_lines
        .saturating_add(read.malformed_lines);
    let mut by_request: BTreeMap<String, Vec<VoiceUsageEvent>> = BTreeMap::new();
    for event in read.events {
        by_request
            .entry(event.request_id.clone())
            .or_default()
            .push(event);
    }
    let mut pending_tail = Vec::new();
    let mut production_events = BTreeMap::new();
    let mut other_requests = Vec::new();
    for (request_id, events) in by_request {
        let belongs_to_current_session = events
            .iter()
            .all(|event| event.session_id == current_session_id);
        if belongs_to_current_session {
            if let Some(sequence) = request_sequence(&request_id, current_session_id) {
                production_events.insert(sequence, (request_id, events));
                continue;
            }
        }
        other_requests.push((request_id, events));
    }

    for (request_id, events) in other_requests {
        // Keep the rolling 24-hour window as raw events. A lifetime checkpoint
        // cannot later know when a count ages out of "today".
        if request_is_recent(&events, compacted_at_ms) {
            pending_tail.extend(events);
            continue;
        }
        // A provider failure is only the end of one leg; the same logical request
        // may immediately continue through a fallback provider. Compact only on
        // explicit whole-request terminal evidence so characters/request counts
        // can never be checkpointed twice across a threshold crossing.
        let is_terminal = request_is_terminal(&events);
        let is_stale = request_is_stale(&events, compacted_at_ms);
        let belongs_to_current_session = events
            .iter()
            .all(|event| event.session_id == current_session_id);
        if is_terminal || is_stale {
            let already_counted = events
                .first()
                .map(|event| request_was_compacted(&aggregate, event))
                .unwrap_or(false);
            let characters = events
                .iter()
                .map(|event| event.character_count)
                .next()
                .unwrap_or(0);
            fold_request_events(&mut aggregate, &events, already_counted);
            if is_terminal {
                aggregate.pending_requests.remove(&request_id);
            } else if belongs_to_current_session {
                aggregate
                    .pending_requests
                    .entry(request_id)
                    .or_insert_with(|| PendingVoiceRequest::Current {
                        character_count: characters,
                        session_id: current_session_id.to_string(),
                    });
            }
        } else {
            pending_tail.extend(events);
        }
    }

    // Production request IDs are issued in order. The watermark is therefore a
    // compacted *prefix*, never the highest compactable ID observed. A live lower
    // request is a hole: every higher request stays in the tail until that hole
    // becomes terminal/stale, preventing late lower results from being mistaken
    // for already-counted traffic.
    if frontier > 0 {
        let already_compacted: Vec<u64> = production_events
            .range(..=frontier)
            .map(|(sequence, _)| *sequence)
            .collect();
        for sequence in already_compacted {
            production_pending.remove(&sequence);
            let Some((_, events)) = production_events.remove(&sequence) else {
                continue;
            };
            if request_is_recent(&events, compacted_at_ms) {
                pending_tail.extend(events);
                continue;
            }
            if request_is_terminal(&events) || request_is_stale(&events, compacted_at_ms) {
                fold_request_events(&mut aggregate, &events, true);
            } else {
                pending_tail.extend(events);
            }
        }
    }

    while let Some(next_sequence) = frontier.checked_add(1) {
        let precounted = production_pending.remove(&next_sequence);
        let request = production_events.remove(&next_sequence);
        match (precounted, request) {
            (None, None) => break,
            (Some(_), None) => frontier = next_sequence,
            (Some(_), Some((_, events))) => {
                if request_is_recent(&events, compacted_at_ms) {
                    pending_tail.extend(events);
                    frontier = next_sequence;
                    continue;
                }
                frontier = next_sequence;
                if request_is_terminal(&events) || request_is_stale(&events, compacted_at_ms) {
                    fold_request_events(&mut aggregate, &events, true);
                } else {
                    pending_tail.extend(events);
                }
            }
            (None, Some((request_id, events))) => {
                if request_is_recent(&events, compacted_at_ms) {
                    production_events.insert(next_sequence, (request_id, events));
                    break;
                }
                if request_is_terminal(&events) || request_is_stale(&events, compacted_at_ms) {
                    fold_request_events(&mut aggregate, &events, false);
                    frontier = next_sequence;
                } else {
                    production_events.insert(next_sequence, (request_id, events));
                    break;
                }
            }
        }
    }

    for (_, (request_id, pending)) in production_pending {
        aggregate.pending_requests.insert(request_id, pending);
    }
    for (_, (_, events)) in production_events {
        pending_tail.extend(events);
    }
    if frontier > 0 {
        aggregate
            .compacted_request_sequences
            .insert(current_session_id.to_string(), frontier);
    } else {
        aggregate
            .compacted_request_sequences
            .remove(current_session_id);
    }
    while aggregate.pending_requests.len() > MAX_FALLBACK_PENDING_IDENTITIES {
        let Some(oldest_key) = aggregate.pending_requests.keys().next().cloned() else {
            break;
        };
        aggregate.pending_requests.remove(&oldest_key);
        aggregate.malformed_lines = aggregate.malformed_lines.saturating_add(1);
    }
    let checkpoint = VoiceUsageCheckpoint {
        record_type: CHECKPOINT_RECORD_TYPE.to_string(),
        schema_version: SCHEMA_VERSION,
        aggregate,
    };
    let mut bytes = serde_json::to_vec(&checkpoint)
        .map_err(|_| "voice-usage-checkpoint-serialize-failed".to_string())?;
    bytes.push(b'\n');
    for event in pending_tail {
        let mut line = serde_json::to_vec(&event)
            .map_err(|_| "voice-usage-event-serialize-failed".to_string())?;
        line.push(b'\n');
        bytes.extend_from_slice(&line);
    }
    atomic_replace_bytes(path, &bytes)
}

#[tauri::command]
pub fn voice_usage_snapshot() -> VoiceUsageSnapshot {
    let (write_failures, maintenance_failures) = current_health_failures();
    let Some(path) = voice_usage_path() else {
        return VoiceUsageSnapshot {
            ledger_status: "unavailable",
            write_failures,
            maintenance_failures,
            ..VoiceUsageSnapshot::default()
        };
    };
    snapshot_from_read(
        read_events_from(&path),
        write_failures,
        maintenance_failures,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "praxis-voice-usage-{}-{}-{name}.jsonl",
            std::process::id(),
            now_ms()
        ))
    }

    fn event(
        timestamp_ms: u64,
        backend: &str,
        model: &str,
        kind: VoiceUsageKind,
        character_count: u64,
        fallback_to: Option<&str>,
    ) -> VoiceUsageEvent {
        VoiceUsageEvent {
            schema_version: SCHEMA_VERSION,
            timestamp_ms,
            session_id: voice_session_id().to_string(),
            request_id: "request-1".to_string(),
            backend: backend.to_string(),
            model: model.to_string(),
            event: kind,
            character_count,
            fallback_to: fallback_to.map(str::to_string),
            reason: None,
            cost_usd: None,
        }
    }

    #[test]
    fn ledger_round_trip_is_privacy_safe_and_cost_unknown() {
        let path = test_path("privacy");
        let attempt = event(
            10,
            "elevenlabs",
            "eleven_turbo_v2_5",
            VoiceUsageKind::Attempt,
            23,
            None,
        );
        append_event_to(&path, &attempt).expect("append attempt");

        let raw = std::fs::read_to_string(&path).expect("read ledger");
        assert!(raw.contains("\"cost_usd\":null"));
        assert!(!raw.contains("secret-key-value"));
        assert!(!raw.contains("This text must never be stored"));

        let read = read_events_from(&path);
        assert_eq!(read.events, vec![attempt]);
        let snapshot = summarize(&read.events);
        assert_eq!(snapshot.provider_attempts, 1);
        assert_eq!(snapshot.logical_requests, 1);
        assert_eq!(snapshot.logical_characters, 23);
        assert_eq!(snapshot.provider_characters, 23);
        assert_eq!(snapshot.cost_usd, None);
        assert_eq!(snapshot.cost_basis, "unknown");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_counts_attempt_results_and_fallbacks_without_double_counting_chars() {
        let events = vec![
            event(
                10,
                "elevenlabs",
                "eleven_turbo_v2_5",
                VoiceUsageKind::Attempt,
                12,
                None,
            ),
            event(
                11,
                "elevenlabs",
                "eleven_turbo_v2_5",
                VoiceUsageKind::Failure,
                12,
                None,
            ),
            event(
                12,
                "elevenlabs",
                "eleven_turbo_v2_5",
                VoiceUsageKind::Fallback,
                12,
                Some("hume"),
            ),
            event(13, "hume", "octave", VoiceUsageKind::Attempt, 12, None),
            event(14, "hume", "octave", VoiceUsageKind::Success, 12, None),
        ];
        let snapshot = summarize(&events);
        assert_eq!(snapshot.provider_attempts, 2);
        assert_eq!(snapshot.logical_requests, 1);
        assert_eq!(snapshot.successes, 1);
        assert_eq!(snapshot.failures, 1);
        assert_eq!(snapshot.fallback_transitions, 1);
        assert_eq!(snapshot.logical_characters, 12);
        assert_eq!(snapshot.provider_characters, 24);
        assert_eq!(snapshot.last_event_ms, Some(14));
        assert_eq!(snapshot.backends.len(), 2);
    }

    #[test]
    fn backend_recent_window_and_last_failure_reason_are_honest() {
        let current = now_ms();
        let mut old_failure = event(
            current.saturating_sub(RECENT_WINDOW_MS + 1),
            "openai",
            "gpt-4o-mini-tts",
            VoiceUsageKind::Failure,
            12,
            None,
        );
        old_failure.reason = None;
        let mut recent_failure = event(
            current,
            "hume",
            "octave",
            VoiceUsageKind::Failure,
            12,
            None,
        );
        recent_failure.reason = Some("timeout 30s".to_string());

        let snapshot = summarize(&[old_failure, recent_failure]);
        let openai = snapshot
            .backends
            .iter()
            .find(|row| row.backend == "openai")
            .expect("OpenAI row");
        assert_eq!(openai.failures, 1);
        assert_eq!(openai.recent.failures, 0);
        assert_eq!(openai.last_failure_reason, None);
        let hume = snapshot
            .backends
            .iter()
            .find(|row| row.backend == "hume")
            .expect("Hume row");
        assert_eq!(hume.recent.failures, 1);
        assert_eq!(hume.last_failure_ms, Some(current));
        assert_eq!(hume.last_failure_reason.as_deref(), Some("timeout 30s"));
    }

    #[test]
    fn legacy_events_without_a_reason_still_parse() {
        let raw = r#"{"schema_version":1,"timestamp_ms":10,"request_id":"old","backend":"openai","model":"gpt-4o-mini-tts","event":"failure","character_count":4,"fallback_to":null,"cost_usd":null}"#;
        let parsed: VoiceUsageEvent = serde_json::from_str(raw).expect("legacy event");
        assert_eq!(parsed.reason, None);
    }

    #[test]
    fn corrupt_or_future_lines_do_not_break_the_snapshot() {
        let path = test_path("corrupt");
        let valid = event(
            21,
            "groq",
            "canopylabs/orpheus-v1-english",
            VoiceUsageKind::Attempt,
            7,
            None,
        );
        append_event_to(&path, &valid).expect("append valid event");
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("reopen");
            writeln!(file, "not-json").expect("append corrupt line");
            writeln!(file, "{{\"schema_version\":99}}").expect("append future line");
        }
        let read = read_events_from(&path);
        assert_eq!(read.malformed_lines, 2);
        let snapshot = summarize(&read.events);
        assert_eq!(snapshot.provider_attempts, 1);
        assert_eq!(snapshot.logical_characters, 7);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_or_write_failures_are_never_reported_as_healthy() {
        let degraded = snapshot_from_read(
            LedgerRead {
                checkpoint: VoiceUsageAggregate::default(),
                events: vec![event(
                    25,
                    "hume",
                    "octave",
                    VoiceUsageKind::Success,
                    7,
                    None,
                )],
                malformed_lines: 2,
                read_error: false,
            },
            1,
            0,
        );
        assert_eq!(degraded.ledger_status, "degraded");
        assert_eq!(degraded.malformed_lines, 2);
        assert_eq!(degraded.write_failures, 1);

        let unavailable = snapshot_from_read(
            LedgerRead {
                read_error: true,
                ..LedgerRead::default()
            },
            3,
            0,
        );
        assert_eq!(unavailable.ledger_status, "unavailable");
        assert_eq!(unavailable.write_failures, 3);
    }

    #[test]
    fn concurrent_appends_remain_one_valid_json_event_per_line() {
        let path = test_path("concurrent");
        let mut workers = Vec::new();
        for index in 0..12u64 {
            let worker_path = path.clone();
            workers.push(std::thread::spawn(move || {
                let mut item = event(
                    100 + index,
                    "hume",
                    "octave",
                    VoiceUsageKind::Attempt,
                    index + 1,
                    None,
                );
                item.request_id = format!("request-{index}");
                append_event_to(&worker_path, &item).expect("concurrent append");
            }));
        }
        for worker in workers {
            worker.join().expect("worker should not panic");
        }

        let read = read_events_from(&path);
        assert_eq!(read.events.len(), 12);
        let snapshot = summarize(&read.events);
        assert_eq!(snapshot.logical_requests, 12);
        assert_eq!(snapshot.provider_attempts, 12);
        assert_eq!(snapshot.logical_characters, (1u64..=12).sum::<u64>());
        assert_eq!(snapshot.provider_characters, (1u64..=12).sum::<u64>());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compaction_preserves_lifetime_totals_in_one_bounded_file() {
        let path = test_path("compaction");
        for index in 0..40u64 {
            let mut attempt = event(
                1_000 + index * 2,
                "hume",
                "octave",
                VoiceUsageKind::Attempt,
                10 + index,
                None,
            );
            attempt.request_id = format!("complete-{index}");
            let mut success = attempt.clone();
            success.timestamp_ms += 1;
            success.event = VoiceUsageKind::Success;
            append_event_to_with_threshold(&path, &attempt, 512).expect("append attempt");
            append_event_to_with_threshold(&path, &success, 512).expect("append success");
        }

        let read = read_events_from(&path);
        assert_eq!(read.malformed_lines, 0);
        let snapshot = snapshot_from_read(read, 0, 0);
        assert_eq!(snapshot.logical_requests, 40);
        assert_eq!(snapshot.provider_attempts, 40);
        assert_eq!(snapshot.successes, 40);
        assert_eq!(snapshot.pending_attempts, 0);
        assert_eq!(snapshot.logical_characters, (10u64..50).sum::<u64>());
        assert_eq!(snapshot.provider_characters, (10u64..50).sum::<u64>());
        let raw = std::fs::read_to_string(&path).expect("read compacted ledger");
        assert!(raw.contains(CHECKPOINT_RECORD_TYPE));
        assert!(raw.lines().count() <= 3, "unexpected tail: {raw}");
        assert!(raw.len() < 4_096, "compacted ledger should stay bounded");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compaction_retains_pending_request_identity_until_result_arrives() {
        let path = test_path("pending-compaction");
        let mut attempt = event(
            now_ms(),
            "groq",
            "canopylabs/orpheus-v1-english",
            VoiceUsageKind::Attempt,
            19,
            None,
        );
        attempt.request_id = "pending-request".to_string();
        append_event_to_with_threshold(&path, &attempt, 1).expect("append pending attempt");
        let pending = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(pending.logical_requests, 1);
        assert_eq!(pending.pending_attempts, 1);

        let mut success = attempt.clone();
        success.timestamp_ms += 1;
        success.event = VoiceUsageKind::Success;
        append_event_to_with_threshold(&path, &success, 1).expect("append result");
        let completed = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(completed.logical_requests, 1);
        assert_eq!(completed.provider_attempts, 1);
        assert_eq!(completed.successes, 1);
        assert_eq!(completed.pending_attempts, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compaction_waits_through_failed_provider_legs_until_logical_success() {
        let path = test_path("failed-leg-compaction");
        let mut first_attempt = event(
            now_ms(),
            "elevenlabs",
            "eleven_turbo_v2_5",
            VoiceUsageKind::Attempt,
            31,
            None,
        );
        first_attempt.request_id = "fallback-request".to_string();
        let mut first_failure = first_attempt.clone();
        first_failure.timestamp_ms += 1;
        first_failure.event = VoiceUsageKind::Failure;
        let mut fallback = first_attempt.clone();
        fallback.timestamp_ms += 2;
        fallback.event = VoiceUsageKind::Fallback;
        fallback.fallback_to = Some("hume".to_string());
        let mut second_attempt = first_attempt.clone();
        second_attempt.timestamp_ms += 3;
        second_attempt.backend = "hume".to_string();
        second_attempt.model = "octave".to_string();
        let mut success = second_attempt.clone();
        success.timestamp_ms += 1;
        success.event = VoiceUsageKind::Success;

        for (index, item) in [&first_attempt, &first_failure, &fallback, &second_attempt]
            .into_iter()
            .enumerate()
        {
            append_event_to_with_threshold(&path, item, 1).expect("append nonterminal leg");
            let read = read_events_from(&path);
            assert_eq!(read.checkpoint.logical_requests, 0);
            assert_eq!(read.checkpoint.logical_characters, 0);
            assert_eq!(read.events.len(), index + 1);
            let snapshot = snapshot_from_read(read, 0, 0);
            assert_eq!(snapshot.logical_requests, 1);
            assert_eq!(snapshot.logical_characters, 31);
        }
        append_event_to_with_threshold(&path, &success, 1).expect("append terminal success");
        let snapshot = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(snapshot.logical_requests, 1);
        assert_eq!(snapshot.logical_characters, 31);
        assert_eq!(snapshot.provider_attempts, 2);
        assert_eq!(snapshot.provider_characters, 62);
        assert_eq!(snapshot.failures, 1);
        assert_eq!(snapshot.successes, 1);
        assert_eq!(snapshot.fallback_transitions, 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compaction_waits_through_unavailable_fallbacks_until_browser_handoff() {
        let path = test_path("unavailable-compaction");
        let mut eleven_to_hume = event(
            now_ms(),
            "elevenlabs",
            "eleven_turbo_v2_5",
            VoiceUsageKind::Fallback,
            41,
            Some("hume"),
        );
        eleven_to_hume.request_id = "unavailable-request".to_string();
        let mut hume_to_groq = eleven_to_hume.clone();
        hume_to_groq.timestamp_ms += 1;
        hume_to_groq.backend = "hume".to_string();
        hume_to_groq.model = "octave".to_string();
        hume_to_groq.fallback_to = Some("groq".to_string());
        let mut groq_to_browser = hume_to_groq.clone();
        groq_to_browser.timestamp_ms += 1;
        groq_to_browser.backend = "groq".to_string();
        groq_to_browser.model = "canopylabs/orpheus-v1-english".to_string();
        groq_to_browser.fallback_to = Some("browser".to_string());

        for (index, item) in [&eleven_to_hume, &hume_to_groq].into_iter().enumerate() {
            append_event_to_with_threshold(&path, item, 1).expect("append nonterminal fallback");
            let read = read_events_from(&path);
            assert_eq!(read.checkpoint.logical_requests, 0);
            assert_eq!(read.checkpoint.logical_characters, 0);
            assert_eq!(read.events.len(), index + 1);
            let snapshot = snapshot_from_read(read, 0, 0);
            assert_eq!(snapshot.logical_requests, 1);
            assert_eq!(snapshot.logical_characters, 41);
            assert_eq!(snapshot.fallback_transitions, index as u64 + 1);
        }
        append_event_to_with_threshold(&path, &groq_to_browser, 1)
            .expect("append terminal browser handoff");
        let snapshot = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(snapshot.logical_requests, 1);
        assert_eq!(snapshot.logical_characters, 41);
        assert_eq!(snapshot.provider_attempts, 0);
        assert_eq!(snapshot.provider_characters, 0);
        assert_eq!(snapshot.fallback_transitions, 3);
        assert_eq!(snapshot.pending_attempts, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn partial_tail_is_separated_compacted_and_remains_visibly_degraded() {
        let path = test_path("partial-tail");
        let mut first = event(
            now_ms(),
            "hume",
            "octave",
            VoiceUsageKind::Success,
            11,
            None,
        );
        first.request_id = "complete-before-partial".to_string();
        append_event_to_with_threshold(&path, &first, u64::MAX).expect("append first event");
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("open ledger tail");
            file.write_all(b"{\"partial\"")
                .expect("append partial record");
            file.flush().expect("flush partial record");
        }
        let mut second = first.clone();
        second.timestamp_ms += 1;
        second.request_id = "complete-after-partial".to_string();
        let outcome =
            append_event_to_with_threshold(&path, &second, 1).expect("valid event remains durable");
        assert!(outcome.maintenance_error.is_none());

        let snapshot = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(snapshot.logical_requests, 2);
        assert_eq!(snapshot.successes, 2);
        assert_eq!(snapshot.malformed_lines, 1);
        assert_eq!(snapshot.ledger_status, "degraded");
        let raw = std::fs::read_to_string(&path).expect("read compacted ledger");
        assert!(raw.contains(CHECKPOINT_RECORD_TYPE));
        assert!(!raw.contains("{\"partial\""));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn prior_session_orphans_are_bounded_without_retaining_dead_request_ids() {
        let path = test_path("prior-session-orphan");
        let old = now_ms().saturating_sub(RECENT_WINDOW_MS + 10_000);
        for index in 0..128 {
            let mut orphan = event(
                old.saturating_add(index),
                "elevenlabs",
                "eleven_turbo_v2_5",
                VoiceUsageKind::Attempt,
                27,
                None,
            );
            orphan.session_id = format!("prior-session-{index}");
            orphan.request_id = format!("prior-orphan-{index}");
            append_event_to_with_threshold(&path, &orphan, 1).expect("append old orphan");
        }
        let pending = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(pending.logical_requests, 128);
        assert_eq!(pending.provider_attempts, 128);
        assert_eq!(pending.pending_attempts, 128);
        let read = read_events_from(&path);
        assert!(read.checkpoint.pending_requests.is_empty());
        assert!(read.events.is_empty());
        let raw = std::fs::read_to_string(&path).expect("read checkpoint");
        assert_eq!(raw.lines().count(), 1);
        assert!(raw.len() < 4_096, "dead request IDs leaked into checkpoint");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_current_session_identity_is_retained_only_until_result_arrives() {
        let path = test_path("current-session-stale");
        let mut attempt = event(
            now_ms().saturating_sub(RECENT_WINDOW_MS + STALE_PENDING_MS + 1),
            "groq",
            "canopylabs/orpheus-v1-english",
            VoiceUsageKind::Attempt,
            23,
            None,
        );
        attempt.request_id = format!("tts-{}-1", voice_session_id());
        append_event_to_with_threshold(&path, &attempt, 1).expect("append stale attempt");
        let read = read_events_from(&path);
        assert!(read.checkpoint.pending_requests.is_empty());
        assert_eq!(
            read.checkpoint
                .compacted_request_sequences
                .get(voice_session_id()),
            Some(&1)
        );
        assert!(read.events.is_empty());

        let mut success = attempt.clone();
        success.timestamp_ms = now_ms();
        success.event = VoiceUsageKind::Success;
        append_event_to_with_threshold(&path, &success, 1).expect("append late result");
        let read = read_events_from(&path);
        assert!(read.checkpoint.pending_requests.is_empty());
        let complete = snapshot_from_read(read, 0, 0);
        assert_eq!(complete.logical_requests, 1);
        assert_eq!(complete.logical_characters, 23);
        assert_eq!(complete.provider_attempts, 1);
        assert_eq!(complete.successes, 1);
        assert_eq!(complete.pending_attempts, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn compaction_never_advances_past_a_live_lower_sequence_hole() {
        let path = test_path("out-of-order-sequence-hole");
        let compacted_at_ms = STALE_PENDING_MS + 10_000;
        let mut lower_live = event(
            compacted_at_ms,
            "elevenlabs",
            "eleven_turbo_v2_5",
            VoiceUsageKind::Attempt,
            11,
            None,
        );
        lower_live.request_id = format!("tts-{}-1", voice_session_id());
        let mut higher_stale = event(1, "hume", "octave", VoiceUsageKind::Attempt, 17, None);
        higher_stale.request_id = format!("tts-{}-2", voice_session_id());

        append_event_to_with_threshold(&path, &lower_live, u64::MAX)
            .expect("append lower live request");
        append_event_to_with_threshold(&path, &higher_stale, u64::MAX)
            .expect("append higher stale request");
        compact_ledger_unlocked_at(&path, compacted_at_ms).expect("compact around live lower hole");

        let read = read_events_from(&path);
        assert!(read
            .checkpoint
            .compacted_request_sequences
            .get(voice_session_id())
            .is_none());
        assert_eq!(
            read.events.len(),
            2,
            "higher stale request must remain behind lower live hole"
        );
        let pending = snapshot_from_read(read, 0, 0);
        assert_eq!(pending.logical_requests, 2);
        assert_eq!(pending.logical_characters, 28);
        assert_eq!(pending.provider_attempts, 2);
        assert_eq!(pending.pending_attempts, 2);

        let mut lower_success = lower_live.clone();
        lower_success.timestamp_ms = compacted_at_ms + 1;
        lower_success.event = VoiceUsageKind::Success;
        append_event_to_with_threshold(&path, &lower_success, u64::MAX)
            .expect("append lower success");
        let aged_at_ms = compacted_at_ms + RECENT_WINDOW_MS + 2;
        compact_ledger_unlocked_at(&path, aged_at_ms)
            .expect("compact closed sequence prefix");

        let read = read_events_from(&path);
        assert_eq!(
            read.checkpoint
                .compacted_request_sequences
                .get(voice_session_id()),
            Some(&2)
        );
        assert!(read.events.is_empty());
        let complete = snapshot_from_read(read, 0, 0);
        assert_eq!(complete.logical_requests, 2);
        assert_eq!(complete.logical_characters, 28);
        assert_eq!(complete.provider_attempts, 2);
        assert_eq!(complete.successes, 1);
        assert_eq!(complete.pending_attempts, 1);

        let mut higher_success = higher_stale.clone();
        higher_success.timestamp_ms = compacted_at_ms + 2;
        higher_success.event = VoiceUsageKind::Success;
        append_event_to_with_threshold(&path, &higher_success, u64::MAX)
            .expect("append higher late success");
        compact_ledger_unlocked_at(&path, compacted_at_ms + 2).expect("compact late higher result");
        let settled = snapshot_from_read(read_events_from(&path), 0, 0);
        assert_eq!(settled.logical_requests, 2);
        assert_eq!(settled.logical_characters, 28);
        assert_eq!(settled.provider_attempts, 2);
        assert_eq!(settled.successes, 2);
        assert_eq!(settled.pending_attempts, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn same_session_orphan_churn_compacts_to_one_sequence_watermark() {
        let path = test_path("same-session-orphan-churn");
        let base = now_ms().saturating_sub(RECENT_WINDOW_MS + STALE_PENDING_MS + 10_000);
        for sequence in 1..=256u64 {
            let mut orphan = event(
                base.saturating_add(sequence),
                "elevenlabs",
                "eleven_turbo_v2_5",
                VoiceUsageKind::Attempt,
                17,
                None,
            );
            orphan.request_id = format!("tts-{}-{sequence}", voice_session_id());
            append_event_to_with_threshold(&path, &orphan, 1)
                .expect("append current-session orphan");
        }
        let read = read_events_from(&path);
        assert!(read.events.is_empty());
        assert!(read.checkpoint.pending_requests.is_empty());
        assert_eq!(read.checkpoint.compacted_request_sequences.len(), 1);
        assert_eq!(
            read.checkpoint
                .compacted_request_sequences
                .get(voice_session_id()),
            Some(&256)
        );
        let snapshot = snapshot_from_read(read, 0, 0);
        assert_eq!(snapshot.logical_requests, 256);
        assert_eq!(snapshot.provider_attempts, 256);
        assert_eq!(snapshot.pending_attempts, 256);
        assert_eq!(snapshot.logical_characters, 256 * 17);
        let raw = std::fs::read_to_string(&path).expect("read bounded checkpoint");
        assert_eq!(raw.lines().count(), 1);
        assert!(
            raw.len() < 4_096,
            "same-session orphan IDs leaked into checkpoint"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_compaction_is_classified_after_the_event_is_durable() {
        let path = test_path("maintenance-stage");
        let item = event(now_ms(), "hume", "octave", VoiceUsageKind::Success, 9, None);
        append_event_to_with_threshold(&path, &item, u64::MAX).expect("durable append");
        let maintenance =
            maintenance_after_append(&path, 1, |_| Err("forced compaction failure".to_string()));
        assert_eq!(maintenance.as_deref(), Some("forced compaction failure"));
        let read = read_events_from(&path);
        assert_eq!(read.events, vec![item]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persistence_health_survives_reload_and_never_auto_clears() {
        let mut path = test_path("health");
        path.set_extension("json");
        let first = record_health_failure_to(&path, HealthFailureKind::Write)
            .expect("persist write failure");
        assert_eq!(first.write_failure_count, 1);
        let second = record_health_failure_to(&path, HealthFailureKind::Maintenance)
            .expect("persist maintenance failure");
        assert_eq!(second.failure_count, 2);
        let health = read_health_from(&path);
        assert!(health.degraded);
        assert_eq!(health.failure_count, 2);
        assert_eq!(health.write_failure_count, 1);
        assert_eq!(health.maintenance_failure_count, 1);
        assert_eq!(health.last_failure_kind, "ledger_maintenance_failed");
        assert!(health.last_failure_ms > 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn health_helper_reports_when_sidecar_cannot_be_persisted() {
        let blocker = test_path("health-blocker");
        std::fs::write(&blocker, b"not-a-directory").expect("write blocker file");
        let impossible = blocker.join("voice-usage-health.json");
        assert!(record_health_failure_to(&impossible, HealthFailureKind::Write).is_err());
        let _ = std::fs::remove_file(blocker);
    }
}
