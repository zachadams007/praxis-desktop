//! LIVE team builds: Praxis operates each agent's OWN desktop app on screen.
//!
//! (Quill/Cursor stays behind its breaker.) HYBRID keeps the headless `agent_delegate`.
//!
//! How each step runs (every UI name below was measured live 2026-09-22):
//! 1. Focus the app window found by process (claude.exe titled "Claude"; ChatGPT.exe, the
//!    Codex app, titled "ChatGPT") - never by a title substring a browser tab could share.
//! 2. New chat. Claude: `New` → the folder button after `Local` → the folder's RadioButton
//!    or `Open folder…` → the Windows folder dialog (Win32: control 1152 ← path, IDOK) →
//!    `Trust workspace` only when the dialog's text is exactly this folder → `Model:` →
//!    `Sonnet …`. Codex: `New chat` (projectless; Full access writes the absolute folder).
//! 3. Click the composer (`Prompt` / `Do anything`) with a real mouse click, paste the step
//!    (plain-text clipboard saved and restored; a rich clipboard is never replaced - the
//!    step is typed instead), check `Send` became enabled, press Enter.
//! 4. Watch the agent's own transcript: Claude `~/.claude/projects/<slug>/*.jsonl`, Codex
//!    `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, bound by a marker in the prompt.
//!    Done = Claude's `end_turn` assistant message / Codex's `task_complete` after OUR
//!    message. UI text is not used for completion: Claude's sidebar says "Running …" for
//!    every other session (the orchestrator's included).
//! 5. Screenshots of the app window at start, mid-step and done go to
//!    `<folder>\.praxis\live\`.
//! Follow-ups (Praxis's re-prompts) go into the SAME chat: Codex reopens it with
//! `codex://threads/<id>`, Claude by its session title in the sidebar.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
struct OwnedSession {
    marker: String,
    transcript: PathBuf,
    /// Claude: the session's title as its header shows it; Codex: the thread id.
    handle: String,
    sends: u32,
}

static OWNED: LazyLock<Mutex<HashMap<String, OwnedSession>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CANCELLED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Debug)]
struct ActiveRun {
    agent: String,
    hwnd: isize,
    /// The window title Praxis drives and the marker of THIS chat's first message: a
    /// Stop only presses Esc when that chat is the one on screen.
    app_title: String,
    chat_marker: String,
    submitted: bool,
}
static ACTIVE: LazyLock<Mutex<HashMap<String, ActiveRun>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct ActiveGuard(Option<String>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let (Some(id), Ok(mut a)) = (self.0.take(), ACTIVE.lock()) {
            a.remove(&id);
        }
    }
}

/// Restores the owner's plain-text clipboard even when a later step fails.
struct ClipboardRestore(Option<crate::computer_use::ClipboardSnapshot>);
impl ClipboardRestore {
    fn restore(&mut self) -> Option<String> {
        self.0.take().and_then(|s| crate::computer_use::restore_clipboard(s).err())
    }
}
impl Drop for ClipboardRestore {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Which app runs which agent, and the names Praxis looks for in it.
#[derive(Debug)]
struct App {
    agent_name: &'static str,
    exe_stem: &'static str,
    title: &'static str,
    composer: &'static str,
}

fn app_for(agent: &str) -> Result<App, String> {
    match agent {
        "claude" => Ok(App { agent_name: "Forge", exe_stem: "claude", title: "Claude", composer: "Prompt" }),
        "codex" => Ok(App { agent_name: "Vega", exe_stem: "chatgpt", title: "ChatGPT", composer: "Do anything" }),
        // Quill stays behind its breaker: never type into Cursor from here.
        "cursor" => Err("Quill's Cursor rail is off; LIVE did not open or type into Cursor.".into()),
        other => Err(format!("unknown LIVE agent {other:?} (expected claude or codex)")),
    }
}

fn cancelled(id: Option<&str>) -> bool {
    id.is_some_and(|id| CANCELLED.lock().map(|s| s.contains(id)).unwrap_or(false))
}

/// Stop points between every UI action: a locked screen, HALT ALL, or a cancelled run.
fn checkpoint(id: Option<&str>, stage: &str) -> Result<(), String> {
    #[cfg(windows)]
    if crate::native_ops::win::screen_locked() {
        return Err(format!("LIVE stopped at {stage}: the screen is locked."));
    }
    if crate::computer_use::is_halted() {
        return Err(format!("LIVE stopped at {stage}: HALT ALL is thrown."));
    }
    if cancelled(id) {
        return Err(format!("LIVE stopped at {stage}: the run was cancelled."));
    }
    Ok(())
}

// ── window + controls ────────────────────────────────────────────────────────

#[cfg(windows)]
fn find_app_window(app: &App) -> Option<crate::native_ops::win::WinInfo> {
    crate::native_ops::win::list_windows()
        .into_iter()
        .find(|w| w.exe_stem.eq_ignore_ascii_case(app.exe_stem) && w.title == app.title)
}

#[cfg(windows)]
fn focus_app(app: &App) -> Result<isize, String> {
    if find_app_window(app).is_none() {
        let launch = if app.exe_stem == "claude" { "Claude" } else { "Codex" };
        crate::desktop_ops::open_app(launch).map_err(|e| format!("couldn't open {}: {e}", app.title))?;
    }
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Some(w) = find_app_window(app) {
            if crate::native_ops::win::focus_window_verified(w.hwnd, 12, Duration::from_millis(120)) {
                std::thread::sleep(Duration::from_millis(250));
                return Ok(w.hwnd);
            }
            return Err(format!("couldn't bring {} to the front", app.title));
        }
        if Instant::now() >= deadline {
            return Err(format!("{} didn't show a window within 25 s", app.title));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn controls(app: &App) -> Vec<crate::ui_elements::UiElement> {
    crate::ui_elements::list_blocking(Some(app.title.to_string())).unwrap_or_default()
}

fn find<'a>(els: &'a [crate::ui_elements::UiElement], pred: impl Fn(&crate::ui_elements::UiElement) -> bool) -> Option<&'a crate::ui_elements::UiElement> {
    els.iter().find(|e| pred(e))
}

/// A real mouse click on a control Praxis has already found by name (UIA Invoke is a
/// no-op on these React apps). No "did the screen change" retry: menus and composers
/// are checked by the caller.
#[cfg(windows)]
fn press(el: &crate::ui_elements::UiElement) -> Result<(), String> {
    crate::desktop_ops::click_screen_point(el.x, el.y).map(|_| ())?;
    std::thread::sleep(Duration::from_millis(450));
    Ok(())
}

#[cfg(windows)]
fn press_named(app: &App, what: &str, pred: impl Fn(&crate::ui_elements::UiElement) -> bool) -> Result<String, String> {
    let els = controls(app);
    let el = find(&els, pred).ok_or_else(|| format!("{}: couldn't find {what}", app.title))?;
    let name = el.name.clone();
    press(el)?;
    Ok(name)
}

fn is_type(e: &crate::ui_elements::UiElement, t: &str) -> bool {
    e.control_type.eq_ignore_ascii_case(t)
}

// ── one project folder per app ───────────────────────────────────────────────

/// Where every Praxis build lives (`%USERPROFILE%\praxis-builds`).
fn builds_root() -> PathBuf {
    home().join("praxis-builds")
}

/// The folder a LIVE chat is opened IN. A step in an existing repo (e.g. `Desktop\praxis`) uses
/// that repo, which is already one of the main folders.
pub(crate) fn session_root(folder: &Path) -> PathBuf {
    session_root_in(&builds_root(), folder)
}

pub(crate) fn session_root_in(root: &Path, folder: &Path) -> PathBuf {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (r, f) = (norm(root), norm(folder));
    if f.starts_with(&format!("{r}\\")) {
        root.to_path_buf()
    } else {
        folder.to_path_buf()
    }
}

/// Claude's weekly usage as its composer shows it (`Usage: … Weekly · all models: 93%, …`).
fn claude_weekly_pct(app: &App) -> Option<u32> {
    let name = controls(app).into_iter().find(|e| e.name.starts_with("Usage:"))?.name;
    parse_weekly_pct(&name)
}

pub(crate) fn parse_weekly_pct(usage: &str) -> Option<u32> {
    let rest = &usage[usage.find("Weekly")?..];
    let pct = rest.find('%')?;
    let digits: String = rest[..pct].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().ok()
}

// ── Claude desktop: new session in the build folder ──────────────────────────

/// Fill the Windows folder picker that `Open folder…` opened (Win32, no typing).
#[cfg(windows)]
fn pick_folder_in_dialog(process: &str, folder: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r##"
param([string]$Path, [string]$Proc)
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class Fd {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr d, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static IntPtr Dialog(uint[] pids) { IntPtr f = IntPtr.Zero; EnumWindows((h,l)=>{ uint pid; GetWindowThreadProcessId(h, out pid); var c=new StringBuilder(64); GetClassName(h,c,64); if (Array.IndexOf(pids,pid)>=0 && c.ToString()=="#32770" && IsWindowVisible(h)) { f=h; return false; } return true; }, IntPtr.Zero); return f; }
  public static IntPtr Edit(IntPtr combo) { IntPtr e = IntPtr.Zero; EnumChildWindows(combo, (h,l)=>{ var c=new StringBuilder(64); GetClassName(h,c,64); if (c.ToString()=="Edit") { e=h; return false; } return true; }, IntPtr.Zero); return e; }
}
"@
$pids = [uint32[]]@(Get-Process $Proc -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$d = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $d -eq [IntPtr]::Zero; $i++) { $d = [Fd]::Dialog($pids); if ($d -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }
if ($d -eq [IntPtr]::Zero) { [Console]::Error.Write('no folder dialog appeared'); exit 1 }
$combo = [Fd]::GetDlgItem($d, 1152); $edit = if ($combo -ne [IntPtr]::Zero) { [Fd]::Edit($combo) } else { [IntPtr]::Zero }
if ($edit -eq [IntPtr]::Zero) { $edit = $combo }
if ($edit -eq [IntPtr]::Zero) { [Console]::Error.Write('no folder field in the dialog'); exit 2 }
[void][Fd]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Path)
[void][Fd]::SendMessage([Fd]::GetDlgItem($d, 1), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 900
if ([Fd]::IsWindowVisible($d)) { [Console]::Error.Write('the folder dialog did not accept the path'); exit 3 }
"##;
    let file = std::env::temp_dir().join("praxis-live-pick-folder.ps1");
    std::fs::write(&file, SCRIPT).map_err(|e| format!("write folder-picker helper failed: {e}"))?;
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&file)
        .arg("-Path")
        .arg(folder)
        .arg("-Proc")
        .arg(process)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("folder-picker helper failed to start: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("the {process} folder dialog: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[cfg(windows)]
fn claude_new_session(app: &App, folder: &Path, id: Option<&str>) -> Result<(), String> {
    let base = folder.file_name().and_then(|n| n.to_str()).ok_or("the build folder has no name")?.to_string();
    let full = folder.to_string_lossy().to_string();
    // A narrow window hides the sidebar (and `New`) behind `Show sidebar`.
    if find(&controls(app), |e| e.name == "New" && is_type(e, "Button")).is_none() {
        press_named(app, "Show sidebar", |e| e.name == "Show sidebar")?;
    }
    if let Some(code) = find(&controls(app), |e| e.name == "Code" && is_type(e, "RadioButton")).cloned() {
        press(&code)?;
    }
    press_named(app, "New", |e| e.name == "New" && is_type(e, "Button"))?;
    checkpoint(id, "new Claude session")?;
    std::thread::sleep(Duration::from_millis(600));
    // The folder button sits right after `Local` in the new-session header.
    let els = controls(app);
    let local = els.iter().position(|e| e.name == "Local" && is_type(e, "Button")).ok_or("Claude's new-session view has no `Local` environment button")?;
    let folder_btn = els.iter().skip(local + 1).find(|e| is_type(e, "Button")).cloned().ok_or("Claude's new-session view has no folder button")?;
    if folder_btn.name != base {
        press(&folder_btn)?;
        let menu = controls(app);
        if let Some(recent) = find(&menu, |e| e.name == base && is_type(e, "RadioButton")).cloned() {
            press(&recent)?;
        } else {
            let open = find(&menu, |e| e.name.starts_with("Open folder") && is_type(e, "MenuItem")).cloned().ok_or("Claude's folder menu has no `Open folder…`")?;
            press(&open)?;
            pick_folder_in_dialog("claude", &full)?;
            std::thread::sleep(Duration::from_millis(800));
        }
        // First use of a folder asks to trust it. Only this exact build folder is trusted.
        if crate::ui_elements::name_present(app.title, "Trust workspace") {
            if !crate::ui_elements::name_present(app.title, &full) {
                return Err(format!("Claude asked to trust a folder that isn't {full}; refusing."));
            }
            press_named(app, "Trust workspace", |e| e.name == "Trust workspace")?;
        }
    }
    checkpoint(id, "Claude folder chosen")?;
    if find(&controls(app), |e| e.name == base && is_type(e, "Button")).is_none() {
        return Err(format!("Claude's new session did not show the folder {base}; refusing to type."));
    }
    Ok(())
}

/// Forge runs on Sonnet in LIVE (weekly limit): pick it and confirm it.
#[cfg(windows)]
fn claude_select_sonnet(app: &App) -> Result<(), String> {
    let model = find(&controls(app), |e| e.name.starts_with("Model:") && is_type(e, "Button")).cloned().ok_or("Claude shows no `Model:` button")?;
    if model.name.starts_with("Model: Sonnet") {
        return Ok(());
    }
    press(&model)?;
    press_named(app, "Sonnet in the model menu", |e| e.name.starts_with("Sonnet") && is_type(e, "RadioButton"))?;
    if find(&controls(app), |e| e.name.starts_with("Model: Sonnet")).is_some() {
        Ok(())
    } else {
        Err("Claude did not confirm `Model: Sonnet`; refusing to send the step on another model.".into())
    }
}

/// The current Claude session's title, from its header (`<title>, rename session`).
fn claude_header(app: &App) -> Option<String> {
    controls(app).into_iter().find_map(|e| e.name.strip_suffix(", rename session").map(str::to_string))
}

/// Bring Forge's own session back into view for a follow-up.
#[cfg(windows)]
fn claude_open_session(app: &App, title: &str) -> Result<(), String> {
    if claude_header(app).as_deref() == Some(title) {
        return Ok(());
    }
    if find(&controls(app), |e| e.name == "New" && is_type(e, "Button")).is_none() {
        press_named(app, "Show sidebar", |e| e.name == "Show sidebar")?;
    }
    press_named(app, "Forge's session in the sidebar", |e| {
        is_type(e, "Button") && e.name.contains(title) && !e.name.ends_with(", rename session") && !e.name.starts_with("More options for")
    })?;
    std::thread::sleep(Duration::from_millis(700));
    if claude_header(app).as_deref() == Some(title) {
        Ok(())
    } else {
        Err(format!("couldn't bring Forge's session {title:?} back into view; refusing to type into another chat."))
    }
}

// ── Codex app ────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn codex_new_chat(app: &App, root: &Path) -> Result<(), String> {
    let els = controls(app);
    if let Some(mode) = find(&els, |e| e.name.starts_with("Switch mode, current mode:")) {
        if !mode.name.ends_with("Codex") {
            return Err(format!("the ChatGPT app is in {:?}, not Codex; refusing to type.", mode.name));
        }
    }
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    // The project row for this folder; created once through `Add new project` when missing.
    let row = |els: &[crate::ui_elements::UiElement]| find(els, |e| e.name == name && is_type(e, "Button")).cloned();
    let mut project = row(&controls(app));
    if project.is_none() {
        codex_create_project(app, root)?;
        std::thread::sleep(Duration::from_millis(800));
        project = row(&controls(app));
    }
    let project = project.ok_or_else(|| format!("the Codex app shows no project {name:?} after creating it."))?;
    // `Start new chat in <project>` only appears while the pointer is over the project row.
    crate::desktop_ops::move_pointer(project.x, project.y)?;
    std::thread::sleep(Duration::from_millis(450));
    let start = format!("Start new chat in {name}");
    press_named(app, &start, |e| e.name == start && is_type(e, "Button"))?;
    std::thread::sleep(Duration::from_millis(600));
    if find(&controls(app), |e| e.name == app.composer && is_type(e, "Edit")).is_none() {
        return Err("the Codex app showed no composer after `New chat`.".into());
    }
    Ok(())
}

/// Codex's `Add new project` → `Local` → `Next` → `Choose source folders` → the Windows
/// folder dialog → `Create project` (measured 2026-09-24).
#[cfg(windows)]
fn codex_create_project(app: &App, root: &Path) -> Result<(), String> {
    press_named(app, "Add new project", |e| e.name == "Add new project" && is_type(e, "Button"))?;
    press_named(app, "Local", |e| e.name.starts_with("Local") && is_type(e, "RadioButton"))?;
    press_named(app, "Next", |e| e.name == "Next" && is_type(e, "Button"))?;
    std::thread::sleep(Duration::from_millis(600));
    press_named(app, "Choose source folders", |e| e.name == "Choose source folders" && is_type(e, "Button"))?;
    pick_folder_in_dialog("ChatGPT", &root.to_string_lossy())?;
    std::thread::sleep(Duration::from_millis(700));
    press_named(app, "Create project", |e| e.name == "Create project" && is_type(e, "Button"))?;
    Ok(())
}

// ── compose + send ───────────────────────────────────────────────────────────

#[cfg(windows)]
fn type_text(text: &str) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("keyboard init failed: {e}"))?;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            // Shift+Enter: a new line in the composer, not a send.
            enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
            let r = enigo.key(Key::Return, Direction::Click);
            enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
            r.map_err(|e| e.to_string())?;
        }
        if !line.is_empty() {
            enigo.text(line.trim_end_matches('\r')).map_err(|e| format!("typing failed: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn clear_composer() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("keyboard init failed: {e}"))?;
    enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
    let a = enigo.key(Key::Other(0x41), Direction::Click);
    enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
    a.map_err(|e| e.to_string())?;
    enigo.key(Key::Backspace, Direction::Click).map_err(|e| e.to_string())
}

/// Put the step into the composer and send it. Returns a note about the clipboard.
#[cfg(windows)]
fn compose_and_send(app: &App, hwnd: isize, text: &str, id: Option<&str>) -> Result<Option<String>, String> {
    let composer = find(&controls(app), |e| e.name == app.composer && is_type(e, "Edit")).cloned()
        .ok_or_else(|| format!("{} shows no `{}` composer", app.title, app.composer))?;
    press(&composer)?;
    clear_composer()?;
    checkpoint(id, "before typing the step")?;
    let mut restore = ClipboardRestore(None);
    match crate::computer_use::clipboard_snapshot() {
        Ok(snap) => {
            restore.0 = Some(snap);
            crate::computer_use::copy_to_clipboard(text)?;
            if !crate::native_ops::win::is_foreground(hwnd) {
                return Err(format!("{} lost the foreground before the paste; nothing was sent.", app.title));
            }
            crate::computer_use::send_paste()?;
        }
        // The owner's clipboard holds an image or rich text: never overwrite it - type instead.
        Err(_) => type_text(text)?,
    }
    std::thread::sleep(Duration::from_millis(500));
    if find(&controls(app), |e| e.name == "Send" && e.enabled).is_none() {
        return Err(format!("the step didn't land in {}'s composer (Send stayed disabled); nothing was sent.", app.title));
    }
    if !crate::native_ops::win::is_foreground(hwnd) {
        return Err(format!("{} lost the foreground before Enter; nothing was sent.", app.title));
    }
    checkpoint(id, "before sending the step")?;
    // Marked submitted BEFORE Enter: a Stop that lands between Enter and the bookkeeping
    // must still interrupt the agent, never report "stopped before sending".
    if let Some(id) = id {
        if let Some(a) = ACTIVE.lock().map_err(|e| e.to_string())?.get_mut(id) {
            a.submitted = true;
        }
    }
    crate::computer_use::send_enter()?;
    std::thread::sleep(Duration::from_millis(400));
    Ok(restore.restore())
}

// ── the agent's own transcript ───────────────────────────────────────────────

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
}

/// Claude Code's project folder name for a working directory: every non-alphanumeric
/// character becomes `-` (`C:\Users\dev\Desktop\praxis` → `C--Users-dev-Desktop-praxis`).
pub(crate) fn claude_project_slug(folder: &str) -> String {
    folder.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn jsonl_files(dir: &Path, depth: u8, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if depth > 0 {
                jsonl_files(&p, depth - 1, since, out);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && entry.metadata().and_then(|m| m.modified()).is_ok_and(|m| m >= since)
        {
            out.push(p);
        }
    }
}

/// The first 256 KB of a file - the marker sits in the chat's first messages, so a
/// multi-megabyte transcript is never read whole while binding.
fn head(path: &Path) -> String {
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(256 * 1024).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn bind_transcript(agent: &str, folder: &str, marker: &str, since: SystemTime) -> Option<PathBuf> {
    let mut files = Vec::new();
    if agent == "claude" {
        let root = home().join(".claude").join("projects");
        jsonl_files(&root.join(claude_project_slug(&session_root(Path::new(folder)).to_string_lossy())), 0, since, &mut files);
        if files.is_empty() {
            jsonl_files(&root, 1, since, &mut files);
        }
    } else {
        jsonl_files(&home().join(".codex").join("sessions"), 3, since, &mut files);
    }
    files.into_iter().find(|p| head(p).contains(marker))
}

enum Progress {
    Waiting,
    Working,
    Done(String),
    Failed(String),
}

fn text_of(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Where the agent is, judged only from its transcript AFTER the line carrying `marker`.
pub(crate) fn progress_after(agent: &str, body: &str, marker: &str) -> ProgressView {
    let lines: Vec<&str> = body.lines().collect();
    // The FIRST line carrying this send's marker is the message itself; Claude later
    // re-logs the prompt ("last-prompt"), which must not move the starting point.
    let Some(start) = lines.iter().position(|l| l.contains(marker)) else { return ProgressView::Waiting };
    let mut working = false;
    let mut our_turn: Option<String> = None;
    for line in &lines[start + 1..] {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        working = true;
        if foreign_user_message(agent, &v, marker) {
            return ProgressView::Failed("someone typed a new message into this chat before the agent finished; Praxis isn't claiming a reply that may not be to its step".into());
        }
        if agent == "codex" {
            if let Some(p) = v.get("payload") {
                let kind = p.get("type").and_then(|t| t.as_str());
                if kind == Some("task_started") && our_turn.is_none() {
                    our_turn = p.get("turn_id").and_then(|t| t.as_str()).map(str::to_string);
                }
                if kind == Some("task_complete") {
                    let theirs = p.get("turn_id").and_then(|t| t.as_str());
                    if let (Some(ours), Some(theirs)) = (our_turn.as_deref(), theirs) {
                        if ours != theirs {
                            continue; // an older turn finishing, not ours
                        }
                    }
                }
            }
        }
        if agent == "claude" {
            let msg = v.get("message");
            let is_final = v.get("type").and_then(|t| t.as_str()) == Some("assistant")
                && msg.and_then(|m| m.get("stop_reason")).and_then(|s| s.as_str()) == Some("end_turn");
            if is_final {
                let reply = msg.and_then(|m| m.get("content")).map(text_of).unwrap_or_default();
                let err = v.get("isApiErrorMessage").and_then(|b| b.as_bool()).unwrap_or(false);
                return if err { ProgressView::Failed(reply) } else { ProgressView::Done(reply) };
            }
        } else if let Some(p) = v.get("payload") {
            if p.get("type").and_then(|t| t.as_str()) == Some("task_complete") {
                if let Some(e) = p.get("error").filter(|e| !e.is_null()) {
                    let m = e.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| e.to_string());
                    return ProgressView::Failed(m);
                }
                let reply = p.get("last_agent_message").and_then(|m| m.as_str()).unwrap_or("").to_string();
                return ProgressView::Done(reply);
            }
        }
    }
    if working { ProgressView::Working } else { ProgressView::Waiting }
}

/// A user message after ours that isn't Praxis's (tool results and marker lines don't count).
fn foreign_user_message(agent: &str, v: &serde_json::Value, marker: &str) -> bool {
    if agent == "claude" {
        if v.get("type").and_then(|t| t.as_str()) != Some("user") || v.get("isMeta").and_then(|b| b.as_bool()) == Some(true) {
            return false;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let is_tool_result = content
            .and_then(|c| c.as_array())
            .is_some_and(|a| a.iter().any(|i| i.get("type").and_then(|t| t.as_str()) == Some("tool_result")));
        let text = content.map(text_of).unwrap_or_default();
        !is_tool_result && !text.trim().is_empty() && !text.contains(marker) && !text.contains("praxis-live-")
    } else {
        let p = v.get("payload");
        p.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message")
            && !p.and_then(|p| p.get("message")).and_then(|m| m.as_str()).unwrap_or("").contains("praxis-live-")
    }
}

/// Public mirror of `Progress` for the unit tests.
#[derive(Debug, PartialEq)]
pub(crate) enum ProgressView {
    Waiting,
    Working,
    Done(String),
    Failed(String),
}

/// Byte offset of the first line carrying `marker`, found by streaming the file once.
fn marker_offset(path: &Path, marker: &str) -> Option<u64> {
    use std::io::BufRead;
    let f = std::fs::File::open(path).ok()?;
    let mut r = std::io::BufReader::new(f);
    let mut at = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = r.read_until(b'\n', &mut line).ok()?;
        if n == 0 {
            return None;
        }
        if String::from_utf8_lossy(&line).contains(marker) {
            return Some(at);
        }
        at += n as u64;
    }
}

/// Only the transcript from our message on: one turn, however long the chat grows.
fn read_progress(agent: &str, path: &Path, marker: &str, offset: &mut Option<u64>) -> Progress {
    use std::io::{Seek, SeekFrom};
    if offset.is_none() {
        *offset = marker_offset(path, marker);
    }
    let Some(at) = *offset else { return Progress::Waiting };
    let mut body = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let mut bytes = Vec::new();
        if f.seek(SeekFrom::Start(at)).is_ok() && f.read_to_end(&mut bytes).is_ok() {
            body = String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    match progress_after(agent, &body, marker) {
        ProgressView::Waiting => Progress::Waiting,
        ProgressView::Working => Progress::Working,
        ProgressView::Done(r) => Progress::Done(r),
        ProgressView::Failed(r) => Progress::Failed(r),
    }
}

#[cfg(windows)]
fn evidence(hwnd: isize, folder: &Path, agent: &str, label: &str) -> Option<String> {
    let shot = crate::qa_eyes::capture_hwnd_blocking(hwnd).ok()?;
    let dir = folder.join(".praxis").join("live");
    std::fs::create_dir_all(&dir).ok()?;
    let target = dir.join(format!("{}-{agent}-{label}.png", now_ms()));
    std::fs::copy(&shot.path, &target).ok()?;
    Some(target.to_string_lossy().into_owned())
}

// ── the command ──────────────────────────────────────────────────────────────

/// Run one LIVE step in the named agent's own app and return its reply. `follow_up`
/// types into the chat this `session_key` already owns (a supervised re-prompt); without
/// a registered chat it refuses rather than start a second one.
#[tauri::command]
pub async fn live_operate_step(
    agent: String,
    folder: String,
    prompt: String,
    follow_up: Option<bool>,
    delegation_id: Option<String>,
    model: Option<String>,
    session_key: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_step(agent, folder, prompt, follow_up.unwrap_or(false), delegation_id, model, session_key))
        .await
        .map_err(|e| format!("LIVE step task failed: {e}"))?
}

#[cfg(not(windows))]
fn run_step(_: String, _: String, _: String, _: bool, _: Option<String>, _: Option<String>, _: Option<String>) -> Result<String, String> {
    Err("LIVE mode drives Windows apps".into())
}

#[cfg(windows)]
fn run_step(agent: String, folder: String, prompt: String, follow_up: bool, delegation_id: Option<String>, model: Option<String>, session_key: Option<String>) -> Result<String, String> {
    let agent = agent.trim().to_ascii_lowercase();
    let folder = folder.trim().to_string();
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() || prompt.trim().is_empty() {
        return Err(format!("LIVE needs an existing folder and a step (folder {folder:?})."));
    }
    let id = delegation_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    checkpoint(id, "admission")?;
    let app = app_for(&agent)?;
    let key = session_key.filter(|k| !k.trim().is_empty()).unwrap_or_else(|| format!("{agent}\u{1f}{}", folder.to_lowercase()));
    let owned = OWNED.lock().map_err(|e| e.to_string())?.get(&key).cloned();
    if follow_up && owned.is_none() {
        return Err(format!("LIVE follow-up refused: {} has no chat of its own for {folder} yet.", app.agent_name));
    }
    let t0 = Instant::now();
    let root = session_root(&folder_path);
    let hwnd = focus_app(&app)?;
    // Forge runs on a subscription: at 99% of the weekly limit Praxis stops rather than
    // spend the last of it (read from the Claude app's own Usage button).
    if agent == "claude" {
        if let Some(pct) = claude_weekly_pct(&app) {
            if pct >= 99 {
                return Err(format!("Forge didn't start: Claude's weekly usage is at {pct}%."));
            }
        }
    }
    let mut shots: Vec<String> = evidence(hwnd, &folder_path, &agent, "start").into_iter().collect();

    // Open the chat: a new one, or the one this step already owns.
    let (marker, sends) = match &owned {
        Some(o) if follow_up => {
            if agent == "codex" {
                crate::desktop_ops::explorer_start(&format!("codex://threads/{}", o.handle), "", true)?;
                std::thread::sleep(Duration::from_millis(2500));
                let hwnd2 = focus_app(&app)?;
                if hwnd2 != hwnd {
                    return Err("the Codex window changed while reopening Vega's thread; refusing to type.".into());
                }
            } else {
                claude_open_session(&app, &o.handle)?;
            }
            // Whatever the header says, the chat on screen must be the one Praxis started.
            if !crate::ui_elements::name_contains(app.title, &format!("{}-1", o.marker)) {
                return Err(format!("{}'s own chat isn't the one on screen; refusing to type the follow-up.", app.agent_name));
            }
            (o.marker.clone(), o.sends + 1)
        }
        _ => {
            if agent == "claude" {
                claude_new_session(&app, &root, id)?;
                if model.as_deref().unwrap_or("sonnet").starts_with("sonnet") {
                    claude_select_sonnet(&app)?;
                }
            } else {
                codex_new_chat(&app, &root)?;
            }
            (format!("praxis-live-{agent}-{:x}", now_ms() % 0xffff_ffff_ffff), 1)
        }
    };
    checkpoint(id, "chat ready")?;
    // Each send carries its own marker line, so the reply Praxis reads is to THIS send.
    let send_marker = format!("{marker}-{sends}");
    let text = if sends == 1 {
        format!("[{send_marker}] Praxis LIVE step for {} — work only in {folder}\n\n{prompt}", app.agent_name)
    } else {
        format!("[{send_marker}] Praxis checked the folder — follow-up:\n\n{prompt}")
    };
    let since = SystemTime::now() - Duration::from_secs(2);
    let _guard = if let Some(id) = id {
        ACTIVE.lock().map_err(|e| e.to_string())?.insert(id.to_string(), ActiveRun { agent: agent.clone(), hwnd, app_title: app.title.to_string(), chat_marker: format!("{marker}-1"), submitted: false });
        ActiveGuard(Some(id.to_string()))
    } else {
        ActiveGuard(None)
    };
    let clip_note = compose_and_send(&app, hwnd, &text, id)?;

    // Bind the agent's own transcript by the marker.
    let transcript = match &owned {
        Some(o) if follow_up => o.transcript.clone(),
        _ => {
            // Measured 2026-09-23: a new Claude desktop session sat on "Starting session…"
            // for ~2.5 min (it loads the owner's MCP servers, several of which time out) before
            // writing its first line. Six minutes, then an honest refusal.
            let deadline = Instant::now() + Duration::from_secs(6 * 60);
            let mut sent_shot = false;
            loop {
                if let Some(p) = bind_transcript(&agent, &folder, &send_marker, since) {
                    break p;
                }
                if !sent_shot && since.elapsed().map(|d| d > Duration::from_secs(6)).unwrap_or(false) {
                    sent_shot = true;
                    shots.extend(evidence(hwnd, &folder_path, &agent, "sent"));
                }
                if Instant::now() >= deadline {
                    return Err(format!("{} got the step, but its app wrote no transcript for it within 6 minutes — not claiming anything.", app.agent_name));
                }
                checkpoint(id, "finding the agent's transcript")?;
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    };
    let handle = match &owned {
        Some(o) => o.handle.clone(),
        None if agent == "codex" => transcript
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.chars().rev().take(36).collect::<String>().chars().rev().collect())
            .unwrap_or_default(),
        None => String::new(),
    };
    OWNED.lock().map_err(|e| e.to_string())?.insert(
        key.clone(),
        OwnedSession { marker: marker.clone(), transcript: transcript.clone(), handle, sends },
    );

    // Watch it work.
    let deadline = Instant::now() + Duration::from_secs(20 * 60);
    let submitted_at = Instant::now();
    let mut mid_shot = false;
    let mut marker_at: Option<u64> = None;
    let reply = loop {
        checkpoint(id, "watching the agent")?;
        let p = read_progress(&agent, &transcript, &send_marker, &mut marker_at);
        if !mid_shot && (matches!(p, Progress::Working) || submitted_at.elapsed() > Duration::from_secs(20)) {
            mid_shot = true;
            shots.extend(evidence(hwnd, &folder_path, &agent, "mid-step"));
        }
        match p {
            Progress::Done(r) => break r,
            Progress::Failed(e) => return Err(format!("{} stopped with an error in its own app: {}", app.agent_name, e.chars().take(300).collect::<String>())),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(format!("{} was still working after 20 minutes in its own app.", app.agent_name));
        }
        std::thread::sleep(Duration::from_millis(1500));
    };
    shots.extend(evidence(hwnd, &folder_path, &agent, "done"));
    if agent == "claude" {
        if let Some(title) = claude_header(&app) {
            if let Some(o) = OWNED.lock().map_err(|e| e.to_string())?.get_mut(&key) {
                o.handle = title;
            }
        }
    }
    let mut out = format!(
        "{} replied in its own app ({}, {:.0}s): {}\n[LIVE evidence: {}]",
        app.agent_name,
        app.title,
        t0.elapsed().as_secs_f32(),
        reply.trim(),
        if shots.is_empty() { "no screenshots".to_string() } else { shots.join(", ") }
    );
    if let Some(n) = clip_note {
        out.push_str(&format!("\n(clipboard not restored: {n})"));
    }
    Ok(out)
}

/// Stop a LIVE step: before Enter nothing is sent; after it, the app's own interrupt
/// (Esc in its window) stops the agent. Never quits an app.
#[tauri::command]
pub async fn live_operate_abort(delegation_id: String) -> Result<String, String> {
    let id = delegation_id.trim().to_string();
    if id.is_empty() {
        return Ok("no LIVE step to stop".into());
    }
    Ok(abort_ids(vec![id]))
}

/// HALT ALL: stop every LIVE step in flight.
#[tauri::command]
pub async fn live_operate_abort_all() -> Result<String, String> {
    let ids: Vec<String> = ACTIVE.lock().map(|a| a.keys().cloned().collect()).unwrap_or_default();
    if ids.is_empty() {
        return Ok("no LIVE step in flight".into());
    }
    Ok(abort_ids(ids))
}

fn abort_ids(ids: Vec<String>) -> String {
    let mut said = Vec::new();
    for id in ids {
        if let Ok(mut c) = CANCELLED.lock() {
            c.insert(id.clone());
        }
        let run = ACTIVE.lock().ok().and_then(|a| a.get(&id).cloned());
        match run {
            Some(r) if r.submitted => {
                #[cfg(windows)]
                {
                    let focused = crate::native_ops::win::focus_window_verified(r.hwnd, 6, Duration::from_millis(100));
                    // Esc only into the chat Praxis started - never another conversation.
                    let ok = focused && crate::ui_elements::name_contains(&r.app_title, &r.chat_marker);
                    if ok {
                        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
                        if let Ok(mut e) = Enigo::new(&Settings::default()) {
                            let _ = e.key(Key::Escape, Direction::Click);
                        }
                    }
                    said.push(format!(
                        "{}: {}",
                        r.agent,
                        if ok {
                            "interrupted in its app"
                        } else if focused {
                            "its own chat isn't on screen, so Praxis didn't press Esc — stop it there"
                        } else {
                            "couldn't focus its app — stop it there"
                        }
                    ));
                }
                #[cfg(not(windows))]
                said.push(format!("{}: cancel recorded", r.agent));
            }
            Some(r) => said.push(format!("{}: stopped before sending", r.agent)),
            None => said.push("cancel recorded before the step started".into()),
        }
    }
    said.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_slug_matches_claude_codes_project_folders() {
        assert_eq!(claude_project_slug(r"C:\Users\dev\Desktop\praxis"), "C--Users-dev-Desktop-praxis");
        assert_eq!(claude_project_slug(r"C:\Users\dev\praxis-builds\hello_1"), "C--Users-dev-praxis-builds-hello-1");
    }

    #[test]
    fn every_build_shares_one_project_folder() {
        let root = Path::new(r"C:\Users\dev\praxis-builds");
        assert_eq!(session_root_in(root, Path::new(r"C:\Users\dev\praxis-builds\hello-1")), root);
        assert_eq!(session_root_in(root, Path::new("C:/Users/dev/praxis-builds/site/")), root);
        let repo = Path::new(r"C:\Users\dev\Desktop\praxis");
        assert_eq!(session_root_in(root, repo), repo, "a repo keeps its own main folder");
        let sibling = Path::new(r"C:\Users\dev\praxis-builds-old\x");
        assert_eq!(session_root_in(root, sibling), sibling);
    }

    #[test]
    fn reads_claudes_weekly_usage_from_its_button() {
        assert_eq!(parse_weekly_pct("Usage: Context 484k / 1M (48%), Weekly · all models: 100%, Resets in 44 min"), Some(100));
        assert_eq!(parse_weekly_pct("Usage: Context 0, Weekly · all models: 7%, Resets Tue 9:00 PM"), Some(7));
        assert_eq!(parse_weekly_pct("Usage: Context 0"), None);
    }

    #[test]
    fn a_message_typed_by_someone_else_voids_the_reply() {
        let m = "praxis-live-claude-2-1";
        let ours = format!(r#"{{"type":"user","message":{{"role":"user","content":"[{m}] go"}}}}"#);
        let tool = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#;
        let zach = r#"{"type":"user","message":{"role":"user","content":"actually make it blue"}}"#;
        let fin = r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}"#;
        assert_eq!(progress_after("claude", &format!("{ours}\n{tool}\n{fin}"), m), ProgressView::Done("done".into()));
        assert!(matches!(progress_after("claude", &format!("{ours}\n{zach}\n{fin}"), m), ProgressView::Failed(_)));
        let c = "praxis-live-codex-3-1";
        let cu = format!(r#"{{"payload":{{"type":"user_message","message":"[{c}] go"}}}}"#);
        let started = r#"{"payload":{"type":"task_started","turn_id":"t2"}}"#;
        let old = r#"{"payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"old"}}"#;
        let new = r#"{"payload":{"type":"task_complete","turn_id":"t2","last_agent_message":"new"}}"#;
        assert_eq!(progress_after("codex", &format!("{cu}\n{started}\n{old}\n{new}"), c), ProgressView::Done("new".into()));
    }

    #[test]
    fn quill_never_falls_through_to_another_app() {
        assert!(app_for("cursor").unwrap_err().contains("off"));
        assert_eq!(app_for("codex").unwrap().title, "ChatGPT");
    }

    #[test]
    fn claude_is_done_only_on_end_turn_after_our_marker() {
        let m = "praxis-live-claude-1-1";
        let before = r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"old"}]}}"#;
        let ours = format!(r#"{{"type":"user","message":{{"role":"user","content":"[{m}] go"}}}}"#);
        let tool = r#"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use"}]}}"#;
        let fin = r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Created index.html."}]}}"#;
        assert_eq!(progress_after("claude", before, m), ProgressView::Waiting);
        assert_eq!(progress_after("claude", &format!("{before}\n{ours}"), m), ProgressView::Waiting);
        assert_eq!(progress_after("claude", &format!("{before}\n{ours}\n{tool}"), m), ProgressView::Working);
        assert_eq!(progress_after("claude", &format!("{before}\n{ours}\n{tool}\n{fin}"), m), ProgressView::Done("Created index.html.".into()));
        // Claude re-logs the prompt after the turn ("last-prompt"); the reply still counts.
        let relog = format!(r#"{{"type":"last-prompt","lastPrompt":"[{m}] go"}}"#);
        assert_eq!(progress_after("claude", &format!("{ours}\n{tool}\n{fin}\n{relog}"), m), ProgressView::Done("Created index.html.".into()));
    }

    #[test]
    fn codex_is_done_on_task_complete_and_reports_its_errors() {
        let m = "praxis-live-codex-9-1";
        let ours = format!(r#"{{"type":"event_msg","payload":{{"type":"user_message","message":"[{m}] go"}}}}"#);
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Wrote index.html"}}"#;
        let limit = r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,"error":{"message":"You've hit your usage limit."}}}"#;
        assert_eq!(progress_after("codex", &format!("{ours}\n{done}"), m), ProgressView::Done("Wrote index.html".into()));
        assert_eq!(progress_after("codex", &format!("{ours}\n{limit}"), m), ProgressView::Failed("You've hit your usage limit.".into()));
    }
}
