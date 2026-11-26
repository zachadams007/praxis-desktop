//! Text-to-speech - Praxis's "Jarvis" voice.
//!
//! PRIMARY: Hume AI **Octave** TTS (`/v0/tts/file`) - a genuinely expressive, emotion-aware
//! voice. Default voice = "Fastidious Robo-Butler" (British, Received Pronunciation) - the
//! closest thing to Jarvis in Hume's library. Returns WAV bytes the WebView plays directly.
//!
//! FALLBACK: Groq (Orpheus, `canopylabs/orpheus-v1-english`, voice `daniel`) if Hume has no
//! key or errors. If BOTH fail, the frontend falls back to the browser's `speechSynthesis`,
//! so Praxis is never mute.
//!
//! KEYS (env first, then on-disk file in `%LOCALAPPDATA%\Praxis\`):
//!   Hume → `HUME_API_KEY` / `hume.key`   ·   Groq → `GROQ_API_KEY` / `groq.key`   ·
//!   ElevenLabs → `elevenlabs.key` (no env override - key-file only, mirrors hume.voice).
//!
//! VOICE PICKER (temporary CONTROLS-tab feature): `%LOCALAPPDATA%\Praxis\voice.profile`
//! selects between two Hume voice ids and an ElevenLabs custom voice. The profile, when
//! set, is AUTHORITATIVE over `hume.voice` (picker wins). See `voice_profile()`.

use crate::voice_usage::{FileVoiceUsageSink, VoiceUsageEvent, VoiceUsageKind, VoiceUsageSink};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;

// --- Hume (Octave) - primary ------------------------------------------------
const HUME_TTS_URL: &str = "https://api.hume.ai/v0/tts/file";
/// Override WITHOUT a rebuild via env `HUME_VOICE_ID` or the first line of
/// `%LOCALAPPDATA%\Praxis\hume.voice`. Deeper/British alternatives to try: Booming British
/// Narrator 84aaf67b-dcab-409d-9f48-8c4aa7abbb24 · Sir Spandrel
/// 921ece15-27c1-4028-b6ac-82d2d93f65c4 · Fastidious Robo-Butler (Jarvis-butler)
/// 661ab31e-c4d6-4a16-952a-b5806a9b4ad1 · Conversational English Guy
/// d1248151-8613-41c1-b524-4ce242b02090 · Male English Actor
/// 9e068547-5ba4-4c8e-8e03-69282a008f04.
const HUME_VOICE_DEFAULT: &str = "9c5a3d53-4a8c-4fa2-adad-8e61a830d0e8";

// --- Voice picker (temporary CONTROLS-tab feature) --------------------------
/// "Deep Male Conversational" - the current Hume default voice.
const HUME_VOICE_CONVERSATIONAL: &str = "9c5a3d53-4a8c-4fa2-adad-8e61a830d0e8";
/// "Classical Film Actor" - Hume's "Male English Actor".
const HUME_VOICE_ACTOR: &str = "9e068547-5ba4-4c8e-8e03-69282a008f04";
/// ElevenLabs voice (used only when the `elevenlabs` profile is active AND a key resolves).
/// "George" - British, warm storyteller: the most Jarvis-adjacent PREMADE voice, which matters
/// because premade voices work on the FREE tier. The old id (`wDsJlOXPqcvIUKdLXjDs`, a library
/// voice) 400s on free/starter accounts - "You need to be on the creator tier or above to use
/// this voice" (live-verified 2026-07-10) - which made the picker silently play Hume instead.
/// Swap WITHOUT a rebuild via the first line of `%LOCALAPPDATA%\Praxis\elevenlabs.voice`
/// (mirrors `hume.voice`) - e.g. to a premium id on a Creator account.
const ELEVENLABS_VOICE_DEFAULT: &str = "JBFqnCBsd6RMkjVDRZzb";

/// Resolve the active ElevenLabs voice id: `elevenlabs.voice` file → default (George).
fn elevenlabs_voice() -> String {
    if let Some(dir) = crate::praxis_dir() {
        if let Ok(s) = std::fs::read_to_string(dir.join("elevenlabs.voice")) {
            let v = s.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    ELEVENLABS_VOICE_DEFAULT.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE VOICE.
//
// The owner heard two different assistants: the live conversation spoke in OpenAI's
// Realtime voice, and every reply that went through this file (Hold-T, and the
// local lane a Realtime session falls back to) spoke in ElevenLabs' George. Realtime
// cannot use an ElevenLabs voice, so the only way to be one assistant is for this
// file to speak in the Realtime voice too. The `atlas` profile does that and is the
// default; the older picks stay available as deliberate choices.
// ─────────────────────────────────────────────────────────────────────────────
const VOICE_PROFILES: [&str; 4] = ["atlas", "hume-conversational", "hume-actor", "elevenlabs"];
const DEFAULT_VOICE_PROFILE: &str = "atlas";
/// Written once the stored profile has been moved onto `atlas`, so a later
/// deliberate re-pick in the Controls tab is respected rather than migrated again.
const ATLAS_PROFILE_MIGRATION_MARKER: &str = "voice.profile.atlas-v1";

/// Read the voice-profile file (`voice.profile`): "atlas" | "hume-conversational" |
/// "hume-actor" | "elevenlabs". Defaults to "atlas" when missing/empty/unrecognized.
#[tauri::command]
pub fn get_voice_profile() -> String {
    if let Some(dir) = crate::praxis_dir() {
        if !dir.join(ATLAS_PROFILE_MIGRATION_MARKER).exists() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("voice.profile"), DEFAULT_VOICE_PROFILE);
            let _ = std::fs::write(dir.join(ATLAS_PROFILE_MIGRATION_MARKER), "1");
            return DEFAULT_VOICE_PROFILE.to_string();
        }
        if let Ok(s) = std::fs::read_to_string(dir.join("voice.profile")) {
            let v = s.trim().to_string();
            if VOICE_PROFILES.contains(&v.as_str()) {
                return v;
            }
        }
    }
    DEFAULT_VOICE_PROFILE.to_string()
}

/// Write the voice-profile selection to disk so `speak_tts` picks it up on the next utterance.
#[tauri::command]
pub fn set_voice_profile(profile: String) -> Result<(), String> {
    let profile = profile.trim();
    if !VOICE_PROFILES.contains(&profile) {
        return Err(format!("unknown voice profile: {profile}"));
    }
    let dir = crate::praxis_dir().ok_or("no LOCALAPPDATA")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(dir.join("voice.profile"), profile).map_err(|e| format!("write: {e}"))?;
    // A pick made by hand is final: never migrate it away afterwards.
    let _ = std::fs::write(dir.join(ATLAS_PROFILE_MIGRATION_MARKER), "1");
    Ok(())
}

/// Resolve the ElevenLabs key: env → key file → secrets vault, the SAME three-step scheme as
/// `hume_key()`. The old key-file-only version was why "ElevenLabs" in the picker silently
/// played a Hume voice (the owner's 2026-07-10 catch): the key has lived in the vault since
/// 2026-07-05, but nothing ever read it from there.
fn elevenlabs_key() -> Option<String> {
    // 1. Env var.
    if let Ok(raw) = std::env::var("ELEVENLABS_API_KEY") {
        let k = crate::voice_stt::clean_key(&raw);
        if !k.is_empty() {
            return Some(k);
        }
    }
    // 2. Runtime key file: %LOCALAPPDATA%\Praxis\elevenlabs.key
    if let Some(dir) = crate::praxis_dir() {
        if let Ok(raw) = std::fs::read_to_string(dir.join("elevenlabs.key")) {
            let k = crate::voice_stt::clean_key(&raw);
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    // 3. Secrets vault (survives %LOCALAPPDATA% wipes - same rationale as hume_key).
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let vault = std::path::PathBuf::from(home)
            .join(".claude")
            .join("secrets")
            .join("praxis-secrets.env");
        if let Some(k) = crate::voice_stt::read_env_file(&vault, "ELEVENLABS_API_KEY") {
            return Some(k);
        }
    }
    None
}

/// Honest per-backend connectivity for the CONTROLS-tab voice picker: an option whose
/// backend has no key must read as disconnected instead of silently falling back to Hume.
#[derive(serde::Serialize)]
pub struct VoiceBackends {
    openai: bool,
    hume: bool,
    elevenlabs: bool,
    groq: bool,
}

#[tauri::command]
pub fn voice_backends() -> VoiceBackends {
    VoiceBackends {
        openai: openai_tts_key().is_some(),
        hume: hume_key().is_some(),
        elevenlabs: elevenlabs_key().is_some(),
        groq: crate::voice_stt::groq_key().is_some(),
    }
}

fn openai_tts_key() -> Option<String> {
    crate::openai_realtime::read_vault_key("OPENAI_API_KEY")
}

/// Resolve the active Hume voice id: voice-profile picker (authoritative when set to a Hume
/// option) → env `HUME_VOICE_ID` → `%LOCALAPPDATA%\Praxis\hume.voice` → default.
/// File/env override means swapping the voice needs NO rebuild - just drop a voice id in the file.
fn hume_voice() -> String {
    // The CONTROLS-tab picker wins over the raw hume.voice file so it's authoritative.
    match get_voice_profile().as_str() {
        "hume-conversational" => return HUME_VOICE_CONVERSATIONAL.to_string(),
        "hume-actor" => return HUME_VOICE_ACTOR.to_string(),
        _ => {}
    }
    if let Ok(v) = std::env::var("HUME_VOICE_ID") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(dir) = crate::praxis_dir() {
        if let Ok(s) = std::fs::read_to_string(dir.join("hume.voice")) {
            let v = s.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    HUME_VOICE_DEFAULT.to_string()
}

// --- Groq (Orpheus) - fallback ---------------------------------------------
const GROQ_TTS_URL: &str = "https://api.groq.com/openai/v1/audio/speech";
const TTS_MODEL: &str = "canopylabs/orpheus-v1-english";
/// Orpheus (Groq) English voices: autumn · diana · hannah · austin · daniel · troy.
const TTS_VOICE: &str = "daniel";
const ELEVENLABS_MODEL: &str = "eleven_turbo_v2_5";
const HUME_MODEL: &str = "octave";
const OPENAI_TTS_URL: &str = "https://api.openai.com/v1/audio/speech";
/// Verified live 2026-09-14: accepts the Realtime session's `cedar` voice (HTTP 200).
const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
const OPENAI_TTS_INSTRUCTIONS: &str =
    "You are Atlas, a calm, capable desktop assistant. Speak naturally and briskly, like the same voice in a live conversation.";
const TTS_HTTP_TIMEOUT_SECS: u64 = 30;
static TTS_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn tts_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(TTS_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|_| "network: client".to_string())
}

fn network_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("timeout {TTS_HTTP_TIMEOUT_SECS}s")
    } else if error.is_connect() {
        "network: connect".to_string()
    } else if error.is_request() {
        "network: request".to_string()
    } else if error.is_body() {
        "network: body".to_string()
    } else {
        "network: unknown".to_string()
    }
}

fn openai_error_code(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let code = parsed
        .get("error")?
        .get("code")?
        .as_str()?;
    let safe: String = code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        .take(64)
        .collect();
    (!safe.is_empty()).then_some(safe)
}

fn privacy_safe_reason(raw: &str) -> String {
    if raw == "credit refused"
        || raw == "no key"
        || raw.starts_with("http ")
        || raw.starts_with("timeout ")
        || raw.starts_with("network: ")
        || raw.starts_with("invalid response: ")
    {
        raw.to_string()
    } else {
        "network: unknown".to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TtsBackend {
    OpenAi,
    ElevenLabs,
    Hume,
    Groq,
}

impl TtsBackend {
    fn key(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::ElevenLabs => "elevenlabs",
            Self::Hume => "hume",
            Self::Groq => "groq",
        }
    }

    fn model(self) -> &'static str {
        match self {
            Self::OpenAi => OPENAI_TTS_MODEL,
            Self::ElevenLabs => ELEVENLABS_MODEL,
            Self::Hume => HUME_MODEL,
            Self::Groq => TTS_MODEL,
        }
    }
}

fn route_for_profile(profile: &str) -> &'static [TtsBackend] {
    // Atlas speaks in the Realtime voice first; the others only if OpenAI cannot answer.
    const ATLAS_ROUTE: &[TtsBackend] = &[
        TtsBackend::OpenAi,
        TtsBackend::ElevenLabs,
        TtsBackend::Hume,
        TtsBackend::Groq,
    ];
    const ELEVENLABS_ROUTE: &[TtsBackend] =
        &[TtsBackend::ElevenLabs, TtsBackend::Hume, TtsBackend::Groq];
    const HUME_ROUTE: &[TtsBackend] = &[TtsBackend::Hume, TtsBackend::Groq];
    match profile {
        "atlas" => ATLAS_ROUTE,
        "elevenlabs" => ELEVENLABS_ROUTE,
        _ => HUME_ROUTE,
    }
}

#[derive(serde::Serialize)]
struct OpenAiTtsReq<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'a str,
    instructions: &'a str,
}

/// Synthesize in the SAME voice the Realtime conversation uses. Returns MP3 bytes.
async fn speak_openai(text: &str) -> Result<Vec<u8>, String> {
    let key = openai_tts_key().ok_or("no-openai-key")?;
    let body = OpenAiTtsReq {
        model: OPENAI_TTS_MODEL,
        input: text,
        voice: crate::openai_realtime::REALTIME_VOICE,
        response_format: "mp3",
        instructions: OPENAI_TTS_INSTRUCTIONS,
    };
    let client = tts_http_client()?;
    let resp = client
        .post(OPENAI_TTS_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| network_reason(&error))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        // Read the body before discarding it: "openai-http-429" alone cannot tell an
        // empty wallet from a busy minute, and only the former should caption the rail.
        let body = resp.text().await.unwrap_or_default();
        if crate::openai_credit::is_credit_refusal(code, &body) {
            crate::openai_credit::record_openai_credit_refusal("tts");
            return Err("credit refused".to_string());
        }
        let detail = openai_error_code(&body)
            .map(|error_code| format!("http {code} {error_code}"))
            .unwrap_or_else(|| format!("http {code}"));
        return Err(detail);
    }
    // Paid call accepted: retire any recorded refusal. Success is proof.
    crate::openai_credit::clear_openai_credit_block();
    let bytes = resp.bytes().await.map_err(|error| network_reason(&error))?;
    Ok(bytes.to_vec())
}

/// Resolve the Hume key from env → on-disk key file → secrets vault .env.
///
/// Resolution order (most→least authoritative), mirroring `voice_stt::groq_key()` so BOTH
/// halves of the voice loop share one robust scheme:
///   1. Env `HUME_API_KEY` (dev shells / any parent process that loaded it).
///   2. `%LOCALAPPDATA%\Praxis\hume.key` - the runtime drop-in file (48 chars, no newline).
///   3. `%USERPROFILE%\.praxis\praxis-secrets.env` - the vault (LAST RESORT).
///
/// The vault fallback is the fix for a real, previously-silent failure: the installer/autostart
/// VBS have historically WIPED `%LOCALAPPDATA%\Praxis` state on reboot/ship (see project memory
/// "state-persistence-and-launch-fix"). When `hume.key` got wiped, Hume went mute while Groq - which
/// already had this vault fallback - kept working, so the Jarvis voice silently swapped backends
/// with no signal. Reading the vault here makes Hume resilient to the same wipe. Uses
/// `crate::voice_stt::clean_key` (strips BOM/CR/LF/whitespace) instead of a bare `.trim()`, so a
/// BOM-prefixed key file can't silently produce an invalid key.
pub(crate) fn hume_key() -> Option<String> {
    // 1. Env var.
    if let Ok(raw) = std::env::var("HUME_API_KEY") {
        let k = crate::voice_stt::clean_key(&raw);
        if !k.is_empty() {
            return Some(k);
        }
    }
    // 2. Runtime key file: %LOCALAPPDATA%\Praxis\hume.key
    if let Some(dir) = crate::praxis_dir() {
        if let Ok(raw) = std::fs::read_to_string(dir.join("hume.key")) {
            let k = crate::voice_stt::clean_key(&raw);
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    // 3. Secrets vault: %USERPROFILE%\.praxis\praxis-secrets.env (last resort - survives a
    //    key-file wipe so the installed app is never mysteriously mute on Hume).
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let vault = std::path::PathBuf::from(home)
            .join(".claude")
            .join("secrets")
            .join("praxis-secrets.env");
        if let Some(k) = crate::voice_stt::read_env_file(&vault, "HUME_API_KEY") {
            return Some(k);
        }
    }
    None
}

#[derive(serde::Serialize)]
struct HumeVoice<'a> {
    id: &'a str,
    provider: &'a str,
}
#[derive(serde::Serialize)]
struct HumeUtterance<'a> {
    text: &'a str,
    voice: HumeVoice<'a>,
    /// Playback speed multiplier (1.0 = normal). Hume Octave accepts ~0.5–2.0.
    speed: f32,
}
#[derive(serde::Serialize)]
struct HumeFormat<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}
#[derive(serde::Serialize)]
struct HumeReq<'a> {
    utterances: Vec<HumeUtterance<'a>>,
    format: HumeFormat<'a>,
}

/// Synthesize via Hume Octave. Returns WAV bytes or a short error string.
async fn speak_hume(text: &str) -> Result<Vec<u8>, String> {
    let key = hume_key().ok_or("no-hume-key")?;
    let voice = hume_voice();
    let body = HumeReq {
        utterances: vec![HumeUtterance {
            text,
            voice: HumeVoice {
                id: &voice,
                provider: "HUME_AI",
            },
            speed: 1.2,
        }],
        format: HumeFormat { kind: "wav" },
    };
    let client = tts_http_client()?;
    let resp = client
        .post(HUME_TTS_URL)
        .header("X-Hume-Api-Key", key)
        .json(&body)
        .send()
        .await
        .map_err(|error| network_reason(&error))?;
    if !resp.status().is_success() {
        let code = resp.status();
        return Err(format!("http {}", code.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|error| network_reason(&error))?;
    Ok(bytes.to_vec())
}

#[derive(serde::Serialize)]
struct TtsReq<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'a str,
}

/// Synthesize via Groq Orpheus (fallback). Returns WAV bytes or a short error string.
async fn speak_groq(text: &str) -> Result<Vec<u8>, String> {
    let key = crate::voice_stt::groq_key().ok_or("no-key")?;
    let body = TtsReq {
        model: TTS_MODEL,
        input: text,
        voice: TTS_VOICE,
        response_format: "wav",
    };
    let client = tts_http_client()?;
    let resp = client
        .post(GROQ_TTS_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| network_reason(&error))?;
    if !resp.status().is_success() {
        let code = resp.status();
        return Err(format!("http {}", code.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|error| network_reason(&error))?;
    Ok(bytes.to_vec())
}

#[derive(serde::Serialize)]
struct ElevenLabsReq<'a> {
    text: &'a str,
    model_id: &'a str,
}

/// Synthesize via ElevenLabs (voice picker's 3rd option). Returns MP3 bytes (`mp3_44100_128` -
/// the safest format for playback via an `<audio>` Blob) or a short error string. Any failure
/// here (no key file, network, non-2xx) is caught by the caller and falls through to Hume so
/// Praxis is never mute even when the ElevenLabs key hasn't been provisioned yet.
async fn speak_elevenlabs(text: &str) -> Result<Vec<u8>, String> {
    let key = elevenlabs_key().ok_or("no-elevenlabs-key")?;
    let body = ElevenLabsReq {
        text,
        model_id: ELEVENLABS_MODEL,
    };
    let client = tts_http_client()?;
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=mp3_44100_128",
        elevenlabs_voice()
    );
    let resp = client
        .post(url)
        .header("xi-api-key", key)
        .header("Accept", "audio/mpeg")
        .json(&body)
        .send()
        .await
        .map_err(|error| network_reason(&error))?;
    if !resp.status().is_success() {
        let code = resp.status();
        return Err(format!("http {}", code.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|error| network_reason(&error))?;
    Ok(bytes.to_vec())
}

trait TtsRunner {
    fn available(&self, backend: TtsBackend) -> bool;

    fn unavailable_reason(&self, _backend: TtsBackend) -> &'static str {
        "no key"
    }

    fn synthesize<'a>(
        &'a self,
        backend: TtsBackend,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>>;
}

struct LiveTtsRunner;

impl TtsRunner for LiveTtsRunner {
    fn available(&self, backend: TtsBackend) -> bool {
        match backend {
            // A key that OpenAI just refused for credit is not a usable voice route.
            // Skipping it here is what makes Atlas speak in ElevenLabs' real voice
            // immediately rather than after a failed round-trip - and, because
            // `blocks_paid_calls()` reopens after five minutes, the route comes back
            // on its own once a call can succeed again. Never a permanent removal.
            TtsBackend::OpenAi => {
                openai_tts_key().is_some() && !crate::openai_credit::blocks_paid_calls()
            }
            TtsBackend::ElevenLabs => elevenlabs_key().is_some(),
            TtsBackend::Hume => hume_key().is_some(),
            TtsBackend::Groq => crate::voice_stt::groq_key().is_some(),
        }
    }

    fn unavailable_reason(&self, backend: TtsBackend) -> &'static str {
        if backend == TtsBackend::OpenAi
            && openai_tts_key().is_some()
            && crate::openai_credit::blocks_paid_calls()
        {
            "credit refused"
        } else {
            "no key"
        }
    }

    fn synthesize<'a>(
        &'a self,
        backend: TtsBackend,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>> {
        match backend {
            TtsBackend::OpenAi => Box::pin(speak_openai(text)),
            TtsBackend::ElevenLabs => Box::pin(speak_elevenlabs(text)),
            TtsBackend::Hume => Box::pin(speak_hume(text)),
            TtsBackend::Groq => Box::pin(speak_groq(text)),
        }
    }
}

fn next_request_id() -> String {
    let sequence = TTS_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("tts-{}-{sequence}", crate::voice_usage::voice_session_id())
}

fn record_route_event<S: VoiceUsageSink>(
    sink: &S,
    request_id: &str,
    backend: TtsBackend,
    event: VoiceUsageKind,
    character_count: u64,
    fallback_to: Option<&str>,
    reason: Option<&str>,
) {
    sink.record(VoiceUsageEvent::new(
        request_id,
        backend.key(),
        backend.model(),
        event,
        character_count,
        fallback_to,
        reason,
    ));
}

async fn route_tts_with<R: TtsRunner, S: VoiceUsageSink>(
    runner: &R,
    sink: &S,
    profile: &str,
    text: &str,
    request_id: &str,
) -> Result<Vec<u8>, String> {
    let route = route_for_profile(profile);
    let character_count = text.chars().count() as u64;
    let mut last_error = "no-tts-backend".to_string();

    for (index, backend) in route.iter().copied().enumerate() {
        let fallback_to = route
            .get(index + 1)
            .map(|next| next.key())
            .unwrap_or("browser");

        if !runner.available(backend) {
            let reason = runner.unavailable_reason(backend);
            crate::elog!(
                "[voice] tts: {} unavailable; routing to {fallback_to}",
                backend.key()
            );
            record_route_event(
                sink,
                request_id,
                backend,
                VoiceUsageKind::Fallback,
                character_count,
                Some(fallback_to),
                Some(reason),
            );
            last_error = format!("no-{}-key", backend.key());
            continue;
        }

        record_route_event(
            sink,
            request_id,
            backend,
            VoiceUsageKind::Attempt,
            character_count,
            None,
            None,
        );

        let failure_reason;
        match runner.synthesize(backend, text).await {
            Ok(bytes) if bytes.len() > 44 => {
                record_route_event(
                    sink,
                    request_id,
                    backend,
                    VoiceUsageKind::Success,
                    character_count,
                    None,
                    None,
                );
                return Ok(bytes);
            }
            Ok(_) => {
                failure_reason = "invalid response: empty audio".to_string();
                last_error = format!("{}-empty-audio", backend.key());
                crate::elog!(
                    "[voice] tts: {} returned empty audio; routing to {fallback_to}",
                    backend.key()
                );
            }
            Err(error) => {
                failure_reason = privacy_safe_reason(&error);
                crate::elog!(
                    "[voice] tts: {} failed; routing to {fallback_to}",
                    backend.key()
                );
                // Provider response bodies can contain request-specific detail. Keep the
                // frontend-facing failure privacy-safe just like the on-disk ledger.
                last_error = format!("{}-failed", backend.key());
            }
        }

        record_route_event(
            sink,
            request_id,
            backend,
            VoiceUsageKind::Failure,
            character_count,
            None,
            Some(&failure_reason),
        );
        record_route_event(
            sink,
            request_id,
            backend,
            VoiceUsageKind::Fallback,
            character_count,
            Some(fallback_to),
            Some(&failure_reason),
        );
    }

    Err(last_error)
}

/// True if any provider-backed voice route is configured. The frontend still
/// speechSynthesis when this is false.
#[tauri::command]
pub fn tts_ready() -> bool {
    let runner = LiveTtsRunner;
    route_for_profile(&get_voice_profile())
        .iter()
        .copied()
        .any(|backend| runner.available(backend))
}

/// Synthesize `text` and record privacy-safe attempt/result/fallback metadata.
/// Utterance text, credentials, provider responses, and audio never enter the
/// telemetry ledger. Cost remains explicitly unknown until a provider-authoritative
/// billing source is connected under a separate confirmation.
#[tauri::command]
pub async fn speak_tts(app: tauri::AppHandle, text: String) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty".into());
    }

    let result = route_tts_with(
        &LiveTtsRunner,
        &FileVoiceUsageSink,
        &get_voice_profile(),
        text,
        &next_request_id(),
    )
    .await;
    let _ = app.emit(
        "praxis://voice-usage",
        crate::voice_usage::voice_usage_snapshot(),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::Mutex;

    struct MemorySink(Mutex<Vec<VoiceUsageEvent>>);

    impl MemorySink {
        fn new() -> Self {
            Self(Mutex::new(Vec::new()))
        }

        fn events(&self) -> Vec<VoiceUsageEvent> {
            self.0.lock().expect("events lock").clone()
        }
    }

    impl VoiceUsageSink for MemorySink {
        fn record(&self, event: VoiceUsageEvent) {
            self.0.lock().expect("events lock").push(event);
        }
    }

    struct FakeRunner {
        available: HashSet<TtsBackend>,
        outcomes: Mutex<HashMap<TtsBackend, VecDeque<Result<Vec<u8>, String>>>>,
        calls: Mutex<Vec<TtsBackend>>,
    }

    impl FakeRunner {
        fn new(
            available: impl IntoIterator<Item = TtsBackend>,
            outcomes: impl IntoIterator<Item = (TtsBackend, Vec<Result<Vec<u8>, String>>)>,
        ) -> Self {
            Self {
                available: available.into_iter().collect(),
                outcomes: Mutex::new(
                    outcomes
                        .into_iter()
                        .map(|(backend, values)| (backend, values.into()))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<TtsBackend> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    impl TtsRunner for FakeRunner {
        fn available(&self, backend: TtsBackend) -> bool {
            self.available.contains(&backend)
        }

        fn synthesize<'a>(
            &'a self,
            backend: TtsBackend,
            _text: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>> {
            self.calls.lock().expect("calls lock").push(backend);
            let result = self
                .outcomes
                .lock()
                .expect("outcomes lock")
                .get_mut(&backend)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| Err(format!("no fake outcome for {}", backend.key())));
            Box::pin(async move { result })
        }
    }

    #[test]
    fn atlas_speaks_in_the_realtime_voice_before_any_other_backend() {
        // One assistant, one voice: the default profile must reach OpenAI (the voice the
        // live Realtime conversation uses) before ElevenLabs/Hume/Groq.
        assert_eq!(DEFAULT_VOICE_PROFILE, "atlas");
        assert!(VOICE_PROFILES.contains(&DEFAULT_VOICE_PROFILE));
        assert_eq!(route_for_profile("atlas").first(), Some(&TtsBackend::OpenAi));
        assert_eq!(TtsBackend::OpenAi.model(), OPENAI_TTS_MODEL);
        // Deliberate legacy picks keep their own first voice.
        assert_eq!(route_for_profile("elevenlabs").first(), Some(&TtsBackend::ElevenLabs));
        assert_eq!(route_for_profile("hume-actor").first(), Some(&TtsBackend::Hume));
    }

    #[tokio::test]
    async fn elevenlabs_hume_groq_fallback_chain_records_each_attempt_and_result() {
        let runner = FakeRunner::new(
            [TtsBackend::ElevenLabs, TtsBackend::Hume, TtsBackend::Groq],
            [
                (
                    TtsBackend::ElevenLabs,
                    vec![Err("elevenlabs-down".to_string())],
                ),
                (TtsBackend::Hume, vec![Err("hume-down".to_string())]),
                (TtsBackend::Groq, vec![Ok(vec![1; 64])]),
            ],
        );
        let sink = MemorySink::new();
        let text = "Move Praxis safely";
        let audio = route_tts_with(&runner, &sink, "elevenlabs", text, "request-test")
            .await
            .expect("Groq should complete the route");
        assert_eq!(audio.len(), 64);
        assert_eq!(
            runner.calls(),
            vec![TtsBackend::ElevenLabs, TtsBackend::Hume, TtsBackend::Groq]
        );

        let events = sink.events();
        let sequence: Vec<(&str, VoiceUsageKind, Option<&str>)> = events
            .iter()
            .map(|event| {
                (
                    event.backend.as_str(),
                    event.event,
                    event.fallback_to.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            sequence,
            vec![
                ("elevenlabs", VoiceUsageKind::Attempt, None),
                ("elevenlabs", VoiceUsageKind::Failure, None),
                ("elevenlabs", VoiceUsageKind::Fallback, Some("hume")),
                ("hume", VoiceUsageKind::Attempt, None),
                ("hume", VoiceUsageKind::Failure, None),
                ("hume", VoiceUsageKind::Fallback, Some("groq")),
                ("groq", VoiceUsageKind::Attempt, None),
                ("groq", VoiceUsageKind::Success, None),
            ]
        );
        assert!(events.iter().all(|event| event.cost_usd.is_none()));
        assert!(events
            .iter()
            .all(|event| event.character_count == text.chars().count() as u64));
        assert_eq!(events[1].reason.as_deref(), Some("network: unknown"));
        assert_eq!(events[2].reason.as_deref(), Some("network: unknown"));
        let serialized = serde_json::to_string(&events).expect("serialize test events");
        assert!(!serialized.contains(text));
    }

    #[tokio::test]
    async fn unavailable_backends_record_fallbacks_without_false_attempts() {
        let runner = FakeRunner::new(
            [TtsBackend::Groq],
            [(TtsBackend::Groq, vec![Ok(vec![1; 64])])],
        );
        let sink = MemorySink::new();
        route_tts_with(&runner, &sink, "elevenlabs", "hello", "request-skip")
            .await
            .expect("Groq should complete the route");

        assert_eq!(runner.calls(), vec![TtsBackend::Groq]);
        let events = sink.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event == VoiceUsageKind::Attempt)
                .count(),
            1
        );
        assert_eq!(events[0].event, VoiceUsageKind::Fallback);
        assert_eq!(events[0].backend, "elevenlabs");
        assert_eq!(events[0].reason.as_deref(), Some("no key"));
        assert_eq!(events[1].event, VoiceUsageKind::Fallback);
        assert_eq!(events[1].backend, "hume");
        assert_eq!(events[1].reason.as_deref(), Some("no key"));
    }

    #[tokio::test]
    async fn first_success_stops_the_route_without_false_fallbacks() {
        let runner = FakeRunner::new(
            [TtsBackend::Hume, TtsBackend::Groq],
            [
                (TtsBackend::Hume, vec![Ok(vec![1; 64])]),
                (TtsBackend::Groq, vec![Ok(vec![1; 64])]),
            ],
        );
        let sink = MemorySink::new();
        route_tts_with(
            &runner,
            &sink,
            "hume-conversational",
            "hello",
            "request-first",
        )
        .await
        .expect("Hume should complete the route");

        assert_eq!(runner.calls(), vec![TtsBackend::Hume]);
        let events = sink.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, VoiceUsageKind::Attempt);
        assert_eq!(events[1].event, VoiceUsageKind::Success);
        assert!(events
            .iter()
            .all(|event| event.event != VoiceUsageKind::Fallback));
    }

    #[tokio::test]
    async fn total_provider_failure_records_browser_handoff_without_claiming_playback() {
        let runner = FakeRunner::new(
            [TtsBackend::ElevenLabs, TtsBackend::Hume, TtsBackend::Groq],
            [
                (
                    TtsBackend::ElevenLabs,
                    vec![Err("elevenlabs-down".to_string())],
                ),
                (TtsBackend::Hume, vec![Err("hume-down".to_string())]),
                (TtsBackend::Groq, vec![Err("groq-down".to_string())]),
            ],
        );
        let sink = MemorySink::new();
        let error = route_tts_with(&runner, &sink, "elevenlabs", "hello", "request-fail")
            .await
            .expect_err("all providers should fail");
        assert_eq!(error, "groq-failed");

        let events = sink.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event == VoiceUsageKind::Attempt)
                .count(),
            3
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event == VoiceUsageKind::Failure)
                .count(),
            3
        );
        let final_event = events.last().expect("browser handoff event");
        assert_eq!(final_event.event, VoiceUsageKind::Fallback);
        assert_eq!(final_event.backend, "groq");
        assert_eq!(final_event.fallback_to.as_deref(), Some("browser"));
    }
}
