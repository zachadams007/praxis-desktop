//! Speech-to-text via Groq (whisper-large-v3-turbo).
//!
//! WebView2 ships NO Web Speech `SpeechRecognition` backend, so the WebView captures mic
//! audio (getUserMedia + MediaRecorder) and hands the clip to this command; we POST it to
//! Groq's OpenAI-compatible transcription endpoint and return the text. The frontend then
//! runs that text through the SAME command router + TTS as the old Web-Speech path.
//!
//! Free tier (~2,000 req/day) covers personal use.
//!
//! KEY resolution order (most to least authoritative):
//!   1. Env `GROQ_API_KEY` (set by rpraxis.ps1 in dev; or any shell that launched the app).
//!   2. `%LOCALAPPDATA%\Praxis\groq.key` - the runtime drop-in file (56 chars, no newline).
//!   3. `%USERPROFILE%\.praxis\praxis-secrets.env` - the vault .env (last resort).
//! Missing key → `Err("no-key")` so the UI can guide setup.

use serde::Deserialize;

const GROQ_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL: &str = "whisper-large-v3-turbo";

/// Strip BOM, CR, LF, and all Unicode whitespace from a candidate key string.
/// `pub(crate)` so `voice_tts::hume_key()` cleans keys with the exact same rules.
pub(crate) fn clean_key(raw: &str) -> String {
    raw.trim_start_matches('\u{FEFF}') // UTF-8 BOM
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\r' && *c != '\n')
        .collect()
}

/// Read a `KEY=value` line from a .env file, returning the value for `name`.
/// `pub(crate)` so `voice_tts::hume_key()` shares one vault reader for its last-resort fallback.
pub(crate) fn read_env_file(path: &std::path::Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{}=", name);
    for line in text.lines() {
        let line = line.trim_start_matches('\u{FEFF}').trim();
        if let Some(val) = line.strip_prefix(&prefix) {
            let k = clean_key(val.trim_matches('"').trim_matches('\''));
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    None
}

/// Resolve the Groq key from env, on-disk key file, or the secrets vault .env.
/// Shared with the TTS module so both halves of the voice loop use one key source.
pub(crate) fn groq_key() -> Option<String> {
    // 1. Env var (set by rpraxis.ps1 in dev, or any parent process that loaded the key).
    if let Ok(raw) = std::env::var("GROQ_API_KEY") {
        let k = clean_key(&raw);
        if !k.is_empty() {
            return Some(k);
        }
    }

    // 2. Runtime key file: %LOCALAPPDATA%\Praxis\groq.key
    if let Some(dir) = crate::praxis_dir() {
        if let Ok(raw) = std::fs::read_to_string(dir.join("groq.key")) {
            let k = clean_key(&raw);
            if !k.is_empty() {
                return Some(k);
            }
        }
    }

    // 3. Secrets vault: %USERPROFILE%\.praxis\praxis-secrets.env
    //    Last-resort so voice works even if the runtime key file is absent.
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let vault = std::path::PathBuf::from(home)
            .join(".claude")
            .join("secrets")
            .join("praxis-secrets.env");
        if let Some(k) = read_env_file(&vault, "GROQ_API_KEY") {
            return Some(k);
        }
    }

    None
}

#[derive(Deserialize)]
struct Resp {
    text: String,
}

/// True if a Groq key is configured - lets the UI show "ready" vs "add a key" honestly.
#[tauri::command]
pub fn stt_ready() -> bool {
    groq_key().is_some()
}

/// Groq chat model for the voice lane's intent classifier. Verified live 2026-09-17 against
/// `GET /openai/v1/models`: qwen/qwen3.8-27b answered the classify prompt with correct JSON
/// in 144-219 ms, where the NVIDIA NIM classifier took 0.8 s, 3.5 s and 25.5 s for three
/// utterances against a 6 s budget. (openai/gpt-oss-20b spent its tokens reasoning and
/// returned nothing.) Model ids expire - the TS caller races this against NIM, so a dead id
/// degrades to the old path instead of breaking the lane.
const GROQ_CLASSIFY_MODEL: &str = "qwen/qwen3.8-27b";
const GROQ_CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";

/// One fast, tiny chat completion for intent classification (a few hundred tokens).
#[tauri::command]
pub async fn groq_classify(prompt: String) -> Result<String, String> {
    let key = groq_key().ok_or("no-key")?;
    let body = serde_json::json!({
        "model": GROQ_CLASSIFY_MODEL,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 160,
        "temperature": 0,
    });
    let resp = reqwest::Client::new()
        .post(GROQ_CHAT_URL)
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("net: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("groq {code}: {}", text.chars().take(180).collect::<String>()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "groq returned no text".to_string())
}

/// Transcribe a captured audio clip. `audio` is the raw bytes from MediaRecorder; `mime`
/// is its content type (e.g. "audio/webm"). Returns the recognized text, or a short error
/// code/string the frontend can surface ("no-key", "empty-audio", "groq 4xx: …", "net: …").
#[tauri::command]
pub async fn transcribe_audio(audio: Vec<u8>, mime: Option<String>) -> Result<String, String> {
    let key = groq_key().ok_or("no-key")?;
    if audio.is_empty() {
        return Err("empty-audio".into());
    }
    let mime = mime.unwrap_or_else(|| "audio/webm".to_string());
    let ext = if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        "mp3"
    } else {
        "webm"
    };

    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(format!("audio.{ext}"))
        .mime_str(&mime)
        .map_err(|e| format!("mime: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", MODEL)
        .text("response_format", "json")
        .text("temperature", "0");

    let client = reqwest::Client::new();
    let resp = client
        .post(GROQ_URL)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("net: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "groq {code}: {}",
            body.chars().take(180).collect::<String>()
        ));
    }
    let parsed: Resp = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(parsed.text.trim().to_string())
}
