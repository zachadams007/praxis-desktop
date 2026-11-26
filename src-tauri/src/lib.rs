// Praxis Tauri shell.
//
// Phase 1 is frontend-only EXCEPT for one real capability the owner asked for: the
// file-birth visualizer. `watch_folder` uses the `notify` crate to watch a local
// folder; when a file appears it emits a `praxis://file-born` event that the frontend
// turns into a brain pulse + a Files-panel entry (see src/data/fileWatch.ts). No API,
// no spend - just the OS telling us a file was created.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager, State};

mod agent_chat;
mod autonomy;
mod board_meeting;
mod claude_usage;
mod codex_usage;
mod computer_use;
mod cursor_usage;
mod desktop_ops;
mod diag;
mod elevenlabs_usage;
mod restore;
mod flightdeck;
mod flightdeck_topology;
mod flow_runner;
mod hermes_bridge;
mod live_operate;
mod hybrid_ops;
mod iso8601;
mod memory_graph;
mod workspace;
mod memory_todo;
mod native_ops;
mod voice_pill;
mod openai_billing;
mod openai_credit;
mod ui_elements;
mod screen_ocr;
mod agent_jobs;
mod atlas_context;
mod openai_realtime;
mod org_scan;
mod prompt_vault;
mod qa_eyes;
mod quartz_sidecar;
mod research_watch;
mod run_ledger;
mod run_notes;
mod screen_capture;
mod session_poller;
mod skill_store;
mod session_deliver;
mod sovereign;
mod state_mirror;
mod transcript_tailer;
pub(crate) mod usage;
mod vault;
mod voice_stt;
mod voice_tts;
mod voice_usage;
mod watchme;
mod web_search;
mod window_ops;

/// WebView2 args applied to EVERY window: keep wry's defaults, let audio/TTS play without a
/// user gesture, and auto-accept the mic/camera permission prompt (this is a personal app) so
/// getUserMedia (voice capture + the gesture webcam) doesn't silently fail. NOTE: setting this
/// REPLACES wry's default `--disable-features`, so we re-include it. WebView2 still ships NO
/// SpeechRecognition backend - real STT is a separate engine, not a flag.
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream";

#[derive(Clone, serde::Serialize)]
struct FileBorn {
    name: String,
    path: String,
}

/// Holds the active watcher so it isn't dropped (dropping stops watching).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// Shared liveness flag for the Phase-2b real-event bus threads (transcript tailer
/// + session poller). Set false on app exit so they stop cleanly instead of being
/// killed mid-read. Managed in app state so the run-loop's Exit handler can reach it.
struct BridgeShutdown(Arc<AtomicBool>);

#[tauri::command]
fn watch_folder(
    app: tauri::AppHandle,
    state: State<WatcherState>,
    path: String,
) -> Result<(), String> {
    std::fs::create_dir_all(&path).ok();

    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Create(_)) {
                for p in event.paths {
                    if p.is_file() {
                        let name = p
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("file")
                            .to_string();
                        let _ = app_handle.emit(
                            "praxis://file-born",
                            FileBorn {
                                name,
                                path: p.to_string_lossy().into_owned(),
                            },
                        );
                    }
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

/// Bring the main window to the front (show + unminimize + focus) and tell the
/// frontend to play the wake pulse. Shared by the tray click and the tray "Show"
/// menu item so every "summon" entry point behaves identically.
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        force_foreground(&window); // beat Windows' foreground lock (see below)
                                   // Self-heal a blank window on show - the taskbar/desktop-icon "white screen".
                                   // A window created hidden at login can reach here with React never mounted
                                   // (R3F's ResizeObserver measures 0x0 while hidden and never recovers) or with
                                   // a dead renderer. If the root has no children, reload NOW that the window is
                                   // visible so the remount measures a real size. No-op on a healthy window.
        let _ = window.eval(
            "(function(){var r=document.getElementById('root');if(!r||!r.hasChildNodes()){location.reload();}})()",
        );
        // And nudge the size by 1px and back so every ResizeObserver re-fires even
        // when React DID mount but the canvas sized to zero.
        if let Ok(size) = window.outer_size() {
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height + 1));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
        }
        let _ = window.emit("praxis:wake", ());
    }
}

/// Force the window to the actual FOREGROUND. When the global hotkey fires from
/// inside another app, Windows blocks a background process from calling
/// SetForegroundWindow (the "foreground lock"), so plain show()+set_focus() leaves
/// Praxis BEHIND the app you're in - it looks like nothing happened. The canonical
/// workaround: temporarily AttachThreadInput our thread to the current foreground
/// thread, which lifts the lock for the duration, then detach.
#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;
    pub type Hwnd = *mut c_void;
    pub const SW_RESTORE: i32 = 9;
    extern "system" {
        pub fn GetForegroundWindow() -> Hwnd;
        pub fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        pub fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        pub fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        pub fn BringWindowToTop(hwnd: Hwnd) -> i32;
        pub fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        pub fn GetCurrentThreadId() -> u32;
    }
}

#[cfg(windows)]
fn force_foreground(window: &tauri::WebviewWindow) {
    let Ok(h) = window.hwnd() else { return };
    let hwnd = h.0 as win32::Hwnd;
    unsafe {
        // attach our input to the foreground thread → the lock lifts → SetForegroundWindow works
        let fg_thread =
            win32::GetWindowThreadProcessId(win32::GetForegroundWindow(), std::ptr::null_mut());
        let this_thread = win32::GetCurrentThreadId();
        win32::AttachThreadInput(fg_thread, this_thread, 1);
        win32::ShowWindow(hwnd, win32::SW_RESTORE);
        win32::SetForegroundWindow(hwnd);
        win32::BringWindowToTop(hwnd);
        win32::AttachThreadInput(fg_thread, this_thread, 0);
    }
}
#[cfg(not(windows))]
fn force_foreground(_window: &tauri::WebviewWindow) {}

/// True iff our main window is the actual foreground window (reliable on Windows,
/// unlike `is_focused()` which the global-hotkey path can misreport).
#[cfg(windows)]
fn is_foreground(window: &tauri::WebviewWindow) -> bool {
    window
        .hwnd()
        .map(|h| unsafe { win32::GetForegroundWindow() == h.0 as win32::Hwnd })
        .unwrap_or(false)
}
#[cfg(not(windows))]
fn is_foreground(window: &tauri::WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

/// Global-hotkey behavior: summon ⇄ dismiss.
///   • hidden, minimized, or sitting behind another app → SHOW + focus (summon)
///   • already the focused front window                → HIDE to tray (dismiss)
/// Hiding keeps the process (and the hotkey) alive - it does NOT quit Praxis, so
/// the next press re-summons instantly. This is the Spotlight-style toggle the owner
/// asked for: one key to call Praxis up, the same key to tuck it away.
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        // dismiss ONLY when Praxis is the front window; otherwise always summon.
        // (GetForegroundWindow is reliable where is_focused() isn't on the hotkey path.)
        if visible && !minimized && is_foreground(&window) {
            let _ = window.hide();
        } else {
            show_main(app);
        }
    }
}

/// Open (or focus) the Flight Deck window - Praxis's mission-control surface for
/// parallel Claude Code sessions. Its own native window (own title + teal icon),
/// not a panel inside the brain. Reached from the in-app button, the tray, and a
/// standalone desktop/taskbar shortcut (`praxis.exe --flight-deck`).
fn open_flight_deck(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("flightdeck") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // Build the window on a dedicated thread - NEVER the caller's thread.
    //
    // `WebviewWindowBuilder::build()` blocks the calling thread until the main
    // event loop processes the create-webview message. Every caller here (the
    // in-app button's sync command, the tray menu, the --flight-deck shortcut)
    // runs ON the main thread, so a direct call deadlocks: the main thread waits
    // on a channel for a message only the main thread can deliver. The window
    // frame appears but its webview never navigates (white screen) and the whole
    // app freezes - the X stops responding. Running build() on a separate thread
    // keeps the main event loop free to actually create the webview.
    let app = app.clone();
    std::thread::spawn(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &app,
            "flightdeck",
            tauri::WebviewUrl::App("flightdeck.html".into()),
        )
        .title("Flight Deck")
        .inner_size(1720.0, 1040.0)
        .min_inner_size(1100.0, 720.0)
        .resizable(true)
        .center()
        .theme(Some(tauri::Theme::Dark))
        .additional_browser_args(WEBVIEW2_ARGS)
        .build();

        match built {
            Ok(w) => {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/flightdeck.png"))
                {
                    let _ = w.set_icon(icon);
                }
                let _ = w.set_focus();
            }
            Err(e) => {
                crate::elog!("[flight-deck] window error: {e}");
                // surface it to the brain window so it isn't an invisible no-op
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("praxis://flightdeck-error", e.to_string());
                }
            }
        }
    });
}

#[tauri::command]
fn open_flight_deck_cmd(app: tauri::AppHandle) {
    open_flight_deck(&app);
}

/// Open (or focus) a secondary super-app window built from an HTML entry. Same
/// discipline as `open_flight_deck`: build on a dedicated thread (the caller runs on
/// the main thread and `build()` would deadlock it). Each window is its own renderer
/// process, so its WebGL/DOM context never competes with the brain's. No custom icon
/// (uses the app default) → no missing-asset build dependency.
fn open_secondary(
    app: &tauri::AppHandle,
    label: &'static str,
    url: &'static str,
    title: &'static str,
    size: (f64, f64),
    min: (f64, f64),
) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.maximize();
        let _ = win.set_focus();
        // Windows foreground lock: a click from another window can't foreground us
        // via plain set_focus - the window opened BEHIND (Codex audit). Same trick
        // show_main uses.
        #[cfg(windows)]
        force_foreground(&win);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let built =
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
                .title(title)
                .inner_size(size.0, size.1)
                .min_inner_size(min.0, min.1)
                .resizable(true)
                // Open filling the screen (maximized → still has a titlebar/controls so it's never
                // trapped). `inner_size` above is the size it restores to when un-maximized.
                .maximized(true)
                .center()
                .theme(Some(tauri::Theme::Dark))
                .additional_browser_args(WEBVIEW2_ARGS)
                .build();
        match built {
            Ok(win) => {
                let _ = win.set_focus();
                #[cfg(windows)]
                force_foreground(&win);
            }
            Err(e) => {
                crate::elog!("[{label}] window error: {e}");
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("praxis://window-error", format!("{label}: {e}"));
                }
            }
        }
    });
}

/// Memory Galaxy - the REAL Quartz graph of the live memory vault, served by a local sidecar and
/// shown embedded in the `knowledge` window (live-updates as agents write notes). Falls back to the
/// bundled `knowledge.html` galaxy if Quartz isn't reachable, so the window is never blank.
fn open_knowledge(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("knowledge") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        #[cfg(windows)]
        force_foreground(&win);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        quartz_sidecar::ensure_started(&app);
        // Short head start only: on a WARM boot the server is up in seconds and the shell's
        // node-content iframe finds it immediately. The star-atlas canvas doesn't need Quartz at
        // all (only clicking a node's content view does), so: open the window, keep waiting in
        // the background, tell the shell when it's genuinely up or down.
        let quartz_fast = quartz_sidecar::wait_ready(std::time::Duration::from_secs(10));
        if !quartz_fast {
            let app_bg = app.clone();
            std::thread::spawn(move || {
                // A cold `npx quartz build --serve` over the ~950-note vault can exceed
                // 2 minutes - the old single 110s window gave up right before it landed
                // and the "degraded" banner then stuck forever (no later ready signal).
                // Now: notify once at ~2min, but KEEP waiting up to 6min total and
                // always fire quartz-ready the moment it's actually up.
                if quartz_sidecar::wait_ready(std::time::Duration::from_secs(110)) {
                    let _ = app_bg.emit("praxis://quartz-ready", ());
                    return;
                }
                let msg = "vault content server (Quartz) still starting — node pages may open blank for a bit; the galaxy itself is unaffected";
                crate::elog!("[knowledge] {msg}");
                let _ = app_bg.emit("praxis://quartz-error", msg.to_string());
                if quartz_sidecar::wait_ready(std::time::Duration::from_secs(250)) {
                    let _ = app_bg.emit("praxis://quartz-ready", ());
                }
            });
        }
        // The window is the React SHELL (header + Agent Dashboard + MAP legend + voice); it embeds
        // the Quartz graph as a transparent iframe (src/knowledge/App.tsx). CSP is null so the
        // cross-origin http://localhost:8181 iframe loads fine.
        let url = tauri::WebviewUrl::App("knowledge.html".into());
        let built = tauri::WebviewWindowBuilder::new(&app, "knowledge", url)
            .title("Praxis · Memory Galaxy")
            .inner_size(1600.0, 1000.0)
            .min_inner_size(1040.0, 700.0)
            .resizable(true)
            .center()
            .theme(Some(tauri::Theme::Dark))
            .additional_browser_args(WEBVIEW2_ARGS)
            .build();
        match built {
            Ok(win) => {
                let _ = win.set_focus();
            }
            Err(e) => {
                crate::elog!("[knowledge] window error: {e}");
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("praxis://window-error", format!("knowledge: {e}"));
                }
            }
        }
    });
}

/// Command Center (the cockpit: autonomy dial, fleet, spend, launcher).
fn open_command_center(app: &tauri::AppHandle) {
    open_secondary(
        app,
        "command",
        "command.html",
        "Praxis · Command Center",
        (1480.0, 940.0),
        (1120.0, 720.0),
    );
}

#[tauri::command]
fn open_knowledge_cmd(app: tauri::AppHandle) {
    open_knowledge(&app);
}

#[tauri::command]
fn open_command_center_cmd(app: tauri::AppHandle) {
    open_command_center(&app);
}

/// Quartz vault-server heartbeat for the Command Center status rail's QUARTZ chip -
/// a plain TCP liveness check against the sidecar (quartz_sidecar::is_up), no HTTP.
#[tauri::command]
fn quartz_health() -> bool {
    quartz_sidecar::is_up()
}

#[derive(serde::Serialize)]
struct QuartzStatus {
    state: &'static str,
    detail: String,
}

/// Honest lifecycle status for Quartz, which starts lazily with the Memory Galaxy.
#[tauri::command]
fn quartz_status() -> QuartzStatus {
    let (state, detail) = quartz_sidecar::status();
    QuartzStatus { state, detail }
}

/// Bring the brain (main) window to the front - used by the Command Center's "Brain"
/// launcher tile and the "run it in the brain" palette actions.
/// Does this path exist on disk? Used by the brain's Inspector to decide whether
/// an artifact chip may advertise itself as openable.
///
/// The chips used to be marked openable purely from a string derivation - any
/// `.tsx` label became `src/components/<label>` - so chips for files in OTHER
/// repos (EngineCore.tsx, MyDesk.tsx) and for files that had since moved
/// (DeckApp.tsx, useHandGesture.ts) rendered with the "leaves the app" arrow and
/// did nothing at all when clicked: openPath rejected into an empty catch.
#[tauri::command]
fn path_exists(path: String) -> bool {
    !path.trim().is_empty() && std::path::Path::new(path.trim()).exists()
}

#[tauri::command]
fn show_main_cmd(app: tauri::AppHandle) {
    show_main(&app);
}

/// Raise the brain window AND switch it to a named view ("brain" | "journey").
/// The other windows' nav buttons need this: "Journey" used to call show_main_cmd,
/// which raises the brain window on whatever view was last active, so a button
/// labelled Journey did not navigate to Journey. The brain window listens for
/// `praxis://view` and drives its own view store, so the switch happens whether
/// the window was hidden, minimised or already showing.
#[tauri::command]
fn show_main_view_cmd(app: tauri::AppHandle, view: String) {
    show_main(&app);
    let _ = app.emit("praxis://view", view);
}

/// Close (HIDE) a Praxis window by label - the voice "close/hide/dismiss the command center"
/// path. We HIDE rather than destroy for the same reasons the app never destroys these
/// windows elsewhere: the brain (`main`) is a resident singleton (its CloseRequested handler
/// already hides + prevent_close), and the secondary windows (`command`/`knowledge`/`flightdeck`)
/// carry a live WebGL/Quartz renderer that is expensive to rebuild and whose builder must run
/// off the main thread. Hiding keeps them instantly re-summonable by the existing open_* path
/// (which show()+focus() an already-built window). Unknown labels return Err so the frontend can
/// surface an honest message instead of silently no-op'ing.
#[tauri::command]
fn close_window_cmd(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let name = window_display_name(&label);
    match app.get_webview_window(&label) {
        Some(window) => {
            let _ = window.hide();
            Ok(format!("{name} hidden."))
        }
        // Already gone (e.g. a secondary window that was never opened) - treat as success so
        // "close the command center" when it's not open is a friendly no-op, not an error.
        None => Ok(format!("{name} was already closed.")),
    }
}

/// Cycle focus through the OPEN Praxis windows in a fixed order (Ctrl+Alt+→ / ←). Pure
/// keyboard window-switching - no mouse. Skips closed windows and wraps around. (A future
/// pass can pin each window to a specific monitor on a multi-screen rig.)
#[tauri::command]
fn cycle_windows(app: tauri::AppHandle, forward: bool) {
    const ORDER: [&str; 4] = ["main", "command", "knowledge", "flightdeck"];
    let open: Vec<tauri::WebviewWindow> = ORDER
        .iter()
        .filter_map(|l| app.get_webview_window(l))
        .collect();
    if open.is_empty() {
        return;
    }
    let cur = open
        .iter()
        .position(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(0);
    let n = open.len();
    let next = if forward {
        (cur + 1) % n
    } else {
        (cur + n - 1) % n
    };
    let w = &open[next];
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn window_display_name(label: &str) -> &str {
    match label {
        "main" => "Praxis",
        "command" => "Command Center",
        "knowledge" => "Memory Galaxy",
        "flightdeck" => "Flight Deck",
        _ => "Praxis window",
    }
}

fn open_window_by_label(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    match label {
        "main" => show_main(app),
        "command" => open_command_center(app),
        "knowledge" => open_knowledge(app),
        "flightdeck" => open_flight_deck(app),
        _ => return Err(format!("Unknown Praxis window '{label}'.")),
    }
    Ok(())
}

fn same_monitor(a: &tauri::Monitor, b: &tauri::Monitor) -> bool {
    let ap = a.position();
    let bp = b.position();
    let asz = a.size();
    let bsz = b.size();
    ap.x == bp.x && ap.y == bp.y && asz.width == bsz.width && asz.height == bsz.height
}

/// Where to send a window. Mirrors the voice-side `VoiceIntent["window-placement"]["placement"]`
/// union in src/voice/commands.ts - keep the two in sync.
///   - `Index(n)` - "monitor 2" / "the third screen" (1-based, as spoken).
///   - `Left` / `Right` - pick the monitor whose position is left/right of the CURRENT one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MonitorTarget {
    NextMonitor,
    Primary,
    Index(usize),
    Left,
    Right,
}

impl MonitorTarget {
    /// Parse the string sent over the Tauri bridge (see `execute.ts` `moveWindowToMonitor`).
    /// Unknown/empty strings fall back to the historical "next monitor" behavior so old
    /// callers (and the default arg) keep working.
    fn parse(spec: &str) -> Self {
        let s = spec.trim().to_ascii_lowercase();
        if s.is_empty() || s == "next" || s == "next-monitor" {
            return MonitorTarget::NextMonitor;
        }
        if s == "primary" || s == "main" {
            return MonitorTarget::Primary;
        }
        if s == "left" {
            return MonitorTarget::Left;
        }
        if s == "right" {
            return MonitorTarget::Right;
        }
        if let Some(rest) = s.strip_prefix("index:") {
            if let Ok(n) = rest.parse::<usize>() {
                return MonitorTarget::Index(n);
            }
        }
        MonitorTarget::NextMonitor
    }
}

/// Resolve a `MonitorTarget` to an actual `tauri::Monitor`, given the window's current monitor
/// and the full monitor list (order is NOT guaranteed to be left-to-right by the OS, so `Left`/
/// `Right` and `Index` both reason from x-position, not list order).
fn resolve_target_monitor<'a>(
    target: MonitorTarget,
    monitors: &'a [tauri::Monitor],
    current: Option<&tauri::Monitor>,
    primary: Option<&tauri::Monitor>,
) -> Result<&'a tauri::Monitor, String> {
    match target {
        MonitorTarget::NextMonitor => {
            let current_index = current
                .and_then(|cur| monitors.iter().position(|m| same_monitor(m, cur)))
                .unwrap_or(0);
            Ok(&monitors[(current_index + 1) % monitors.len()])
        }
        MonitorTarget::Primary => {
            if let Some(p) = primary {
                monitors
                    .iter()
                    .find(|m| same_monitor(m, p))
                    .ok_or_else(|| "Could not match the primary display.".to_string())
            } else {
                // Windows can fail to report a primary monitor; fall back to the
                // left-most one, which is the primary on the overwhelming majority
                // of multi-monitor Windows setups.
                monitors
                    .iter()
                    .min_by_key(|m| m.position().x)
                    .ok_or_else(|| "No displays reported.".to_string())
            }
        }
        MonitorTarget::Index(n) => {
            // Spoken as 1-based ("monitor 2" = the second one), ordered left-to-right by
            // x-position since that's how the owner counts his physical desk layout.
            if n == 0 {
                return Err("Monitor numbers start at 1.".to_string());
            }
            let mut ordered: Vec<&tauri::Monitor> = monitors.iter().collect();
            ordered.sort_by_key(|m| m.position().x);
            ordered.get(n - 1).copied().ok_or_else(|| {
                format!(
                    "You only have {} display{} — there's no monitor {n}.",
                    monitors.len(),
                    if monitors.len() == 1 { "" } else { "s" }
                )
            })
        }
        MonitorTarget::Left | MonitorTarget::Right => {
            let Some(cur) = current else {
                return Err("Could not read the current display.".to_string());
            };
            let cur_x = cur.position().x;
            let candidates: Vec<&tauri::Monitor> =
                monitors.iter().filter(|m| !same_monitor(m, cur)).collect();
            if candidates.is_empty() {
                return Err("There's no other display to move to.".to_string());
            }
            let picked = if target == MonitorTarget::Left {
                candidates
                    .into_iter()
                    .filter(|m| m.position().x < cur_x)
                    .max_by_key(|m| m.position().x) // nearest one to the left
            } else {
                candidates
                    .into_iter()
                    .filter(|m| m.position().x > cur_x)
                    .min_by_key(|m| m.position().x) // nearest one to the right
            };
            picked.ok_or_else(|| {
                format!(
                    "There's no display to the {} of the current one.",
                    if target == MonitorTarget::Left {
                        "left"
                    } else {
                        "right"
                    }
                )
            })
        }
    }
}

fn move_window_to_target_monitor(
    app: &tauri::AppHandle,
    label: &str,
    target: MonitorTarget,
) -> Result<String, String> {
    let name = window_display_name(label);
    let Some(window) = app.get_webview_window(label) else {
        open_window_by_label(app, label)?;
        let app = app.clone();
        let label = label.to_string();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if app.get_webview_window(&label).is_some() {
                    let _ = move_window_to_target_monitor(&app, &label, target);
                    break;
                }
            }
        });
        return Ok(format!(
            "Opening {name} and moving it to the other display."
        ));
    };

    let monitors = window
        .available_monitors()
        .map_err(|e| format!("Could not read displays: {e}"))?;
    if monitors.is_empty() {
        return Err("Windows did not report any displays.".to_string());
    }
    if monitors.len() < 2 {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        force_foreground(&window);
        return Ok(format!("{name} is on screen. Windows only reports one display, so there is no other monitor to move it to."));
    }

    let current = window
        .current_monitor()
        .map_err(|e| format!("Could not read the current display: {e}"))?;
    let primary = window
        .primary_monitor()
        .map_err(|e| format!("Could not read the primary display: {e}"))?;

    let target_monitor =
        resolve_target_monitor(target, &monitors, current.as_ref(), primary.as_ref())
            .map_err(|e| format!("Could not move {name}: {e}"))?;

    // If the window is maximized, `set_position` is a no-op on Windows (the OS keeps a
    // maximized window snapped to its monitor's work area). Unmaximize first, move, then
    // restore the maximized state on the NEW monitor so a maximized window actually follows.
    let was_maximized = window.is_maximized().unwrap_or(false);
    if was_maximized {
        let _ = window.unmaximize();
    }

    let work = target_monitor.work_area();
    let margin = (48.0 * target_monitor.scale_factor()).round() as i32;
    let x = work.position.x + margin;
    let y = work.position.y + margin;

    if let Ok(size) = window.outer_size() {
        let max_w = work
            .size
            .width
            .saturating_sub((margin.max(0) as u32).saturating_mul(2));
        let max_h = work
            .size
            .height
            .saturating_sub((margin.max(0) as u32).saturating_mul(2));
        if max_w > 0 && max_h > 0 && (size.width > max_w || size.height > max_h) {
            let _ = window.set_size(tauri::PhysicalSize::new(
                size.width.min(max_w),
                size.height.min(max_h),
            ));
        }
    }

    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| format!("Could not move {name}: {e}"))?;

    if was_maximized {
        let _ = window.maximize();
    }

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    force_foreground(&window);

    let display = target_monitor
        .name()
        .map(|s| s.as_str())
        .unwrap_or("the other display");
    Ok(format!("Moved {name} to {display}."))
}

/// `target` is an optional monitor spec string: "" / "next" (default = cycle to next display),
/// "primary" / "main" (bring it back), "left" / "right" (relative to the window's current
/// monitor), or "index:<n>" (1-based, left-to-right, e.g. "index:2" for "monitor 2"). Kept as a
/// loose string (not a Tauri-serialized enum) so the JS side stays a plain literal union -
/// see `MonitorPlacement` in src/voice/commands.ts.
#[tauri::command]
fn move_window_to_monitor_cmd(
    app: tauri::AppHandle,
    label: String,
    target: Option<String>,
) -> Result<String, String> {
    let spec = MonitorTarget::parse(target.as_deref().unwrap_or(""));
    move_window_to_target_monitor(&app, &label, spec)
}

/// Fire a native OS toast when the Board Meeting digest is generated (6am or catch-up).
/// Best-effort: notification permission/plugin failures never block the digest from
/// having been written - the vault note + Command Center card are the real artifact,
/// this is just the "you have a new digest" nudge.
#[tauri::command]
fn board_meeting_notify(app: tauri::AppHandle, date: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("Board Meeting")
        .body(format!(
            "Today's digest is ready ({date}) — open the Command Center."
        ))
        .show()
        .map_err(|e| format!("board_meeting_notify: {e}"))
}

/// %LOCALAPPDATA%\Praxis - where we drop a boot log so a post-reboot hotkey failure
/// is diagnosable without attaching a debugger. Also home to the optional `groq.key`.
pub(crate) fn praxis_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| std::path::PathBuf::from(p).join("Praxis"))
}

/// Append one timestamped line to praxis-boot.log (best-effort; never panics).
pub(crate) fn boot_log(msg: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(dir) = praxis_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("praxis-boot.log"))
        {
            let _ = writeln!(f, "[{stamp}] {msg}");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRAXIS WAS RUNNING AT BELOW-NORMAL PRIORITY, AND HUNG UNDER LOAD.
//
// Measured on the installed app, 2026-09-15 12:30: `Responding=False`, every invoke
// and every CDP call timing out, the UI thread sitting in the ready queue while two
// Cursor agents and a cargo link held the CPU. praxis.exe and every WebView2 child
// were BELOW_NORMAL. Raising the tree to NORMAL by hand brought it back within 1.5s
// (CDP connect went from 26s to 95ms).
//
// Cause: Task Scheduler starts tasks at priority 7, which is BELOW_NORMAL_PRIORITY_
// CLASS, and Praxis is launched through Task Scheduler on purpose - the install
// script uses it to escape the MSIX sandbox, and the old autostart and fix tasks did
// too. Every child process inherits the class, so the renderers starved with it.
//
// Raised here, first thing, before any WebView2 process exists, so the whole tree
// inherits NORMAL whichever launcher started it. Only the two starved classes are
// raised; a deliberately higher class is left alone.
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
const NORMAL_PRIORITY_CLASS: u32 = 0x0000_0020;

/// The class an inherited launcher class should be raised to, if any.
fn raised_priority_class(current: u32) -> Option<u32> {
    match current {
        IDLE_PRIORITY_CLASS | BELOW_NORMAL_PRIORITY_CLASS => Some(NORMAL_PRIORITY_CLASS),
        _ => None,
    }
}

#[cfg(windows)]
fn ensure_normal_priority() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn GetPriorityClass(process: *mut std::ffi::c_void) -> u32;
        fn SetPriorityClass(process: *mut std::ffi::c_void, class: u32) -> i32;
    }
    let current = unsafe { GetPriorityClass(GetCurrentProcess()) };
    let Some(target) = raised_priority_class(current) else { return };
    let ok = unsafe { SetPriorityClass(GetCurrentProcess(), target) } != 0;
    boot_log(&format!(
        "priority: launched at class {current:#x}; raise to NORMAL {}",
        if ok { "ok" } else { "FAILED" }
    ));
}

#[cfg(not(windows))]
fn ensure_normal_priority() {}

/// Set once the frontend actually mounts (see `boot_ok`). The boot watchdog reads
/// it to distinguish "window is up and painted" from the grey-window class where
/// the webview loads but React never mounts (2026-07-09: a ctor crash left every
/// window blank and nothing noticed until the owner did).
static FRONTEND_BOOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Marker that the watchdog already spent its single automatic restart, so a
/// deterministic boot crash can't restart-loop the app forever.
fn boot_retry_marker() -> Option<std::path::PathBuf> {
    praxis_dir().map(|d| d.join("boot-retry.txt"))
}

/// Separate marker for the LIFETIME renderer watchdog's escalated main-window
/// restart (distinct from the boot-time `boot-retry.txt`). Stores the epoch-ms of
/// the last auto-restart; a stale marker older than 10 minutes re-arms restarts, so
/// a recurring OOM crash can self-heal at most once per 10 minutes instead of
/// restart-looping. See `escalate_heal`.
fn heal_restart_marker() -> Option<std::path::PathBuf> {
    praxis_dir().map(|d| d.join("heal-restart.txt"))
}

/// Frontend calls this exactly once after React mounts the main window. Writes
/// `boot-ok.json` ({version, ts}) so the INSTALLER can verify a new build actually
/// painted (polled via UNC from sessions), and clears the watchdog's retry marker.
#[tauri::command]
fn boot_ok() {
    FRONTEND_BOOTED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(dir) = praxis_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let body = format!(
            "{{\"version\":\"{}\",\"ts\":{}}}",
            env!("CARGO_PKG_VERSION"),
            ts
        );
        let _ = std::fs::write(dir.join("boot-ok.json"), body);
    }
    if let Some(m) = boot_retry_marker() {
        let _ = std::fs::remove_file(m);
    }
    boot_log("boot_ok — frontend mounted");
}

/// Per-window renderer heartbeats - the "always awake" contract.
static HEARTBEATS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::OnceLock::new();

fn heartbeats() -> &'static Mutex<std::collections::HashMap<String, u64>> {
    HEARTBEATS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Per-window count of CONSECUTIVE watchdog silence flags that a plain reload failed
/// to clear. Reset the instant a fresh heartbeat arrives (see `window_heartbeat`) or
/// the watchdog next sees the window beating. Drives the escalation in `escalate_heal`:
/// a crashed renderer (WebView2 "Out of Memory" page) can't run `location.reload()`,
/// so one failed reload - or two consecutive silent cycles - triggers a harder heal.
static HEAL_FAILS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, u32>>> =
    std::sync::OnceLock::new();

fn heal_fails() -> &'static Mutex<std::collections::HashMap<String, u32>> {
    HEAL_FAILS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn window_heartbeat(label: String) {
    if let Ok(mut m) = heartbeats().lock() {
        m.insert(label.clone(), epoch_ms());
    }
    // A fresh beat means the renderer is alive again - forget any accrued heal
    // failures so a briefly-busy window can't inch toward an escalated restart.
    if let Ok(mut f) = heal_fails().lock() {
        f.remove(&label);
    }
}

/// Append one JS-heap sample to %LOCALAPPDATA%\Praxis\memory-telemetry.log so the
/// recurring WebView2 OOM crash (renderer climbing to ~2.6GB → "Out of Memory" page)
/// can finally be traced to the window and growth curve responsible. Called from the
/// frontend heartbeat hook every ~30s when `performance.memory` is available. Best-
/// effort and never panics; caps the file at ~2MB by keeping only the last ~500 lines.
#[tauri::command]
fn memory_telemetry(label: String, used_mb: f64, total_mb: f64) {
    let Some(dir) = praxis_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("memory-telemetry.log");
    // Cap the file so an always-on sampler can't grow it without bound.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            if let Ok(body) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = body.lines().collect();
                let start = lines.len().saturating_sub(500);
                let tail = lines[start..].join("\n");
                let _ = std::fs::write(&path, format!("{tail}\n"));
            }
        }
    }
    let line = format!(
        "[{}] {} {:.1}/{:.1}\n",
        epoch_ms(),
        label,
        used_mb,
        total_mb
    );
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Lifetime renderer watchdog: every 30s, any VISIBLE window whose heartbeat is older than 75s
/// gets a best-effort `location.reload()` (the same self-heal show_main() does on summon,
/// generalized to run continuously). This adds ESCALATION: if the reload `eval` errors, or the
/// window is still silent on the NEXT cycle too (2 consecutive flags), we escalate via
/// `escalate_heal` - destroy+recreate a secondary window, or a marker-guarded app restart for
/// `main`. The failure count is cleared the moment a fresh heartbeat lands. All logged to
/// praxis-boot.log.
fn spawn_renderer_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let now = epoch_ms();
        for (label, window) in app.webview_windows() {
            // Only Praxis's own pages send heartbeats. Police tauri.localhost pages only.
            let own_page = window
                .url()
                .map(|u| u.host_str() == Some("tauri.localhost") || u.scheme() == "tauri")
                .unwrap_or(true);
            if !own_page {
                continue;
            }
            let visible = window.is_visible().unwrap_or(false);
            // The resident overlay must keep receiving voice state while hidden.
            if !visible && label != "voicepill" {
                continue;
            }
            let last = {
                let mut m = match heartbeats().lock() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                *m.entry(label.clone()).or_insert(now) // first sight = grace period
            };
            let silent_ms = now.saturating_sub(last);
            // Chromium throttles a HIDDEN page's timers to ~1 wake-up a minute, so the
            // resting voice pill's 15s heartbeat can legitimately arrive ~60s late. At
            // 75s it would be "recovered" by a reload over and over while doing nothing
            // wrong; four minutes still catches a genuinely crashed renderer.
            let silent_limit_ms = if label == "voicepill" && !visible { 240_000 } else { 75_000 };
            if silent_ms <= silent_limit_ms {
                // Beating (or within grace) - drop any accrued failure count.
                if let Ok(mut f) = heal_fails().lock() {
                    f.remove(&label);
                }
                continue;
            }
            // Silent > 75s. Count this flag, attempt the cheap heal, then decide.
            // NOTE: unlike before, we do NOT reset the heartbeat here - that reset is
            // what would hide a persistently-dead renderer from the NEXT cycle. A
            // recovered renderer re-beats within ~15s (< the 30s loop) and clears the
            // flag; a still-dead one stays silent and earns its 2nd consecutive flag.
            let fails = {
                let mut f = match heal_fails().lock() {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let e = f.entry(label.clone()).or_insert(0);
                *e += 1;
                *e
            };
            if label == "voicepill" {
                // Never destroy/rebuild this singleton. A native reload can also
                // recover a crash page where eval cannot execute JavaScript.
                voice_pill::suspend_for_reload(&app);
                let reloaded = window.reload().is_ok();
                boot_log(&format!("voicepill heartbeat silent: reload {reloaded}"));
                if let Ok(mut m) = heartbeats().lock() {
                    m.insert(label.clone(), now); // fresh grace period, including hidden retries
                }
                continue;
            }
            let eval_ok = window.eval("location.reload()").is_ok();
            boot_log(&format!(
                "RENDERER WATCHDOG: window '{label}' silent {}s (flag #{fails}, eval {}) — reloading",
                silent_ms / 1000,
                if eval_ok { "ok" } else { "ERR" }
            ));
            // A failed eval = crashed renderer (crash page can't run our JS); a 2nd
            // consecutive flag = the reload didn't bring it back. Either way, escalate.
            if !eval_ok || fails >= 2 {
                escalate_heal(&app, &label, now);
                if let Ok(mut f) = heal_fails().lock() {
                    f.remove(&label);
                }
            }
        }
    });
}

/// Harder self-heal when a plain reload can't revive a silent renderer.
///   - SECONDARY windows (`command`/`knowledge`/`flightdeck`): destroy and rebuild
///     at the same label via the window's own creation path (`open_window_by_label`),
///     so a wedged/OOM'd webview gets a brand-new renderer process.
///   - `main`: a marker-guarded app restart (at most one per 10 minutes) - the OOM
///     crash page can only be cleared by a fresh process, but we must never
///     restart-loop, so `heal-restart.txt` records the last restart epoch.
/// Runs on the watchdog thread; the short sleep + `app.restart()` are safe there
/// (mirrors `spawn_boot_watchdog`).
fn escalate_heal(app: &tauri::AppHandle, label: &str, now: u64) {
    if label != "main" {
        boot_log(&format!(
            "RENDERER WATCHDOG: escalating — recreate '{label}'"
        ));
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
        // Let the main event loop process the destroy before rebuilding the label.
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Err(e) = open_window_by_label(app, label) {
            boot_log(&format!(
                "RENDERER WATCHDOG: recreate '{label}' failed: {e}"
            ));
        }
        // Give the freshly-built window a grace period so it isn't instantly re-flagged.
        if let Ok(mut m) = heartbeats().lock() {
            m.insert(label.to_string(), now);
        }
        return;
    }
    // main: marker-guarded restart, at most once per 10 minutes.
    let last_restart = heal_restart_marker()
        .and_then(|m| std::fs::read_to_string(m).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if now.saturating_sub(last_restart) <= 600_000 {
        boot_log(
            "RENDERER WATCHDOG: main still silent but auto-restart used <10min ago — holding for diagnosis",
        );
        return;
    }
    if let Some(m) = heal_restart_marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&m, now.to_string());
    }
    boot_log("RENDERER WATCHDOG: escalating — app restart (OOM crash page suspected)");
    app.restart();
}

/// Boot watchdog: if the frontend hasn't reported `boot_ok` within the window,
/// the webview is almost certainly blank (grey-window class). Restart the app
/// ONCE (marker-guarded); on the second failure log loudly and leave the process
/// up for diagnosis (memory: praxis-grey-window-webview-debug-playbook).
fn spawn_boot_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(25));
        if FRONTEND_BOOTED.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        boot_log("BOOT WATCHDOG: frontend never mounted after 25s — webview likely blank");
        match boot_retry_marker() {
            Some(marker) if !marker.exists() => {
                let _ = std::fs::write(&marker, "1");
                boot_log("BOOT WATCHDOG: restarting app once");
                app.restart();
            }
            Some(marker) => {
                let _ = std::fs::remove_file(marker);
                boot_log("BOOT WATCHDOG: retry already used — leaving app up for diagnosis");
            }
            None => {}
        }
    });
}

/// Register system-wide hotkeys. Returns whether every shortcut is registered
/// (false if e.g. another app momentarily owns one combo at boot - the caller
/// retries until it succeeds).
fn register_hotkey(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };
    let summon = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let shortcuts = app.global_shortcut();
    let mut ok = true;

    // NOTE: Ctrl+T deliberately does NOT live here. It belongs to register_voice_hotkey
    // (no-window-move background listening). A second registration here was THE
    // "Ctrl+T moves the window and doesn't listen" bug: this function runs first,
    // its handler force-foregrounded the window and emitted a legacy event name no
    // Tauri listener consumed, and the real handler then failed with "conflict".

    if !shortcuts.is_registered(summon) {
        if let Err(e) = shortcuts.on_shortcut(summon, |app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main(app);
            }
        }) {
            boot_log(&format!("hotkey Ctrl+Shift+Space register failed: {e}"));
            ok = false;
        }
    }

    ok
}

/// Register the global Ctrl+T hands-free voice toggle. One press = START listening
/// (no hold required); second press = STOP + send. Works from any foreground app so
/// The owner never has to click the Praxis window first.
///
/// Flow: Ctrl+T fires anywhere → Rust emits `praxis://voice-toggle` on the main
/// window → VoicePopup's useEffect listener calls mic.toggle() / brings the popup
/// forward. The main window does NOT need to be visible or focused.
fn register_voice_hotkey(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };
    let sc = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyT);
    if app.global_shortcut().is_registered(sc) {
        return true; // idempotent for the retry loop
    }
    match app.global_shortcut().on_shortcut(sc, |app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            // Emit the toggle event on the main window. The window does not need
            // to be focused or even visible - the webview processes it regardless.
            // Do NOT move, raise, or minimize the window - the owner wants Wispr-style background
            // listening (the window must stay put). Just fire the toggle; the main window's
            // ALWAYS-ON popup mic (alwaysOn) captures in the background without needing focus.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("praxis://voice-toggle", ());
            }
        }
    }) {
        Ok(_) => true,
        Err(e) => {
            boot_log(&format!("voice hotkey register failed: {e}"));
            false
        }
    }
}

/// Self-heal the WebView2 cache on EVERY launch path (taskbar, autostart, installer
/// relaunch, `r praxis`): a hard shutdown corrupts the cache and blanks the window
/// (the recurring white-screen). Previously external launchers fixed this by
/// `rmdir /s /q ...\EBWebView` - which also nuked **Local Storage** (tasks, trust,
/// fleet picks, galaxy tuning) on every login/install. This clears ONLY the pure
/// cache directories and never touches Local Storage / IndexedDB / Session Storage.
/// Runs before the builder, so no webview holds the files yet.
fn clear_webview_caches() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let base = std::path::PathBuf::from(local)
        .join("com.praxis.os")
        .join("EBWebView");
    // GUARD (v0.15.8): a taskbar/desktop click while Praxis is already running spawns a
    // SECOND instance that reaches here before the single-instance plugin kills it -
    // it must NOT delete cache files the live instance holds open (partial deletes
    // corrupt the running webview: the exact white-screen this fn exists to prevent).
    // Chromium keeps `EBWebView\lockfile` exclusively open while alive; if we can't
    // remove it, an instance is live and healthy - skip. A stale lockfile from a
    // crash removes fine and the clear proceeds.
    let lock = base.join("lockfile");
    if lock.exists() && std::fs::remove_file(&lock).is_err() {
        return;
    }
    for rel in [
        "GPUCache",
        "Default/Cache",
        "Default/Code Cache",
        "Default/GPUCache",
        "Default/DawnGraphiteCache",
        "Default/DawnWebGPUCache",
        "ShaderCache",
        "GrShaderCache",
    ] {
        let p = base.join(rel);
        if p.exists() {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything spawns a WebView2 process: children inherit this class.
    ensure_normal_priority();
    clear_webview_caches();
    tauri::Builder::default()
        // Single instance MUST be the first plugin: a second launch (e.g. the
        // "Flight Deck" desktop shortcut → `praxis.exe --flight-deck`) is routed
        // into the already-running Praxis instead of starting a duplicate app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--flight-deck") {
                open_flight_deck(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Autostart is handled OUTSIDE the app now (scripts/install-autostart.ps1):
        // a Windows Scheduled Task at logon - with restart-on-failure - runs a launcher
        // that CLEARS the WebView2 cache and then starts Praxis --hidden. The app no
        // longer writes its own Run-key entry; that was the unreliable path across
        // reboots (cache corruption + a Run-key/Task race), the exact bug the owner kept hitting.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(WatcherState::default())
        .manage(voice_pill::TrackerState::default())
        .invoke_handler(tauri::generate_handler![
            voice_pill::voice_pill_track,
            voice_pill::voice_pill_resize,
            diag::diag_recent,
            diag::diag_report,
            boot_ok,
            window_heartbeat,
            memory_telemetry,
            watch_folder,
            open_flight_deck_cmd,
            open_knowledge_cmd,
            open_command_center_cmd,
            show_main_cmd,
            path_exists,
            close_window_cmd,
            cycle_windows,
            move_window_to_monitor_cmd,
            flightdeck::fd_sessions,
            flightdeck::fd_session_tail,
            flightdeck::fd_read_vault,
            flightdeck_topology::fd_worktree_topology,
            vault::vault_set,
            vault::vault_get,
            vault::vault_list,
            vault::vault_delete,
            vault::vault_has,
            screen_capture::capture_active_monitor_jpeg,
            screen_capture::capture_atlas_monitor_frame,
            screen_capture::capture_stream_start,
            screen_capture::capture_stream_stop,
            sovereign::sovereign_start,
            sovereign::sovereign_do,
            sovereign::sovereign_abort,
            sovereign::sovereign_abort_all,
            sovereign::sovereign_stop,
            watchme::watchme_start,
            watchme::watchme_stop,
            watchme::watchme_ask,
            flightdeck::fd_write_vault,
            flightdeck::fd_set_active_window,
            flightdeck::fd_add_worktree,
            show_main_view_cmd,
            flightdeck::fd_set_lane_readonly,
            flightdeck::fd_spawn_session,
            flightdeck::fd_stop_session,
            voice_stt::transcribe_audio,
            voice_stt::groq_classify,
            voice_stt::stt_ready,
            voice_tts::speak_tts,
            ui_elements::ui_list_elements,
            ui_elements::ui_click_element,
            ui_elements::ui_fill_field,
            ui_elements::ui_clear_popups,
            agent_jobs::agent_jobs_run_daily,
            agent_jobs::lens_qa_workspace,
            atlas_context::atlas_context_card,
            cursor_usage::cursor_pool_state,
            openai_billing::openai_billing_state,
            openai_billing::openai_billing_refresh,
            openai_billing::openai_billing_sign_in,
            openai_credit::note_openai_credit_refusal,
            openai_credit::clear_openai_credit_refusal,
            openai_credit::openai_credit_status,
            voice_tts::tts_ready,
            voice_tts::get_voice_profile,
            voice_tts::set_voice_profile,
            voice_tts::voice_backends,
            voice_usage::voice_usage_snapshot,
            window_ops::tile_quadrants,
            window_ops::restore_formation,
            window_ops::formation_state,
            hermes_bridge::hermes_brain,
            hermes_bridge::brain_chat,
            hermes_bridge::brain_rail_status,
            hermes_bridge::praxis_look,
            hermes_bridge::agent_delegate,
            hermes_bridge::agent_delegate_abort,
            hermes_bridge::agent_delegate_abort_all,
            hermes_bridge::live_opened_recent,
            live_operate::live_operate_step,
            live_operate::live_operate_abort,
            live_operate::live_operate_abort_all,
            hermes_bridge::hermes_teach,
            computer_use::computer_use_operate,
            computer_use::computer_use_abort,
            computer_use::computer_use_abort_all,
            computer_use::autonomy_sync,
            computer_use::halt_sync,
            flow_runner::flow_start,
            flow_runner::flow_status,
            flow_runner::flow_stop,
            flow_runner::flow_list,
            prompt_vault::pv_list,
            prompt_vault::pv_add,
            prompt_vault::pv_update,
            prompt_vault::pv_remove,
            prompt_vault::pv_record_outcome,
            prompt_vault::pv_search,
            native_ops::native_op_try,
            native_ops::native_op_matches,
            native_ops::native_op_abort,
            native_ops::native_op_abort_all,
            desktop_ops::desktop_open_app,
            desktop_ops::desktop_open_url,
            desktop_ops::live_open_workspace,
            desktop_ops::desktop_screen_locked,
            desktop_ops::desktop_web_search,
            web_search::web_search_answer,
            desktop_ops::desktop_focus_window,
            desktop_ops::desktop_list_windows,
            desktop_ops::desktop_click,
            desktop_ops::desktop_window_control,
            openai_realtime::mint_realtime_session,
            openai_realtime::realtime_ready,
            openai_realtime::record_realtime_usage,
            openai_realtime::authorize_realtime_response,
            openai_realtime::mark_realtime_usage_uncertain,
            openai_realtime::close_realtime_accounting_session,
            hybrid_ops::hybrid_type,
            hybrid_ops::hybrid_press,
            hybrid_ops::hybrid_scroll,
            qa_eyes::qa_capture_window,
            qa_eyes::qa_inspect,
            run_ledger::ledger_log_run,
            run_notes::write_run_note,
            skill_store::skill_save,
            skill_store::skill_list,
            agent_chat::agent_chat_append,
            agent_chat::agent_chat_read,
            session_deliver::session_deliver,
            elevenlabs_usage::elevenlabs_usage,
            restore::restore_live_state,
            restore::refresh_live_state,
            hermes_bridge::hermes_health,
            usage::usage_snapshot,
            usage::usage_summary,
            usage::plan_names,
            memory_graph::refresh_memory_graph,
            memory_graph::read_memory_graph,
            memory_graph::open_memory_file,
            memory_graph::memory_recall,
            workspace::workspace_prepare,
            workspace::workspace_write_file,
            workspace::workspace_manifest,
            memory_todo::memory_todo_open_now,
            research_watch::research_scan,
            research_watch::take_research_pending,
            research_watch::write_research_pending,
            research_watch::write_research_note,
            quartz_health,
            quartz_status,
            state_mirror::state_set,
            state_mirror::state_all,
            board_meeting::board_meeting_gather,
            board_meeting::board_meeting_write,
            board_meeting::board_meeting_exists_today,
            board_meeting_notify,
            org_scan::org_scan
        ])
        // Closing the window HIDES it to the tray instead of quitting, so the
        // background process (and the global hotkey) stays alive. Real quit is
        // via the tray's "Quit Praxis" item.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            // One read-only voice surface over other apps, created on the first live
            // voice broadcast (see voice_pill::install for why not here at startup).
            voice_pill::install(app.handle());
            openai_billing::install(app.handle());

            // Is the FREE brain rail still alive? Two NIM models have reached
            // end-of-life under us and taken every breaker-cut reroute down with them,
            // the second unnoticed for three weeks. One cheap GET at boot, logged either
            // way; it disables nothing and never blocks startup.
            hermes_bridge::spawn_nvidia_rail_health_check();

            // When launched at login (--hidden), stay in the tray instead of popping open.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Launched via the standalone Flight Deck shortcut (`--flight-deck`):
            // keep the brain hidden and open just the Flight Deck window.
            if std::env::args().any(|a| a == "--flight-deck") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                open_flight_deck(app.handle());
            }

            // System tray - keeps the process resident when the window is closed.
            let show_i = MenuItem::with_id(app, "show", "Show Praxis", true, None::<&str>)?;
            let command_i =
                MenuItem::with_id(app, "command", "Command Center", true, None::<&str>)?;
            let galaxy_i = MenuItem::with_id(app, "galaxy", "Memory Galaxy", true, None::<&str>)?;
            let deck_i = MenuItem::with_id(app, "flightdeck", "Flight Deck", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Praxis", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &command_i, &galaxy_i, &deck_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Praxis — press Ctrl+Shift+Space")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "command" => open_command_center(app),
                    "galaxy" => open_knowledge(app),
                    "flightdeck" => open_flight_deck(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global hotkey: Ctrl+Shift+Space, system-wide (toggles summon ⇄ dismiss).
            // Register now; if it fails (a boot-time race with another app, or the
            // shortcut subsystem not ready yet on a cold start) keep retrying in the
            // background for a minute so login SELF-HEALS instead of leaving a dead key.
            // Every step is written to praxis-boot.log so a post-reboot failure is
            // diagnosable after the fact (this is the bug the owner kept hitting).
            boot_log(&format!(
                "setup reached (args: {:?})",
                std::env::args().collect::<Vec<_>>()
            ));
            // Watchdog only on VISIBLE launches. An autostart (--hidden) window can
            // legitimately mount late or not at all (R3F measures 0x0 while hidden;
            // show_main() self-heals that on first summon) - restarting a healthy
            // hidden instance would fight the tray workflow.
            if !std::env::args().any(|a| a == "--hidden") {
                spawn_boot_watchdog(app.handle().clone());
            }
            // Lifetime watchdog runs on EVERY launch (hidden included): a wedged
            // renderer should self-heal whether or not the owner summoned the window yet.
            spawn_renderer_watchdog(app.handle().clone());
            // Read the memory notes now, off the UI thread, so Atlas's first question
            // and a build's first plan are answered from memory, not from a cold disk.
            memory_graph::warm_recall_cache();
            if register_hotkey(app.handle()) {
                boot_log("hotkey registered on first attempt");
            } else {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    for i in 1..=20 {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        if register_hotkey(&h) {
                            boot_log(&format!("hotkey registered on retry #{i}"));
                            return;
                        }
                    }
                    boot_log("hotkey STILL unregistered after 60s of retries");
                });
            }

            // Global Ctrl+T - hands-free voice toggle (start/stop listening from any app).
            // This is the owner's #1 interaction with Praxis, so it gets the same
            // retry-until-registered treatment as the summon hotkey.
            if register_voice_hotkey(app.handle()) {
                boot_log("voice hotkey (Ctrl+T) registered");
            } else {
                boot_log("voice hotkey (Ctrl+T) conflict — retrying in background");
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    for i in 1..=20 {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        if register_voice_hotkey(&h) {
                            boot_log(&format!("voice hotkey (Ctrl+T) registered on retry #{i}"));
                            return;
                        }
                    }
                    boot_log("voice hotkey (Ctrl+T) STILL unregistered after 60s of retries");
                });
            }

            // ── Real-event bus (Phase 2b): push-based brain signal from live sessions ──
            // Two background threads tail real Claude transcripts and diff the running
            // set, emitting praxis://transcript-event + praxis://session-state. The
            // frontend (useRealEvents) maps them to the SAME PraxisEvent shapes the mock
            // timeline uses, so the brain reflects real work without polling lag. The
            // shared flag is flipped false on RunEvent::Exit (see run-loop below).
            let bridge_alive = Arc::new(AtomicBool::new(true));
            app.manage(BridgeShutdown(bridge_alive.clone()));
            // Seed the deck's ACTIVE WINDOW from the vault before any snapshot is
            // built, so the first paint already honours the owner's saved setting
            // instead of flashing the 24h default and then correcting itself.
            // A realtime accounting marker left by a crashed/killed process latches
            // realtime OFF forever ("unreconciled usage"), silently demoting Atlas to
            // the local voice stack. A marker seen at STARTUP is orphaned by
            // definition - reconcile it so a crash cannot cost the owner the feature.
            // Same class of bug as the accounting marker: a single failed usage
            // write latched persistence "degraded" permanently, which disables
            // Realtime forever. Re-validate the ledger and clear a stale flag.
            if usage::reconcile_usage_health() {
                boot_log("usage: cleared stale degraded flag after re-validating the ledger");
            }
            if let Some(id) = openai_realtime::reconcile_orphaned_accounting_marker() {
                boot_log(&format!("realtime: reconciled orphaned accounting marker {id}"));
            }
            flightdeck::load_active_window(&app.handle().clone());
            transcript_tailer::spawn(app.handle().clone(), bridge_alive.clone());
            session_poller::spawn(app.handle().clone(), bridge_alive.clone());
            hermes_bridge::spawn_observer(app.handle().clone(), bridge_alive.clone());

            // Sage's research-watch loop: RSS-check Example Creator (+ future sources) every 6h,
            // fetch new-video transcripts, and signal the frontend to run idea-extraction.
            // Same shutdown flag as the bus above - no separate lifecycle to manage.
            research_watch::spawn(app.handle().clone(), bridge_alive.clone());
            org_scan::spawn(app.handle().clone(), bridge_alive.clone());
            board_meeting::spawn(app.handle().clone(), bridge_alive.clone());

            // Native orchestration engine: seed the shipped flow definitions
            // (delegate / overnight) into %LOCALAPPDATA%\Praxis\flows\definitions\
            // if absent, then re-drive any flow that was mid-run when the app last
            // exited (crash/reboot). Reads its own crash-safe state from
            // %LOCALAPPDATA%\Praxis\flows\*.json; honors the trust + HALT gates
            // (defers if they're not clear) before re-spawning any lane.
            flow_runner::seed_definitions();
            flow_runner::resume_running(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Praxis")
        .run(|app_handle, event| {
            // On real quit (tray → Quit Praxis), tell the real-event-bus threads to
            // stop so they don't keep doing FS work while the app tears down.
            if let tauri::RunEvent::Exit = event {
                if let Some(b) = app_handle.try_state::<BridgeShutdown>() {
                    b.0.store(false, Ordering::Relaxed);
                }
                quartz_sidecar::stop(); // tree-kill the Quartz node process so it doesn't orphan
                hermes_bridge::stop(); // tree-kill the Hermes dashboard process so it doesn't orphan
                flow_runner::stop_all(); // signal every live flow to cancel + tear down its lane processes
            }
        });
}

#[cfg(test)]
mod priority_tests {
    use super::*;

    #[test]
    fn only_the_starved_launcher_classes_are_raised() {
        assert_eq!(raised_priority_class(BELOW_NORMAL_PRIORITY_CLASS), Some(NORMAL_PRIORITY_CLASS));
        assert_eq!(raised_priority_class(IDLE_PRIORITY_CLASS), Some(NORMAL_PRIORITY_CLASS));
        assert_eq!(raised_priority_class(NORMAL_PRIORITY_CLASS), None);
        // ABOVE_NORMAL and HIGH were chosen on purpose; never lowered.
        assert_eq!(raised_priority_class(0x0000_8000), None);
        assert_eq!(raised_priority_class(0x0000_0080), None);
        // GetPriorityClass failure returns 0.
        assert_eq!(raised_priority_class(0), None);
    }
}
