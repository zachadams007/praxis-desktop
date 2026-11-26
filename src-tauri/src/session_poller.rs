// Session poller - the LIFECYCLE half of the Praxis real-event bus (Phase 2b).
//
// Where `transcript_tailer` streams what a session is *doing*, this thread tracks
// when sessions come and go. Every ~2s it re-reads the live running set (process
// verified alive) and diffs it against the previous poll, emitting a
// `praxis://session-state` for each running transition:
//
//   • started (running_before=false → running_after=true)  → agent flies in, lobe lights
//   • stopped (running_before=true  → running_after=false)  → agent docks (idle)
//
// On the FIRST poll `prev` is empty, so every already-running session emits a
// "started" event - the brain lights up for in-flight work the moment Praxis
// launches, not only when a session next produces a line.
//
// The frontend (`useRealEvents`) maps these to `agent:status` working/idle. We
// use `working_sessions()` - a live PROCESS is not a running prompt, and emitting
// merely-open sessions here put agents in orbit around nothing (owner request 2026-09-05).
// It builds on the lightweight `running_sessions()` (session store + pid
// liveness) rather than the full `build_snapshot()` - the latter shells out to
// `git worktree list` per repo, which is far too heavy to run on a 2s loop just to
// learn which sessions flipped state.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use crate::flightdeck;

const POLL_MS: u64 = 2000;

/// snake_case field names (serde default) match the frontend contract:
/// `e.payload.session_id`, `running_before`, `running_after`, `model`.
#[derive(Clone, serde::Serialize)]
struct SessionState {
    session_id: String,
    cwd: String,
    running_before: bool,
    running_after: bool,
    model: Option<String>,
    timestamp: u64,
}

/// Spawn the poller on its own OS thread; `running` is cleared on app exit.
pub fn spawn(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || poll_loop(app, running));
}

fn poll_loop(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    // session id → (cwd, model) for everything running as of the last poll. Holds
    // the cwd/model so a STOP transition can still be attributed to the right area
    // even though the session is already gone from the live set.
    let mut prev: HashMap<String, (String, Option<String>)> = HashMap::new();

    while running.load(Ordering::Relaxed) {
        let mut cur: HashMap<String, (String, Option<String>)> = HashMap::new();
        for s in flightdeck::working_sessions() {
            cur.insert(s.session_id, (s.cwd, s.model));
        }
        let ts = flightdeck::now_ms();

        // started → running_after = true
        for (id, (cwd, model)) in &cur {
            if !prev.contains_key(id) {
                crate::dlog!("[bridge] session {} false→true ({cwd})", short(id));
                let _ = app.emit(
                    "praxis://session-state",
                    SessionState {
                        session_id: id.clone(),
                        cwd: cwd.clone(),
                        running_before: false,
                        running_after: true,
                        model: model.clone(),
                        timestamp: ts,
                    },
                );
            }
        }
        // stopped → running_after = false (use the cwd/model captured while live)
        for (id, (cwd, model)) in &prev {
            if !cur.contains_key(id) {
                crate::dlog!("[bridge] session {} true→false ({cwd})", short(id));
                let _ = app.emit(
                    "praxis://session-state",
                    SessionState {
                        session_id: id.clone(),
                        cwd: cwd.clone(),
                        running_before: true,
                        running_after: false,
                        model: model.clone(),
                        timestamp: ts,
                    },
                );
            }
        }

        prev = cur;
        sleep_interruptible(&running, POLL_MS);
    }
}

/// First 8 chars of a session id, for compact log lines.
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

/// Sleep `total_ms`, waking every 100ms to honor a shutdown request promptly.
fn sleep_interruptible(running: &Arc<AtomicBool>, total_ms: u64) {
    let mut left = total_ms;
    while left > 0 && running.load(Ordering::Relaxed) {
        let slice = left.min(100);
        std::thread::sleep(Duration::from_millis(slice));
        left -= slice;
    }
}
