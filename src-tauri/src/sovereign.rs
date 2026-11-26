//! Sovereign layer - Trust IV - the credentialed-action engine.
//!
//! Praxis drives a REAL browser we own (the `praxis-browser` Node/Playwright
//! sidecar) to log in and fill forms ON THE OWNER'S BEHALF, with a
//! mandatory human veto in front of every irreversible step.
//!
//! Shape:
//!   • `sovereign_start()` - spawn the Node sidecar (persistent headed Chromium
//!                            with user-data-dir %LOCALAPPDATA%\Praxis\browser-profile)
//!                            and hold its stdin/stdout for the JSON protocol.
//!   • `sovereign_do(goal)` - run the plan→act loop: ask OpenRouter what to do
//!                            next given the current page snapshot + the goal,
//!                            execute the step against the sidecar, repeat.
//!                            Credentials come from the DPAPI vault (vault.rs)
//!                            and go Rust→sidecar directly - the raw password
//!                            NEVER enters the LLM prompt.
//!   • `sovereign_stop()` - shut the sidecar (and its Chromium) down.
//!
//! VETO: before any action classified irreversible (pay / post / send / final
//! login-submit / create-account), we emit `praxis://veto-request` and BLOCK on
//! `praxis://veto-response` (with a TTL) before the side effect runs.
//!
//! No new crates: std::process for the sidecar, reqwest (already a dep) for
//! OpenRouter, the existing vault.rs for credentials.

use std::io::{BufRead, BufReader, Write};
use std::collections::VecDeque;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Listener};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── secrets / model ─────────────────────────────────────────────────────────

/// Same vault file the Hermes bridge reads. Kept in sync deliberately.
const SECRETS_PATH: &str = r"C:\Users\dev\.praxis\praxis-secrets.env";

/// Capable planning model on OpenRouter. Reasoning + tool-following, cheap enough
/// for a per-step loop. (Not a scoring/ranking call - a plain instruction-follow.)
use crate::autonomy::{
    unattended_decision, ActionClass, ActionOrigin, Approval, Decision, Level,
};

const PLANNER_MODEL: &str = "gpt-5.6-terra";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

/// Plan→act iterations before a run pauses, so a confused loop cannot run forever.
///
/// A live run is one the owner is watching and can HALT at any moment, so the ceiling
/// that protects an unattended loop from itself is just an interruption there -
/// he steered it to step 24 and would have to say the whole goal again.
const MAX_STEPS: usize = 24;
const MAX_STEPS_LIVE: usize = 200;
/// How long we wait for the owner to approve/reject an irreversible action.
const VETO_TTL_SECS: u64 = 180;
/// Per-command sidecar round-trip timeout.
const CMD_TIMEOUT_SECS: u64 = 60;

/// Read `KEY=value` from the one-source-of-truth secrets file (mirrors
/// hermes_bridge::read_vault_key so the two never diverge).
fn read_secret(key: &str) -> Option<String> {
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

// ── sidecar process handle ──────────────────────────────────────────────────

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: u64,
}

static SIDECAR: Mutex<Option<Sidecar>> = Mutex::new(None);
/// Monotonic id for veto requests so a stale response can't satisfy a new one.
static VETO_SEQ: AtomicU64 = AtomicU64::new(1);
/// Serializes run-start and stop state transitions so a stop request can never
/// be lost while a new sovereign run is claiming the slot.
static RUN_STATE_LOCK: Mutex<()> = Mutex::new(());
/// Active-run guard plus an immediately observable stop token. The stop token is
/// checked between every planner/veto/act boundary; the HALT file is checked too.
static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static ACTIVE_OWNER: Mutex<Option<String>> = Mutex::new(None);
static PRE_CANCELLED_OWNERS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static SERVICE_STOPPING: AtomicBool = AtomicBool::new(false);
const MAX_PRE_CANCELLED_OWNERS: usize = 64;
const OWNER_TERMINAL_TIMEOUT: Duration = Duration::from_secs(5);
const OWNER_TERMINAL_POLL: Duration = Duration::from_millis(10);

fn normalized_owner_token(owner_token: Option<String>) -> Option<String> {
    owner_token.and_then(|token| {
        let token = token.trim().to_string();
        (!token.is_empty()).then_some(token)
    })
}

fn owner_request_matches(active: Option<&str>, requested: Option<&str>) -> bool {
    match requested {
        None => false,
        Some(token) if token.trim().is_empty() => false,
        Some(token) => active == Some(token.trim()),
    }
}

fn record_pre_cancelled_owner(token: &str) -> Result<(), String> {
    let mut tokens = PRE_CANCELLED_OWNERS.lock().map_err(|e| e.to_string())?;
    if !tokens.iter().any(|existing| existing == token) {
        tokens.push_back(token.to_string());
        while tokens.len() > MAX_PRE_CANCELLED_OWNERS {
            let _ = tokens.pop_front();
        }
    }
    Ok(())
}

fn take_pre_cancelled_owner(token: &str) -> Result<bool, String> {
    let mut tokens = PRE_CANCELLED_OWNERS.lock().map_err(|e| e.to_string())?;
    let Some(index) = tokens.iter().position(|existing| existing == token) else {
        return Ok(false);
    };
    let _ = tokens.remove(index);
    Ok(true)
}

fn owner_is_terminal(owner_token: &str) -> Result<bool, String> {
    if !RUNNING.load(Ordering::SeqCst) {
        return Ok(true);
    }
    let active_owner = ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
    Ok(active_owner.as_deref() != Some(owner_token))
}

fn wait_for_owner_terminal(owner_token: &str) -> Result<(), String> {
    let deadline = Instant::now() + OWNER_TERMINAL_TIMEOUT;
    loop {
        if owner_is_terminal(owner_token)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for sovereign owner {owner_token} to become terminal."
            ));
        }
        thread::sleep(OWNER_TERMINAL_POLL);
    }
}

fn wait_for_sovereign_slot_terminal() -> Result<(), String> {
    let deadline = Instant::now() + OWNER_TERMINAL_TIMEOUT;
    while RUNNING.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the sovereign action to become terminal.".to_string());
        }
        thread::sleep(OWNER_TERMINAL_POLL);
    }
    Ok(())
}

struct SovereignRunGuard;
impl Drop for SovereignRunGuard {
    fn drop(&mut self) {
        let _state_guard = RUN_STATE_LOCK.lock().ok();
        if let Ok(mut owner) = ACTIVE_OWNER.lock() {
            *owner = None;
        }
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn is_halted() -> bool {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .map(|dir| dir.join("Praxis").join("halted.txt"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

fn ensure_active() -> Result<(), String> {
    if STOP_REQUESTED.load(Ordering::SeqCst) {
        return Err("Sovereign action stopped by user.".to_string());
    }
    if is_halted() {
        return Err("HALT ALL is thrown; sovereign action stopped.".to_string());
    }
    Ok(())
}

/// Where the `praxis-browser` sidecar lives. Dev: alongside the repo. Installed:
/// falls back to `%USERPROFILE%\tools\praxis-browser` (same convention as the
/// Quartz workspace, which OneDrive-tidying can't relocate).
fn sidecar_dir() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 1. dev: <repo>/praxis-browser, relative to the running exe
    //    (…/src-tauri/target/debug/praxis.exe → up to repo root → praxis-browser)
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe.clone();
        for _ in 0..5 {
            if let Some(parent) = p.parent() {
                p = parent.to_path_buf();
                let cand = p.join("praxis-browser");
                if cand.join("index.mjs").exists() {
                    candidates.push(cand);
                }
            }
        }
    }

    // 2. dev: the compile-time repo path (CARGO_MANIFEST_DIR = …/src-tauri)
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo) = manifest.parent() {
        candidates.push(repo.join("praxis-browser"));
    }

    // 3. installed: ~/tools/praxis-browser
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(
            std::path::Path::new(&home)
                .join("tools")
                .join("praxis-browser"),
        );
    }

    candidates
        .into_iter()
        .find(|c| c.join("index.mjs").exists())
}

/// Spawn the Node sidecar with piped stdio. `node` is on PATH via `cmd /C` on
/// Windows (same reason quartz_sidecar goes through cmd). No console window.
fn spawn_sidecar() -> Result<Sidecar, String> {
    let dir = sidecar_dir().ok_or_else(|| {
        "praxis-browser sidecar not found — expected <repo>/praxis-browser/index.mjs or \
         %USERPROFILE%\\tools\\praxis-browser\\index.mjs. Run `npm install` + \
         `npx playwright install chromium` there first."
            .to_string()
    })?;

    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "node", "index.mjs"])
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn praxis-browser (is Node installed?): {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    // Drain the unsolicited boot line ({ id:0, ok:true, result:{ready:true,...} }).
    let mut boot = String::new();
    reader
        .read_line(&mut boot)
        .map_err(|e| format!("sidecar produced no boot line: {e}"))?;

    Ok(Sidecar {
        child,
        stdin,
        reader,
        next_id: 1,
    })
}

/// Send one JSON command and read exactly one JSON response line. Because the
/// sidecar answers one-response-per-request in order, a simple write→readline is
/// correct as long as all traffic goes through this single locked path.
fn sidecar_call(sc: &mut Sidecar, cmd: &str, args: Value) -> Result<Value, String> {
    let id = sc.next_id;
    sc.next_id += 1;

    let mut req = json!({ "id": id, "cmd": cmd });
    if let (Value::Object(obj), Value::Object(extra)) = (&mut req, args) {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }

    let line = format!("{req}\n");
    sc.stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("sidecar write ({cmd}): {e}"))?;
    sc.stdin
        .flush()
        .map_err(|e| format!("sidecar flush ({cmd}): {e}"))?;

    // Read one line, guarded by a timeout via a helper thread would need a
    // non-blocking reader; instead we rely on the sidecar's own per-command
    // timeouts (navigate 45s, fill/click 15s) which always produce a line.
    let mut resp = String::new();
    let n = sc
        .reader
        .read_line(&mut resp)
        .map_err(|e| format!("sidecar read ({cmd}): {e}"))?;
    if n == 0 {
        return Err(format!("sidecar closed the pipe during '{cmd}'"));
    }

    let v: Value =
        serde_json::from_str(resp.trim()).map_err(|e| format!("sidecar bad JSON ({cmd}): {e}"))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(format!(
            "sidecar error ({cmd}): {}",
            v.get("error").and_then(Value::as_str).unwrap_or("unknown")
        ))
    }
}

// ── veto gate ───────────────────────────────────────────────────────────────

/// Actions that spend money, create an identity, or say something publicly in
/// The owner's name. The planner tags each step with an `action`; this set is what
/// III · EXECUTE stops at and IV · SOVEREIGN clears.
fn is_irreversible(action: &str) -> bool {
    matches!(
        action,
        "pay" | "purchase" | "post" | "send" | "submit_login" | "create_account" | "accept_tos"
    )
}

/// Every action that mutates the page rather than reading it. Planner labels are
/// advisory, so an unattended run below the top of the dial treats a generic
/// mutation with the same suspicion as a labelled one.
fn mutates_page(action: &str) -> bool {
    is_irreversible(action) || matches!(action, "click" | "fill" | "type" | "press")
}

/// Does this step stop and ask the owner before it runs?
///
/// This used to be `is_irreversible(action) || click|fill|type|press`, flat, with
/// no way to turn it off - so EVERY browser mutation prompted, at every trust
/// level including `full`. "Driving the browser" was gated at maximum trust, and
/// a live run the owner was watching interrupted him to ask permission for the click
/// he had just asked for.
///
/// Now:
///   live                  → never. He is watching; the veto is the friction.
///   IV · SOVEREIGN         → never. That is what the top detent promises.
///   III · EXECUTE          → only the irreversible set (pay/post/send/log in/…).
///   II · PROPOSE           → every mutation, which is what "asks before each step" means.
///   I · OBSERVE / suggest  → the run never starts; the dial blocked it upstream.
fn requires_veto(action: &str, origin: ActionOrigin, level: Level) -> bool {
    if origin.is_live() {
        return false;
    }
    if !mutates_page(action) {
        return false;
    }
    let class = if is_irreversible(action) {
        ActionClass::Sensitive
    } else {
        ActionClass::Actuate
    };
    matches!(
        unattended_decision(level, class),
        Decision::Allowed(Approval::Step) | Decision::Blocked(_)
    )
}

#[derive(Clone, serde::Serialize)]
struct VetoRequest {
    veto_id: u64,
    action: String,
    summary: String,
    args: Value,
}

#[derive(serde::Deserialize)]
struct VetoResponse {
    veto_id: u64,
    approved: bool,
}

/// Emit `praxis://veto-request` and BLOCK until the matching
/// `praxis://veto-response` arrives (or TTL). Returns whether the owner approved.
///
/// `pub(crate)` because II · PROPOSE reuses it to ask before each flow lane. One
/// approval overlay for the whole app is the point - a second "are you sure?"
/// surface would be a second thing to get subtly wrong.
pub(crate) fn request_veto(
    app: &tauri::AppHandle,
    action: &str,
    summary: &str,
    args: &Value,
) -> Result<bool, String> {
    let veto_id = VETO_SEQ.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel::<bool>();

    // Listen BEFORE emitting so we can't miss a fast response.
    let handler = app.listen("praxis://veto-response", move |event| {
        if let Ok(resp) = serde_json::from_str::<VetoResponse>(event.payload()) {
            if resp.veto_id == veto_id {
                let _ = tx.send(resp.approved);
            }
        }
    });

    if let Err(e) = app.emit(
        "praxis://veto-request",
        VetoRequest {
            veto_id,
            action: action.to_string(),
            summary: summary.to_string(),
            args: args.clone(),
        },
    ) {
        // Don't leak the listener if we never managed to ask.
        app.unlisten(handler);
        return Err(format!("veto emit failed: {e}"));
    }

    let deadline = Instant::now() + Duration::from_secs(VETO_TTL_SECS);
    let outcome = loop {
        if let Err(err) = ensure_active() {
            break Err(err);
        }
        let now = Instant::now();
        if now >= deadline {
            break Err(format!("veto timed out after {VETO_TTL_SECS}s with no response — action '{action}' cancelled"));
        }
        let remaining = deadline.saturating_duration_since(now);
        match rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(approved) => break Ok(approved),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err("veto response channel disconnected — action cancelled".to_string())
            }
        }
    };
    app.unlisten(handler);
    outcome
}

// ── planner (OpenRouter) ────────────────────────────────────────────────────

/// Ask the planner for the next step given the goal + page snapshot. Returns the
/// raw decision object: { action, selector?, value?, credential?, summary, done? }.
///
/// The planner never sees a raw password. When it needs to type a credential it
/// returns `"value": "$SECRET"` (or a `"credential": "<vault-label>"` hint); Rust
/// substitutes the real value from the vault before calling the sidecar.
async fn plan_step(
    api_key: &str,
    goal: &str,
    snapshot: &Value,
    history: &[String],
) -> Result<Value, String> {
    let system = "You are Praxis' browser operator planner. You control a real Chromium browser \
via a fixed command set. Given the user's GOAL and the current PAGE (url, title, visible text, \
and a list of interactable elements each with a `selector`), decide the SINGLE next step. \
Respond with ONLY a compact JSON object, no prose, no markdown.\n\
Schema: {\"action\": one of \
[navigate, fill, click, type, press, read, submit_login, post, send, pay, purchase, \
create_account, accept_tos, human_takeover, done], \
\"selector\": <css selector from the element list, when relevant>, \
\"value\": <text to type; use the literal string \"$SECRET\" for a password you must NOT see>, \
\"url\": <for navigate>, \"key\": <for press>, \
\"credential\": <vault label to pull username/password from, when logging in>, \
\"summary\": <one human sentence describing exactly what this step does>, \
\"done\": <true only when the goal is fully achieved>}.\n\
Rules: Never invent a selector — only use ones present in the element list, or navigate first. \
For login, `fill` the username, then `fill` the password with value \"$SECRET\", then use action \
\"submit_login\" to click the submit control. Use pay/purchase/post/send/create_account/accept_tos \
for their real-world meaning so they can be human-confirmed. If a CAPTCHA or anti-bot wall blocks \
you, return action \"human_takeover\". Prefer reading the page (action \"read\") if you are unsure.";

    let user = json!({
        "goal": goal,
        "page": snapshot,
        "history": history,
    });

    let body = json!({
        "model": PLANNER_MODEL,
        "instructions": system,
        "input": user.to_string(),
        "max_output_tokens": 400,
        "reasoning": { "effort": "low" },
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CMD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("planner http build: {e}"))?;

    let resp = client
        .post(OPENAI_RESPONSES_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("planner request failed: {e}"))?;

    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("planner non-JSON response (HTTP {status}): {e}"))?;
    if !status.is_success() {
        let snippet: String = v.to_string().chars().take(300).collect();
        return Err(format!("planner HTTP {status}: {snippet}"));
    }

    let (input, output) = crate::hermes_bridge::openai_usage_tokens(&v);
    crate::usage::record_usage(
        "openai",
        PLANNER_MODEL,
        input,
        output,
        crate::hermes_bridge::openai_cost_usd(PLANNER_MODEL, input, output),
    );

    let content = crate::hermes_bridge::openai_response_text(&v)
        .ok_or_else(|| "planner returned no content".to_string())?;

    parse_decision(&content)
}

/// The model may wrap JSON in ```json fences or stray prose - extract the object.
fn parse_decision(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    let start = trimmed.find('{');
    let end = trimmed.rfind('}');
    let slice = match (start, end) {
        (Some(s), Some(e)) if e >= s => &trimmed[s..=e],
        _ => trimmed,
    };
    serde_json::from_str(slice)
        .map_err(|e| format!("planner emitted unparseable decision: {e} — {raw}"))
}

// ── credential injection ────────────────────────────────────────────────────

/// Pull username/password for a vault label. Password is returned separately and
/// NEVER logged. Uses vault.rs's Tauri command as a plain fn.
fn creds_for(label: &str) -> Option<(String, String)> {
    match crate::vault::vault_get(label.to_string()) {
        Ok(Some(entry)) => Some((entry.username, entry.password)),
        _ => None,
    }
}

/// Which field of a credential we still need from the owner.
#[derive(Clone, Copy)]
enum CredField {
    Username,
    Password,
}

impl CredField {
    fn as_str(self) -> &'static str {
        match self {
            CredField::Username => "username",
            CredField::Password => "password",
        }
    }
}

/// Monotonic id for credential prompts (same anti-stale-response guard as VETO_SEQ).
static CRED_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, serde::Serialize)]
struct CredentialRequest {
    cred_id: u64,
    label: String,
    /// "username" | "password" - which field the vault is missing.
    field: String,
    /// Whatever the operator already knows (e.g. the username when only the
    /// password is missing), so the overlay can show context. NEVER carries a secret.
    known_username: String,
}

#[derive(serde::Deserialize)]
struct CredentialResponse {
    cred_id: u64,
    /// The raw secret the owner typed once. Consumed Rust-side, persisted to the DPAPI
    /// vault, and NEVER echoed back to any event/log.
    value: String,
    /// The owner can decline - then the action fails closed exactly like a vault miss.
    provided: bool,
}

/// Give-a-password-ONCE flow. Emit `praxis://credential-request` and BLOCK for a
/// matching `praxis://credential-response` (with a TTL). On a real value we PERSIST
/// it to the DPAPI vault under `label` so the NEXT sovereign action reuses it and
/// never asks again. Fail-closed: a decline, a timeout, or an empty value returns
/// None and the caller aborts - we never proceed with a blank/placeholder secret.
fn request_credential(
    app: &tauri::AppHandle,
    label: &str,
    field: CredField,
    known_username: &str,
) -> Option<String> {
    let cred_id = CRED_SEQ.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel::<Option<String>>();

    // Listen BEFORE emitting so a fast reply can't be missed.
    let handler = app.listen("praxis://credential-response", move |event| {
        if let Ok(resp) = serde_json::from_str::<CredentialResponse>(event.payload()) {
            if resp.cred_id == cred_id {
                let val = if resp.provided && !resp.value.is_empty() {
                    Some(resp.value)
                } else {
                    None
                };
                let _ = tx.send(val);
            }
        }
    });

    if app
        .emit(
            "praxis://credential-request",
            CredentialRequest {
                cred_id,
                label: label.to_string(),
                field: field.as_str().to_string(),
                known_username: known_username.to_string(),
            },
        )
        .is_err()
    {
        app.unlisten(handler);
        return None;
    }

    let deadline = Instant::now() + Duration::from_secs(VETO_TTL_SECS);
    let outcome = loop {
        if ensure_active().is_err() {
            break None;
        }
        let now = Instant::now();
        if now >= deadline {
            break None;
        }
        let remaining = deadline.saturating_duration_since(now);
        match rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(value) => break Some(value),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
        }
    };
    app.unlisten(handler);

    let value = match outcome {
        Some(Some(v)) => v,
        _ => return None, // declined / timed out / empty - fail closed
    };

    // A stop received while the response was being delivered must prevent the
    // follow-on vault write as well as the page action.
    ensure_active().ok()?;

    // Persist so the next action reuses it (the "give it once" contract). Merge with
    // any existing entry so filling the password doesn't wipe a stored username, and
    // vice-versa. A persist failure still lets THIS action proceed (the owner just typed
    // it) but surfaces so he knows it wasn't saved.
    let existing = creds_for(label);
    let (username, password) = match field {
        CredField::Username => (value.clone(), existing.map(|(_, p)| p).unwrap_or_default()),
        CredField::Password => (existing.map(|(u, _)| u).unwrap_or_default(), value.clone()),
    };
    if let Err(e) = crate::vault::vault_set(label.to_string(), username, password, String::new()) {
        // Do NOT include the value in the message.
        let _ = app.emit(
            "praxis://sovereign-step",
            json!({ "action": "vault-warn", "summary": format!("couldn't save credential '{label}' to the vault: {e}") }),
        );
    }

    ensure_active().ok()?;
    Some(value)
}

/// Vault-first credential resolution with a one-time prompt on a miss. Consults the
/// DPAPI vault FIRST; only if the needed field is absent does it ask the owner (once),
/// persist the answer, and return it. Fail-closed: returns Err (aborting the action)
/// on decline/timeout so a blank secret can never reach the page.
fn resolve_credential(
    app: &tauri::AppHandle,
    label: &str,
    field: CredField,
) -> Result<String, String> {
    let existing = creds_for(label);
    // Vault hit for the needed field → reuse silently, no prompt.
    match (field, &existing) {
        (CredField::Password, Some((_, p))) if !p.is_empty() => return Ok(p.clone()),
        (CredField::Username, Some((u, _))) if !u.is_empty() => return Ok(u.clone()),
        _ => {}
    }
    // Miss → prompt the owner once, persist, reuse next time.
    let known_username = existing.map(|(u, _)| u).unwrap_or_default();
    match request_credential(app, label, field, &known_username) {
        Some(v) => Ok(v),
        None => Err(format!(
            "refused: no {} in vault for credential '{label}' and none provided — action aborted",
            field.as_str()
        )),
    }
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sovereign_start() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut slot = SIDECAR.lock().map_err(|e| e.to_string())?;
        if let Some(sc) = slot.as_mut() {
            // Already up? Confirm with a ping; if it's dead, respawn.
            if sidecar_call(sc, "ping", json!({})).is_ok() {
                return Ok("Sovereign browser already running.".to_string());
            }
        }
        let sc = spawn_sidecar()?;
        *slot = Some(sc);
        Ok("Sovereign browser started (persistent headed Chromium).".to_string())
    })
    .await
    .map_err(|e| format!("sovereign_start task panicked: {e}"))?
}

#[tauri::command]
pub async fn sovereign_abort(owner_token: Option<String>) -> Result<String, String> {
    let Some(owner_token) = normalized_owner_token(owner_token) else {
        return Ok("No matching sovereign action to abort; a scoped owner token is required.".to_string());
    };
    let _state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !RUNNING.load(Ordering::SeqCst) {
        record_pre_cancelled_owner(&owner_token)?;
        return Ok("Scoped sovereign cancellation recorded before run admission.".to_string());
    }
    {
        let active_owner = ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
        if !owner_request_matches(active_owner.as_deref(), Some(owner_token.as_str())) {
            record_pre_cancelled_owner(&owner_token)?;
            return Ok("Scoped sovereign cancellation recorded; the active run has a different owner.".to_string());
        }
    }
    STOP_REQUESTED.store(true, Ordering::SeqCst);
    drop(_state_guard);
    let wait_owner = owner_token.clone();
    tauri::async_runtime::spawn_blocking(move || wait_for_owner_terminal(&wait_owner))
        .await
        .map_err(|e| format!("sovereign terminal wait panicked: {e}"))??;
    Ok("Sovereign action cancellation requested.".to_string())
}

#[tauri::command]
pub async fn sovereign_abort_all() -> Result<String, String> {
    let _state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !RUNNING.load(Ordering::SeqCst) {
        return Ok("No active sovereign action to abort.".to_string());
    }
    STOP_REQUESTED.store(true, Ordering::SeqCst);
    drop(_state_guard);
    tauri::async_runtime::spawn_blocking(wait_for_sovereign_slot_terminal)
        .await
        .map_err(|e| format!("sovereign terminal wait panicked: {e}"))??;
    Ok("All sovereign action cancellation requested.".to_string())
}

/// Explicitly shut down the persistent Sovereign browser service. Ordinary
/// voice interruption and HALT use `sovereign_abort` instead so they never
/// force-kill an unrelated Chromium process tree.
#[tauri::command]
pub async fn sovereign_stop() -> Result<String, String> {
    // Make stop observable before waiting for the sidecar mutex.
    let state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    SERVICE_STOPPING.store(true, Ordering::SeqCst);
    STOP_REQUESTED.store(true, Ordering::SeqCst);
    drop(state_guard);
    let joined = tauri::async_runtime::spawn_blocking(|| {
        let mut slot = SIDECAR.lock().map_err(|e| e.to_string())?;
        if let Some(mut sc) = slot.take() {
            let _ = sidecar_call(&mut sc, "shutdown", json!({}));
            // Best-effort tree-kill in case shutdown didn't take (Windows: node
            // may be a grandchild of cmd, so kill by pid tree).
            let pid = sc.child.id();
            let _ = sc.child.kill();
            #[cfg(windows)]
            {
                let mut kill = Command::new("taskkill");
                kill.args(["/F", "/T", "/PID", &pid.to_string()]);
                kill.creation_flags(CREATE_NO_WINDOW);
                let _ = kill.spawn();
            }
            Ok("Sovereign browser stopped.".to_string())
        } else {
            Ok("Sovereign browser was not running.".to_string())
        }
    })
    .await;
    SERVICE_STOPPING.store(false, Ordering::SeqCst);
    joined.map_err(|e| format!("sovereign_stop task panicked: {e}"))?
}

/// Run the plan→act loop toward `goal`. Blocks (spawn_blocking) because the
/// sidecar protocol + the veto wait are synchronous.
#[tauri::command]
pub async fn sovereign_do(
    app: tauri::AppHandle,
    goal: String,
    owner_token: Option<String>,
    origin: Option<ActionOrigin>,
) -> Result<String, String> {
    // A caller that forgets to say who asked gets the gated half.
    let origin = origin.unwrap_or_default();
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("sovereign_do requires a non-empty goal".to_string());
    }
    let api_key = read_secret("OPENAI_API_KEY")
        .ok_or_else(|| "OPENAI_API_KEY not found in the secrets vault".to_string())?;

    let owner_token = normalized_owner_token(owner_token);
    {
    let state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if SERVICE_STOPPING.load(Ordering::SeqCst) {
        return Err("The sovereign browser service is stopping; wait for teardown to finish.".to_string());
    }
    if let Some(token) = owner_token.as_deref() {
        if take_pre_cancelled_owner(token)? {
            return Err("Sovereign action was cancelled before it started.".to_string());
        }
    }
    let mut active_owner = ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(
            "A sovereign action is already running — stop it before starting another.".to_string(),
        );
    }
    STOP_REQUESTED.store(false, Ordering::SeqCst);
    *active_owner = owner_token;
    drop(active_owner);
    drop(state_guard);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SovereignRunGuard;
        run_loop(&app, &goal, &api_key, origin)
    })
    .await
    .map_err(|e| format!("sovereign_do task panicked: {e}"))?
}

fn run_loop(
    app: &tauri::AppHandle,
    goal: &str,
    api_key: &str,
    origin: ActionOrigin,
) -> Result<String, String> {
    ensure_active()?;
    // Ensure the sidecar is up (auto-start so callers don't have to sequence it).
    {
        let mut slot = SIDECAR.lock().map_err(|e| e.to_string())?;
        let need_spawn = match slot.as_mut() {
            Some(sc) => sidecar_call(sc, "ping", json!({})).is_err(),
            None => true,
        };
        if need_spawn {
            *slot = Some(spawn_sidecar()?);
        }
    }

    let mut history: Vec<String> = Vec::new();
    let mut last_snapshot = json!({ "note": "no page loaded yet" });

    let level = crate::autonomy::effective_level();
    let max_steps = if origin.is_live() {
        MAX_STEPS_LIVE
    } else {
        MAX_STEPS
    };

    for step in 0..max_steps {
        ensure_active()?;
        // The planner is async (reqwest); this loop is synchronous (sidecar stdio
        // + veto wait), so drive the HTTP call on the shared Tauri runtime.
        let decision =
            tauri::async_runtime::block_on(plan_step(api_key, goal, &last_snapshot, &history))?;
        ensure_active()?;
        let action = decision
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let summary = decision
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or(&action)
            .to_string();

        let _ = app.emit(
            "praxis://sovereign-step",
            json!({ "step": step, "action": action, "summary": summary }),
        );

        if action == "done" || decision.get("done").and_then(Value::as_bool) == Some(true) {
            return Ok(format!("Goal complete: {summary}"));
        }

        if action == "human_takeover" {
            let _ = app.emit("praxis://sovereign-takeover", json!({ "reason": summary }));
            return Ok(format!(
                "Handed to you: {summary}. Solve it in the browser window, then re-run the goal."
            ));
        }

        // ── VETO GATE - unattended only, and only below the top detent ───────
        if requires_veto(&action, origin, level) {
            let redacted = redact_args(&decision);
            let approved = request_veto(app, &action, &summary, &redacted)?;
            if !approved {
                let _ = app.emit(
                    "praxis://sovereign-step",
                    json!({ "step": step, "action": "rejected", "summary": summary }),
                );
                return Ok(format!("Rejected by you — stopped before: {summary}"));
            }
        }

        // ── execute against the sidecar ─────────────────────────────────────
        ensure_active()?;
        let result = exec_decision(app, &action, &decision)?;
        ensure_active()?;
        history.push(format!("{action}: {summary}"));

        // Refresh the page snapshot for the next planning turn (unless the step
        // itself already returned one).
        last_snapshot = if action == "read" {
            result
        } else {
            let mut slot = SIDECAR.lock().map_err(|e| e.to_string())?;
            let sc = slot.as_mut().ok_or_else(|| "sidecar dropped".to_string())?;
            sidecar_call(sc, "read", json!({}))?
        };
    }

    Ok(format!(
        "Reached the {max_steps}-step limit without a 'done' — pausing. Last: {}",
        history.last().cloned().unwrap_or_default()
    ))
}

/// Never let a password ride into the veto event payload / logs.
fn redact_args(decision: &Value) -> Value {
    let mut v = decision.clone();
    if let Some(obj) = v.as_object_mut() {
        if obj.get("value").and_then(Value::as_str) == Some("$SECRET") {
            obj.insert("value".into(), Value::String("••••••••".into()));
        }
        obj.remove("credential");
    }
    v
}

/// Map a planner decision onto a concrete sidecar call, substituting credentials
/// from the vault at the last moment so the raw password only travels Rust→sidecar.
fn exec_decision(app: &tauri::AppHandle, action: &str, decision: &Value) -> Result<Value, String> {
    ensure_active()?;
    let sel = decision.get("selector").and_then(Value::as_str);
    let val = decision.get("value").and_then(Value::as_str);
    let credential = decision.get("credential").and_then(Value::as_str);

    // Resolve a "$SECRET" placeholder (or a username) to the real vault value.
    // Vault-FIRST: consult the DPAPI vault; on a miss, prompt the owner ONCE, persist,
    // and reuse next time (resolve_credential). FAIL CLOSED: a placeholder with no
    // usable vault entry AND no provided value ABORTS the action - never a blank
    // password, never the literal "$SECRET"/"$USERNAME" into the form field.
    let resolve_value = |raw: Option<&str>| -> Result<String, String> {
        match (raw, credential) {
            (Some("$SECRET"), Some(label)) => resolve_credential(app, label, CredField::Password),
            (Some("$USERNAME"), Some(label)) => resolve_credential(app, label, CredField::Username),
            // A placeholder with NO credential label can't be resolved - refuse
            // rather than typing the literal "$SECRET"/"$USERNAME" into the page.
            (Some("$SECRET"), None) | (Some("$USERNAME"), None) => Err(
                "refused: planner used a credential placeholder without a 'credential' label"
                    .to_string(),
            ),
            (Some(other), _) => Ok(other.to_string()),
            (None, _) => Ok(String::new()),
        }
    };

    // Resolve credentials BEFORE taking the sidecar lock - resolve_credential can
    // block on a human prompt for up to VETO_TTL_SECS, and we must not hold the
    // SIDECAR mutex during that wait (it would freeze every other sidecar call).
    let resolved_value = match action {
        "fill" | "type" => Some(resolve_value(val)?),
        _ => None,
    };

    let mut slot = SIDECAR.lock().map_err(|e| e.to_string())?;
    let sc = slot
        .as_mut()
        .ok_or_else(|| "sidecar not running".to_string())?;

    match action {
        "navigate" => {
            let url = decision
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "navigate needs a url".to_string())?;
            sidecar_call(sc, "navigate", json!({ "url": url }))
        }
        "fill" => {
            let selector = sel.ok_or_else(|| "fill needs a selector".to_string())?;
            let value = resolved_value.unwrap_or_default();
            sidecar_call(sc, "fill", json!({ "selector": selector, "value": value }))
        }
        // click and the approved irreversible actions all reduce to a click on a
        // control - they were separate `action` names purely so the veto gate
        // could classify them. By the time we're here they've been approved.
        "click" | "submit_login" | "post" | "send" | "pay" | "purchase" | "create_account"
        | "accept_tos" => {
            let selector = sel.ok_or_else(|| format!("{action} needs a selector"))?;
            let out = sidecar_call(sc, "click", json!({ "selector": selector }))?;
            let _ = app.emit(
                "praxis://sovereign-step",
                json!({ "action": action, "summary": "executed after approval" }),
            );
            Ok(out)
        }
        "type" => {
            let text = resolved_value.unwrap_or_default();
            sidecar_call(sc, "type", json!({ "text": text }))
        }
        "press" => {
            let key = decision
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("Enter");
            sidecar_call(sc, "press", json!({ "key": key }))
        }
        "read" => sidecar_call(sc, "read", json!({})),
        other => Err(format!("unknown planner action: {other}")),
    }
}

#[cfg(test)]
mod safety_tests {
    use super::{is_irreversible, owner_request_matches, requires_veto};
    use crate::autonomy::{ActionOrigin, Level};

    const IRREVERSIBLE: [&str; 7] = [
        "pay",
        "purchase",
        "post",
        "send",
        "submit_login",
        "create_account",
        "accept_tos",
    ];
    const GENERIC_MUTATIONS: [&str; 4] = ["click", "fill", "type", "press"];

    #[test]
    fn a_live_run_is_never_vetoed() {
        // The owner triggered it and is watching it happen. A veto overlay here asks
        // him to approve the click he just asked for. This is the single biggest
        // source of friction the split removes.
        for action in IRREVERSIBLE.iter().chain(GENERIC_MUTATIONS.iter()) {
            for level in [Level::Observe, Level::Approve, Level::Operator, Level::Full] {
                assert!(
                    !requires_veto(action, ActionOrigin::Live, level),
                    "live {action} vetoed at {level:?}"
                );
            }
        }
    }

    #[test]
    fn sovereign_clears_the_veto_entirely() {
        // The direct answer to "at maximum, does the dial clear every gate?".
        // It did not: `full` opened the loop but every click still prompted, so
        // paying and driving the browser were gated at the top detent.
        for action in IRREVERSIBLE.iter().chain(GENERIC_MUTATIONS.iter()) {
            assert!(
                !requires_veto(action, ActionOrigin::Unattended, Level::Full),
                "{action} still vetoed at IV \u{b7} SOVEREIGN"
            );
        }
    }

    #[test]
    fn execute_stops_only_at_the_irreversible_set() {
        for action in IRREVERSIBLE {
            assert!(
                requires_veto(action, ActionOrigin::Unattended, Level::Operator),
                "{action} must ask at III \u{b7} EXECUTE"
            );
        }
        for action in GENERIC_MUTATIONS {
            assert!(
                !requires_veto(action, ActionOrigin::Unattended, Level::Operator),
                "ordinary {action} should run unattended at III \u{b7} EXECUTE"
            );
        }
    }

    #[test]
    fn propose_asks_before_every_mutation() {
        // II \u{b7} PROPOSE finally means something: it acts, and it asks each time.
        for action in IRREVERSIBLE.iter().chain(GENERIC_MUTATIONS.iter()) {
            assert!(
                requires_veto(action, ActionOrigin::Unattended, Level::Approve),
                "{action} must ask at II \u{b7} PROPOSE"
            );
        }
    }

    #[test]
    fn the_four_detents_veto_differently() {
        // If any two rungs produce the same veto shape, a detent is decorative.
        let shape = |l: Level| {
            (
                requires_veto("click", ActionOrigin::Unattended, l),
                requires_veto("pay", ActionOrigin::Unattended, l),
            )
        };
        assert_eq!(shape(Level::Approve), (true, true));
        assert_eq!(shape(Level::Operator), (false, true));
        assert_eq!(shape(Level::Full), (false, false));
    }

    #[test]
    fn reading_the_page_is_never_a_veto() {
        for level in [Level::Approve, Level::Operator, Level::Full] {
            assert!(!requires_veto("read", ActionOrigin::Unattended, level));
            assert!(!requires_veto("navigate", ActionOrigin::Unattended, level));
        }
        // The label set itself is unchanged \u{2014} these are still the seven that cost
        // money, create an identity, or speak publicly in Zach\u{2019}s name.
        for action in IRREVERSIBLE {
            assert!(is_irreversible(action), "{action} must be irreversible");
        }
        for action in GENERIC_MUTATIONS {
            assert!(!is_irreversible(action));
        }
    }

    #[test]
    fn scoped_abort_matches_only_the_owning_sovereign_run() {
        assert!(owner_request_matches(Some("voice:one"), Some("voice:one")));
        assert!(!owner_request_matches(Some("voice:two"), Some("voice:one")));
        assert!(!owner_request_matches(None, Some("voice:one")));
        assert!(!owner_request_matches(Some("voice:one"), Some("")));
        assert!(!owner_request_matches(Some("voice:two"), None));
    }
}
