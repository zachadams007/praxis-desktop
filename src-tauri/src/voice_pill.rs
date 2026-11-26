//! Read-only desktop voice indicator. All window work runs off the UI thread.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use tauri::Manager;

#[cfg(windows)]
use crate::native_ops::win::{self, Rect};

#[cfg(not(windows))]
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

const VOICE_STATE_EVENT: &str = "praxis://voice-popup-state";
const PILL_LABEL: &str = "voicepill";

// ─────────────────────────────────────────────────────────────────────────────
// THE PILL WINDOW NEVER EXISTED.
//
// Measured on the installed app (2026-09-15), twice: Tauri listed the "voicepill"
// label, but no native window existed, its page never loaded, and every call on it
// answered "failed to receive message from webview" - with nothing logged.
//
// Cause: every other Praxis window is built with `additional_browser_args(
// WEBVIEW2_ARGS)`; this one was not. All WebView2 instances sharing a user-data
// folder must use IDENTICAL environment options, so the mismatched webview failed to
// create inside the event loop, after build() had already returned Ok.
//
// Rust also creates the window lazily, on the first LIVE voice broadcast (the runtime
// path the Flight Deck and Command Center use), and turns click-through on only after
// its page has loaded. From then on the page drives show/hide/track as before.
// ─────────────────────────────────────────────────────────────────────────────
pub fn install(app: &tauri::AppHandle) {
    use tauri::Listener;
    let handle = app.clone();
    app.listen_any(VOICE_STATE_EVENT, move |event| {
        if !broadcast_is_active(event.payload()) {
            return;
        }
        let app = handle.clone();
        // Never build a window on the event-dispatch path.
        std::thread::spawn(move || ensure_window(&app));
    });
}

/// Only a live session should create the surface; malformed payloads never do.
fn broadcast_is_active(payload: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("active").and_then(|a| a.as_bool()))
        .unwrap_or(false)
}

fn ensure_window(app: &tauri::AppHandle) {
    static CREATING: AtomicBool = AtomicBool::new(false);
    if app.get_webview_window(PILL_LABEL).is_some() || CREATING.swap(true, Ordering::AcqRel) {
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        PILL_LABEL,
        tauri::WebviewUrl::App("voicepill.html".into()),
    )
    .title("Atlas voice state")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .focusable(false)
    .shadow(false)
    .visible(false)
    .inner_size(340.0, 72.0)
    // MUST match every other window's WebView2 environment options (see above).
    .additional_browser_args(crate::WEBVIEW2_ARGS)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            // Click-through only once the webview is fully attached.
            let _ = window.set_ignore_cursor_events(true);
        }
    })
    .build();
    if let Err(error) = built {
        crate::boot_log(&format!("voicepill: could not create the window: {error}"));
    }
    CREATING.store(false, Ordering::Release);
}

/// All arguments are physical pixels, including the already DPI-scaled margin.
pub fn pill_position(work: Rect, pill_w: i32, pill_h: i32, margin: i32) -> (i32, i32) {
    (work.right - pill_w - margin, work.bottom - pill_h - margin)
}

/// Serialized by TrackerState. Join before restarting: a rapid off/on must never
/// revive an old sleeper alongside a new thread or let it show after hide.
#[derive(Default)]
struct TrackerGate {
    on: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl TrackerGate {
    fn start(
        &mut self,
        track: impl FnOnce(Arc<AtomicBool>) + Send + 'static,
    ) -> std::io::Result<bool> {
        if self.on.load(Ordering::Acquire)
            && self
                .worker
                .as_ref()
                .is_some_and(|worker| !worker.is_finished())
        {
            return Ok(false);
        }
        self.stop();
        self.on.store(true, Ordering::Release);
        let on = self.on.clone();
        match std::thread::Builder::new()
            .name("voice-pill".into())
            .spawn(move || track(on))
        {
            Ok(worker) => {
                self.worker = Some(worker);
                Ok(true)
            }
            Err(error) => {
                self.on.store(false, Ordering::Release);
                Err(error)
            }
        }
    }

    fn stop(&mut self) {
        self.on.store(false, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Default)]
pub struct TrackerState(Mutex<TrackerGate>);

/// Called only on the existing watchdog worker, never the UI thread. Reload the
/// same webview after suspending it so a crashed renderer cannot leave stale state.
pub fn suspend_for_reload(app: &tauri::AppHandle) {
    if let Ok(mut gate) = app.state::<TrackerState>().0.lock() {
        gate.stop();
    }
    if let Some(pill) = app.get_webview_window("voicepill") {
        let _ = pill.hide();
    }
}

/// Notices can wrap beyond the initial 72 logical pixels. The tracker observes
/// the resulting physical size and anchors the expanded surface on its next tick.
#[tauri::command]
pub async fn voice_pill_resize(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() || !(72.0..=1024.0).contains(&height) {
        return Err("invalid voice pill height".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.get_webview_window("voicepill")
            .ok_or("voicepill window missing")?
            .set_size(tauri::LogicalSize::new(340.0, height))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_pill_track(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TrackerState>();
        let mut gate = state.0.lock().map_err(|e| e.to_string())?;
        let pill = app
            .get_webview_window("voicepill")
            .ok_or("voicepill window missing")?;
        if on {
            // Also protects against a cached active state arriving during startup.
            pill.set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            pill.set_focusable(false).map_err(|e| e.to_string())?;
            gate.start(move |on| track(pill, on))
                .map_err(|e| e.to_string())?;
        } else {
            gate.stop();
            pill.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn track(pill: tauri::WebviewWindow, on: Arc<AtomicBool>) {
    use tauri::PhysicalPosition;
    // ─────────────────────────────────────────────────────────────────────────
    // A STEADY TICK TOUCHES THE UI THREAD ZERO TIMES.
    //
    // Every Tauri window getter (hwnd, outer_size, is_visible, available_monitors)
    // blocks its caller until the UI thread's event loop answers. This loop used to
    // make five of those calls every 350 ms for as long as a voice session ran - about
    // fourteen synchronous UI-thread round trips a second. On 2026-09-15 the installed
    // app sat at `Responding=False` with its UI thread starved (see
    // `ensure_normal_priority` in lib.rs), and a queue like this one only deepens that.
    //
    // The handle is fetched once; each tick then reads the foreground monitor, its
    // DPI, and the pill's own rect and visibility straight from Win32. Tauri setters
    // run only when the placement actually changes.
    // ─────────────────────────────────────────────────────────────────────────
    let mut own: Option<isize> = None;
    let mut previous = None;
    while on.load(Ordering::Acquire) {
        let update = || -> Result<(), Box<dyn std::error::Error>> {
            let hwnd = match own {
                Some(hwnd) => hwnd,
                None => {
                    let hwnd = pill.hwnd()?.0 as isize;
                    own = Some(hwnd);
                    hwnd
                }
            };
            let Some((monitor, _bounds, work)) = win::foreground_work_area(hwnd) else {
                return Ok(());
            };
            let scale = win::monitor_scale(monitor).ok_or("foreground monitor scale unavailable")?;
            let rect = win::window_rect(hwnd).ok_or("voice pill rect unavailable")?;
            let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
            let target = (monitor, work, width, height, scale);
            if previous != Some(target) || !win::window_visible(hwnd) {
                let (x, y) = pill_position(work, width, height, (20.0 * scale).round() as i32);
                pill.set_position(PhysicalPosition::new(x, y))?;
                pill.set_always_on_top(true)?;
                // Show only after placement, and never after cancellation.
                if on.load(Ordering::Acquire) {
                    pill.show()?;
                }
                previous = Some(target);
            }
            Ok(())
        };
        let mut update = update;
        if let Err(error) = update() {
            // Retry next tick (monitor unplug/DPI transition/window not ready).
            crate::elog!("voice pill placement: {error}");
        }
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
}

#[cfg(not(windows))]
fn track(pill: tauri::WebviewWindow, on: Arc<AtomicBool>) {
    let _ = pill.show();
    while on.load(Ordering::Acquire) {
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PRIMARY: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };
    #[test]
    fn only_a_live_broadcast_creates_the_pill() {
        assert!(broadcast_is_active(r#"{"active":true,"state":"listening"}"#));
        assert!(!broadcast_is_active(r#"{"active":false}"#));
        assert!(!broadcast_is_active(r#"{"state":"listening"}"#));
        assert!(!broadcast_is_active("not json"));
    }

    #[test]
    fn primary_bottom_right() {
        assert_eq!(pill_position(PRIMARY, 340, 72, 20), (1560, 988));
    }
    #[test]
    fn negative_x_monitor() {
        assert_eq!(
            pill_position(
                Rect {
                    left: -1920,
                    right: 0,
                    ..PRIMARY
                },
                340,
                72,
                20
            ),
            (-360, 988)
        );
    }
    #[test]
    fn taskbar_reduces_work_area() {
        assert_eq!(
            pill_position(
                Rect {
                    bottom: 1040,
                    ..PRIMARY
                },
                340,
                72,
                20
            ),
            (1560, 948)
        );
    }
    #[test]
    fn scaled_margin_is_applied_on_both_axes() {
        assert_eq!(pill_position(PRIMARY, 510, 108, 30), (1380, 942));
        assert_eq!(pill_position(PRIMARY, 510, 108, 0), (1410, 972));
    }
    #[test]
    fn tracker_start_is_idempotent_and_stop_allows_restart() {
        use std::sync::atomic::AtomicUsize;
        let starts = Arc::new(AtomicUsize::new(0));
        let mut gate = TrackerGate::default();
        for expected in [true, false, false] {
            let starts = starts.clone();
            assert_eq!(
                gate.start(move |on| {
                    starts.fetch_add(1, Ordering::SeqCst);
                    while on.load(Ordering::Acquire) {
                        std::thread::yield_now();
                    }
                })
                .unwrap(),
                expected
            );
        }
        gate.stop();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(!gate.on.load(Ordering::Acquire));
        let restarted = starts.clone();
        assert!(gate
            .start(move |_| {
                restarted.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap());
        gate.stop();
        gate.stop();
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }
}
