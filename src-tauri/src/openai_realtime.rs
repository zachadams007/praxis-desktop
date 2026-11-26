//! OpenAI GPT-Realtime-2 speech-to-speech transport - Rust side.
//!
//! The webview's `RealtimeTransport` (src/voice/realtimeTransport.ts) needs three
//! things from Rust, and NONE of them ever expose the raw vault key to the webview:
//!
//!   1. **`mint_realtime_session`** - reads `OPENAI_API_KEY` from the vault and calls
//!      OpenAI's `POST /v1/realtime/client_secrets` to mint a SHORT-LIVED ephemeral
//!      client secret (`ek_…`) bound to a `gpt-realtime-2` session (server VAD, low
//!      reasoning effort, voice `cedar`). Only the ephemeral token + session params
//!      go back to the webview - the webview POSTs its own SDP offer to
//!      `/v1/realtime/calls` with that ephemeral token as Bearer.
//!
//!   2. **`realtime_ready`** - reports whether the transport can run: the key is
//!      present in the vault AND cumulative OpenAI spend (from the usage ledger) is
//!      under the hard cap. Never returns the key, only a boolean + the reason.
//!
//! Live-verified against OpenAI's docs 2026-07-02: endpoint URLs, session-create body
//! shape, model id `gpt-realtime-2`, voice `cedar`, and the rate card below all
//! confirmed with a real HTTP 200 smoke test (no audio → no meaningful spend).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// ── Config surface (consts so the fleet-UI lane can expose them later) ───────

/// The realtime model. `gpt-realtime-2` = first voice model with GPT-5-class reasoning;
/// speech-to-speech over WebRTC. Verified accepted by the API 2026-07-02. Frontier Realtime
/// model. Bumped 2026-09-15 from `gpt-realtime-2` after verifying `/v1/realtime/client_secrets`
/// mints 200 for it on the owner's key. If a session ever fails to acknowledge the config below, drop
/// back to "gpt-realtime-2" - the client validates the session ack field by field and ends the
/// session on a mismatch.
pub const REALTIME_MODEL: &str = "gpt-realtime-2.1";

/// Voice. `cedar` is OpenAI's warm mid-range MALE voice (shipped alongside `marin`,
/// the female counterpart) - the natural male-neutral pick for a Jarvis feel.
/// Transcription model for the USER side of a Realtime conversation. Cheap,
/// fast, and the only way the spoken half of a turn reaches the Atlas chat.
/// The FULL transcription model, not the mini.
///
/// Verified present on his own /v1/models listing 2026-09-11, alongside gpt-4o-mini-transcribe.
///
/// Deliberately NOT `gpt-transcribe` or `gpt-live-transcribe`, which are also on
/// the listing: `gpt-4o-transcribe` is the documented option for the Realtime
/// API's input_audio_transcription, and a model the session silently refuses means
/// NO transcripts at all - a failure this app has already shipped once.
const REALTIME_TRANSCRIBE_MODEL: &str = "gpt-4o-transcribe";
pub const REALTIME_VOICE: &str = "cedar";

/// Reasoning effort. `low` is OpenAI's default and the right latency/quality balance
/// for a live voice agent (minimal < low < medium < high < xhigh).
pub const REALTIME_REASONING_EFFORT: &str = "low";

/// Vault file that holds `OPENAI_API_KEY=<value>` - the SAME file hermes_bridge and
/// usage read from (one key per line, `#` comments allowed).
const SECRETS_PATH: &str = r"C:\Users\dev\.praxis\praxis-secrets.env";

/// OpenAI endpoints (verified live 2026-07-02).
const CLIENT_SECRETS_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";

/// Source key under which realtime spend is recorded in the usage ledger.
pub const USAGE_SOURCE: &str = "openai";

// ── Spend guard ──────────────────────────────────────────────────────────────
//
// THE OLD GUARD SWITCHED REALTIME OFF FOR GOOD.
//
// The wallet belongs to OpenAI: when the credit is gone, the mint is refused and
// that refusal is shown in plain words. What Praxis still needs is a RUNAWAY brake
// (a noisy room answering itself all afternoon), so the local cap is a rolling
// 24-hour budget that recovers on its own instead of a lifetime latch.
pub const REALTIME_DAILY_CAP_USD: f64 = 3.00;
/// Room required before one bounded Realtime response may start.
pub const REALTIME_RESPONSE_HEADROOM_USD: f64 = 0.25;
const REALTIME_BUDGET_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
/// 1024, not 512: gpt-realtime-2.1 reasons before it acts, and reasoning counts against this
/// cap. A multi-field job ("compose an email to X, subject Y, body Z") must be able to plan and
/// emit its next tool call without the response being cut off mid-chain (2026-09-24: the chain
/// stopped after the recipient).
pub const REALTIME_MAX_OUTPUT_TOKENS: u64 = 1024;
pub const REALTIME_POST_INSTRUCTION_TOKENS: u64 = 4_000;
static ACCOUNTING_SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ACCOUNTING_MARKER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RealtimeAccountingReservation {
    schema_version: u8,
    accounting_session_id: String,
    created_ms: u64,
}

struct AccountingReservationGuard {
    path: PathBuf,
    accounting_session_id: String,
    keep: bool,
}

impl AccountingReservationGuard {
    fn new(path: PathBuf, accounting_session_id: String) -> Self {
        Self {
            path,
            accounting_session_id,
            keep: false,
        }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for AccountingReservationGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = release_accounting_session_from(&self.path, &self.accounting_session_id);
        }
    }
}

fn realtime_accounting_path() -> Result<PathBuf, String> {
    crate::praxis_dir()
        .map(|dir| dir.join("realtime-accounting-session.json"))
        .ok_or_else(|| "realtime-accounting-path-unavailable".to_string())
}

fn accounting_marker_lock() -> &'static Mutex<()> {
    ACCOUNTING_MARKER_LOCK.get_or_init(|| Mutex::new(()))
}

fn read_accounting_reservation_from_unlocked(
    path: &Path,
) -> Result<Option<RealtimeAccountingReservation>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("realtime-accounting-marker-unreadable".to_string()),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "realtime-accounting-marker-invalid".to_string())
}

fn read_accounting_reservation_from(
    path: &Path,
) -> Result<Option<RealtimeAccountingReservation>, String> {
    let _guard = accounting_marker_lock()
        .lock()
        .map_err(|_| "realtime-accounting-lock-poisoned".to_string())?;
    read_accounting_reservation_from_unlocked(path)
}

fn reserve_accounting_session_to(path: &Path, accounting_session_id: &str) -> Result<(), String> {
    let _guard = accounting_marker_lock()
        .lock()
        .map_err(|_| "realtime-accounting-lock-poisoned".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "realtime-accounting-parent-missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "realtime-accounting-mkdir-failed".to_string())?;
    let reservation = RealtimeAccountingReservation {
        schema_version: 1,
        accounting_session_id: accounting_session_id.to_string(),
        created_ms: now_ms(),
    };
    let bytes = serde_json::to_vec_pretty(&reservation)
        .map_err(|_| "realtime-accounting-marker-serialize-failed".to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "realtime-accounting-session-already-active".to_string()
            } else {
                "realtime-accounting-marker-open-failed".to_string()
            }
        })?;
    file.write_all(&bytes)
        .map_err(|_| "realtime-accounting-marker-write-failed".to_string())?;
    file.flush()
        .map_err(|_| "realtime-accounting-marker-flush-failed".to_string())?;
    file.sync_all()
        .map_err(|_| "realtime-accounting-marker-sync-failed".to_string())
}

fn release_accounting_session_from(path: &Path, accounting_session_id: &str) -> Result<(), String> {
    release_accounting_session_from_with_hook(path, accounting_session_id, || {})
}

fn release_accounting_session_from_with_hook(
    path: &Path,
    accounting_session_id: &str,
    before_remove: impl FnOnce(),
) -> Result<(), String> {
    let _guard = accounting_marker_lock()
        .lock()
        .map_err(|_| "realtime-accounting-lock-poisoned".to_string())?;
    let Some(reservation) = read_accounting_reservation_from_unlocked(path)? else {
        return Ok(());
    };
    if reservation.accounting_session_id != accounting_session_id {
        return Err("realtime-accounting-session-mismatch".to_string());
    }
    before_remove();
    std::fs::remove_file(path).map_err(|_| "realtime-accounting-marker-remove-failed".to_string())
}

/// Reconcile an accounting marker left behind by a process that is GONE.
///
/// The marker exists so a crash mid-session cannot silently drop realtime spend.
/// But nothing ever cleaned it up: if Praxis was killed, force-quit, or crashed
/// while a realtime session was open, the marker survived and `realtime_ready`
/// latched OFF **permanently** - "a prior OpenAI realtime session has
/// unreconciled usage". Atlas then fell back to the local STT lane forever, with
/// no way for the owner to clear it and no visible explanation. That is exactly the
/// state this machine was found in (marker from pid 55248, long dead).
///
/// A marker found during STARTUP is orphaned by definition: this is a fresh
/// process, so whatever wrote it is no longer running. The spend it guarded can
/// never be reported now, so holding the feature hostage protects nothing.
///
/// It does NOT invent a cost for the lost session. An earlier attempt charged a
/// flat estimate here and that was wrong twice over: it fabricates a number this
/// codebase is not allowed to fabricate, and `record_cost` bumps the accumulator
/// WITHOUT appending a ledger line - which broke the accumulator<=ledger
/// invariant and tripped `usage-ledger-cost-below-accumulator`, disabling
/// realtime through a different door. The marker's job is to prevent
/// double-counting a session, not to bill for one.
///
/// Returns the id it reconciled, if any (for the boot log and tests).
pub fn reconcile_orphaned_accounting_marker() -> Option<String> {
    let path = realtime_accounting_path().ok()?;
    let reservation = read_accounting_reservation_from(&path).ok()??;
    let id = reservation.accounting_session_id.clone();
    match release_accounting_session_from(&path, &id) {
        Ok(()) => {
            crate::dlog!("[realtime] reconciled orphaned accounting marker {id}; realtime re-enabled");
            Some(id)
        }
        Err(e) => {
            crate::elog!("[realtime] could not reconcile orphaned marker {id}: {e}");
            None
        }
    }
}

fn accounting_session_id() -> String {
    let sequence = ACCOUNTING_SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("rt-{:x}-{}-{sequence}", now_ms(), std::process::id())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// ── Live gpt-realtime-2 rate card (USD per 1,000,000 tokens) ─────────────────
// Verified 2026-07-02 against OpenAI pricing. Audio dominates cost; text is a
// rounding error but priced correctly anyway. Cached audio input is 98.75% off.
const PRICE_AUDIO_IN_PER_M: f64 = 32.0;
const PRICE_CACHED_INPUT_PER_M: f64 = 0.40;
const PRICE_AUDIO_OUT_PER_M: f64 = 64.0;
const PRICE_TEXT_IN_PER_M: f64 = 4.0;
const PRICE_IMAGE_IN_PER_M: f64 = 5.0;
const PRICE_TEXT_OUT_PER_M: f64 = 24.0;

// ── Vault helper (mirrors usage.rs / hermes_bridge.rs read_vault_key) ────────

/// Read a `KEY=value` line from the vault `.env`. `None` if the file is missing or
/// the key isn't present. Never panics, never logs the value.
pub(crate) fn read_vault_key(key: &str) -> Option<String> {
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

// ── 1. Mint an ephemeral client secret ───────────────────────────────────────

/// What the webview needs to open its WebRTC peer connection. Only ephemeral,
/// short-lived material crosses this boundary - never the raw account key.
#[derive(Serialize)]
pub struct RealtimeSession {
    /// Ephemeral client secret (`ek_…`). Bearer token for the SDP POST to
    /// `/v1/realtime/calls`. Expires in ~1 minute - mint fresh per connection.
    pub client_secret: String,
    /// Unix seconds when `client_secret` expires.
    pub expires_at: u64,
    /// The model the session was created with (echoed for the UI tag).
    pub model: String,
    /// The voice the session was created with (echoed for the UI tag).
    pub voice: String,
    /// The realtime calls endpoint the webview should POST its SDP offer to.
    pub calls_url: String,
    /// Opaque identifier for the durable accounting reservation. The webview
    /// must return it only after every started response has been recorded.
    pub accounting_session_id: String,
    pub max_output_tokens: u64,
    pub post_instruction_tokens: u64,
    pub reasoning_effort: String,
}

/// Mint an ephemeral realtime client secret for `gpt-realtime-2`.
///
/// Reads the vault key server-side, POSTs to `/v1/realtime/client_secrets` with the session
/// config (server VAD so barge-in is native, low reasoning effort, `cedar` voice), and returns
/// ONLY the ephemeral token + params.
#[tauri::command]
pub async fn mint_realtime_session() -> Result<RealtimeSession, String> {
    let accounting_path = realtime_accounting_path()?;
    ensure_realtime_response_headroom()?;
    let api_key = read_vault_key("OPENAI_API_KEY")
        .ok_or_else(|| "OPENAI_API_KEY is not in the Praxis vault.".to_string())?;
    let accounting_session_id = accounting_session_id();
    reserve_accounting_session_to(&accounting_path, &accounting_session_id).map_err(|_| {
        "A prior OpenAI realtime session has unreconciled usage; using the local voice until its accounting marker is repaired."
            .to_string()
    })?;
    let mut accounting_guard =
        AccountingReservationGuard::new(accounting_path.clone(), accounting_session_id.clone());

    // Session config: server VAD (native turn-taking + barge-in), low reasoning
    // effort for latency, cedar voice. The heavy, STABLE system prompt is applied
    // by the webview via session.update AFTER connect (kept out of the mint body so
    // this request stays tiny and the prompt is versioned in one place, TS-side).
    // GA /v1/realtime/client_secrets shape (2026): turn_detection nests under
    // audio.input. We intentionally apply the stable system prompt and reasoning
    // effort together in the acknowledged TS session.update after WebRTC connects.
    let body = json!({
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "max_output_tokens": REALTIME_MAX_OUTPUT_TOKENS,
            "truncation": {
                "type": "retention_ratio",
                "retention_ratio": 0.8,
                "token_limits": { "post_instructions": REALTIME_POST_INSTRUCTION_TOKENS }
            },
            "audio": {
                "input": {
                    // Transcribe what the owner SAYS. Transcribe what the owner SAYS, IN ENGLISH.
                    //
                    // The language pin is not a nicety. Codex's live audit sat in silence for
                    // two minutes on 2026-09-09 and Atlas produced six invented transcripts in
                    // FIVE languages - Mandarin, Japanese, Russian, Turkish and English - and
                    // then answered them.
                    //
                    // Whisper-family models hallucinate stock phrases on silence,
                    // and an unpinned language lets them wander across the whole
                    // multilingual prior - which is exactly the shape of those six.
                    // Pinning to English cannot stop hallucination outright, but it
                    // removes the entire non-English space it was drawing from.
                    "transcription": {
                        "model": REALTIME_TRANSCRIBE_MODEL,
                        "language": "en"
                    },
                    // Suppress the room before it ever reaches the recognizer. The
                    // audit could not separate "ASR invented this" from "ambient
                    // bleed was transcribed"; near-field is correct for a desktop
                    // mic at arm's length and helps either way.
                    "noise_reduction": { "type": "near_field" },
                    "turn_detection": {
                        "type": "server_vad",
                        // Must match src/voice/realtimeTransport.ts exactly - the
                        // client validates the session acknowledgement field by
                        // field and ends the session on a mismatch. See the note
                        // there for why these two numbers are what they are.
                        "threshold": 0.62,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 700,
                        // Letting the server auto-respond would bypass that gate. This is NOT
                        // what made the mic feel push-to-talk.
                        "create_response": false,
                        "interrupt_response": true
                    }
                },
                "output": { "voice": REALTIME_VOICE }
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;

    let resp = client
        .post(CLIENT_SECRETS_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        // Bind a stable safety identifier server-side; the browser needn't send it.
        .header("OpenAI-Safety-Identifier", "praxis-desktop")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("realtime mint request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("realtime mint response read failed: {e}"))?;

    if !status.is_success() {
        // Say so in words instead of a bare status, so it can never be mistaken for a Praxis
        // bug.
        //
        // Persist it too. Before this, the refusal lived only in this error string and
        // a 5-minute in-memory TTL in realtimeTransport.ts, so the Command Center went
        // on drawing a spend bar as though the account were fine. Now the rail can
        // report what was actually measured, and `clear_openai_credit_block()` below
        // retires it the moment a mint succeeds.
        if crate::openai_credit::is_credit_refusal(status.as_u16(), &text) {
            crate::openai_credit::record_openai_credit_refusal("realtime mint");
            return Err(
                "OpenAI API credit is used up - add credit at platform.openai.com (Billing), then press the chord again."
                    .to_string(),
            );
        }
        // Surface the HTTP status but NOT any echoed key material.
        return Err(format!(
            "OpenAI returned HTTP {status} minting a realtime session."
        ));
    }

    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("realtime mint response parse failed: {e}"))?;

    // Response shape (verified): { "value": "ek_…", "expires_at": <secs>, "session": {…} }
    let client_secret = v
        .get("value")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "realtime mint response had no ephemeral value".to_string())?
        .to_string();
    let expires_at = v.get("expires_at").and_then(|x| x.as_u64()).unwrap_or(0);
    let model = v
        .get("session")
        .and_then(|s| s.get("model"))
        .and_then(|x| x.as_str())
        .unwrap_or(REALTIME_MODEL)
        .to_string();
    // OpenAI just took a paid request from this key, so any recorded "no credit" is
    // demonstrably stale. Success is proof - this is what makes adding credit take
    // effect on the very next chord press with no restart.
    crate::openai_credit::clear_openai_credit_block();

    // Spend or persistence health may change while minting. Re-check before the
    // ephemeral secret can leave Rust, then transfer reservation ownership.
    ensure_realtime_response_headroom()?;
    accounting_guard.keep();

    Ok(RealtimeSession {
        client_secret,
        expires_at,
        model,
        voice: REALTIME_VOICE.to_string(),
        calls_url: "https://api.openai.com/v1/realtime/calls".to_string(),
        accounting_session_id,
        max_output_tokens: REALTIME_MAX_OUTPUT_TOKENS,
        post_instruction_tokens: REALTIME_POST_INSTRUCTION_TOKENS,
        reasoning_effort: REALTIME_REASONING_EFFORT.to_string(),
    })
}


/// What the webview's `realtimeAvailable()` needs, without ever seeing the key.
#[derive(Serialize)]
pub struct RealtimeReady {
    /// True when the transport may be used (key present AND under the cap).
    pub ready: bool,
    /// True when a key is present in the vault (independent of the cap).
    pub has_key: bool,
    /// Cumulative OpenAI spend so far, USD (from the usage ledger).
    pub spent_usd: f64,
    /// The hard cap, USD.
    pub cap_usd: f64,
    /// Human-readable reason when `ready == false` (empty when ready).
    pub reason: String,
}

/// Report realtime availability. Never returns key material.
///
/// Async on purpose. It decrypts the DPAPI vault and scans the usage ledger, and a
/// synchronous Tauri command runs on the UI thread - the same thread that sat
/// starved at `Responding=False` on 2026-09-15. Every Ctrl+T asks this first now,
/// so it must never be the thing that makes the whole app wait.
#[tauri::command]
pub async fn realtime_ready() -> RealtimeReady {
    tauri::async_runtime::spawn_blocking(realtime_ready_now)
        .await
        .unwrap_or_else(|error| RealtimeReady {
            ready: false,
            has_key: false,
            spent_usd: 0.0,
            cap_usd: REALTIME_DAILY_CAP_USD,
            reason: format!("Realtime check failed: {error}"),
        })
}

fn realtime_ready_now() -> RealtimeReady {
    let has_key = read_vault_key("OPENAI_API_KEY").is_some();
    let accounting_clear = matches!(
        realtime_accounting_path().and_then(|path| read_accounting_reservation_from(&path)),
        Ok(None)
    );
    let spend_result = recent_openai_spend();
    let ledger_ok = spend_result.is_ok();
    let spent = spend_result.unwrap_or(0.0);
    let has_response_headroom =
        ledger_ok && spent + REALTIME_RESPONSE_HEADROOM_USD <= REALTIME_DAILY_CAP_USD;
    // OpenAI itself refused a paid call recently. Reporting `ready` here would send
    // Ctrl+T into a mint that is already known to fail, and Atlas would answer with an
    // error instead of a voice. This gate is deliberately time-boxed inside
    // `blocks_paid_calls()` (5 minutes): past that it reopens so the next chord press
    // genuinely re-tries the account, which is the only way a refill gets discovered.
    let credit_refused = crate::openai_credit::blocks_paid_calls();
    let ready = has_key && accounting_clear && ledger_ok && has_response_headroom && !credit_refused;
    let reason = if !has_key {
        "No OpenAI key in the vault — using the local voice stack.".to_string()
    } else if !accounting_clear {
        "A prior OpenAI realtime session has unreconciled usage; realtime is disabled to protect the spend cap."
            .to_string()
    } else if !ledger_ok {
        "OpenAI usage ledger unavailable; realtime is disabled to protect the spend cap."
            .to_string()
    } else if !has_response_headroom {
        format!("{} Using the local voice stack meanwhile.", over_daily_budget_reason(spent))
    } else if credit_refused {
        "OpenAI refused the last paid call for credit - speaking through ElevenLabs until a call succeeds."
            .to_string()
    } else {
        String::new()
    };
    RealtimeReady {
        ready,
        has_key,
        spent_usd: spent,
        cap_usd: REALTIME_DAILY_CAP_USD,
        reason,
    }
}

// ── 3. Record realtime usage (accurate pricing → shared ledger) ──────────────

/// The token breakdown the webview reads from OpenAI's `response.done` `usage`
/// object. Field names mirror the API (snake_case) so the webview can pass the
/// nested details straight through. All fields default to 0 so a partial usage
/// object (e.g. a text-only turn) still records cleanly.
#[derive(Deserialize, Default)]
pub struct RealtimeUsage {
    #[serde(default)]
    pub audio_input_tokens: u64,
    #[serde(default)]
    pub cached_audio_input_tokens: u64,
    #[serde(default)]
    pub cached_text_input_tokens: u64,
    #[serde(default)]
    pub text_input_tokens: u64,
    #[serde(default)]
    pub image_input_tokens: u64,
    #[serde(default)]
    pub audio_output_tokens: u64,
    #[serde(default)]
    pub text_output_tokens: u64,
}

/// Price a realtime usage breakdown with the live gpt-realtime-2 rate card.
/// Cached audio input is billed at the discounted rate; the remaining
/// (non-cached) audio input at the full rate.
fn price_usage(u: &RealtimeUsage) -> Result<f64, String> {
    if u.cached_audio_input_tokens > u.audio_input_tokens
        || u.cached_text_input_tokens > u.text_input_tokens
    {
        return Err("realtime-usage-cache-details-invalid".to_string());
    }
    let non_cached_audio_in = u
        .audio_input_tokens
        .saturating_sub(u.cached_audio_input_tokens);
    let non_cached_text_in = u
        .text_input_tokens
        .saturating_sub(u.cached_text_input_tokens);
    let per = |tokens: u64, rate_per_m: f64| (tokens as f64) * rate_per_m / 1_000_000.0;
    Ok(per(non_cached_audio_in, PRICE_AUDIO_IN_PER_M)
        + per(u.cached_audio_input_tokens, PRICE_CACHED_INPUT_PER_M)
        + per(non_cached_text_in, PRICE_TEXT_IN_PER_M)
        + per(u.cached_text_input_tokens, PRICE_CACHED_INPUT_PER_M)
        + per(u.image_input_tokens, PRICE_IMAGE_IN_PER_M)
        + per(u.audio_output_tokens, PRICE_AUDIO_OUT_PER_M)
        + per(u.text_output_tokens, PRICE_TEXT_OUT_PER_M))
}

/// Record one realtime turn's usage into the shared ledger via the existing
/// `record_usage` choke point (source `"openai"`, model `gpt-realtime-2`). Input =
/// audio+text+image in, output = audio+text out. Returns the newly-updated cumulative
/// OpenAI spend so the webview can immediately re-check the cap without a second call.
#[tauri::command]
pub fn record_realtime_usage(
    usage: RealtimeUsage,
    accounting_session_id: String,
) -> Result<f64, String> {
    let accounting_path = realtime_accounting_path()?;
    let _guard = accounting_marker_lock()
        .lock()
        .map_err(|_| "realtime-accounting-lock-poisoned".to_string())?;
    let reservation_matches = read_accounting_reservation_from_unlocked(&accounting_path)
        .map(|reservation| {
            reservation
                .map(|active| active.accounting_session_id == accounting_session_id)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let cost = price_usage(&usage)?;
    let input_tokens = usage
        .audio_input_tokens
        .saturating_add(usage.text_input_tokens)
        .saturating_add(usage.image_input_tokens);
    let output_tokens = usage
        .audio_output_tokens
        .saturating_add(usage.text_output_tokens);
    crate::usage::record_usage(
        USAGE_SOURCE,
        REALTIME_MODEL,
        input_tokens,
        output_tokens,
        cost,
    );
    if !reservation_matches {
        let _ = crate::usage::mark_usage_persistence_uncertain();
        return Err("realtime-accounting-session-mismatch".to_string());
    }
    // Same basis as realtime_ready's cap: the rolling 24-hour budget.
    recent_openai_spend()
}

/// A realtime response began but OpenAI did not provide trustworthy totals (or
/// the connection disappeared before they could be recorded). Persist a sticky
/// shared-ledger health marker so every later readiness check and mint fails
/// closed across app restarts instead of reopening an unmetered paid session.
#[tauri::command]
pub fn mark_realtime_usage_uncertain(accounting_session_id: String) -> Result<(), String> {
    let reservation_result =
        realtime_accounting_path().and_then(|path| read_accounting_reservation_from(&path));
    let persistence_result = crate::usage::mark_usage_persistence_uncertain();
    if let Some(reservation) = reservation_result? {
        if reservation.accounting_session_id != accounting_session_id {
            return Err("realtime-accounting-session-mismatch".to_string());
        }
    }
    persistence_result.map_err(|_| {
        "OpenAI realtime usage is uncertain; realtime remains disabled until usage persistence is repaired.".to_string()
    })
}

/// Release the durable reservation only after every response from this exact
/// session has been recorded. Missing is idempotent; a stale session ID cannot
/// clear a newer lease.
#[tauri::command]
pub fn close_realtime_accounting_session(accounting_session_id: String) -> Result<(), String> {
    release_accounting_session_from(&realtime_accounting_path()?, &accounting_session_id)
}

/// Authorize exactly one bounded response for the active lease. The webview
/// disables automatic VAD responses and calls this before every response.create,
/// so Realtime never begins another turn on stale spend or degraded persistence.
#[tauri::command]
pub fn authorize_realtime_response(accounting_session_id: String) -> Result<f64, String> {
    let reservation = read_accounting_reservation_from(&realtime_accounting_path()?)?
        .ok_or_else(|| "realtime-accounting-session-missing".to_string())?;
    if reservation.accounting_session_id != accounting_session_id {
        return Err("realtime-accounting-session-mismatch".to_string());
    }
    ensure_realtime_response_headroom()
}

// ── Cumulative OpenAI spend from the usage ledger ────────────────────────────

/// Sum `cost_usd` across every `usage.jsonl` line whose `tool == "openai"`. This is
/// the authoritative spend figure the guard uses. The shared usage module
/// serializes reads with writers and fails closed on malformed or degraded state;
/// only a genuinely missing ledger is treated as a fresh zero-spend install.
/// OpenAI spend recorded in the last 24 hours (the runaway-brake window).
fn recent_openai_spend() -> Result<f64, String> {
    crate::usage::usage_cost_in_window(USAGE_SOURCE, REALTIME_BUDGET_WINDOW_MS)
}

fn over_daily_budget_reason(spent: f64) -> String {
    format!(
        "Realtime used ${spent:.2} of its ${REALTIME_DAILY_CAP_USD:.2} daily budget - it frees up as the last 24 hours roll over."
    )
}

fn ensure_realtime_response_headroom() -> Result<f64, String> {
    let spent = recent_openai_spend().map_err(|_| {
        "OpenAI usage persistence is unavailable; Realtime is disabled until it is repaired."
            .to_string()
    })?;
    if spent + REALTIME_RESPONSE_HEADROOM_USD > REALTIME_DAILY_CAP_USD {
        return Err(over_daily_budget_reason(spent));
    }
    Ok(spent)
}

#[cfg(test)]
mod tests {

    /// A marker left by a dead process must NOT disable realtime forever. This is
    /// the bug that had Atlas silently running on the local voice stack: Praxis was
    /// killed mid-session, the marker survived, and realtime_ready latched off with
    /// no way to clear it.
    #[test]
    fn orphaned_marker_is_reconciled_and_cleared() {
        let dir = std::env::temp_dir().join("praxis-rt-orphan-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("realtime-accounting-session.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"accounting_session_id":"rt-dead-55248-1","created_ms":1}"#,
        )
        .unwrap();

        // Present before.
        assert!(matches!(read_accounting_reservation_from(&path), Ok(Some(_))));
        // Releasing by its own id clears it - the operation reconcile performs.
        release_accounting_session_from(&path, "rt-dead-55248-1").unwrap();
        assert!(
            matches!(read_accounting_reservation_from(&path), Ok(None)),
            "marker must be gone, or realtime stays latched off"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Releasing with the WRONG id must not clear a live session's marker.
    #[test]
    fn release_requires_the_matching_session_id() {
        let dir = std::env::temp_dir().join("praxis-rt-mismatch-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("realtime-accounting-session.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"accounting_session_id":"rt-live-1-1","created_ms":1}"#,
        )
        .unwrap();
        assert!(release_accounting_session_from(&path, "rt-other-2-1").is_err());
        assert!(matches!(read_accounting_reservation_from(&path), Ok(Some(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn accounting_test_path(name: &str) -> PathBuf {
        let sequence = ACCOUNTING_SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "praxis-realtime-accounting-{}-{sequence}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn accounting_reservation_is_exclusive_matched_and_idempotent() {
        let path = accounting_test_path("lifecycle");
        reserve_accounting_session_to(&path, "session-a").expect("reserve first session");
        let reservation = read_accounting_reservation_from(&path)
            .expect("read reservation")
            .expect("reservation exists");
        assert_eq!(reservation.accounting_session_id, "session-a");
        assert_eq!(
            reserve_accounting_session_to(&path, "session-b"),
            Err("realtime-accounting-session-already-active".to_string())
        );
        assert_eq!(
            release_accounting_session_from(&path, "session-b"),
            Err("realtime-accounting-session-mismatch".to_string())
        );
        assert!(path.exists());
        release_accounting_session_from(&path, "session-a").expect("release matching session");
        assert!(!path.exists());
        release_accounting_session_from(&path, "session-a").expect("missing release is idempotent");
    }

    #[test]
    fn corrupt_accounting_marker_fails_closed() {
        let path = accounting_test_path("corrupt");
        std::fs::write(&path, b"{partial").expect("write corrupt marker");
        assert_eq!(
            read_accounting_reservation_from(&path),
            Err("realtime-accounting-marker-invalid".to_string())
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn validated_close_blocks_duplicate_close_and_new_reserve_until_delete() {
        let path = accounting_test_path("concurrent-close");
        reserve_accounting_session_to(&path, "session-a").expect("reserve session a");

        let (validated_tx, validated_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let stale_path = path.clone();
        let stale = std::thread::spawn(move || {
            release_accounting_session_from_with_hook(&stale_path, "session-a", || {
                validated_tx.send(()).expect("signal validated");
                continue_rx.recv().expect("continue delete");
            })
        });
        validated_rx
            .recv()
            .expect("stale close reached validation window");

        let (close_started_tx, close_started_rx) = mpsc::channel();
        let (close_done_tx, close_done_rx) = mpsc::channel();
        let duplicate_path = path.clone();
        let duplicate = std::thread::spawn(move || {
            close_started_tx.send(()).expect("signal duplicate start");
            let result = release_accounting_session_from(&duplicate_path, "session-a");
            close_done_tx.send(result).expect("signal duplicate done");
        });
        close_started_rx.recv().expect("duplicate close started");

        let (reserve_started_tx, reserve_started_rx) = mpsc::channel();
        let (reserve_done_tx, reserve_done_rx) = mpsc::channel();
        let reserve_path = path.clone();
        let reserve = std::thread::spawn(move || {
            reserve_started_tx.send(()).expect("signal reserve start");
            let result = reserve_accounting_session_to(&reserve_path, "session-b");
            reserve_done_tx.send(result).expect("signal reserve done");
        });
        reserve_started_rx.recv().expect("new reserve started");

        assert!(close_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        assert!(reserve_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        continue_tx.send(()).expect("allow validated delete");

        stale
            .join()
            .expect("join stale close")
            .expect("stale close succeeds");
        let duplicate_result = close_done_rx.recv().expect("duplicate close result");
        let reserve_result = reserve_done_rx.recv().expect("new reserve result");
        duplicate.join().expect("join duplicate close");
        reserve.join().expect("join reserve");
        assert!(
            duplicate_result.is_ok()
                || duplicate_result == Err("realtime-accounting-session-mismatch".to_string())
        );
        reserve_result.expect("new session reserves after old close");
        let current = read_accounting_reservation_from(&path)
            .expect("read session b")
            .expect("session b remains");
        assert_eq!(current.accounting_session_id, "session-b");
        assert_eq!(
            release_accounting_session_from(&path, "session-a"),
            Err("realtime-accounting-session-mismatch".to_string())
        );
        release_accounting_session_from(&path, "session-b").expect("cleanup session b");
    }

    #[test]
    fn prices_audio_dominant_turn() {
        // A ~10s exchange: ~500 audio-in tokens (none cached), ~800 audio-out.
        let u = RealtimeUsage {
            audio_input_tokens: 500,
            cached_audio_input_tokens: 0,
            cached_text_input_tokens: 0,
            text_input_tokens: 0,
            image_input_tokens: 0,
            audio_output_tokens: 800,
            text_output_tokens: 0,
        };
        let cost = price_usage(&u).expect("valid usage");
        // 500 * 32/1e6 + 800 * 64/1e6 = 0.016 + 0.0512 = 0.0672
        assert!((cost - 0.0672).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn cached_audio_is_discounted() {
        // 1000 audio-in, 900 of them cached → 100 * 32 + 900 * 0.40 (per M).
        let u = RealtimeUsage {
            audio_input_tokens: 1000,
            cached_audio_input_tokens: 900,
            ..Default::default()
        };
        let cost = price_usage(&u).expect("valid usage");
        // (100*32 + 900*0.40)/1e6 = (3200 + 360)/1e6 = 0.00356
        assert!((cost - 0.00356).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn official_cached_text_and_audio_details_are_priced_by_modality() {
        let usage = RealtimeUsage {
            text_input_tokens: 119,
            cached_text_input_tokens: 64,
            audio_input_tokens: 13,
            cached_audio_input_tokens: 0,
            image_input_tokens: 0,
            text_output_tokens: 30,
            audio_output_tokens: 91,
        };
        let cost = price_usage(&usage).expect("official fixture is valid");
        let expected =
            (55.0 * 4.0 + 64.0 * 0.4 + 13.0 * 32.0 + 30.0 * 24.0 + 91.0 * 64.0) / 1_000_000.0;
        assert!((cost - expected).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn prices_image_input_and_reasoning_as_text_output() {
        let usage = RealtimeUsage {
            image_input_tokens: 1_000,
            text_output_tokens: 250,
            ..Default::default()
        };
        let cost = price_usage(&usage).expect("image/reasoning usage is valid");
        let expected = (1_000.0 * 5.0 + 250.0 * 24.0) / 1_000_000.0;
        assert!((cost - expected).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn impossible_cached_modality_totals_fail_closed() {
        let usage = RealtimeUsage {
            text_input_tokens: 5,
            cached_text_input_tokens: 6,
            ..Default::default()
        };
        assert_eq!(
            price_usage(&usage),
            Err("realtime-usage-cache-details-invalid".to_string())
        );
    }

    #[test]
    fn cap_is_a_single_const() {
        assert_eq!(REALTIME_DAILY_CAP_USD, 3.00);
        assert_eq!(REALTIME_RESPONSE_HEADROOM_USD, 0.25);
        assert_eq!(REALTIME_BUDGET_WINDOW_MS, 86_400_000);
        assert_eq!(REALTIME_MAX_OUTPUT_TOKENS, 1024);
        assert_eq!(REALTIME_POST_INSTRUCTION_TOKENS, 4_000);
    }

    #[test]
    fn the_budget_is_a_rolling_day_not_a_lifetime_latch() {
        // The brake now only ever looks at the last 24 hours, so old spend can never block it.
        assert!(over_daily_budget_reason(2.80).contains("$2.80 of its $3.00 daily budget"));
        assert!(0.0 + REALTIME_RESPONSE_HEADROOM_USD <= REALTIME_DAILY_CAP_USD);
    }
}
