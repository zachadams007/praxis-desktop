//! Watch-me / screen-share - Praxis WATCHES the owner's screen and answers questions about it.
//!
//! It is the ChatGPT/Gemini "screen-share" experience, built on our own capture → vision-model
//! loop (there is no embeddable consumer screen-share API - see
//! `praxis-screenshare-watchme-decision-2026-07-06`).
//!
//! Three Tauri commands:
//!
//!   * `watchme_start` - begins the hardware-accelerated capture stream (via
//!     `screen_capture::capture_stream_start`, which emits `praxis://screen-frame` for the
//!     live "watching" indicator) AND spins a lightweight backend keeper thread that grabs a
//!     fresh frame every ~1.5s into `LATEST_FRAME`, so an `ask` always has a recent image
//!     without waiting on the event bus.
//!   * `watchme_stop` - stops the stream + the keeper thread and clears the buffer.
//!   * `watchme_ask` - takes the latest frame (grabbing a fresh one if the buffer is empty or
//!     stale), sends it + the question to a VISION model, records usage, SPEAKS the answer via
//!     the existing TTS path, and emits `praxis://watchme-answer { text }`.
//!
//! MVP: on-demand ask (not a continuous monologue). Cost is bounded - a frame is only sent to
//! the model when the owner actually asks.
//!
//! Model + key: OpenRouter chat-completions vision, resolved through the SAME single-source
//! key scheme `qa_eyes` / `hermes_bridge` use (`hermes_bridge::read_vault_key`, env override
//! first). No new key parser, no hardcoded secret.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::Emitter;

// ── Constants ────────────────────────────────────────────────────────────────

/// Vision model for watch-me answers. Cheap + capable multimodal, matches `qa_eyes`'s default
/// so both visual features share one model surface (swap here in one place).
const WATCHME_VISION_MODEL: &str = "gpt-5.6-terra";

/// OpenRouter chat-completions endpoint (OpenAI-compatible), same base `qa_eyes`/`brain_chat` use.
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

/// How long the vision request may run before we give up.
const WATCHME_HTTP_TIMEOUT_SECS: u64 = 60;

/// Capture tuning. The decision memo calls for ~1024–1280px longest edge, JPEG q60–70 - this
/// keeps the token cost sane while staying legible for "what's on my screen" questions.
const CAPTURE_MAX_EDGE: u32 = 1280;
const CAPTURE_QUALITY: u8 = 68;

/// Live-stream frame rate for the "watching" indicator. The frontend downsamples visually; this
/// is deliberately calm (the decision memo's idle cadence) so the capture thread is cheap.
const STREAM_FPS: f64 = 1.0;

/// How often the backend keeper thread refreshes `LATEST_FRAME` while watching. Independent of
/// the frontend stream so an `ask` always has a fresh-enough image even if the webview is busy.
const KEEPER_INTERVAL: Duration = Duration::from_millis(1500);

/// A frame older than this is considered stale for an `ask` - we grab a fresh one on demand.
const STALE_AFTER: Duration = Duration::from_millis(2500);

// ── Shared state ─────────────────────────────────────────────────────────────

/// True while watch-me is active (drives both the keeper thread's loop and the "already on" guard).
static WATCHING: AtomicBool = AtomicBool::new(false);

/// The most recent captured frame: (base64 JPEG, captured Instant). `None` until the first
/// grab lands or after a stop.
static LATEST_FRAME: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);

// ── Key resolution (single source of truth) ──────────────────────────────────

/// Resolve the OpenRouter key: env override first, else the shared vault reader
/// (`hermes_bridge::read_vault_key`). Mirrors `qa_eyes::openrouter_key` exactly - one scheme.
fn openai_key() -> Option<String> {
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    crate::hermes_bridge::read_vault_key("OPENAI_API_KEY")
}

// ── Frame buffer helpers ─────────────────────────────────────────────────────

/// Store a freshly captured frame with the current timestamp.
fn store_frame(b64: String) {
    if let Ok(mut guard) = LATEST_FRAME.lock() {
        *guard = Some((b64, std::time::Instant::now()));
    }
}

/// Return the latest frame's base64 IF it exists and is newer than `STALE_AFTER`.
fn fresh_frame() -> Option<String> {
    let guard = LATEST_FRAME.lock().ok()?;
    let (b64, at) = guard.as_ref()?;
    if at.elapsed() <= STALE_AFTER {
        Some(b64.clone())
    } else {
        None
    }
}

/// Capture a single frame right now (blocking; runs the windows-capture handshake). Returns the
/// base64 JPEG. This is the SAME entry point the stream uses, so there's one capture path.
fn capture_now() -> Result<String, String> {
    // The SYNC core, not the Tauri command: this runs on the keeper thread, and the
    // command is now async precisely so it never blocks the UI thread.
    crate::screen_capture::capture_once(CAPTURE_MAX_EDGE, CAPTURE_QUALITY)
}

// ── Command: start ───────────────────────────────────────────────────────────

/// Begin watching. Starts the frontend-facing capture stream (for the live indicator) and a
/// backend keeper thread that keeps `LATEST_FRAME` warm. Idempotent-ish: a second start while
/// already watching is a no-op success (so a double-click of the toggle doesn't error).
#[tauri::command]
pub fn watchme_start(app: tauri::AppHandle) -> Result<(), String> {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already watching
    }

    // Start the frontend stream for the live "watching" indicator. If the stream is somehow
    // already running (e.g. another feature holds it), don't fail the whole start - the keeper
    // thread below is what `ask` actually depends on.
    if let Err(e) = crate::screen_capture::capture_stream_start(
        app.clone(),
        STREAM_FPS,
        CAPTURE_MAX_EDGE,
        CAPTURE_QUALITY,
    ) {
        crate::elog!("[watchme] capture_stream_start: {e} — continuing with keeper-only capture");
    }

    // Backend keeper: refresh LATEST_FRAME on its own cadence so `ask` never waits on the bus.
    std::thread::Builder::new()
        .name("praxis-watchme-keeper".to_string())
        .spawn(move || {
            while WATCHING.load(Ordering::SeqCst) {
                match capture_now() {
                    Ok(b64) => store_frame(b64),
                    Err(e) => crate::elog!("[watchme] keeper capture failed: {e}"),
                }
                // Sleep in small slices so a stop is honored promptly.
                let mut remaining = KEEPER_INTERVAL;
                let slice = Duration::from_millis(150);
                while remaining > Duration::ZERO && WATCHING.load(Ordering::SeqCst) {
                    let step = remaining.min(slice);
                    std::thread::sleep(step);
                    remaining = remaining.saturating_sub(step);
                }
            }
        })
        .map(|_| ())
        .map_err(|e| {
            WATCHING.store(false, Ordering::SeqCst);
            let _ = crate::screen_capture::capture_stream_stop();
            format!("watchme keeper thread failed to start: {e}")
        })
}

// ── Command: stop ────────────────────────────────────────────────────────────

/// Stop watching: end the stream + keeper thread and clear the buffered frame.
#[tauri::command]
pub fn watchme_stop() -> Result<(), String> {
    WATCHING.store(false, Ordering::SeqCst);
    let _ = crate::screen_capture::capture_stream_stop();
    if let Ok(mut guard) = LATEST_FRAME.lock() {
        *guard = None;
    }
    Ok(())
}

// ── Command: ask ─────────────────────────────────────────────────────────────

/// Ask a question about what's on screen. Uses the freshest buffered frame (grabbing a new one
/// on demand if the buffer is empty/stale - so `ask` works even without a prior `start`), sends
/// it + the question to the vision model, SPEAKS the answer, and emits `praxis://watchme-answer`.
/// Returns the answer text to the caller as well.
#[tauri::command]
pub async fn watchme_ask(app: tauri::AppHandle, question: String) -> Result<String, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("watchme_ask: question must not be empty".to_string());
    }

    // 1. Freshest frame - prefer the warm buffer, else capture on demand (blocking pool).
    let b64 = match fresh_frame() {
        Some(b) => b,
        None => tauri::async_runtime::spawn_blocking(capture_now)
            .await
            .map_err(|e| format!("watchme_ask capture join error: {e}"))??,
    };
    let data_url = format!("data:image/jpeg;base64,{b64}");

    // 2. Resolve the key through the shared scheme.
    let api_key = openai_key().ok_or_else(|| {
        "no OPENAI_API_KEY (env or vault) - cannot answer about the screen".to_string()
    })?;

    // 3. Build the request. The system turn frames Praxis as a real-time screen observer; the
    //    user turn carries the current frame + the owner's question.
    let _legacy_body = serde_json::json!({
        "model": WATCHME_VISION_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are Praxis, watching the user's screen in real time and helping \
                            like a screen-share assistant. Answer the user's question about what \
                            is currently on their screen using ONLY what you can see in the \
                            image. Be concise and specific — name the app, window, code, error, \
                            or UI element you see. If the answer isn't visible on screen, say so \
                            plainly. Reply in one or two short spoken-style sentences (this will \
                            be read aloud), no markdown, no lists."
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": question },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }
        ],
        "max_tokens": 400,
        "temperature": 0.2
    });

    let body = serde_json::json!({
        "model": WATCHME_VISION_MODEL,
        "instructions": "You are Praxis, watching the user's screen in real time and helping like a screen-share assistant. Answer using only what you can see. Be concise and specific. If the answer is not visible on screen, say so plainly. Reply in one or two short spoken-style sentences, no markdown.",
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": question },
                    { "type": "input_image", "image_url": data_url }
                ]
            }
        ],
        "max_output_tokens": 400,
        "reasoning": { "effort": "low" }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(WATCHME_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("watchme_ask reqwest build: {e}"))?;

    let resp = client
        .post(OPENAI_RESPONSES_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("watchme_ask request: {e}"))?;

    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("watchme_ask json: {e}"))?;

    if !status.is_success() {
        let snippet: String = v.to_string().chars().take(200).collect();
        return Err(format!("watchme_ask HTTP {status}: {snippet}"));
    }

    // Record usage for the cost dashboard (same accumulator qa_eyes/hermes_bridge use).
    let (input, output) = crate::hermes_bridge::openai_usage_tokens(&v);
    crate::usage::record_usage(
        "openai",
        WATCHME_VISION_MODEL,
        input,
        output,
        crate::hermes_bridge::openai_cost_usd(WATCHME_VISION_MODEL, input, output),
    );

    let answer = crate::hermes_bridge::openai_response_text(&v)
        .ok_or_else(|| "watchme_ask: no content in vision response".to_string())?;

    // 4. Emit the answer so the overlay can show it, then speak it (best-effort - a TTS failure
    //    never fails the ask; the overlay still shows the text).
    let _ = app.emit(
        "praxis://watchme-answer",
        serde_json::json!({ "text": answer }),
    );
    speak(&app, &answer).await;

    Ok(answer)
}

// ── Voice ────────────────────────────────────────────────────────────────────

/// Speak the answer via the existing TTS path (`voice_tts::speak_tts`, same Hume→Groq stack the
/// voice system uses). Returns audio bytes; we emit them on `praxis://watchme-speak` so the
/// frontend (which owns the WebView audio element) plays them - Rust has no audio sink. Purely
/// best-effort: any failure is logged and swallowed so the text answer still lands.
async fn speak(app: &tauri::AppHandle, text: &str) {
    match crate::voice_tts::speak_tts(app.clone(), text.to_string()).await {
        Ok(bytes) if !bytes.is_empty() => {
            let _ = app.emit(
                "praxis://watchme-speak",
                serde_json::json!({ "audio": bytes }),
            );
        }
        Ok(_) => crate::elog!("[watchme] TTS returned empty audio — answer shown as text only"),
        Err(_) => crate::elog!("[watchme] TTS failed - answer shown as text only"),
    }
}
