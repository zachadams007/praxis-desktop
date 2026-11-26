//! QA "eyes" - the visual-QA loop for Praxis.
//!
//! Praxis's job is to stop the owner being the visual QA for the apps he builds. This module
//! is the LOOK step: it screenshots a real top-level window, sends the image to a cheap
//! vision model, and turns each defect the model finds into a `praxis://hermes-event`
//! frame - so findings animate the brain through the SAME contract Hermes uses (the
//! `a.lens` QA agent, "Lens", is already in the roster: role "QA", haiku/mint tint).
//!
//! Two Tauri commands:
//!
//!   * `qa_capture_window` - find a top-level window by (case-insensitive) title substring,
//!     capture a full-window PNG via `uiautomation`'s screenshot feature, save it under
//!     `%LOCALAPPDATA%\Praxis\qa\<timestamp>.png`, and return its path + dimensions + title.
//!   * `qa_inspect` - capture (via the above), base64 the PNG, POST it to OpenRouter's
//!     chat-completions vision endpoint, parse the strict-JSON findings, emit one
//!     `agent:thinking`-shaped Hermes event per finding, and return the raw findings JSON.
//!
//! The OpenRouter key is resolved through the EXACT same scheme `hermes_bridge::brain_chat`
//! uses (`hermes_bridge::read_vault_key`) - with an env-var override first - so there is one
//! source of truth for the key, not a second parser.
//!
//! COM note: `uiautomation::UIAutomation::new()` initialises COM as multithreaded on each
//! call, so we build a fresh instance inside `capture_impl` (no shared global state, no COM
//! apartment fights with WebView2's own STA on the main thread - we run capture on Tauri's
//! blocking pool via `spawn_blocking`).

use std::time::Duration;

use serde_json::Value;
use tauri::Emitter;

// ── Constants ────────────────────────────────────────────────────────────────

/// Vision model for QA inspection. Cheap + capable multimodal. Kept as a const so it's
/// swappable in one place (matches how `hermes_bridge` pins its default model).
const QA_VISION_MODEL: &str = "gpt-5.6-terra";

/// OpenRouter chat-completions endpoint (OpenAI-compatible), same base `brain_chat` uses.
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

/// How long the vision request may run before we give up. A single-image inspection returns
/// quickly; 60 s is a generous ceiling so a slow model never wedges the caller.
const QA_HTTP_TIMEOUT_SECS: u64 = 60;

/// UI-automation search settings for locating the target window under the desktop root.
const MATCH_DEPTH: u32 = 6; // top-level windows sit just under the desktop root
const MATCH_TIMEOUT_MS: u64 = 4_000;

/// The QA agent already in the roster (`src/shared/agents.ts`): id "a.lens", role "QA".
/// Emitting findings under this subagent_id routes them to the Lens node in the brain.
const QA_AGENT_ID: &str = "a.lens";

// ── Return types (frontend contract - snake_case via serde default) ──────────

/// Result of a window capture - returned to the frontend as-is.
#[derive(Clone, serde::Serialize)]
pub struct CaptureResult {
    /// Absolute path of the saved PNG.
    pub path: String,
    /// Captured image width in pixels.
    pub width: u32,
    /// Captured image height in pixels.
    pub height: u32,
    /// The matched window's full title (from UIAutomation `get_name`).
    pub title: String,
}

// ── Key resolution (single source of truth) ──────────────────────────────────

/// Resolve the OpenRouter key: env var first (lets an operator override without touching the
/// vault), then fall through to the SAME vault reader `hermes_bridge::brain_chat` uses. We do
/// NOT re-implement the vault parser here - we call the shared `hermes_bridge::read_vault_key`.
fn openai_key() -> Option<String> {
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    crate::hermes_bridge::read_vault_key("OPENAI_API_KEY")
}

// ── Paths ────────────────────────────────────────────────────────────────────

/// `%LOCALAPPDATA%\Praxis\qa` - where captured PNGs land. Created on demand.
fn qa_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::praxis_dir()
        .ok_or_else(|| "LOCALAPPDATA not set — cannot resolve the Praxis QA directory".to_string())?
        .join("qa");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A filesystem-safe timestamp for the capture filename (millis since epoch - monotonic
/// enough for unique names, sortable, no separators to escape).
fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── Capture (blocking; runs on the Tauri blocking pool) ──────────────────────

/// The synchronous capture body. Runs entirely on a blocking thread (COM is initialised here,
/// off the main WebView2 thread). Finds the top-level window whose title CONTAINS
/// `window_title_substring` (case-insensitive), optionally brings it forward, captures a
/// full-window PNG, saves it, and returns the metadata.
fn capture_impl(
    window_title_substring: String,
    bring_to_front: bool,
) -> Result<CaptureResult, String> {
    use uiautomation::screenshots::Screenshot;
    use uiautomation::UIAutomation;

    if window_title_substring.trim().is_empty() {
        return Err("qa_capture_window: window_title_substring must not be empty".to_string());
    }

    let automation = UIAutomation::new().map_err(|e| format!("UIAutomation init failed: {e}"))?;

    // `contains_name` is documented as case-insensitive substring matching - exactly the
    // "title contains the substring (case-insensitive)" contract. Search shallow (top-level
    // windows sit near the desktop root) with a bounded timeout so a missing window fails fast.
    let matcher = automation
        .create_matcher()
        .contains_name(window_title_substring.clone())
        .depth(MATCH_DEPTH)
        .timeout(MATCH_TIMEOUT_MS);

    let element = matcher.find_first().map_err(|e| {
        format!("no top-level window whose title contains {window_title_substring:?}: {e}")
    })?;

    let title = element.get_name().unwrap_or_default();

    if bring_to_front {
        // Best-effort - never fail the capture just because focus was denied (e.g. the
        // Windows foreground lock). `try_focus` returns a bool and never errors.
        let _ = element.try_focus();
        // Give the compositor a beat to repaint the now-foreground window before we grab it.
        std::thread::sleep(Duration::from_millis(180));
    }

    let shot = Screenshot::capture_element(&element)
        .map_err(|e| format!("window screenshot failed for {title:?}: {e}"))?;
    let width = shot.width();
    let height = shot.height();

    let path = qa_dir()?.join(format!("{}.png", timestamp()));
    shot.save_png(&path)
        .map_err(|e| format!("could not save PNG to {}: {e}", path.display()))?;

    Ok(CaptureResult {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        title,
    })
}

/// Capture one exact top-level window by handle (the LIVE driver knows which app window it
/// drives; a title substring like "Claude" can also match a browser tab titled "Claude").
#[cfg(windows)]
pub(crate) fn capture_hwnd_blocking(hwnd: isize) -> Result<CaptureResult, String> {
    use uiautomation::screenshots::Screenshot;
    use uiautomation::types::Handle;
    use uiautomation::UIAutomation;
    let automation = UIAutomation::new().map_err(|e| format!("UIAutomation init failed: {e}"))?;
    let element = automation
        .element_from_handle(Handle::from(hwnd))
        .map_err(|e| format!("no window for handle {hwnd:#x}: {e}"))?;
    let title = element.get_name().unwrap_or_default();
    let shot = Screenshot::capture_element(&element).map_err(|e| format!("window screenshot failed for {title:?}: {e}"))?;
    let (width, height) = (shot.width(), shot.height());
    let path = qa_dir()?.join(format!("{}.png", timestamp()));
    shot.save_png(&path).map_err(|e| format!("could not save PNG to {}: {e}", path.display()))?;
    Ok(CaptureResult { path: path.to_string_lossy().into_owned(), width, height, title })
}

// ── Tauri command: capture only ──────────────────────────────────────────────

/// Find a top-level window by (case-insensitive) title substring and capture a full-window
/// PNG to `%LOCALAPPDATA%\Praxis\qa\<timestamp>.png`.
///
/// `bring_to_front` (JS `bringToFront`) optionally focuses the window before capture; defaults
/// to `false` so a background QA pass never steals the user's foreground.
#[tauri::command]
pub async fn qa_capture_window(
    window_title_substring: String,
    bring_to_front: Option<bool>,
) -> Result<CaptureResult, String> {
    let bring = bring_to_front.unwrap_or(false);
    // UIAutomation is blocking + COM-bound → run it on the blocking pool, never the async
    // reactor (blocking there would starve other Tauri commands).
    tauri::async_runtime::spawn_blocking(move || capture_impl(window_title_substring, bring))
        .await
        .map_err(|e| format!("qa_capture_window join error: {e}"))?
}

// ── Tauri command: capture + vision inspect + emit findings ──────────────────

/// Capture the window, run a vision-model QA inspection, emit one Hermes event per finding
/// (so the brain animates them under the Lens QA agent), and return the raw findings JSON.
///
/// `focus_note` (JS `focusNote`) is an optional hint appended to the prompt - e.g. "focus on
/// the header spacing" - to steer the inspector without changing its defect taxonomy.
///
/// `model` (JS `model`) optionally overrides `QA_VISION_MODEL` - set from the Command
/// Center's Fleet panel (Lens dropdown, `src/command/fleetStore.ts`). Empty/omitted falls
/// back to the const default.
#[tauri::command]
pub async fn qa_inspect(
    app: tauri::AppHandle,
    window_title_substring: String,
    focus_note: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let vision_model = model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(QA_VISION_MODEL);
    // 1. Capture (bring the window forward so the shot is of the live, front-most render).
    let capture = {
        let substr = window_title_substring.clone();
        tauri::async_runtime::spawn_blocking(move || capture_impl(substr, true))
            .await
            .map_err(|e| format!("qa_inspect capture join error: {e}"))??
    };

    // 2. Read the PNG back and base64 it for the vision content part. (We read the saved file
    //    rather than re-encoding so there's exactly one PNG encoder in play - the crate's.)
    let png_bytes = std::fs::read(&capture.path)
        .map_err(|e| format!("could not read captured PNG {}: {e}", capture.path))?;
    let b64 = base64_encode(&png_bytes);
    let data_url = format!("data:image/png;base64,{b64}");

    // 3. Resolve the key through the shared scheme.
    let api_key = openai_key()
        .ok_or_else(|| "no OPENAI_API_KEY (env or vault) - cannot run QA vision".to_string())?;

    // 4. Build the structured request. The system prompt pins the defect taxonomy and the
    //    STRICT-JSON output contract; the user turn carries the image + optional focus note.
    let mut instruction = String::from(
        "Inspect this screenshot of an application window for visual defects. Look for: \
         overlapping elements, clipped or truncated text, misalignment, inconsistent spacing, \
         broken layout, and unreadable contrast.",
    );
    if let Some(note) = focus_note
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        instruction.push_str(&format!(" Pay particular attention to: {note}."));
    }
    instruction.push_str(
        " Return STRICT JSON only, no prose, no code fences, in exactly this shape: \
         {\"findings\": [{\"element\": \"...\", \"issue\": \"...\", \"severity\": \"high|med|low\"}]}. \
         If there are no defects, return {\"findings\": []}.",
    );

    let body = serde_json::json!({
        "model": vision_model,
        "instructions": "You are a meticulous UI QA inspector. Find visual defects: overlapping elements, clipped/truncated text, misalignment, inconsistent spacing, broken layout, and unreadable contrast. Return STRICT JSON only.",
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": instruction },
                    { "type": "input_image", "image_url": data_url }
                ]
            }
        ],
        "max_output_tokens": 900,
        "reasoning": { "effort": "low" }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(QA_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("qa_inspect reqwest build: {e}"))?;

    let resp = client
        .post(OPENAI_RESPONSES_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("qa_inspect request: {e}"))?;

    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("qa_inspect json: {e}"))?;

    if !status.is_success() {
        let snippet: String = v.to_string().chars().take(200).collect();
        return Err(format!("qa_inspect HTTP {status}: {snippet}"));
    }

    // Record usage for the cost dashboard (same accumulator hermes_bridge uses).
    let (input, output) = crate::hermes_bridge::openai_usage_tokens(&v);
    crate::usage::record_usage(
        "openai",
        vision_model,
        input,
        output,
        crate::hermes_bridge::openai_cost_usd(vision_model, input, output),
    );

    let content = crate::hermes_bridge::openai_response_text(&v)
        .ok_or_else(|| "qa_inspect: no content in vision response".to_string())?;

    // 5. Parse the findings (tolerating ```json code fences), then emit one event per finding.
    let findings_json = extract_json(&content);
    let parsed: Value = serde_json::from_str(&findings_json)
        .map_err(|e| format!("qa_inspect: could not parse findings JSON ({e}); raw: {content}"))?;

    emit_findings(&app, &capture.title, &parsed);

    // Return the raw (normalised) findings JSON string to the caller.
    Ok(findings_json)
}

// ── Event emission ────────────────────────────────────────────────────────────

/// Emit one `praxis://hermes-event` per finding. Each frame uses the SAME `HermesEvent`
/// contract the Hermes observer emits (see `hermes_bridge::HermesEvent`), with:
///   * `kind = "status.update"` → the frontend `onHermesEvent` maps this (with `text`) to an
///     `agent:thinking` PraxisEvent.
///   * `subagent_id = "a.lens"` → `onHermesEvent` uses `agentId = p.subagent_id ?? "a.hermes"`,
///     so the thought animates on the Lens QA agent node.
///   * `text` = the human-readable finding (severity · element · issue), sliced to 80 chars by
///     the frontend for the HUD ticker.
fn emit_findings(app: &tauri::AppHandle, window_title: &str, parsed: &Value) {
    let findings = parsed.get("findings").and_then(|f| f.as_array());

    // A "clean" result still deserves a heartbeat so the brain shows Lens looked and found
    // nothing, rather than silence.
    let empty = Vec::new();
    let list = findings.unwrap_or(&empty);
    if list.is_empty() {
        emit_one(app, &format!("QA {window_title}: no visual defects found"));
        return;
    }

    for finding in list {
        let element = finding
            .get("element")
            .and_then(|x| x.as_str())
            .unwrap_or("element");
        let issue = finding
            .get("issue")
            .and_then(|x| x.as_str())
            .unwrap_or("issue");
        let severity = finding
            .get("severity")
            .and_then(|x| x.as_str())
            .unwrap_or("low");
        let text = format!("[{severity}] {element}: {issue}");
        emit_one(app, &text);
    }
}

/// Emit a single Lens QA thought onto the Hermes event channel.
fn emit_one(app: &tauri::AppHandle, text: &str) {
    // Build the payload with the exact snake_case field names the frontend reads. We construct
    // it as JSON (rather than importing hermes_bridge::HermesEvent, whose fields are private) so
    // this module owns its own emit without reaching into the bridge's internals.
    let payload = serde_json::json!({
        "kind": "status.update",
        "session_id": "qa-eyes",
        "text": text,
        "tool_name": null,
        "model": QA_VISION_MODEL,
        "subagent_id": QA_AGENT_ID,
        "parent_id": null,
        "depth": null,
    });
    let _ = app.emit("praxis://hermes-event", payload);
}

// ── JSON extraction (tolerate code fences) ───────────────────────────────────

/// Strip ```json ... ``` (or bare ``` ... ```) fences and return the inner JSON substring.
/// If no fence is present, return the trimmed input unchanged. As a final safety net, if the
/// text still isn't clean, slice from the first `{` to the last `}`.
fn extract_json(text: &str) -> String {
    let t = text.trim();
    // Fenced block: ```json\n...\n``` or ```\n...\n```
    if let Some(rest) = t.strip_prefix("```") {
        // Drop an optional language tag on the first line (e.g. "json").
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        let rest = rest.trim_start_matches(['\r', '\n']);
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
        return rest.trim().to_string();
    }
    // Bare object: slice first `{` .. last `}` if there's leading/trailing chatter.
    if let (Some(start), Some(end)) = (t.find('{'), t.rfind('}')) {
        if start < end {
            return t[start..=end].to_string();
        }
    }
    t.to_string()
}

// ── Base64 (no extra runtime scheme; uses the `base64` crate already in the lock) ─

/// Standard-alphabet base64 of arbitrary bytes (for the vision data URL).
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
