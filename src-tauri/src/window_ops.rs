//!   1. explicit `screen` hint - "primary", "largest", "next", "left", "right",
//!      "index:<n>", or a numeric monitor index
//!   2. the invoking window's current monitor (`invoker` label from the frontend)
//!   3. the focused Praxis window's monitor
//!   4. the main brain window's monitor
//!   5. the largest display (last resort - the old default)
//! The chosen monitor AND the reason are narrated to praxis-boot.log ("TILE:").
//!
//! Quadrant rects are computed from the target monitor's `work_area()` (excludes
//! the taskbar, matching `move_window_to_target_monitor`'s existing convention in
//! lib.rs) using PHYSICAL pixels throughout - Tauri's `set_position`/`set_size`
//! both expect physical pixels, and `work_area()` already reports physical
//! pixels, so no manual scale-factor math is needed for the rect split itself.
//!
//! Quad-tiling is also the "open everything" gesture: any of the four windows
//! that isn't open yet gets created (or un-hidden) FIRST, via the exact same
//! create-or-show helpers every other entry point uses (`show_main`,
//! `open_command_center`, `open_knowledge`, `open_flight_deck` in `lib.rs`), and
//! only then do we tile all four into quadrants. A window is only left out of
//! the final tile if it still fails to come up after a short wait (e.g. a
//! genuine build error) - that's logged, never a panic.

use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

/// Run `f` ON THE MAIN THREAD and wait for its result. Window operations issued
/// from an async command's worker thread are NOT all reliable on Windows -
/// live-proven 2026-07-10: `set_size`/`set_position` proxied fine, but
/// `unminimize()` on a minimized window silently no-op'd from the worker thread
/// while the identical call from a main-thread command worked. So the async
/// commands below do their sleeping/polling off-loop (that part MUST stay off the
/// main thread - the poll would starve the very event loop window creation needs)
/// and hop onto the loop for every actual window mutation/getter.
fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_secs(6)).ok()
}

/// The four Praxis window labels, in the fixed order used everywhere else in the
/// app (see `cycle_windows` / `ORDER` in lib.rs) - top-left, top-right,
/// bottom-left, bottom-right.
const QUADRANT_ORDER: [&str; 4] = ["main", "command", "knowledge", "flightdeck"];

/// One window's geometry, captured just before tiling so "exit formation" can put
/// it back exactly where it was. `visible: false` = the window existed but was
/// hidden/minimized pre-tile - its stash rect (Windows parks minimized windows at
/// ~(-21333,-21333) 158x26) is GARBAGE and must never be "restored"; exit hides
/// the window again instead.
#[derive(Clone)]
struct WinGeom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
    visible: bool,
}

/// The layout snapshot taken at the top of `tile_quadrants`. `Mutex::new` is const,
/// so this needs no `lazy_static`/`once_cell`. `None` = nothing tiled yet → exit is
/// a friendly no-op. Cleared (`take()`) on restore so a second "exit formation" is
/// an honest "nothing to restore" rather than re-applying a stale layout.
static PRE_TILE: Mutex<Option<Vec<(String, WinGeom)>>> = Mutex::new(None);

/// Live quad-formation state - `Some((work_w, work_h))` = the PHYSICAL work-area
/// size of the tiled monitor while the formation is active, `None` otherwise.
/// This is the one truth FitScaler's maximized-look scaling hangs off: windows
/// PULL it on load (`formation_state`) so a reload mid-formation re-enters scaled
/// mode, and tile/exit PUSH transitions over `praxis://formation`. Cleared on
/// `restore_formation` so exiting always un-scales every window.
static FORMATION: Mutex<Option<(u32, u32)>> = Mutex::new(None);

/// Payload for `praxis://formation` + the `formation_state` pull. `base_w/base_h`
/// are the target monitor's FULL work-area size in LOGICAL pixels for the
/// receiving window's scale factor - i.e. exactly the viewport a maximized window
/// on that monitor would lay out at. FitScaler renders the app root at this size
/// and scales it down uniformly (~0.5: the quarter is half the work area per
/// axis), yielding a pixel-faithful miniature of the maximized layout. DPI-aware
/// per window: monitors can have different scale factors, so the logical base is
/// computed from the physical work area / THAT window's `scale_factor()`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormationPayload {
    pub active: bool,
    pub base_w: f64,
    pub base_h: f64,
}

fn payload_for(window: &tauri::WebviewWindow, work: Option<(u32, u32)>) -> FormationPayload {
    match work {
        Some((pw, ph)) => {
            let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
            FormationPayload {
                active: true,
                base_w: pw as f64 / scale,
                base_h: ph as f64 / scale,
            }
        }
        None => FormationPayload {
            active: false,
            base_w: 0.0,
            base_h: 0.0,
        },
    }
}

/// Emit `praxis://formation` to each window in `labels`. `active: true` sends the
/// per-window logical base (see `FormationPayload`); `active: false` tells the
/// window to drop back to native rendering. Hops to the main thread - the
/// `scale_factor()` getter is a window op (see `on_main`).
fn emit_formation(app: &tauri::AppHandle, labels: Vec<String>, active: bool) {
    let work = if active {
        FORMATION.lock().ok().and_then(|g| *g)
    } else {
        None
    };
    let handle = app.clone();
    let _ = on_main(app, move || {
        for label in labels {
            let Some(w) = handle.get_webview_window(&label) else {
                continue;
            };
            let payload = payload_for(&w, work);
            let _ = handle.emit_to(label.as_str(), "praxis://formation", payload);
        }
    });
}

/// Frontend PULL for the formation state - FitScaler invokes this on mount, so a
/// window that reloads (or was still booting) while the formation is live re-enters
/// maximized-look scaling. A pull is deliberately used instead of a Rust-side
/// re-emit on page load: an event emitted at page-load time races React mounting
/// the listener and can be lost, while the static `FORMATION` answered here is
/// race-free. Sync command = runs on the main thread, so the `scale_factor()`
/// getter is reliable (see `on_main`) and there's no polling to starve the loop.
#[tauri::command]
pub fn formation_state(window: tauri::WebviewWindow) -> FormationPayload {
    payload_for(&window, FORMATION.lock().ok().and_then(|g| *g))
}

/// Capture the CURRENT geometry of every open Praxis window before we tile, so the
/// pre-formation layout is recoverable. Called at the very start of tiling, before
/// any window is moved. Windows that don't exist yet simply aren't in the snapshot;
/// windows that exist but are hidden/minimized are recorded `visible: false` so exit
/// tucks them away again instead of "restoring" their minimized stash rect.
fn snapshot_layout(app: &tauri::AppHandle) {
    let handle = app.clone();
    let snap = on_main(app, move || {
        let mut snap: Vec<(String, WinGeom)> = Vec::new();
        for label in QUADRANT_ORDER {
            if let Some(w) = handle.get_webview_window(label) {
                // INNER size, OUTER position - the exact pair set_size/set_position
                // take, so restore round-trips byte-exact (snapshotting outer_size
                // grew every restored window by its decorations: +22x56 live).
                if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
                    let visible =
                        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
                    snap.push((
                        label.to_string(),
                        WinGeom {
                            x: pos.x,
                            y: pos.y,
                            w: size.width,
                            h: size.height,
                            maximized: w.is_maximized().unwrap_or(false),
                            visible,
                        },
                    ));
                }
            }
        }
        snap
    })
    .unwrap_or_default();
    crate::boot_log(&format!(
        "TILE: snapshot {}",
        snap.iter()
            .map(|(l, g)| format!(
                "{l}@{},{} {}x{} vis={} max={}",
                g.x, g.y, g.w, g.h, g.visible, g.maximized
            ))
            .collect::<Vec<_>>()
            .join(" · ")
    ));
    if let Ok(mut g) = PRE_TILE.lock() {
        *g = Some(snap);
    }
}

/// Exit quad-tile formation: restore every window to the geometry captured before
/// the last `tile_quadrants`, and HIDE any window the formation itself opened (it
/// wasn't on screen before, so a true reverse takes it back off screen). Errors
/// (honestly) when there's no saved layout so the voice/launcher path can say
/// "nothing was tiled yet" instead of silently no-op'ing.
#[tauri::command]
pub async fn restore_formation(app: tauri::AppHandle) -> Result<String, String> {
    let snap = {
        let mut g = PRE_TILE.lock().map_err(|e| e.to_string())?;
        g.take()
    };
    // Formation is over the moment exit is asked for - clear the scaling state and
    // tell every window to drop back to native rendering BEFORE geometry restore,
    // so content un-miniaturizes first and no window can stay stuck scaled even if
    // a later restore hop fails. Runs on the no-snapshot path too (belt-and-braces:
    // scaling must never outlive the formation).
    if let Ok(mut g) = FORMATION.lock() {
        *g = None;
    }
    emit_formation(
        &app,
        QUADRANT_ORDER.iter().map(|s| s.to_string()).collect(),
        false,
    );

    let Some(snap) = snap else {
        return Err("Nothing to restore — the windows aren't in a tiled formation.".to_string());
    };

    let handle = app.clone();
    let (restored, rehidden, notes) = on_main(&app, move || {
        let mut restored = 0usize;
        let mut rehidden = 0usize;
        let mut notes: Vec<String> = Vec::new();
        for label in QUADRANT_ORDER {
            let Some(w) = handle.get_webview_window(label) else {
                continue;
            };
            match snap.iter().find(|(l, _)| l == label) {
                // Open AND on-screen pre-tile → put it back exactly where it was.
                Some((_, geom)) if geom.visible => {
                    // Unmaximize/unminimize first - Windows makes set_position/set_size
                    // a no-op on a maximized window and lies about a minimized one.
                    let _ = w.unmaximize();
                    let _ = w.unminimize();
                    let _ = w.set_size(PhysicalSize::new(geom.w, geom.h));
                    let _ = w.set_position(PhysicalPosition::new(geom.x, geom.y));
                    if geom.maximized {
                        let _ = w.maximize();
                    }
                    let _ = w.show();
                    notes.push(format!("{label}->{},{}", geom.x, geom.y));
                    restored += 1;
                }
                // Existed but hidden/minimized pre-tile, or created by the formation
                // itself ⇒ reverse = tuck it away again (hide, never destroy - these
                // are resident singletons). Its pre-tile stash rect is garbage; never
                // "restore" a window to (-21333,-21333).
                _ => {
                    let _ = w.hide();
                    notes.push(format!("{label}->hidden"));
                    rehidden += 1;
                }
            }
        }
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.set_focus();
        }
        (restored, rehidden, notes)
    })
    .ok_or("main-thread hop failed")?;

    crate::boot_log(&format!("TILE: exit — {}", notes.join(" · ")));

    Ok(if rehidden > 0 {
        format!("Exited formation — restored {restored} window(s), tucked away {rehidden} the formation had opened.")
    } else {
        format!("Exited formation — restored {restored} window(s) to the layout before tiling.")
    })
}

/// Any open Praxis window - monitor enumeration needs a window handle to hang off.
fn any_open_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    QUADRANT_ORDER
        .iter()
        .find_map(|label| app.get_webview_window(label))
}

fn largest_monitor(w: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    w.available_monitors()
        .ok()?
        .into_iter()
        .max_by_key(|monitor| {
            let size = monitor.size();
            (size.width as u64) * (size.height as u64)
        })
}

fn same_monitor(a: &tauri::Monitor, b: &tauri::Monitor) -> bool {
    let ap = a.position();
    let bp = b.position();
    let asz = a.size();
    let bsz = b.size();
    ap.x == bp.x
        && ap.y == bp.y
        && asz.width == bsz.width
        && asz.height == bsz.height
        && a.name() == b.name()
}

fn sorted_monitors(mut monitors: Vec<tauri::Monitor>) -> Vec<tauri::Monitor> {
    monitors.sort_by_key(|m| {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, s.width, s.height)
    });
    monitors
}

fn current_reference_monitor(
    app: &tauri::AppHandle,
    invoker: Option<&str>,
) -> Option<tauri::Monitor> {
    if let Some(label) = invoker {
        if let Some(w) = app.get_webview_window(label) {
            if let Ok(Some(m)) = w.current_monitor() {
                return Some(m);
            }
        }
    }
    for label in QUADRANT_ORDER {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_focused().unwrap_or(false) {
                if let Ok(Some(m)) = w.current_monitor() {
                    return Some(m);
                }
            }
        }
    }
    app.get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
}

fn monitor_index(monitors: &[tauri::Monitor], current: &tauri::Monitor) -> Option<usize> {
    monitors.iter().position(|m| same_monitor(m, current))
}

fn monitor_by_one_based_index(monitors: &[tauri::Monitor], n: usize) -> Option<tauri::Monitor> {
    if n == 0 {
        monitors.first().cloned()
    } else {
        monitors.get(n.saturating_sub(1)).cloned()
    }
}

fn next_monitor(
    monitors: &[tauri::Monitor],
    current: Option<&tauri::Monitor>,
) -> Option<tauri::Monitor> {
    if monitors.is_empty() {
        return None;
    }
    if monitors.len() == 1 {
        return monitors.first().cloned();
    }
    let idx = current
        .and_then(|m| monitor_index(monitors, m))
        .unwrap_or(0);
    monitors.get((idx + 1) % monitors.len()).cloned()
}

fn side_monitor(
    monitors: &[tauri::Monitor],
    current: Option<&tauri::Monitor>,
    dir: i32,
) -> Option<tauri::Monitor> {
    if monitors.is_empty() {
        return None;
    }
    let Some(current) = current else {
        return if dir < 0 {
            monitors.first().cloned()
        } else {
            monitors.last().cloned()
        };
    };
    let Some(idx) = monitor_index(monitors, current) else {
        return if dir < 0 {
            monitors.first().cloned()
        } else {
            monitors.last().cloned()
        };
    };
    if dir < 0 {
        idx.checked_sub(1).and_then(|i| monitors.get(i)).cloned()
    } else {
        monitors.get(idx + 1).cloned()
    }
}

/// Find the monitor to tile onto. Resolution order (see module docs): explicit
/// `screen` hint → `invoker` window's monitor → focused Praxis window → main's
/// monitor → largest display. Returns the monitor AND a human-readable reason so
/// `tile_quadrants` can narrate WHY that screen was chosen to praxis-boot.log -
/// "it tiled the wrong screen" must be diagnosable, not a mystery.
fn pick_target_monitor(
    app: &tauri::AppHandle,
    invoker: Option<&str>,
    screen: Option<&str>,
) -> Result<(tauri::Monitor, String), String> {
    // (1) Explicit screen hint - primary/largest/next/left/right/index.
    //     An unrecognized/out-of-range hint logs and falls through rather than
    //     erroring: a garbled voice hint should still tile SOMEWHERE sensible.
    if let Some(hint) = screen {
        let hint = hint.trim().to_ascii_lowercase();
        if let Some(w) = any_open_window(app) {
            let monitors = w
                .available_monitors()
                .map(sorted_monitors)
                .unwrap_or_default();
            let current = current_reference_monitor(app, invoker);
            if hint == "primary" {
                if let Ok(Some(m)) = w.primary_monitor() {
                    return Ok((m, "screen hint 'primary'".to_string()));
                }
            } else if hint == "largest" {
                if let Some(m) = largest_monitor(&w) {
                    return Ok((m, "screen hint 'largest'".to_string()));
                }
            } else if matches!(hint.as_str(), "next" | "other" | "different") {
                if let Some(m) = next_monitor(&monitors, current.as_ref()) {
                    return Ok((m, format!("screen hint '{hint}'")));
                }
            } else if hint == "left" {
                if let Some(m) = side_monitor(&monitors, current.as_ref(), -1) {
                    return Ok((m, "screen hint 'left'".to_string()));
                }
            } else if hint == "right" {
                if let Some(m) = side_monitor(&monitors, current.as_ref(), 1) {
                    return Ok((m, "screen hint 'right'".to_string()));
                }
            } else if let Some(raw) = hint.strip_prefix("index:") {
                if let Ok(idx) = raw.parse::<usize>() {
                    let count = monitors.len();
                    if let Some(m) = monitor_by_one_based_index(&monitors, idx) {
                        return Ok((m, format!("screen hint monitor {idx}")));
                    }
                    crate::boot_log(&format!(
                        "TILE: screen hint monitor {idx} out of range ({count} monitor(s)) — falling through"
                    ));
                }
            } else if let Ok(idx) = hint.parse::<usize>() {
                let count = monitors.len();
                if let Some(m) = monitor_by_one_based_index(&monitors, idx) {
                    return Ok((m, format!("screen hint monitor {idx}")));
                }
                crate::boot_log(&format!(
                    "TILE: screen hint monitor {idx} out of range ({count} monitor(s)) — falling through"
                ));
            } else {
                crate::boot_log(&format!(
                    "TILE: unrecognized screen hint '{hint}' — falling through"
                ));
            }
        }
    }

    // (2) The invoking window's monitor - tile lands where the owner actually is
    //     (the window whose mic/launcher fired the command).
    if let Some(label) = invoker {
        if let Some(w) = app.get_webview_window(label) {
            if let Ok(Some(m)) = w.current_monitor() {
                return Ok((m, format!("invoker window '{label}'")));
            }
        }
    }

    // (3) The focused Praxis window's monitor.
    for label in QUADRANT_ORDER {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_focused().unwrap_or(false) {
                if let Ok(Some(m)) = w.current_monitor() {
                    return Ok((m, format!("focused window '{label}'")));
                }
            }
        }
    }

    // (4) The main brain window's monitor - it's the one Tauri keeps genuinely
    //     alive, so it's almost always open.
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.current_monitor() {
            return Ok((m, "main window's monitor".to_string()));
        }
    }

    // (5) Last resort: the largest display (the old default), then primary/first.
    if let Some(w) = any_open_window(app) {
        if let Some(m) = largest_monitor(&w) {
            return Ok((m, "largest display (fallback)".to_string()));
        }
        if let Ok(Some(m)) = w.primary_monitor() {
            return Ok((m, "primary display (fallback)".to_string()));
        }
        if let Ok(monitors) = w.available_monitors() {
            if let Some(m) = monitors.into_iter().next() {
                return Ok((m, "first enumerated display (fallback)".to_string()));
            }
        }
    }
    Err("Could not find any open Praxis window to read a display from.".to_string())
}

fn is_close_to_quadrant(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    target_x: i32,
    target_y: i32,
    target_w: u32,
    target_h: u32,
) -> bool {
    const TOLERANCE_PX: i32 = 8;

    let dw = size.width.abs_diff(target_w) as i32;
    let dh = size.height.abs_diff(target_h) as i32;

    (position.x - target_x).abs() <= TOLERANCE_PX
        && (position.y - target_y).abs() <= TOLERANCE_PX
        && dw <= TOLERANCE_PX
        && dh <= TOLERANCE_PX
}

/// Position + resize one window into the quadrant at `(qx, qy)` of a 2x2 grid
/// inside the work area (physical pixels). Every attempt runs the full wake+place
/// sequence ON THE MAIN THREAD (see `on_main`): unmaximize (Windows makes
/// `set_position` a no-op on a maximized window), unminimize + show (a window
/// summoned from hidden can materialize MINIMIZED at the (-21333,-21333) stash -
/// the 2026-07-10 "only the invoking window tiled" state), then size + position.
/// Logs the final outcome so a stubborn window is diagnosable from praxis-boot.log.
fn place_in_quadrant(
    app: &tauri::AppHandle,
    label: &str,
    work_x: i32,
    work_y: i32,
    work_w: u32,
    work_h: u32,
    qx: u32,
    qy: u32,
) -> bool {
    let quad_w = work_w / 2;
    let quad_h = work_h / 2;
    let x = work_x + (qx * quad_w) as i32;
    let y = work_y + (qy * quad_h) as i32;

    let mut placed = false;
    let mut last = String::new();
    // `set_size` takes the INNER (client) size but the quadrant budget is the
    // OUTER rect - asking for quad_w×quad_h yields outer quad+decorations (live:
    // 1302x856 for a 1280x800 ask → 22x56 of borders+titlebar → overlapping
    // tiles + a verifier that "fails" every attempt). Measure the decoration
    // delta from the first attempt's outer−inner readback and re-ask minus it.
    let (mut deco_w, mut deco_h) = (0u32, 0u32);
    for attempt in 0..5 {
        let ask_w = quad_w.saturating_sub(deco_w);
        let ask_h = quad_h.saturating_sub(deco_h);
        let handle = app.clone();
        let lbl = label.to_string();
        let state = on_main(app, move || {
            let Some(window) = handle.get_webview_window(&lbl) else {
                return None;
            };
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            }
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_size(PhysicalSize::new(ask_w, ask_h));
            let _ = window.set_position(PhysicalPosition::new(x, y));
            match (
                window.outer_position(),
                window.outer_size(),
                window.inner_size(),
            ) {
                (Ok(p), Ok(s), Ok(i)) => Some((p, s, i, window.is_minimized().unwrap_or(false))),
                _ => None,
            }
        })
        .flatten();

        if let Some((position, outer, inner, minimized)) = state {
            last = format!(
                "{},{} outer {}x{} inner {}x{} min={minimized}",
                position.x, position.y, outer.width, outer.height, inner.width, inner.height
            );
            deco_w = outer.width.saturating_sub(inner.width);
            deco_h = outer.height.saturating_sub(inner.height);
            if !minimized && is_close_to_quadrant(position, outer, x, y, quad_w, quad_h) {
                placed = true;
                break;
            }
        } else {
            last = "no-window/getter-failed".into();
        }

        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    crate::boot_log(&format!(
        "TILE: place '{label}' -> target {x},{y} {quad_w}x{quad_h} · {} · last seen {last}",
        if placed {
            "OK"
        } else {
            "FAILED after 5 attempts"
        }
    ));
    placed
}

/// Ensure all four Praxis windows exist and are visible, creating/showing
/// whichever ones aren't open yet, by calling the exact same create-or-show
/// helpers every other entry point in `lib.rs` uses (tray menu, hotkeys, in-app
/// launcher tiles). Those helpers spawn the actual `WebviewWindowBuilder::build()`
/// on a dedicated thread (building on the caller's/main thread would deadlock),
/// so a freshly-created window doesn't exist yet the instant this call returns -
/// we poll briefly for it to land before giving up on that one label.
fn ensure_all_windows_open(app: &tauri::AppHandle) {
    crate::show_main(app);
    crate::open_command_center(app);
    crate::open_knowledge(app);
    crate::open_flight_deck(app);

    // Give freshly-spawned window builders a chance to finish. Each already-open
    // window resolves instantly (the `get_webview_window` check below just
    // succeeds on the first poll), so this only adds latency for windows that
    // were genuinely being created for the first time.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let all_open = QUADRANT_ORDER
            .iter()
            .all(|label| app.get_webview_window(label).is_some());
        if all_open || std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Open (creating/showing any that aren't up yet) and then tile all four Praxis
/// windows into the four quarters of the monitor Praxis is currently showing on.
/// A window is only skipped from the final tile if it still isn't open after the
/// open-everything step above - e.g. a genuine window-build error - which is
/// reported back in the result string rather than causing a panic.
///
/// ⚠️ MUST be `async`. A sync command runs ON the main thread, and this function
/// sleep-polls while the `open_*` helpers build windows on their dedicated threads
/// - but `WebviewWindowBuilder::build()` completes only when the MAIN event loop
/// processes the create-webview message. Sync = the poll loop freezes the very
/// loop the builds are waiting on: the invoking window tiled, the other three
/// timed out and popped up untiled after the freeze (the owner's 2026-07-10 ten-second
/// catch). Async runs on the tokio worker pool, the main loop stays live, and the
/// in-body sleeps are harmless.
#[tauri::command]
pub async fn tile_quadrants(
    app: tauri::AppHandle,
    invoker: Option<String>,
    screen: Option<String>,
) -> Result<String, String> {
    // Capture where the windows are NOW (before anything moves) so "exit formation"
    // can put them back. Snapshot the already-open ones first, then open the rest.
    // EXCEPT when a formation is already live: re-tiling then must NOT overwrite the
    // snapshot with quarter rects, or "exit formation" would restore… the formation.
    let already_tiled = FORMATION.lock().ok().and_then(|g| *g).is_some();
    if already_tiled {
        crate::boot_log(
            "TILE: re-tile while formation active — keeping the original pre-tile snapshot",
        );
    } else {
        snapshot_layout(&app);
    }
    ensure_all_windows_open(&app);

    let (monitor, monitor_why) = pick_target_monitor(&app, invoker.as_deref(), screen.as_deref())?;
    let work = monitor.work_area();
    let work_x = work.position.x;
    let work_y = work.position.y;
    let work_w = work.size.width;
    let work_h = work.size.height;

    // (qx, qy) for each label, in QUADRANT_ORDER: main=TL, command=TR,
    // knowledge=BL, flightdeck=BR.
    const POSITIONS: [(u32, u32); 4] = [(0, 0), (1, 0), (0, 1), (1, 1)];

    crate::boot_log(&format!(
        "TILE: work area {work_x},{work_y} {work_w}x{work_h} · monitor '{}' via {monitor_why}",
        monitor.name().map(|n| n.as_str()).unwrap_or("?"),
    ));

    let mut tiled: Vec<&str> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();

    for (label, (qx, qy)) in QUADRANT_ORDER.iter().zip(POSITIONS.iter()) {
        if app.get_webview_window(label).is_some()
            && place_in_quadrant(&app, label, work_x, work_y, work_w, work_h, *qx, *qy)
        {
            tiled.push(label);
        } else {
            skipped.push(label);
        }
    }

    // Refocus main last so the brain window ends up foreground (matches every
    // other multi-window op in lib.rs, which leaves `main` as the "home" window).
    let handle = app.clone();
    let _ = on_main(&app, move || {
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.set_focus();
        }
    });

    if tiled.is_empty() {
        return Err(
            "Could not open any Praxis windows to tile (all four failed to launch).".to_string(),
        );
    }

    // Formation is live: record the tiled monitor's physical work-area size (the
    // maximized-look basis) and push `praxis://formation` to the windows that
    // actually landed in their quarters - a window that failed placement must NOT
    // render a miniature inside a non-quarter rect. Emitted AFTER placement so
    // each window's `scale_factor()` reflects the TARGET monitor (windows may
    // have hopped displays with different DPI).
    if let Ok(mut g) = FORMATION.lock() {
        *g = Some((work_w, work_h));
    }
    emit_formation(&app, tiled.iter().map(|s| s.to_string()).collect(), true);
    crate::boot_log(&format!(
        "TILE: formation active — base {work_w}x{work_h} physical → {}",
        tiled.join(", ")
    ));

    if skipped.is_empty() {
        Ok(format!(
            "Opened and tiled all {} windows into the four quadrants.",
            tiled.len()
        ))
    } else {
        Ok(format!(
            "Tiled {} window(s) ({}); {} failed to open in time ({}).",
            tiled.len(),
            tiled.join(", "),
            skipped.len(),
            skipped.join(", ")
        ))
    }
}
