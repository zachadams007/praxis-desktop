//! Why it exists: an app left open for a long while went stale. Nothing updated
//! automatically, and the brain still showed an agent orbiting its cluster hours
//! after that agent had finished.
//!
//! The ROOT cause of that is fixed elsewhere (flightdeck.rs: a Flight Deck rebuild
//! that hung or panicked latched its in-flight flag forever, so every later poll got
//! the same frozen snapshot). This is the backstop on top of it: one
//! action that throws away every cached view of the world and makes every window
//! re-read it from source. If some future latch appears, Restore still works,
//! because it does not trust any cache to have noticed.

use tauri::Emitter;

/// Drop every cache that can serve a stale answer, force a fresh Flight Deck
/// rebuild, and tell every Praxis window to reload.
///
/// Persistent state is untouched: localStorage, settings, the trust dial, breakers,
/// chat history and the usage ledger all survive. Only CACHED READINGS are dropped.
#[tauri::command]
pub async fn restore_live_state(app: tauri::AppHandle) -> Result<RestoreReport, String> {
    crate::codex_usage::clear_cache();
    crate::claude_usage::clear_cache();
    crate::cursor_usage::clear_cache();
    crate::elevenlabs_usage::clear_cache();
    crate::flightdeck::force_fresh_snapshot(app.clone());

    app.emit("praxis://restore", serde_json::json!({ "at": crate::flightdeck::now_ms() }))
        .map_err(|e| format!("restore: could not reach the other windows: {e}"))?;

    Ok(RestoreReport {
        caches_cleared: 4,
        snapshot_rebuild_started: true,
    })
}

/// Restore's quiet sibling: drop every cached reading and force a fresh Flight
/// Deck snapshot, WITHOUT telling the windows to reload.
///
/// `restore_live_state` broadcasts a reload, which is right when the owner presses the
/// button and far too violent to do silently every time he comes back to the app.
/// This runs on resume (`src/shared/liveOnResume.ts`) so a reading that expired
/// while he was away is re-measured instead of replayed.
#[tauri::command]
pub async fn refresh_live_state(app: tauri::AppHandle) -> Result<RestoreReport, String> {
    // Drops the 60s Codex `/wham/usage` cache (and the rollout fallback cache).
    crate::codex_usage::clear_cache();
    crate::claude_usage::clear_cache();
    crate::cursor_usage::clear_cache();
    crate::elevenlabs_usage::clear_cache();
    crate::flightdeck::force_fresh_snapshot(app);

    Ok(RestoreReport {
        caches_cleared: 4,
        snapshot_rebuild_started: true,
    })
}

#[derive(serde::Serialize)]
pub struct RestoreReport {
    pub caches_cleared: u32,
    pub snapshot_rebuild_started: bool,
}
