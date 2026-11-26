//! desktop_ops - the REAL computer-control primitives Atlas calls directly.
//!
//! Why this module exists (read before changing it):
//!
//! Praxis already had a Realtime voice session that hands the model a tool roster
//! (`hybridTools.ts`) - the same shape Example Creator's Jarvis uses. But every tool
//! call was converted BACK into an English sentence and re-parsed by a regex
//! ladder (`native_ops::match_simple_op`), whose app table knew ~16 hardcoded
//! names. So the model would correctly decide "open the browser", and Praxis
//! would throw that decision away, fail to match "a browser" against the alias
//! table, and fall through to a Codex-Desktop prompt-paste that needed Live mode.
//! Net effect: Atlas could not open a browser.
//!
//! The fix is this module. It exposes the primitives a computer-use model
//! actually needs, resolved at RUNTIME against the real machine rather than a
//! literal table:
//!
//!   * `desktop_open_app` - open ANY installed app by name (alias → running
//!                            window → App Paths → PATH → Start Menu → shell).
//!   * `desktop_focus_window` / `desktop_list_windows` - see and target real windows.
//!   * `desktop_click` - click at a screen point (the primitive `native_ops`
//!                            deliberately never had).
//!   * `desktop_open_url` / `desktop_web_search` - browser without an alias table.
//!
//! Typing / key-press / scroll already exist in `hybrid_ops.rs` and are NOT
//! duplicated here - the tool layer calls those directly.
//!
//! Safety: this module is a pure actuator. Every trust-dial / HALT / sensitivity
//! decision is made ONCE, above it, in `operatorPolicy.ts`. Adding a gate here
//! would create a second policy that can silently disagree with the dial the user
//! can see, which is exactly the failure mode the Command Center contract forbids.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

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

// ────────────────────────────────────────────────────────── name normalization ──

/// Strip the filler a spoken app name arrives with: "the browser", "my chrome",
/// "vs code app", "Codex please". Deliberately mirrors the spoken-language shapes
/// the Realtime model produces, since it passes through what the user said.
pub fn clean_app_name(raw: &str) -> String {
    let mut t = raw.trim().trim_matches(['"', '\'']).trim().to_lowercase();

    for prefix in [
        "the ", "my ", "a ", "an ", "up ", "open ", "launch ", "start ",
    ] {
        while let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim().to_string();
        }
    }
    for suffix in [
        " please",
        " for me",
        " app",
        " application",
        " window",
        " program",
    ] {
        while let Some(rest) = t.strip_suffix(suffix) {
            t = rest.trim().to_string();
        }
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Names that mean "whatever the user's default browser is" rather than a
/// specific product. The alias table can't answer these - the shell can.
fn is_generic_browser(name: &str) -> bool {
    matches!(
        name,
        "browser" | "web browser" | "internet" | "the web" | "web" | "default browser"
    )
}

/// Executable stems for known apps, tried before the filesystem search so common
/// requests stay instant. Unlike `native_ops::APP_ALIASES` this is an OPTIMIZATION,
/// not a gate: an unknown name still resolves through the search chain below.
const KNOWN_EXES: &[(&[&str], &str)] = &[
    (&["chrome", "google chrome"], "chrome"),
    (&["edge", "microsoft edge"], "msedge"),
    (&["firefox", "mozilla firefox"], "firefox"),
    (&["notepad"], "notepad"),
    (&["calculator", "calc"], "calc"),
    (&["file explorer", "explorer", "files"], "explorer"),
    (&["task manager"], "taskmgr"),
    (&["paint"], "mspaint"),
    (&["terminal", "windows terminal"], "wt"),
    (&["powershell"], "powershell"),
    (&["vs code", "vscode", "visual studio code", "code"], "code"),
    (&["cursor"], "cursor"),
    (&["spotify"], "spotify"),
    (&["discord"], "discord"),
    (&["slack"], "slack"),
    (&["obsidian"], "obsidian"),
    (&["steam"], "steam"),
    (&["word", "microsoft word"], "winword"),
    (&["excel", "microsoft excel"], "excel"),
    (&["outlook"], "outlook"),
];

fn known_exe(name: &str) -> Option<&'static str> {
    KNOWN_EXES
        .iter()
        .find_map(|(names, exe)| names.contains(&name).then_some(*exe))
}

// ──────────────────────────────────────────────────────────────── app resolution ──

/// How an app was found - carried into the spoken confirmation so the user hears
/// what actually happened ("Focused Codex" vs "Opened Codex") instead of a
/// uniform "Done" that hides a no-op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenOutcome {
    Focused(String),
    Launched(String),
}

impl OpenOutcome {
    pub fn message(&self) -> String {
        match self {
            OpenOutcome::Focused(name) => format!("Focused {name}."),
            OpenOutcome::Launched(name) => format!("Opened {name}."),
        }
    }
}

/// Recursively collect `.lnk` shortcuts under a Start Menu root. Depth-capped:
/// Start Menu trees are shallow, and an unbounded walk on a pathological folder
/// would stall the voice lane the user is waiting on.
#[cfg(windows)]
fn collect_shortcuts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() > 4000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_shortcuts(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
        {
            out.push(path);
        }
    }
}

/// Score how well an app's display name answers a spoken request. LOWER is better;
/// `None` means "not a match at all".
///
/// The ranking is tuned against this machine's real Start Menu, where a naive
/// prefix match picked "Chrome Canvas" (a browser web-app shim) over "Google
/// Chrome". Product names put the brand LAST - "Google Chrome", "Microsoft Edge",
/// "Visual Studio Code" - so an ending word-match is the strongest signal after an
/// exact hit, and shorter names break ties toward the plain product.
pub fn match_score(candidate: &str, query: &str) -> Option<usize> {
    let c = candidate.trim().to_lowercase();
    let q = query.trim().to_lowercase();
    if c.is_empty() || q.is_empty() {
        return None;
    }
    if c == q {
        return Some(0);
    }

    let words: Vec<&str> = c.split_whitespace().collect();
    let tie = c.len().min(60);

    if words.last().is_some_and(|w| *w == q) {
        return Some(100 + tie);
    }
    if words.first().is_some_and(|w| *w == q) {
        return Some(200 + tie);
    }
    if words.contains(&q.as_str()) {
        return Some(300 + tie);
    }
    // Multi-word queries ("visual studio code") won't appear as a single word.
    if c.contains(&q) {
        return Some(400 + tie);
    }
    None
}

/// Pick the best-scoring candidate from `(display_name, payload)` pairs.
fn best_match<T: Clone>(candidates: &[(String, T)], query: &str) -> Option<T> {
    candidates
        .iter()
        .filter_map(|(name, payload)| match_score(name, query).map(|s| (s, payload)))
        .min_by_key(|(score, _)| *score)
        .map(|(_, payload)| payload.clone())
}

/// Find a Start Menu shortcut whose filename best answers `name` (see match_score).
#[cfg(windows)]
fn find_start_menu_shortcut(name: &str) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }

    let mut shortcuts = Vec::new();
    for root in roots {
        if root.is_dir() {
            collect_shortcuts(&root, 0, &mut shortcuts);
        }
    }

    let candidates: Vec<(String, PathBuf)> = shortcuts
        .into_iter()
        .filter_map(|p| {
            let stem = p.file_stem()?.to_str()?.to_string();
            Some((stem, p))
        })
        .collect();

    best_match(&candidates, name)
}

/// Ask Windows for its own Start-menu app list (`Get-StartApps`) and launch the
/// best match by AppUserModelID.
///
/// This is the layer that catches Store/UWP apps, which have NO `.lnk` and no
/// `App Paths` entry - on this machine that includes Notepad and Claude. It costs
/// a PowerShell spawn, so it runs only after the cheap resolvers have missed.
#[cfg(windows)]
fn find_store_app(name: &str) -> Option<(String, String)> {
    let mut ps = Command::new("powershell.exe");
    hide_window(&mut ps);
    let output = ps
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // Tab-separated so a name containing a comma can't split the record.
            "Get-StartApps | ForEach-Object { \"$($_.Name)`t$($_.AppID)\" }",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let candidates: Vec<(String, (String, String))> = text
        .lines()
        .filter_map(|line| {
            let (display, app_id) = line.trim_end().split_once('\t')?;
            let (display, app_id) = (display.trim(), app_id.trim());
            if display.is_empty() || app_id.is_empty() {
                return None;
            }
            Some((
                display.to_string(),
                (display.to_string(), app_id.to_string()),
            ))
        })
        .collect();

    best_match(&candidates, name)
}

/// Launch a Store/desktop app by AppUserModelID through the shell's AppsFolder -
/// the only reliable way to start a packaged app from outside the Start menu.
#[cfg(windows)]
fn launch_app_id(app_id: &str) -> Result<(), String> {
    let mut command = Command::new("explorer.exe");
    hide_window(&mut command);
    command
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("launch failed: {e}"))
}

/// Is `exe` resolvable as a command? Checks the App Paths registry (how Windows
/// itself resolves `chrome`) and then PATH via `where.exe`.
#[cfg(windows)]
fn command_resolves(exe: &str) -> bool {
    let app_paths = format!(r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}.exe");
    let mut reg = Command::new("reg.exe");
    hide_window(&mut reg);
    let registry_hit = reg
        .args(["query", &app_paths])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if registry_hit {
        return true;
    }

    let mut which = Command::new("where.exe");
    hide_window(&mut which);
    which
        .arg(exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `cmd /C start "" <target>` - detaches GUI apps, resolves App Paths, and honors
/// protocol URIs. The empty `""` is the window title argument; omitting it makes
/// `start` treat a quoted path as the title and silently do nothing.
#[cfg(windows)]
pub(crate) fn shell_start(target: &str) -> Result<(), String> {
    shell_start_args(target, &[])
}

// ── Where did "open this page" actually land? ────────────────────────────────
//
// It was right only because the check cleared by itself a few seconds later. `open_url` now
// waits for the tab to settle and reports its title, so "you're there" rests on what the browser
// shows.

const BROWSER_EXES: &[&str] = &["msedge", "chrome", "firefox", "brave", "opera", "vivaldi", "arc"];

/// Titles of the open browser windows - only `exe`'s when given, so the settle wait
/// watches the browser the page was actually sent to.
#[cfg(windows)]
fn browser_titles(exe: Option<&str>) -> Vec<(isize, String)> {
    crate::native_ops::win::list_windows()
        .into_iter()
        .filter(|w| BROWSER_EXES.contains(&w.exe_stem.as_str()) && exe.is_none_or(|e| w.exe_stem == e))
        .map(|w| (w.hwnd, w.title.replace('\u{200b}', "")))
        .collect()
}

// ── Which browser does "open X" mean? ────────────────────────────────────────
//
// "Open X" right after opening a browser means in THAT browser: the one in front, else the
// top-most one, else the default.

/// One top-level window, as the browser choice sees it. `z_order` 0 is the top.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowFacts {
    pub pid: u32,
    /// Lower-case executable stem: "chrome", "msedge", "firefox".
    pub exe_name: String,
    pub title: String,
    pub z_order: usize,
    pub is_foreground: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserChoice {
    /// An open browser window: launch through its process's own executable.
    Window(WindowFacts),
    /// A browser he named that has no window open: start it by name.
    Named(&'static str),
    /// Nothing to go on, or he asked for the default: the shell's default browser.
    Default,
}

/// The executable stem a spoken browser name means.
fn browser_exe_for(name: &str) -> Option<&'static str> {
    Some(match name {
        "chrome" | "google chrome" => "chrome",
        "edge" | "microsoft edge" | "msedge" => "msedge",
        "firefox" | "mozilla firefox" => "firefox",
        "brave" | "brave browser" => "brave",
        "opera" => "opera",
        "vivaldi" => "vivaldi",
        "arc" => "arc",
        _ => return None,
    })
}

/// Spoken name for a browser's executable stem.
fn browser_label(exe: &str) -> &'static str {
    match exe {
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "opera" => "Opera",
        "vivaldi" => "Vivaldi",
        "arc" => "Arc",
        _ => "the browser",
    }
}

/// Pick where a page opens: the browser he named → the browser window in front → the
/// top-most browser window → the default browser. The note says when a named window
/// fragment matched nothing, so the fallback is visible instead of silent.
pub(crate) fn choose_browser(windows: &[WindowFacts], browser: Option<&str>) -> (BrowserChoice, Option<String>) {
    let browsers: Vec<&WindowFacts> = windows.iter().filter(|w| BROWSER_EXES.contains(&w.exe_name.as_str())).collect();
    let top = |pred: &dyn Fn(&WindowFacts) -> bool| {
        browsers.iter().filter(|w| pred(w)).min_by_key(|w| w.z_order).map(|w| (*w).clone())
    };
    let mut note = None;
    let asked = browser.map(clean_app_name).unwrap_or_default();
    if !asked.is_empty() && !matches!(asked.as_str(), "browser" | "web browser") {
        if matches!(asked.as_str(), "default" | "default browser") {
            return (BrowserChoice::Default, None);
        }
        if let Some(exe) = browser_exe_for(&asked) {
            let choice = top(&|w| w.exe_name == exe).map(BrowserChoice::Window).unwrap_or(BrowserChoice::Named(exe));
            return (choice, None);
        }
        if let Some(w) = top(&|w| w.title.to_lowercase().contains(&asked)) {
            return (BrowserChoice::Window(w), None);
        }
        note = Some(format!("No open browser window matches \"{asked}\"."));
    }
    if let Some(w) = browsers.iter().find(|w| w.is_foreground) {
        return (BrowserChoice::Window((*w).clone()), note);
    }
    (top(&|_| true).map(BrowserChoice::Window).unwrap_or(BrowserChoice::Default), note)
}

/// Arguments that open `url` as a new tab of an already-running browser. Chromium
/// browsers take the bare URL (a new tab in their last active window); Firefox needs
/// `-new-tab`, or it may open a new window.
pub(crate) fn browser_launch_args(exe: &str, url: &str) -> Vec<String> {
    if exe == "firefox" {
        vec!["-new-tab".to_string(), url.to_string()]
    } else {
        vec![url.to_string()]
    }
}

#[cfg(windows)]
mod browser_proc {
    use std::ffi::c_void;
    use std::path::PathBuf;
    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn QueryFullProcessImageNameW(h: Handle, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    }

    pub fn pid_of(hwnd: isize) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd as Handle, &mut pid) };
        pid
    }

    /// Full path of a process's executable ("C:\Program Files\Google\Chrome\Application\chrome.exe").
    pub fn image_path(pid: u32) -> Option<PathBuf> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            (ok != 0 && size > 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..size as usize])))
        }
    }
}

/// The visible windows with what the browser choice needs, in Z-order (top first).
#[cfg(windows)]
fn window_facts() -> Vec<WindowFacts> {
    let fg = crate::native_ops::win::foreground_window();
    crate::native_ops::win::list_windows()
        .into_iter()
        .enumerate()
        .map(|(z, w)| WindowFacts {
            pid: browser_proc::pid_of(w.hwnd),
            exe_name: w.exe_stem,
            title: w.title.replace('\u{200b}', ""),
            z_order: z,
            is_foreground: Some(w.hwnd) == fg,
        })
        .collect()
}

/// Send `url` to the chosen browser. Returns the executable stem it went to (None for
/// the default browser), so the caller can watch that browser's windows.
#[cfg(windows)]
fn open_in_browser(choice: &BrowserChoice, url: &str) -> Result<Option<&'static str>, String> {
    match choice {
        BrowserChoice::Default => shell_start(url).map(|_| None),
        BrowserChoice::Named(exe) => {
            let mut args = Vec::new();
            if *exe == "chrome" {
                // Straight into his last-used profile, never the "Who's using Chrome?" picker.
                if let Some(profile) = chrome_last_used_profile() {
                    args.push(format!("--profile-directory={profile}"));
                }
            }
            args.extend(browser_launch_args(exe, url));
            start_named(exe, &args).map(|_| Some(*exe))
        }
        BrowserChoice::Window(w) => {
            let exe = BROWSER_EXES.iter().copied().find(|e| *e == w.exe_name);
            let args = browser_launch_args(&w.exe_name, url);
            match browser_proc::image_path(w.pid) {
                Some(path) => {
                    let mut command = Command::new(&path);
                    let child = command
                        .args(&args)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|e| format!("{} didn't start: {e}", path.display()))?;
                    await_launcher(child)?;
                }
                None => start_named(&w.exe_name, &args)?,
            }
            Ok(exe)
        }
    }
}

/// `start "" <exe> "<arg>"…` with every argument quoted, so a URL's `&` is not read by
/// cmd.exe as a command separator.
#[cfg(windows)]
fn start_named(exe: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    hide_window(&mut command);
    command.args(["/C", "start", "", exe]);
    for arg in args {
        command.raw_arg(format!("\"{}\"", arg.replace('"', "%22")));
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("launch failed: {e}"))?;
    await_launcher(child)
}

/// A human-verification page. Atlas never tries to get past one; it waits or asks the owner.
pub(crate) fn is_check_title(title: &str) -> bool {
    let t = title.to_lowercase();
    ["just a moment", "verify you are human", "attention required", "checking your browser", "security check", "are you a robot", "one more step"]
        .iter()
        .any(|k| t.contains(k))
}

/// A title that says the page has not arrived yet.
pub(crate) fn is_transient_title(title: &str, url: &str) -> bool {
    let t = title.trim().to_lowercase();
    let host = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    t.is_empty()
        || t.starts_with("new tab")
        || t.starts_with("untitled")
        || t.starts_with("loading")
        || t.starts_with("http")
        || (!host.is_empty() && t.starts_with(&host))
        || is_check_title(&t)
}

pub(crate) fn page_part(window_title: &str) -> String {
    let t = window_title.replace('\u{200b}', "");
    let mut page = t.as_str();
    for suffix in [" - Microsoft Edge", " - Google Chrome", " — Mozilla Firefox", " - Mozilla Firefox", " - Brave", " - Opera", " - Vivaldi"] {
        if let Some(i) = page.rfind(suffix) {
            page = &page[..i];
            break;
        }
    }
    // Edge: "… and 24 more pages - Personal" (the profile name follows the tab count).
    let tab_count = page.match_indices(" and ").map(|(i, _)| i).find(|&i| {
        let rest = &page[i + 5..];
        rest.split_whitespace().next().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit())) && rest.contains(" more page")
    });
    if let Some(i) = tab_count {
        page = &page[..i];
    }
    page.trim().to_string()
}

/// Worth a little more patience.
pub(crate) fn is_bare_title(window_title: &str) -> bool {
    page_part(window_title).split_whitespace().count() == 1
}

/// Wait (up to `timeout`) for a browser window's title to change and hold still on a real
/// page title; returns the last title seen, even a transient one, or None if nothing moved.
#[cfg(windows)]
fn settle_browser_title(before: &[(isize, String)], exe: Option<&str>, url: &str, timeout: Duration) -> Option<String> {
    let start = std::time::Instant::now();
    let mut last: Option<(String, std::time::Instant)> = None;
    while start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(250));
        let changed = browser_titles(exe)
            .into_iter()
            .find(|(h, t)| !before.iter().any(|(bh, bt)| bh == h && bt == t))
            .map(|(_, t)| t);
        let Some(title) = changed else { continue };
        match &last {
            Some((prev, since)) if *prev == title => {
                let hold = if is_bare_title(&title) { 2500 } else { 500 };
                if !is_transient_title(&title, url) && since.elapsed() >= Duration::from_millis(hold) {
                    return Some(title);
                }
            }
            _ => last = Some((title, std::time::Instant::now())),
        }
    }
    last.map(|(t, _)| t)
}

pub(crate) fn landed_sentence(title: &str) -> String {
    if is_check_title(title) {
        format!(
            "The browser is showing \"{title}\" — a human-verification check. Wait a few seconds and look again; if it is still asking, tell Zach he has to finish that check himself. Never try to get past it."
        )
    } else {
        format!("The browser now shows \"{title}\".")
    }
}

/// Whether the lock screen (or another secure screen) is up - see `native_ops::win::screen_locked`.
#[tauri::command]
pub async fn desktop_screen_locked() -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(crate::native_ops::win::screen_locked)
            .await
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Start a program, file or link the way clicking it in Explorer does: Explorer's own
/// shell runs it (the desktop window's Shell.Application), so it is not a child of Praxis -
/// no Praxis job, no hidden console handles, Explorer's environment. Measured 2026-09-18:
/// `(New-Object -ComObject Shell.Application).ShellExecute` runs INSIDE the calling
/// PowerShell, and Cursor started that way from Praxis's tree sat 33 s before it began to
/// start; through the desktop's shell it showed its window in ~5 s, parent explorer.exe.
/// `activate: false` shows the window without taking focus (hybrid: never steal focus
/// from the owner or Atlas). Blocking (~0.5 s): call it off the async runtime.
#[cfg(windows)]
pub(crate) fn explorer_start(file: &str, args: &str, activate: bool) -> Result<(), String> {
    use base64::Engine;
    let q = |s: &str| s.replace('\'', "''");
    let show = if activate { 1 } else { 4 }; // SW_SHOWNORMAL / SW_SHOWNOACTIVATE
    let script = format!(
        "$ErrorActionPreference = 'Stop'; $s = New-Object -ComObject Shell.Application; \
         try {{ $d = $s.Windows().FindWindowSW(0, $null, 8, [ref]0, 1); $d.Document.Application.ShellExecute('{f}', '{a}', '', 'open', {show}) }} \
         catch {{ $s.ShellExecute('{f}', '{a}', '', 'open', {show}) }}",
        f = q(file),
        a = q(args),
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("couldn't ask Windows to open {file}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Windows couldn't open {file}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Hybrid: an app that takes the foreground anyway (a deep link that raises its window)
/// hands it straight back to whatever the owner had in front. Watches for `ms`.
#[cfg(windows)]
pub(crate) fn keep_focus(before: Option<isize>, taker: &str, ms: u64) {
    let Some(prev) = before else { return };
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(200));
        let Some(fg) = crate::native_ops::win::foreground_window() else { continue };
        if fg != prev && crate::native_ops::win::window_title(fg).contains(taker) {
            let _ = crate::native_ops::win::focus_window_verified(prev, 3, Duration::from_millis(100));
            return;
        }
    }
}

/// Open a build folder in Cursor, in its own IDE window, so the owner watches the files appear
/// as the team writes them. The editor only shows the folder; it runs nothing.
/// `activate` (Live) brings the window forward; otherwise (Hybrid) it opens behind.
#[tauri::command]
pub async fn live_open_workspace(path: String, activate: Option<bool>) -> Result<String, String> {
    let dir = std::path::PathBuf::from(path.trim());
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    #[cfg(windows)]
    {
        let exe = std::env::var_os("LOCALAPPDATA")
            .map(|l| std::path::PathBuf::from(l).join("Programs").join("cursor").join("Cursor.exe"))
            .filter(|p| p.is_file())
            .ok_or("Cursor isn't installed where Praxis expects it (%LOCALAPPDATA%\\Programs\\cursor)")?;
        let activate = activate.unwrap_or(false);
        let build = dir.clone();
        let dir = crate::live_operate::session_root(&dir);
        let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let shown = if build == dir { dir.display().to_string() } else { format!("{} (in the {} workspace)", build.display(), name) };
        tauri::async_runtime::spawn_blocking(move || {
            let before = crate::native_ops::win::foreground_window();
            // `--classic`: Cursor 3.21 otherwise binds the folder to its "Cursor Agents"
            // window, which never shows the files (measured 2026-09-18).
            explorer_start(&exe.to_string_lossy(), &format!("--classic --new-window \"{}\"", dir.display()), activate)?;
            // 75 s: live 2026-09-18 (build 20) Cursor launched by Explorer still sat 33 s before
            // it began to start on some cold starts (a Cursor background update had been stuck
            // since 02:53), then showed "<folder> - Cursor" - a 25 s wait called that a failure.
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(75) {
                std::thread::sleep(Duration::from_millis(400));
                let open = crate::native_ops::win::list_windows()
                    .into_iter()
                    .any(|w| w.title.contains(&name) && w.title.contains("Cursor"));
                if open {
                    if !activate {
                        keep_focus(before, "Cursor", 1500);
                    }
                    crate::hermes_bridge::note_live_opened(format!("the build folder in Cursor ({:.0}s): {shown}", start.elapsed().as_secs_f32()));
                    return Ok(format!("the build folder is open in Cursor — {shown}"));
                }
            }
            crate::hermes_bridge::note_live_opened(format!("FAILED: Cursor showed no window for {shown} within 75 s"));
            Err(format!("asked Cursor to open {shown}, but its window didn't appear within 75 s"))
        })
        .await
        .map_err(|e| format!("live_open_workspace join failed: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = activate;
        Err("opening Cursor is Windows-only".to_string())
    }
}

/// The Chrome profile the owner used last, read from Chrome's own `Local State`.
///
/// Measured 2026-09-14: "open Chrome" on a cold start put up "Who's using Chrome?"
/// (a window titled just "Google Chrome"), so every spoken step after it typed into
/// the picker and nothing happened. Launching with `--profile-directory` goes
/// straight to his browser window, the way clicking his profile would.
#[cfg(windows)]
fn chrome_last_used_profile() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let path = std::path::PathBuf::from(local)
        .join("Google")
        .join("Chrome")
        .join("User Data")
        .join("Local State");
    parse_chrome_last_used(&std::fs::read_to_string(path).ok()?)
}

fn parse_chrome_last_used(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let usable = |p: &str| {
        let p = p.trim();
        (!p.is_empty() && !p.contains('"') && p != "System Profile" && p != "Guest Profile")
            .then(|| p.to_string())
    };
    v.pointer("/profile/last_used")
        .and_then(|x| x.as_str())
        .and_then(usable)
        .or_else(|| {
            v.pointer("/profile/last_active_profiles/0")
                .and_then(|x| x.as_str())
                .and_then(usable)
        })
}

fn shell_start_args(target: &str, extra: &[String]) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    hide_window(&mut command);
    command.args(["/C", "start", "", target]);
    command.args(extra);
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("launch failed: {e}"))?;
    await_launcher(child)
}

/// Poll briefly so a bad target reports honestly instead of claiming success;
/// long-lived launchers are assumed good once they outlive the window.
fn await_launcher(mut child: std::process::Child) -> Result<(), String> {
    for _ in 0..8 {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("launcher exited with {status}")),
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("launcher poll failed: {e}")),
        }
    }
    Ok(())
}

/// Run a `.cmd`/`.bat` shim (code, cursor) inside a HIDDEN console. `start` on a
/// shim flashes a visible console window; this does not.
#[cfg(windows)]
fn shim_start(name: &str) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    hide_window(&mut command);
    command.args(["/C", name]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("launch failed: {e}"))?;
    Ok(())
}

/// Open (or focus) any app by spoken name.
///
/// Order matters and is deliberate:
///   1. generic "browser" → default HTTP handler, since no alias can answer it
///   2. an ALREADY-OPEN window with that name → focus it (opening a second copy
///      of an app the user can already see reads as a failure)
///   3. known exe stem, if the command resolves
///   4. Start Menu shortcut (catches everything installed but not on PATH)
///   5. bare shell start, as a last honest attempt
#[cfg(windows)]
pub fn open_app(raw_name: &str) -> Result<OpenOutcome, String> {
    let name = clean_app_name(raw_name);
    if name.is_empty() {
        return Err("I need an app name to open.".to_string());
    }

    if is_generic_browser(&name) {
        // "The browser" is the one he is using - the browser window in front, else the top-most
        // one - not whichever browser Windows calls the default. Only an explicit "default
        // browser", or no browser window at all, starts the default.
        if name != "default browser" {
            if let (BrowserChoice::Window(w), _) = choose_browser(&window_facts(), None) {
                let win = crate::native_ops::win::list_windows()
                    .into_iter()
                    .find(|x| x.exe_stem == w.exe_name && x.title.replace('\u{200b}', "") == w.title);
                if let Some(win) = win {
                    if crate::native_ops::win::focus_window_verified(win.hwnd, 12, Duration::from_millis(120)) {
                        return Ok(OpenOutcome::Focused(w.title));
                    }
                }
            }
        }
        shell_start("https://www.google.com")?;
        return Ok(OpenOutcome::Launched("your browser".to_string()));
    }

    // Codex Desktop ships as a CLI subcommand (`codex app`), not a shortcut or an App Paths
    // entry - the generic chain below would never find it.
    if matches!(name.as_str(), "codex" | "codex desktop") {
        if let Some(existing) = crate::native_ops::win::find_codex_window() {
            if crate::native_ops::win::focus_window_verified(
                existing.hwnd,
                12,
                Duration::from_millis(120),
            ) {
                return Ok(OpenOutcome::Focused(existing.title));
            }
        }
        let mut command = Command::new("cmd.exe");
        hide_window(&mut command);
        command
            .args(["/C", "codex", "app"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Codex didn't start: {e}"))?;
        return Ok(OpenOutcome::Launched("Codex".to_string()));
    }

    let is_chrome = known_exe(&name) == Some("chrome");

    // 2 - focus an existing window rather than launching a duplicate. A Chrome
    // window titled exactly "Google Chrome" is the profile picker, not a browser:
    // focusing it would make every following step type into the picker.
    if let Some(existing) = crate::native_ops::win::find_window_matching(&name) {
        let is_chrome_picker = is_chrome && existing.title.trim() == "Google Chrome";
        if !is_chrome_picker
            && crate::native_ops::win::focus_window_verified(
                existing.hwnd,
                12,
                Duration::from_millis(120),
            )
        {
            return Ok(OpenOutcome::Focused(existing.title));
        }
    }

    // 3a - Chrome straight into his last-used profile (skips the picker).
    if is_chrome && command_resolves("chrome") {
        if let Some(profile) = chrome_last_used_profile() {
            if shell_start_args("chrome", &[format!("--profile-directory={profile}")]).is_ok() {
                return Ok(OpenOutcome::Launched(name));
            }
        }
    }

    // 3 - known executable stem.
    if let Some(exe) = known_exe(&name) {
        // .cmd shims must not go through `start` (visible console flash).
        if matches!(exe, "code" | "cursor") {
            if shim_start(exe).is_ok() {
                return Ok(OpenOutcome::Launched(name));
            }
        } else if command_resolves(exe) && shell_start(exe).is_ok() {
            return Ok(OpenOutcome::Launched(name));
        }
    }

    // 4 - Start Menu shortcut: the broad catch for anything installed.
    if let Some(shortcut) = find_start_menu_shortcut(&name) {
        let label = shortcut
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&name)
            .to_string();
        shell_start(&shortcut.to_string_lossy())?;
        return Ok(OpenOutcome::Launched(label));
    }

    // 5 - Store/UWP apps (no .lnk, no App Paths) via the shell's AppsFolder.
    if let Some((label, app_id)) = find_store_app(&name) {
        launch_app_id(&app_id)?;
        return Ok(OpenOutcome::Launched(label));
    }

    // 6 - last attempt: let the shell try the bare name.
    if command_resolves(&name) && shell_start(&name).is_ok() {
        return Ok(OpenOutcome::Launched(name));
    }

    Err(format!(
        "I couldn't find an app called \"{name}\" on this machine."
    ))
}

#[cfg(not(windows))]
pub fn open_app(_raw_name: &str) -> Result<OpenOutcome, String> {
    Err("desktop app control is Windows-only".to_string())
}

// ─────────────────────────────────────────────────────────────── Tauri commands ──

/// Open or focus any installed app by name. Replaces the alias-table fast path as
/// the tool layer's entry point for "open X".
#[tauri::command]
pub async fn desktop_open_app(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || open_app(&name).map(|o| o.message()))
        .await
        .map_err(|e| format!("open app task panicked: {e}"))?
}

/// Bare domains are upgraded to https so the model can pass through what the user said ("open
/// github.com"). A local path with no named browser opens with its own handler.
#[tauri::command]
pub async fn desktop_open_url(url: String, browser: Option<String>) -> Result<String, String> {
    let raw = url.trim().to_string();
    if raw.is_empty() {
        return Err("I need a web address to open.".to_string());
    }
    // A local path is NOT a hostname. `file:///C:/...` used to get "https://" glued on
    // the front, so Edge resolved a domain called "file" and rendered
    // DNS_PROBE_FINISHED_NXDOMAIN - a page with no controls on it, which reads exactly
    // like "the click tool is broken". That cost three debugging cycles on 2026-09-15.
    // Windows paths get the same treatment: "open this file" is an ordinary spoken ask.
    let b = raw.as_bytes();
    let drive_path = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    let looks_local = raw.starts_with("file://") || raw.starts_with(r"\\") || drive_path;
    let full = if raw.starts_with("http://") || raw.starts_with("https://") || looks_local {
        raw.clone()
    } else {
        format!("https://{raw}")
    };

    #[cfg(windows)]
    {
        let target = full.clone();
        let web = full.starts_with("http://") || full.starts_with("https://");
        let named = browser.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
        let (landed, label, note) = tauri::async_runtime::spawn_blocking(
            move || -> Result<(Option<String>, Option<&'static str>, Option<String>), String> {
                // A build's index.html or a .cmd keeps opening with its own handler unless
                // he named a browser for it.
                if !web && named.is_none() {
                    shell_start(&target)?;
                    return Ok((None, None, None));
                }
                let (choice, note) = choose_browser(&window_facts(), named.as_deref());
                let watch = match &choice {
                    BrowserChoice::Window(w) => BROWSER_EXES.iter().copied().find(|e| *e == w.exe_name),
                    BrowserChoice::Named(exe) => Some(*exe),
                    BrowserChoice::Default => None,
                };
                let before = browser_titles(watch);
                let sent_to = open_in_browser(&choice, &target)?;
                let landed = if web { settle_browser_title(&before, sent_to, &target, Duration::from_secs(6)) } else { None };
                Ok((landed, sent_to.map(browser_label), note))
            },
        )
        .await
        .map_err(|e| format!("open url task panicked: {e}"))??;
        Ok(open_url_sentence(&raw, label, note.as_deref(), landed.as_deref()))
    }
    #[cfg(not(windows))]
    {
        let _ = (full, browser);
        Err("desktop browser control is Windows-only".to_string())
    }
}

pub(crate) fn open_url_sentence(raw: &str, label: Option<&str>, note: Option<&str>, landed: Option<&str>) -> String {
    let mut out = match label {
        Some(l) => format!("Opened {raw} in {l}."),
        None => format!("Opened {raw}."),
    };
    if let Some(n) = note {
        out = format!("{n} {out}");
    }
    if let Some(title) = landed {
        out = format!("{out} {}", landed_sentence(title));
    }
    out
}

/// Percent-encode a search query. Hand-rolled to avoid pulling the `url` crate
/// into a build that deliberately keeps its Rust dependency set small.
fn encode_query(q: &str) -> String {
    let mut out = String::with_capacity(q.len() * 2);
    for b in q.bytes() {
        match b {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Run a web search in the browser the owner is using, or in `browser` when he names one
/// (same choice as `desktop_open_url`).
#[tauri::command]
pub async fn desktop_web_search(query: String, browser: Option<String>) -> Result<String, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("I need something to search for.".to_string());
    }
    let url = format!("https://www.google.com/search?q={}", encode_query(&q));

    #[cfg(windows)]
    {
        let named = browser.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
        let (label, note) = tauri::async_runtime::spawn_blocking(move || -> Result<(Option<&'static str>, Option<String>), String> {
            let (choice, note) = choose_browser(&window_facts(), named.as_deref());
            let sent_to = open_in_browser(&choice, &url)?;
            Ok((sent_to.map(browser_label), note))
        })
        .await
        .map_err(|e| format!("web search task panicked: {e}"))??;
        let lead = note.map(|n| format!("{n} ")).unwrap_or_default();
        Ok(match label {
            Some(l) => format!("{lead}Searching the web for {q} in {l}."),
            None => format!("{lead}Searching the web for {q}."),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (url, browser);
        Err("desktop browser control is Windows-only".to_string())
    }
}

/// Bring a window matching `query` to the foreground. Unlike the old window rung
/// this is not restricted to three hardcoded browsers.
#[tauri::command]
pub async fn desktop_focus_window(query: String) -> Result<String, String> {
    let needle = clean_app_name(&query);
    if needle.is_empty() {
        return Err("I need a window name to focus.".to_string());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let found = crate::native_ops::win::find_window_matching(&needle)
                .ok_or_else(|| format!("No open window matches \"{needle}\"."))?;
            if crate::native_ops::win::focus_window_verified(
                found.hwnd,
                12,
                Duration::from_millis(120),
            ) {
                Ok(format!("Focused {}.", found.title))
            } else {
                Err(format!(
                    "I couldn't bring \"{}\" to the front.",
                    found.title
                ))
            }
        })
        .await
        .map_err(|e| format!("focus task panicked: {e}"))?
    }
    #[cfg(not(windows))]
    {
        Err("desktop window control is Windows-only".to_string())
    }
}

/// The visible windows, so the model can target one by its real title instead of
/// guessing. Returned newest-Z-order first, capped to keep the tool result small.
#[tauri::command]
pub async fn desktop_list_windows() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let titles: Vec<String> = crate::native_ops::win::list_windows()
                .into_iter()
                .map(|w| w.title)
                .filter(|t| !t.trim().is_empty())
                .take(40)
                .collect();
            Ok(titles)
        })
        .await
        .map_err(|e| format!("window list task panicked: {e}"))?
    }
    #[cfg(not(windows))]
    {
        Err("desktop window control is Windows-only".to_string())
    }
}

/// Without these, "maximize this window" had no resolvable target and came back as an
/// ambiguous-command refusal.
fn means_current_window(target: &str) -> bool {
    matches!(
        target,
        "" | "this" | "that" | "it" | "current" | "active" | "focused" | "foreground" | "front"
    )
}

/// Minimize / maximize / restore / close ANY window - named, or the focused one.
///
/// This replaces the browser-only window rung for Atlas. `target` may name a
/// window ("chrome", "obsidian", part of a title) or be empty/"this" to mean the
/// window currently in front.
#[tauri::command]
pub async fn desktop_window_control(
    target: Option<String>,
    action: String,
) -> Result<String, String> {
    let raw = target.unwrap_or_default();
    let name = clean_app_name(&raw);
    let verb = action.trim().to_lowercase();

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use crate::native_ops::win;

            // Praxis's own window is never a valid target for a spoken window
            // command - minimizing or closing the cockpit mid-sentence would look
            // like a crash.
            let (hwnd, label) = if means_current_window(&name) {
                let hwnd = win::foreground_window()
                    .ok_or_else(|| "I couldn't tell which window is in front.".to_string())?;
                let label = win::title_for(hwnd).unwrap_or_else(|| "that window".to_string());
                (hwnd, label)
            } else {
                let found = win::find_window_matching(&name)
                    .ok_or_else(|| format!("No open window matches \"{name}\"."))?;
                (found.hwnd, found.title)
            };

            win::apply_window_action(hwnd, &verb)
                .map(|()| format!("{} {label}.", past_tense(&verb)))
                .map_err(|e| format!("I couldn't {verb} {label}: {e}"))
        })
        .await
        .map_err(|e| format!("window control task panicked: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (name, verb);
        Err("desktop window control is Windows-only".to_string())
    }
}

/// Spoken past tense for the confirmation line.
fn past_tense(verb: &str) -> &'static str {
    match verb {
        "minimize" => "Minimized",
        "maximize" => "Maximized",
        "restore" | "unmaximize" => "Restored",
        "close" => "Closed",
        _ => "Done —",
    }
}

/// Click the desktop. `button` is left/right/middle; `double` requests a
/// double-click. This is the primitive the old native rung never had - without it
/// the model could open an app but never operate it.
///
/// `space` says which coordinate system `x`/`y` are in:
///
///   "capture" (DEFAULT) - the last screenshot's pixels. This is what a model
///                          means, always: it picked the point off an image.
///   "screen" - raw desktop pixels, for a caller that already knows
///                          where things are.
///
/// The default is "capture" because the old behaviour was to treat model
/// coordinates as screen coordinates, and the two are different units. The
/// screenshot is capped at 1280px on its longest edge; this machine's primary
/// monitor is 1707 wide, so every click landed at 0.75x of where it was aimed -
/// close enough to look plausible in a log and far enough to hit nothing. And the
/// capture followed the foreground window onto a second display at x=2048, which
/// a raw coordinate could never reach.
///
/// The success string now reports BOTH points when they differ, so a miss is
/// diagnosable from the transcript instead of reading as "Clicked at 300, 380."
#[tauri::command]
pub async fn desktop_click(
    x: i32,
    y: i32,
    button: Option<String>,
    double: Option<bool>,
    space: Option<String>,
    capture_id: Option<u64>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let in_capture_space = !matches!(
            space
                .as_deref()
                .unwrap_or("capture")
                .trim()
                .to_lowercase()
                .as_str(),
            "screen" | "desktop" | "absolute"
        );
        let (tx, ty, mapped) = if in_capture_space {
            let capture_id = capture_id.ok_or_else(|| {
                "I need a fresh screenshot before I can click — take one first, then tell me where."
                    .to_string()
            })?;
            match crate::screen_capture::capture_point_to_screen(capture_id, x, y) {
                Some((sx, sy)) => (sx, sy, true),
                // A streamed or newer screenshot must never silently remap this
                // point. Tokens are owned by the Atlas screenshot that produced it.
                None => {
                    return Err(
                        "That screenshot is no longer available — take a fresh one, then click from it."
                            .to_string(),
                    )
                }
            }
        } else {
            (x, y, false)
        };

        tauri::async_runtime::spawn_blocking(move || {
            use enigo::{Button, Direction, Enigo, Mouse, Settings};

            let which = match button
                .as_deref()
                .unwrap_or("left")
                .trim()
                .to_lowercase()
                .as_str()
            {
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let mut enigo = Enigo::new(&Settings::default())
                .map_err(|e| format!("input synthesizer init failed: {e}"))?;
            // Enigo normalizes absolute points through SM_CXSCREEN/SM_CYSCREEN
            // and omits MOUSEEVENTF_VIRTUALDESK, so a valid second-monitor point
            // is scaled against the primary display. SetCursorPos takes the real
            // virtual-desktop pixels produced by the capture map, including a
            // negative monitor origin.
            #[repr(C)]
            struct Point {
                x: i32,
                y: i32,
            }
            unsafe extern "system" {
                fn SetCursorPos(x: i32, y: i32) -> i32;
                fn GetCursorPos(point: *mut Point) -> i32;
            }
            if unsafe { SetCursorPos(tx, ty) } == 0 {
                return Err("could not move the pointer to the captured point".to_string());
            }
            let mut landed = Point { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut landed) } == 0 || landed.x != tx || landed.y != ty {
                return Err("the pointer did not reach the captured point".to_string());
            }
            enigo
                .button(which, Direction::Click)
                .map_err(|e| format!("click failed: {e}"))?;
            let where_ = if mapped && (tx != x || ty != y) {
                format!("{x}, {y} on screen → {tx}, {ty}")
            } else {
                format!("{tx}, {ty}")
            };
            if double.unwrap_or(false) {
                enigo
                    .button(which, Direction::Click)
                    .map_err(|e| format!("second click failed: {e}"))?;
                return Ok(format!("Double-clicked at {where_}."));
            }
            Ok(format!("Clicked at {where_}."))
        })
        .await
        .map_err(|e| format!("click task panicked: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (x, y, button, double, capture_id);
        Err("desktop input synthesis is Windows-only".to_string())
    }
}

/// Press a point in REAL screen pixels, synchronously.
///
/// Exposed for `ui_elements`, which gets its coordinates from UI Automation's own
/// bounding rectangles - already virtual-desktop pixels, so they must NOT go through the
/// capture-space remap that `desktop_click` applies to a model's screenshot coordinates.
/// Same actuation as `desktop_click`'s tail: SetCursorPos (virtual-desktop correct,
/// including negative monitor origins) then an enigo button click, because enigo's own
/// absolute move rescales against the primary display.
#[cfg(windows)]
/// Move the pointer without clicking (hover-only controls, e.g. Codex's "Start new chat in …").
#[cfg(windows)]
pub(crate) fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    unsafe extern "system" {
        fn SetCursorPos(x: i32, y: i32) -> i32;
    }
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err("could not move the pointer".to_string());
    }
    Ok(())
}

pub(crate) fn click_screen_point(x: i32, y: i32) -> Result<String, String> {
    use enigo::{Button, Direction, Enigo, Mouse, Settings};
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    unsafe extern "system" {
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn GetCursorPos(point: *mut Point) -> i32;
    }
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| format!("input synthesizer init failed: {e}"))?;
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err("could not move the pointer".to_string());
    }
    let mut landed = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut landed) } == 0 || landed.x != x || landed.y != y {
        return Err("the pointer did not reach the point".to_string());
    }
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| format!("click failed: {e}"))?;
    Ok(format!("Clicked at {x}, {y}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `file:///C:/...` must not become `https://file:///C:/...`. Edge then resolves a
    /// hostname called "file" and renders DNS_PROBE_FINISHED_NXDOMAIN - a page with no
    /// controls, which reads exactly like "the click tool is broken".
    #[test]
    fn a_local_path_is_not_turned_into_a_hostname() {
        fn norm(raw: &str) -> String {
            let b = raw.as_bytes();
            let drive_path = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
            let looks_local = raw.starts_with("file://") || raw.starts_with(r"\\") || drive_path;
            if raw.starts_with("http://") || raw.starts_with("https://") || looks_local {
                raw.to_string()
            } else {
                format!("https://{raw}")
            }
        }
        assert_eq!(norm("file:///C:/tmp/x.html"), "file:///C:/tmp/x.html");
        assert_eq!(norm(r"C:\Users\dev\x.html"), r"C:\Users\dev\x.html");
        assert_eq!(norm(r"\\server\share\x.html"), r"\\server\share\x.html");
        // Ordinary bare hostnames still get a scheme.
        assert_eq!(norm("gmail.com"), "https://gmail.com");
        assert_eq!(norm("http://127.0.0.1:8777/a.html"), "http://127.0.0.1:8777/a.html");
    }

    #[test]
    fn cleans_spoken_app_names() {
        assert_eq!(clean_app_name("the browser"), "browser");
        assert_eq!(clean_app_name("  my Chrome  "), "chrome");
        // Chrome opens straight into the last-used profile, never the picker.
        assert_eq!(
            parse_chrome_last_used(r#"{"profile":{"last_used":"Profile 1","last_active_profiles":["Default"]}}"#),
            Some("Profile 1".to_string())
        );
        assert_eq!(
            parse_chrome_last_used(r#"{"profile":{"last_used":"System Profile","last_active_profiles":["Default"]}}"#),
            Some("Default".to_string())
        );
        assert_eq!(parse_chrome_last_used(r#"{"profile":{}}"#), None);
        assert_eq!(clean_app_name("up Codex please"), "codex");
        assert_eq!(clean_app_name("VS Code app"), "vs code");
        assert_eq!(clean_app_name("\"Obsidian\""), "obsidian");
    }

    #[test]
    fn recognizes_generic_browser_requests() {
        // The exact phrasings that used to fall through the alias table and end
        // up as a blocked Codex handoff.
        for phrase in ["the browser", "a browser", "my web browser", "the internet"] {
            assert!(
                is_generic_browser(&clean_app_name(phrase)),
                "{phrase} should resolve to the default browser"
            );
        }
    }

    #[test]
    fn known_exes_still_fast_path() {
        assert_eq!(known_exe(&clean_app_name("Google Chrome")), Some("chrome"));
        assert_eq!(known_exe(&clean_app_name("vs code")), Some("code"));
        // An unknown name must NOT be a hard failure here - it falls through to
        // the Start Menu search, which is the whole point of this module.
        assert_eq!(known_exe("blender"), None);
    }

    /// Product names end with the brand, so an ending word-match must win.
    #[test]
    fn prefers_the_real_product_over_a_lookalike() {
        let candidates = vec![
            ("Chrome Canvas".to_string(), "canvas"),
            ("Google Chrome".to_string(), "chrome"),
        ];
        assert_eq!(best_match(&candidates, "chrome"), Some("chrome"));

        let edge = vec![
            ("Microsoft Edge".to_string(), "edge"),
            ("Edge Beta Updater Helper".to_string(), "helper"),
        ];
        assert_eq!(best_match(&edge, "edge"), Some("edge"));

        let code = vec![
            ("Code Signing Tools".to_string(), "signing"),
            ("Visual Studio Code".to_string(), "vscode"),
        ];
        assert_eq!(best_match(&code, "code"), Some("vscode"));
    }

    #[test]
    fn exact_name_always_wins() {
        let candidates = vec![
            ("Discord Updater".to_string(), "updater"),
            ("Discord".to_string(), "discord"),
        ];
        assert_eq!(best_match(&candidates, "discord"), Some("discord"));
    }

    #[test]
    fn unrelated_names_do_not_match() {
        assert_eq!(match_score("Calculator", "blender"), None);
        // An honest miss is required - silently opening the wrong app is worse
        // than saying the app isn't installed.
        let candidates = vec![("Calculator".to_string(), "calc")];
        assert_eq!(best_match(&candidates, "blender"), None);
    }

    #[test]
    fn multi_word_queries_match_substrings() {
        let candidates = vec![("Visual Studio Code".to_string(), "vscode")];
        assert_eq!(best_match(&candidates, "visual studio"), Some("vscode"));
    }

    /// Live probe against THIS machine - resolution only, nothing is launched.
    /// Run with `cargo test resolves_real_apps -- --ignored --nocapture`.
    /// Ignored by default because it depends on what is actually installed.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn resolves_real_apps_on_this_machine() {
        for spoken in [
            "the browser",
            "chrome",
            "edge",
            "obsidian",
            "cursor",
            "vs code",
            "notepad",
            "discord",
            "codex",
            "calculator",
            "file explorer",
            "definitely-not-installed-xyz",
        ] {
            let name = clean_app_name(spoken);
            let how = if is_generic_browser(&name) {
                "default browser".to_string()
            } else if matches!(name.as_str(), "codex" | "codex desktop") {
                "codex app (CLI)".to_string()
            } else if known_exe(&name).is_some_and(command_resolves) {
                format!("exe `{}`", known_exe(&name).unwrap())
            } else if let Some(p) = find_start_menu_shortcut(&name) {
                format!("shortcut `{}`", p.file_stem().unwrap().to_string_lossy())
            } else if let Some((label, _)) = find_store_app(&name) {
                format!("store app `{label}`")
            } else if command_resolves(&name) {
                "bare shell".to_string()
            } else {
                "UNRESOLVED".to_string()
            };
            println!("{spoken:<28} -> {how}");
        }
    }

    fn win(pid: u32, exe: &str, title: &str, z: usize, fg: bool) -> WindowFacts {
        WindowFacts { pid, exe_name: exe.to_string(), title: title.to_string(), z_order: z, is_foreground: fg }
    }

    fn picked_pid(choice: &BrowserChoice) -> Option<u32> {
        match choice {
            BrowserChoice::Window(w) => Some(w.pid),
            _ => None,
        }
    }

    /// Live 2026-09-24: Chrome had just been focused, and "open https://mail.google.com"
    /// still went to Edge (the default). The browser in front is the one he means.
    #[test]
    fn a_page_opens_in_the_browser_in_front() {
        let windows = vec![
            win(10, "chrome", "gmail - Google Search - Google Chrome", 0, true),
            win(20, "msedge", "Inbox (53) - Microsoft Edge", 1, false),
            win(30, "code", "praxis - Cursor", 2, false),
        ];
        let (choice, note) = choose_browser(&windows, None);
        assert_eq!(picked_pid(&choice), Some(10));
        assert_eq!(note, None);
    }

    #[test]
    fn without_a_browser_in_front_the_top_most_browser_wins() {
        let windows = vec![
            win(30, "cursor", "praxis - Cursor", 0, true),
            win(20, "msedge", "Inbox - Microsoft Edge", 3, false),
            win(10, "chrome", "New Tab - Google Chrome", 1, false),
        ];
        assert_eq!(picked_pid(&choose_browser(&windows, None).0), Some(10));
        // "the browser" is no preference at all, not a request for the default.
        assert_eq!(picked_pid(&choose_browser(&windows, Some("the browser")).0), Some(10));
    }

    #[test]
    fn no_browser_open_means_the_default_browser() {
        let windows = vec![win(30, "cursor", "praxis - Cursor", 0, true)];
        assert_eq!(choose_browser(&windows, None).0, BrowserChoice::Default);
        assert_eq!(choose_browser(&[], None).0, BrowserChoice::Default);
    }

    #[test]
    fn a_named_browser_beats_the_one_in_front() {
        let windows = vec![
            win(10, "chrome", "New Tab - Google Chrome", 0, true),
            win(20, "msedge", "Inbox - Microsoft Edge", 2, false),
            win(21, "msedge", "Bing - Microsoft Edge", 1, false),
        ];
        assert_eq!(picked_pid(&choose_browser(&windows, Some("edge")).0), Some(21), "top-most Edge window");
        assert_eq!(picked_pid(&choose_browser(&windows, Some("Microsoft Edge")).0), Some(21));
        assert_eq!(choose_browser(&windows, Some("default")).0, BrowserChoice::Default);
        // Named but not running: start that browser, not whichever one is in front.
        assert_eq!(choose_browser(&windows, Some("firefox")).0, BrowserChoice::Named("firefox"));
        assert_eq!(choose_browser(&windows, Some("Brave")).0, BrowserChoice::Named("brave"));
    }

    #[test]
    fn a_window_title_fragment_picks_that_browser_window() {
        let windows = vec![
            win(10, "chrome", "New Tab - Google Chrome", 0, true),
            win(20, "msedge", "Inbox (53) - zach@example.com - Gmail - Microsoft Edge", 1, false),
            win(30, "code", "gmail-notes.md - Cursor", 2, false),
        ];
        assert_eq!(picked_pid(&choose_browser(&windows, Some("gmail")).0), Some(20), "only browser windows count");
        let (choice, note) = choose_browser(&windows, Some("outlook"));
        assert_eq!(picked_pid(&choice), Some(10), "no match falls back to the browser in front");
        assert!(note.is_some_and(|n| n.contains("outlook")), "and says so");
    }

    #[test]
    fn browsers_get_a_new_tab_the_way_each_one_takes_it() {
        assert_eq!(browser_launch_args("chrome", "https://mail.google.com"), vec!["https://mail.google.com"]);
        assert_eq!(browser_launch_args("msedge", "https://a.b"), vec!["https://a.b"]);
        assert_eq!(browser_launch_args("brave", "https://a.b"), vec!["https://a.b"]);
        assert_eq!(browser_launch_args("firefox", "https://a.b"), vec!["-new-tab", "https://a.b"]);
    }

    #[test]
    fn the_open_url_result_names_the_browser_it_used() {
        assert_eq!(open_url_sentence("https://mail.google.com", Some("Google Chrome"), None, None), "Opened https://mail.google.com in Google Chrome.");
        assert_eq!(open_url_sentence("gmail.com", None, None, None), "Opened gmail.com.");
        assert_eq!(
            open_url_sentence("gmail.com", Some("Google Chrome"), Some("No open browser window matches \"x\"."), Some("Inbox (53) - Gmail - Google Chrome")),
            "No open browser window matches \"x\". Opened gmail.com in Google Chrome. The browser now shows \"Inbox (53) - Gmail - Google Chrome\"."
        );
    }

    #[test]
    fn encodes_search_queries() {
        assert_eq!(encode_query("weather in lisbon"), "weather+in+lisbon");
        assert_eq!(encode_query("c++ & rust"), "c%2B%2B+%26+rust");
    }

    #[test]
    fn a_page_that_has_not_arrived_is_not_where_he_is() {
        let url = "https://stackoverflow.com/questions";
        // Live 2026-09-18: the tab read "Just a moment..." when Atlas said "Done".
        assert!(is_check_title("Just a moment... and 21 more pages - Personal - Microsoft Edge"));
        assert!(is_transient_title("Just a moment... and 21 more pages - Personal - Microsoft Edge", url));
        assert!(is_transient_title("New Tab and 22 more pages - Personal - Microsoft Edge", url));
        assert!(is_transient_title("stackoverflow.com/questions - Google Chrome", url));
        assert!(!is_transient_title("Newest Questions - Stack Overflow and 21 more pages - Personal - Microsoft Edge", url));
        assert!(!is_transient_title("Inbox (49) - someone@example.com - Gmail - Google Chrome", "https://mail.google.com/"));
        assert!(landed_sentence("Just a moment...").contains("never try to get past it") || landed_sentence("Just a moment...").contains("Never try to get past it"));
        assert_eq!(landed_sentence("Newest Questions - Stack Overflow"), "The browser now shows \"Newest Questions - Stack Overflow\".");
    }

    #[test]
    fn the_page_title_is_read_out_of_the_browser_window_title() {
        assert_eq!(page_part("Inbox (49) - a@b.com - Gmail and 24 more pages - Personal - Microsoft\u{200b} Edge"), "Inbox (49) - a@b.com - Gmail");
        assert_eq!(page_part("Newest Questions - Stack Overflow - Google Chrome"), "Newest Questions - Stack Overflow");
        assert_eq!(page_part("Gmail and 24 more pages - Personal - Microsoft Edge"), "Gmail");
        assert!(is_bare_title("Gmail and 24 more pages - Personal - Microsoft Edge"));
        assert!(!is_bare_title("Inbox (49) - a@b.com - Gmail and 24 more pages - Personal - Microsoft Edge"));
        assert_eq!(page_part("Salt and Pepper Recipes - Google Chrome"), "Salt and Pepper Recipes", "an ordinary 'and' is not a tab count");
        assert_eq!(page_part("Salt and Pepper Recipes and 3 more pages - Personal - Microsoft Edge"), "Salt and Pepper Recipes");
    }
}

#[cfg(all(test, windows))]
mod lock_probe {
    #[test]
    #[ignore = "reads this machine's real lock state"]
    fn live_screen_locked_print() {
        println!("screen_locked = {}", crate::native_ops::win::screen_locked());
    }
}
