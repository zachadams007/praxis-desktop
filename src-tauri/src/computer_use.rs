//! Visible Codex Computer Use operator - the SEAMLESS path.
//!
//! The owner speaks a desktop goal → Praxis prepares an `@Computer` prompt, launches
//! (or reuses) Codex Desktop and prepares a scoped clipboard handoff. Deterministic
//! native actions remain instant; unmatched visible work is never auto-submitted
//! until Praxis can track and cancel the submitted Codex run authoritatively.
//!
//! Trivial goals ("open chrome", "focus obsidian") never touch Codex at all:
//! `native_ops` executes them directly through Windows in under a second.
//!
//! Every stage emits an `operator:phase` event so the in-app Operator overlay
//! (src/operator/OperatorOverlay.tsx) narrates what the machine is doing.
//!
//! The autonomy gate reads %LOCALAPPDATA%\Praxis\autonomy.txt, mirrored from the
//! frontend trust dial by `autonomy_sync` (called from src/shared/autonomy.ts).

use std::{
    collections::VecDeque,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::Emitter;

use crate::native_ops;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

// ─────────────────────────────────────────────────────────── run tracking ──

/// The spawned `codex app` launcher child (if this run spawned one). Codex
/// Desktop is single-instance, so this may be a short-lived shim - abort kills
/// it when still alive but does NOT force-quit an already-running Codex Desktop
/// (that could destroy unrelated work).
static OPERATOR_CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Serializes run-start and abort state transitions so an abort cannot land
/// between claiming the run and clearing a stale token.
static RUN_STATE_LOCK: Mutex<()> = Mutex::new(());
/// Set by `computer_use_abort`; polled between every stage of the flow.
static ABORTED: AtomicBool = AtomicBool::new(false);
/// One operator run at a time - a second concurrent run would fight over the
/// clipboard and the foreground window.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Optional voice/tool turn that owns the active run. `None` means the run can
/// only be stopped by an explicit unscoped HALT/stop-button request.
static ACTIVE_OWNER: Mutex<Option<String>> = Mutex::new(None);
static PRE_CANCELLED_OWNERS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const MAX_PRE_CANCELLED_OWNERS: usize = 64;
const OWNER_TERMINAL_TIMEOUT: Duration = Duration::from_secs(5);
const OWNER_TERMINAL_POLL: Duration = Duration::from_millis(10);

fn normalized_owner_token(owner_token: Option<String>) -> Option<String> {
    owner_token.and_then(|token| {
        let token = token.trim().to_string();
        (!token.is_empty()).then_some(token)
    })
}

/// No requested token is the explicit-global form. A supplied token must be
/// non-empty and exactly match the active owner, making stale stops harmless.
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
                "Timed out waiting for operator owner {owner_token} to become terminal."
            ));
        }
        thread::sleep(OWNER_TERMINAL_POLL);
    }
}

fn wait_for_operator_slot_terminal() -> Result<(), String> {
    let deadline = Instant::now() + OWNER_TERMINAL_TIMEOUT;
    while RUNNING.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the operator run to become terminal.".to_string());
        }
        thread::sleep(OWNER_TERMINAL_POLL);
    }
    Ok(())
}

struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        // Keep the state transition and child-slot cleanup ordered together. The
        // launcher handle belongs only to this run; dropping it does not kill an
        // already-running Codex Desktop process.
        let _state_guard = RUN_STATE_LOCK.lock().ok();
        if let Ok(mut slot) = OPERATOR_CHILD.lock() {
            let _ = slot.take();
        }
        if let Ok(mut owner) = ACTIVE_OWNER.lock() {
            *owner = None;
        }
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn abort_message(stage: &str) -> Option<String> {
    if ABORTED.load(Ordering::SeqCst) {
        return Some(format!("Operator run aborted {stage}."));
    }
    is_halted().then(|| format!("HALT ALL is thrown; operator run stopped {stage}."))
}

pub(crate) fn is_halted() -> bool {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("Praxis").join("halted.txt"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

// ─────────────────────────────────────────────────────────── phase events ──

/// Payload for `operator:phase` - the overlay's whole world.
/// Phases: launching | waiting | focusing | pasting | submitted | handed-off | error.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorPhase {
    phase: &'static str,
    detail: String,
    goal: String,
    autonomy: String,
    /// "codex" (visible operator) or "native" (direct Windows fast path).
    mode: &'static str,
    ts_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_phase(
    app: &tauri::AppHandle,
    phase: &'static str,
    detail: impl Into<String>,
    goal: &str,
    autonomy: &str,
    mode: &'static str,
) {
    let _ = app.emit(
        "operator:phase",
        OperatorPhase {
            phase,
            detail: detail.into(),
            goal: goal.to_string(),
            autonomy: autonomy.to_string(),
            mode,
            ts_ms: now_ms(),
        },
    );
}

// ─────────────────────────────────────────────────────────── autonomy gate ──

const AUTONOMY_LEVELS: [&str; 5] = ["observe", "suggest", "approve", "operator", "full"];

fn praxis_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not set; cannot write Praxis prompt handoff".to_string())?;
    let dir = base.join("Praxis");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {} failed: {e}", dir.display()))?;
    Ok(dir)
}

use crate::autonomy::{ActionOrigin, Level};

fn autonomy_file() -> Result<PathBuf, String> {
    praxis_dir().map(|d| d.join("autonomy.txt"))
}

/// The current trust-dial level as the shell sees it. Missing/invalid file falls
/// back to "operator" - the SAME default as DEFAULT_AUTONOMY in
/// src/shared/autonomy.ts, so shell and frontend agree before the dial is ever
/// touched. (Callers additionally gate in route.ts, so this is defense in depth.)
fn effective_autonomy() -> String {
    let level = autonomy_file()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if AUTONOMY_LEVELS.contains(&level.as_str()) {
        level
    } else {
        "operator".to_string()
    }
}

fn autonomy_unlocks_auto_submit(level: &str) -> bool {
    matches!(level, "operator" | "full")
}

/// Mirror the frontend trust dial into %LOCALAPPDATA%\Praxis\autonomy.txt.
/// Called from src/shared/autonomy.ts every time the dial changes (and once at
/// startup), so Rust-side gates always read the live level.
#[tauri::command]
pub fn autonomy_sync(level: String) -> Result<(), String> {
    let level = level.trim().to_lowercase();
    if !AUTONOMY_LEVELS.contains(&level.as_str()) {
        return Err(format!("unknown autonomy level '{level}'"));
    }
    let path = autonomy_file()?;
    std::fs::write(&path, &level).map_err(|e| format!("write {} failed: {e}", path.display()))
}

/// Mirror the frontend HALT breaker into %LOCALAPPDATA%\Praxis\halted.txt ("1"/"0").
/// Called from src/command/haltStore.ts every time the breaker flips (and once at
/// startup), so Rust-side gates with no localStorage - the native FlowRunner
/// (flow_runner.rs::is_halted) - read the live breaker exactly like orchestrate()'s
/// policy.isHalted() reads the localStorage flag. Same pattern as autonomy_sync.
#[tauri::command]
pub fn halt_sync(halted: bool) -> Result<(), String> {
    let path = praxis_dir()?.join("halted.txt");
    std::fs::write(&path, if halted { "1" } else { "0" })
        .map_err(|e| format!("write {} failed: {e}", path.display()))
}

// ───────────────────────────────────────────────────────── prompt handoff ──

fn codex_workspace() -> PathBuf {
    if let Some(path) = std::env::var_os("PRAXIS_CODEX_WORKSPACE") {
        let path = PathBuf::from(path);
        if path.exists() {
            return path;
        }
    }

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(user_profile);
        let command_deck = home.join("Desktop").join("command-deck");
        if command_deck.exists() {
            return command_deck;
        }
        if home.exists() {
            return home;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The handoff prompt for visible Codex computer use.
///
/// The ask-first paragraph is the whole reason this takes an origin. It used to
/// be emitted unconditionally, at every trust level - so even at IV · SOVEREIGN
/// the operator was being told to stop and ask before financial, account and
/// credential actions, which is exactly what that detent exists to permit.
///
/// Live: the owner is watching and answering in real time, so an instruction to ask
/// him first just adds a round trip to a question he already answered by saying
/// the thing out loud.
///
/// Unattended: keep it, and keep it verbatim - unless the dial is at the top, in
/// which case the level has already answered it.
fn prompt_for(goal: &str, origin: ActionOrigin, level: Level) -> String {
    let mut lines = vec![
        "@Computer",
        "",
        "Use visible Windows computer use for this goal. Keep the task scoped, show your work on the active desktop, operate quickly, and stop immediately if Zach interrupts or redirects you.",
    ];

    if origin.is_live() {
        lines.push("Zach is at the machine watching this run and directing it in real time. Do not ask for confirmation — he is the confirmation. Do what he asked.");
    } else if level.is_sovereign() {
        lines.push("This is an unattended run at IV \u{b7} SOVEREIGN. Zach has cleared every gate for it: complete the goal end to end, including payments, account creation, sign-in and form submission, without asking.");
    } else {
        lines.push("Ask before destructive, financial, account, message-sending, install/uninstall, security, privacy, password, or credential actions. Never create accounts or enter passwords without explicit confirmation.");
    }

    lines.extend(["", "Goal:", goal]);
    lines.join("\n")
}

fn write_prompt_file(prompt: &str) -> Result<PathBuf, String> {
    let path = praxis_dir()?.join("codex-computer-use-latest.txt");
    std::fs::write(&path, prompt).map_err(|e| format!("write {} failed: {e}", path.display()))?;
    Ok(path)
}

/// Standard base64 (RFC 4648). ASCII only, so the text survives any console code page.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Windows PowerShell 5.1 decodes a piped stdin with the console's OEM code page, so
/// UTF-8 piped straight into `$input | Set-Clipboard` arrived garbled: live 2026-09-17
/// every em dash in a Codex handoff pasted as "ΓÇö". The prompt now crosses the pipe as
/// base64 and is decoded as UTF-8 inside the script.
const CLIPBOARD_SCRIPT: &str = "$b = [Console]::In.ReadToEnd(); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())))";

pub(crate) fn copy_to_clipboard(prompt: &str) -> Result<(), String> {
    let mut command = Command::new("powershell.exe");
    hide_window(&mut command);
    let mut child = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            CLIPBOARD_SCRIPT,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start clipboard helper failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(base64_encode(prompt.as_bytes()).as_bytes())
            .map_err(|e| format!("write clipboard prompt failed: {e}"))?;
        // Dropped here: ReadToEnd needs end-of-file before it returns.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait for clipboard helper failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("clipboard helper exited with {}", output.status)
        } else {
            stderr
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClipboardSnapshot { Empty, Text(String) }

// Set-Clipboard cannot losslessly restore image, file-drop, HTML, or RTF data.
// Reject every non-plain-text format before changing the clipboard. -STA is
// required for Windows.Forms clipboard access.
const CLIPBOARD_SNAPSHOT_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
$d=[Windows.Forms.Clipboard]::GetDataObject()
if($null -eq $d){'__EMPTY__'; exit 0}
$allowed=@('UnicodeText','Text','System.String')
$foreign=@($d.GetFormats($true) | Where-Object { $allowed -notcontains $_ })
if($foreign.Count -gt 0){ [Console]::Error.Write(('non-text clipboard formats: '+($foreign -join ', '))); exit 3 }
$v=$d.GetData([Windows.Forms.DataFormats]::UnicodeText,$true)
if($null -eq $v){'__EMPTY__'}else{[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v))}
"#;

pub(crate) fn clipboard_snapshot() -> Result<ClipboardSnapshot, String> {
    let mut command = Command::new("powershell.exe");
    hide_window(&mut command);
    let output = command.args(["-STA", "-NoProfile", "-NonInteractive", "-Command", CLIPBOARD_SNAPSHOT_SCRIPT]).output()
        .map_err(|e| format!("read clipboard helper failed: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { format!("refusing to replace a non-text or unreadable clipboard (helper exited with {})", output.status) } else { format!("refusing to replace clipboard: {detail}") });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "__EMPTY__" { return Ok(ClipboardSnapshot::Empty); }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw).map_err(|e| format!("decode clipboard snapshot failed: {e}"))?;
    String::from_utf8(bytes).map(ClipboardSnapshot::Text).map_err(|e| format!("clipboard snapshot was not UTF-8: {e}"))
}

pub(crate) fn restore_clipboard(snapshot: ClipboardSnapshot) -> Result<(), String> {
    match snapshot {
        ClipboardSnapshot::Text(text) => copy_to_clipboard(&text),
        ClipboardSnapshot::Empty => {
            let mut command = Command::new("powershell.exe");
            hide_window(&mut command);
            let status = command.args(["-STA", "-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear()"]).status()
                .map_err(|e| format!("start clipboard clear helper failed: {e}"))?;
            if status.success() { Ok(()) } else { Err(format!("clipboard clear helper exited with {status}")) }
        }
    }
}

fn launch_codex_desktop(workspace: &PathBuf) -> Result<Child, String> {
    #[cfg(windows)]
    let candidates = ["codex.cmd", "codex.exe", "codex"];

    #[cfg(not(windows))]
    let candidates = ["codex"];

    let mut last_error = None;
    for candidate in candidates {
        let mut command = Command::new(candidate);
        hide_window(&mut command);
        command
            .arg("app")
            .arg(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                last_error = Some(e.to_string());
            }
            Err(e) => return Err(format!("launch `{candidate} app` failed: {e}")),
        }
    }

    Err(format!(
        "Could not find the Codex CLI on PATH; tried {}. Last error: {}",
        candidates.join(", "),
        last_error.unwrap_or_else(|| "not found".to_string())
    ))
}

// ───────────────────────────────────────────────────────── input injection ──

/// Ctrl+V via SendInput. `Key::Other(0x56)` is the raw VK code for 'V' - Electron
/// accelerators match on virtual keys, where a Unicode packet (VK_PACKET) can miss.
#[cfg(windows)]
pub(crate) fn send_paste() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| format!("Ctrl press failed: {e}"))?;
    let v = enigo.key(Key::Other(0x56), Direction::Click);
    // ALWAYS release Ctrl, even when the V click failed - a stuck modifier would
    // corrupt whatever the owner types next. (enigo also releases held keys on drop.)
    let release = enigo.key(Key::Control, Direction::Release);
    v.map_err(|e| format!("V press failed: {e}"))?;
    release.map_err(|e| format!("Ctrl release failed: {e}"))?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn send_enter() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input synthesizer init failed: {e}"))?;
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|e| format!("Enter press failed: {e}"))
}

// ──────────────────────────────────────────────────────────── the command ──

/// Open Codex Desktop for a foreground Computer Use task and prepare a scoped,
/// explicit handoff. Submission remains manual until a cancellable run handle exists.
/// Same JS call shape as before: `invoke("computer_use_operate", { goal })`.
///
/// `skip_native`: when `Some(true)`, skips real native actuation and goes straight
/// to the Codex handoff. Matched refusals are always terminal regardless of this
/// flag or autonomy; callers can never turn an unsafe local refusal into a handoff.
#[tauri::command]
pub async fn computer_use_operate(
    app: tauri::AppHandle,
    goal: String,
    skip_native: Option<bool>,
    owner_token: Option<String>,
    origin: Option<ActionOrigin>,
) -> Result<String, String> {
    // A caller that forgets to say who asked gets the gated half.
    let origin = origin.unwrap_or_default();
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("computer_use_operate requires a non-empty goal".to_string());
    }
    if is_halted() {
        return Err("HALT ALL is thrown; operator admission is closed.".to_string());
    }
    let skip_native = skip_native.unwrap_or(false);
    let owner_token = normalized_owner_token(owner_token);

    {
    let state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if let Some(token) = owner_token.as_deref() {
        if take_pre_cancelled_owner(token)? {
            return Err("Operator run was cancelled before it started.".to_string());
        }
    }
    let mut active_owner = ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(
            "An operator run is already in flight — abort it first or let it finish.".to_string(),
        );
    }
    ABORTED.store(false, Ordering::SeqCst);
    *active_owner = owner_token;
    drop(active_owner);
    drop(state_guard);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RunGuard;
        operate_blocking(&app, &goal, skip_native, origin)
    })
    .await
    .map_err(|e| format!("operator task panicked: {e}"))?
}

/// Abort the current operator run: stop the flow at the next stage boundary and
/// kill the `codex app` launcher this run spawned (if it's still alive). Does not
/// force-quit an already-running Codex Desktop.
#[tauri::command]
pub async fn computer_use_abort(
    app: tauri::AppHandle,
    owner_token: Option<String>,
) -> Result<String, String> {
    let Some(owner_token) = normalized_owner_token(owner_token) else {
        return Ok("No matching operator run to abort; a scoped owner token is required.".to_string());
    };
    let state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !RUNNING.load(Ordering::SeqCst) {
        record_pre_cancelled_owner(&owner_token)?;
        return Ok("Scoped operator cancellation recorded before run admission.".to_string());
    }
    {
        let active_owner = ACTIVE_OWNER.lock().map_err(|e| e.to_string())?;
        if !owner_request_matches(active_owner.as_deref(), Some(owner_token.as_str())) {
            record_pre_cancelled_owner(&owner_token)?;
            return Ok("Scoped operator cancellation recorded; the active run has a different owner.".to_string());
        }
    }
    ABORTED.store(true, Ordering::SeqCst);
    let child = {
        let mut slot = OPERATOR_CHILD.lock().map_err(|e| e.to_string())?;
        slot.take()
    };
    drop(state_guard);

    let killed = match child {
        Some(mut child) => match child.try_wait() {
            Ok(Some(_)) => false,
            _ => child.kill().is_ok(),
        },
        None => false,
    };

    let detail = if killed {
        "Aborted — killed the Codex launcher this run spawned."
    } else {
        "Aborted — no live launcher process to kill; stopping the automation flow."
    };
    emit_phase(&app, "error", detail, "", &effective_autonomy(), "codex");
    let wait_owner = owner_token.clone();
    tauri::async_runtime::spawn_blocking(move || wait_for_owner_terminal(&wait_owner))
        .await
        .map_err(|e| format!("operator terminal wait panicked: {e}"))??;
    Ok(detail.to_string())
}

/// Explicit global stop for HALT ALL and the Operator overlay's stop button.
#[tauri::command]
pub async fn computer_use_abort_all(app: tauri::AppHandle) -> Result<String, String> {
    let state_guard = RUN_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    if !RUNNING.load(Ordering::SeqCst) {
        if let Ok(mut slot) = OPERATOR_CHILD.lock() {
            let _ = slot.take();
        }
        return Ok("No active operator run to abort.".to_string());
    }
    ABORTED.store(true, Ordering::SeqCst);
    let child = {
        let mut slot = OPERATOR_CHILD.lock().map_err(|e| e.to_string())?;
        slot.take()
    };
    drop(state_guard);
    let killed = match child {
        Some(mut child) => match child.try_wait() {
            Ok(Some(_)) => false,
            _ => child.kill().is_ok(),
        },
        None => false,
    };
    let detail = if killed {
        "Aborted all operator work — killed the Codex launcher this run spawned."
    } else {
        "Aborted all operator work — stopping the automation flow."
    };
    emit_phase(&app, "error", detail, "", &effective_autonomy(), "codex");
    tauri::async_runtime::spawn_blocking(wait_for_operator_slot_terminal)
        .await
        .map_err(|e| format!("operator terminal wait panicked: {e}"))??;
    Ok(detail.to_string())
}

/// The whole flow, on a blocking thread (Win32 polling + sleeps live here).
///
/// `skip_native`: skip the internal native-op fast path entirely (the caller
/// already tried it and it failed) - go straight to the Codex handoff.
fn operate_blocking(
    app: &tauri::AppHandle,
    goal: &str,
    skip_native: bool,
    origin: ActionOrigin,
) -> Result<String, String> {
    let autonomy = effective_autonomy();
    let level = crate::autonomy::effective_level();
    // The native fast path is real actuation the owner asked for out loud. Gating it on the trust
    // dial meant a LIVE "open Chrome" was refused at I \u{b7} OBSERVE while he sat watching the
    // screen - the coupling this whole change exists to cut.
    let auto = origin.is_live() || autonomy_unlocks_auto_submit(&autonomy);

    if let Some(message) = abort_message("before work started") {
        return Err(message);
    }

    // Match once before the autonomy gate. A refusal now only ever means "which
    // window did you mean?" - every policy refusal was removed from
    // `match_simple_op`, so what is left is a genuine failure to resolve a target.
    // It still terminates locally rather than guessing.
    let matched_native = native_ops::match_simple_op(goal);
    if let Some(native_ops::SimpleOp::Refuse { message }) = &matched_native {
        emit_phase(app, "error", message.clone(), goal, &autonomy, "native");
        return Err(message.clone());
    }

    // ── Native fast path: deterministic open/focus/url/search/media, no Codex ─
    // Runs the SAME native_ops::try_native the voice router uses, so the two entry
    // points can never drift. The cheap pure match gates the "native" phase event
    // so a non-eligible goal never flashes a misleading native phase before Codex.
    if auto && !skip_native {
        if let Some(op) = matched_native {
            if let Some(message) = abort_message("before the native action") {
                return Err(message);
            }
            emit_phase(
                app,
                "launching",
                format!(
                    "Native fast path — {} directly, no Codex needed",
                    op.describe()
                ),
                goal,
                &autonomy,
                "native",
            );
            match native_ops::try_native(goal) {
                Ok(Some(msg)) => {
                    if let Some(message) = abort_message("after the native action") {
                        return Err(message);
                    }
                    emit_phase(
                        app,
                        "submitted",
                        format!("Done — {msg}"),
                        goal,
                        &autonomy,
                        "native",
                    );
                    return Ok(format!("{msg} (native fast path — no Codex needed)"));
                }
                Ok(None) => {
                    let message = "The matched local desktop action did not complete.".to_string();
                    emit_phase(app, "error", message.clone(), goal, &autonomy, "native");
                    return Err(message);
                }
                Err(e) => {
                    emit_phase(app, "error", e.clone(), goal, &autonomy, "native");
                    return Err(e);
                }
            }
        }
    }

    // ── Prompt handoff (file + clipboard) ───────────────────────────────────
    if let Some(message) = abort_message("before preparing the handoff") {
        return Err(message);
    }
    emit_phase(
        app,
        "launching",
        "Preparing the @Computer prompt",
        goal,
        &autonomy,
        "codex",
    );
    let prompt = prompt_for(goal, origin, level);
    let prompt_path = write_prompt_file(&prompt)?;
    if let Some(message) = abort_message("before copying the handoff") {
        return Err(message);
    }
    let clipboard = copy_to_clipboard(&prompt);
    let clipboard_status = match &clipboard {
        Ok(()) => "Copied the @Computer prompt to the clipboard.".to_string(),
        Err(e) => format!("Clipboard copy failed ({e}); use the saved prompt file instead."),
    };
    if let Some(message) = abort_message("after copying the handoff") {
        return Err(message);
    }

    // ── Detect a running Codex Desktop, else launch one ─────────────────────
    #[cfg(windows)]
    let codex_win = native_ops::win::find_codex_window();
    #[cfg(windows)]
    let reused = codex_win.is_some();
    #[cfg(not(windows))]
    let reused = false;

    if reused {
        if let Some(message) = abort_message("before reusing Codex Desktop") {
            return Err(message);
        }
        emit_phase(
            app,
            "launching",
            "Codex Desktop is already running — reusing its window",
            goal,
            &autonomy,
            "codex",
        );
    } else {
        if let Some(message) = abort_message("before launching Codex Desktop") {
            return Err(message);
        }
        let workspace = codex_workspace();
        emit_phase(
            app,
            "launching",
            format!("Launching Codex Desktop ({})", workspace.display()),
            goal,
            &autonomy,
            "codex",
        );
        let mut child = launch_codex_desktop(&workspace).map_err(|e| {
            emit_phase(app, "error", e.clone(), goal, &autonomy, "codex");
            e
        })?;
        let mut slot = match OPERATOR_CHILD.lock() {
            Ok(slot) => slot,
            Err(e) => {
                let _ = child.kill();
                return Err(e.to_string());
            }
        };
        // computer_use_abort sets ABORTED before taking this same child lock.
        // Checking while holding it closes the launch-before-registration race:
        // either this path kills the new child, or abort observes and kills it.
        if let Some(message) = abort_message("during Codex Desktop launch") {
            let _ = child.kill();
            return Err(message);
        }
        *slot = Some(child);
        drop(slot);
    }

    if let Some(message) = abort_message("before completing the handoff") {
        return Err(message);
    }

    // ── Below Operator: honest clipboard handoff (today's behavior) ─────────
    if !auto {
        let msg = format!(
            "Opened Codex Desktop for visible Computer Use. {clipboard_status} Prompt saved at {}. Autonomy is '{autonomy}' — auto-submit stays locked below Operator, so paste/submit the prepared prompt in Codex yourself.",
            prompt_path.display(),
        );
        emit_phase(
            app,
            "handed-off",
            format!("Autonomy '{autonomy}' — prompt copied; paste it in Codex to start"),
            goal,
            &autonomy,
            "codex",
        );
        return Ok(msg);
    }

    // Clipboard is the injection vehicle - without it, auto-submit would paste garbage.
    if clipboard.is_err() {
        let msg = format!(
            "Opened Codex Desktop for visible Computer Use. {clipboard_status} Prompt saved at {}. Auto-submit skipped because the clipboard copy failed.",
            prompt_path.display(),
        );
        emit_phase(
            app,
            "error",
            clipboard_status.clone(),
            goal,
            &autonomy,
            "codex",
        );
        emit_phase(
            app,
            "handed-off",
            "Paste the saved prompt in Codex to start",
            goal,
            &autonomy,
            "codex",
        );
        return Ok(msg);
    }

    // ── Auto-submit (Windows only) ──────────────────────────────────────────
    // A submitted Codex Desktop task currently exposes no cancellable run handle
    // back to Praxis. Fail safe: prepare and open the handoff, but never synthesize
    // Enter until that task can be tracked and stopped authoritatively.
    let msg = format!(
        "Opened Codex Desktop for visible Computer Use. {clipboard_status} Prompt saved at {}. Cancellable handoff gate: auto-submit is disabled until Praxis can stop the submitted Codex run itself; paste and submit the prepared prompt in Codex when ready.",
        prompt_path.display(),
    );
    emit_phase(
        app,
        "handed-off",
        "Prompt ready — submit it in Codex when you want the visible run to start",
        goal,
        &autonomy,
        "codex",
    );
    Ok(msg)
}

#[cfg(all(windows, any()))]
fn auto_submit(
    app: &tauri::AppHandle,
    goal: &str,
    autonomy: &str,
    codex_win: &mut Option<native_ops::win::WinInfo>,
    prompt_path: &std::path::Path,
    clipboard_status: &str,
) -> Result<String, String> {
    use native_ops::win;

    let aborted = || ABORTED.load(Ordering::SeqCst);
    let handoff_fallback = |detail: String| -> String {
        emit_phase(app, "error", detail.clone(), goal, autonomy, "codex");
        emit_phase(
            app,
            "handed-off",
            "The prompt is on the clipboard — paste it in Codex to start",
            goal,
            autonomy,
            "codex",
        );
        format!(
            "Opened Codex Desktop for visible Computer Use. {clipboard_status} Prompt saved at {}. Auto-submit fell back to manual: {detail}",
            prompt_path.display(),
        )
    };

    // Wait for the Codex window (it may still be booting) - up to 30s.
    if codex_win.is_none() {
        emit_phase(
            app,
            "waiting",
            "Waiting for the Codex Desktop window (up to 30s)",
            goal,
            autonomy,
            "codex",
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        while codex_win.is_none() && Instant::now() < deadline {
            if aborted() {
                return Ok("Operator run aborted while waiting for Codex Desktop.".to_string());
            }
            std::thread::sleep(Duration::from_millis(300));
            *codex_win = win::find_codex_window();
        }
    }

    let Some(target) = codex_win.clone() else {
        return Ok(handoff_fallback(
            "Codex Desktop window never appeared within 30s.".to_string(),
        ));
    };

    if aborted() {
        return Ok("Operator run aborted before focusing Codex Desktop.".to_string());
    }

    // Foreground it - verified; injecting into the wrong window is the one
    // unforgivable failure mode, so no keys fly unless Codex truly holds focus.
    emit_phase(
        app,
        "focusing",
        format!("Bringing \"{}\" to the foreground", target.title),
        goal,
        autonomy,
        "codex",
    );
    if !win::focus_window_verified(target.hwnd, 14, Duration::from_millis(150)) {
        return Ok(handoff_fallback(
            "Could not bring Codex Desktop to the foreground (foreground lock).".to_string(),
        ));
    }

    // Let Electron settle + focus its composer (Codex focuses it on activation).
    std::thread::sleep(Duration::from_millis(900));
    if aborted() {
        return Ok("Operator run aborted before injecting the prompt.".to_string());
    }
    if !win::is_foreground(target.hwnd)
        && !win::focus_window_verified(target.hwnd, 6, Duration::from_millis(150))
    {
        return Ok(handoff_fallback(
            "Codex lost the foreground before injection.".to_string(),
        ));
    }

    // Paste, re-verify focus (the owner may have alt-tabbed mid-flow), then submit.
    emit_phase(
        app,
        "pasting",
        "Injecting the prompt — Ctrl+V",
        goal,
        autonomy,
        "codex",
    );
    if let Err(e) = send_paste() {
        return Ok(handoff_fallback(format!("Paste injection failed: {e}")));
    }
    std::thread::sleep(Duration::from_millis(350));
    if aborted() {
        return Ok("Operator run aborted after paste, before submit.".to_string());
    }
    if !win::is_foreground(target.hwnd) {
        return Ok(handoff_fallback(
            "Focus moved away between paste and submit — NOT pressing Enter into another app."
                .to_string(),
        ));
    }
    if let Err(e) = send_enter() {
        return Ok(handoff_fallback(format!("Submit keystroke failed: {e}")));
    }

    emit_phase(
        app,
        "submitted",
        "Prompt submitted — Codex is driving the desktop",
        goal,
        autonomy,
        "codex",
    );
    Ok(format!(
        "Auto-submitted the @Computer prompt into Codex Desktop — visible Computer Use is running on the desktop. Prompt saved at {} in case Codex needs it again.",
        prompt_path.display(),
    ))
}

#[cfg(test)]
mod clipboard_tests {
    use super::{base64_encode, ClipboardSnapshot, CLIPBOARD_SCRIPT, CLIPBOARD_SNAPSHOT_SCRIPT};

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(plain.as_bytes()), encoded, "{plain:?}");
        }
    }

    #[test]
    fn non_ascii_prompt_text_crosses_the_pipe_as_ascii() {
        // Live 2026-09-17: " - " (E2 80 94) reached Codex as "ΓÇö" through the OEM code page.
        assert_eq!(base64_encode("—".as_bytes()), "4oCU");
        let encoded = base64_encode("Praxis live tester — “QA” · naïve ✓".as_bytes());
        assert!(encoded.is_ascii());
        assert!(!CLIPBOARD_SCRIPT.contains("$input"), "a piped $input is decoded with the OEM code page");
        assert!(CLIPBOARD_SCRIPT.contains("UTF8.GetString([Convert]::FromBase64String"));
    }

    #[test]
    fn owned_live_rejects_rich_clipboards_before_replacement() {
        assert!(CLIPBOARD_SNAPSHOT_SCRIPT.contains("GetFormats($true)"));
        assert!(CLIPBOARD_SNAPSHOT_SCRIPT.contains("non-text clipboard formats"));
        assert_eq!(ClipboardSnapshot::Empty, ClipboardSnapshot::Empty);
    }

    /// Touches the real clipboard, so it runs only on request:
    /// `cargo test --lib clipboard_tests -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_real_clipboard_round_trips_unicode() {
        let text = "Praxis live tester — “QA” · naïve ✓\nsecond line";
        super::copy_to_clipboard(text).expect("clipboard helper");
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"])
            .output()
            .expect("read clipboard");
        let got = String::from_utf8_lossy(&out.stdout).replace("\r\n", "\n");
        assert_eq!(got.trim_end(), text);
    }
}

#[cfg(test)]
mod safety_tests {
    use super::{abort_message, owner_request_matches, ABORTED};
    use std::sync::atomic::Ordering;

    #[test]
    fn active_operator_path_observes_abort_token() {
        let prior = ABORTED.swap(true, Ordering::SeqCst);
        assert!(abort_message("at a checkpoint").is_some());
        ABORTED.store(false, Ordering::SeqCst);
        assert!(abort_message("at a checkpoint").is_none());
        ABORTED.store(prior, Ordering::SeqCst);
    }

    #[test]
    fn scoped_abort_matches_only_the_owning_run() {
        assert!(owner_request_matches(Some("voice:one"), Some("voice:one")));
        assert!(!owner_request_matches(Some("voice:two"), Some("voice:one")));
        assert!(!owner_request_matches(None, Some("voice:one")));
        assert!(!owner_request_matches(Some("voice:one"), Some("")));
        assert!(!owner_request_matches(Some("voice:two"), None));
    }
}
