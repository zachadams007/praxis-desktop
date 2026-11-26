//! state_mirror - durable disk mirror for the frontend's critical localStorage keys.
//!
//! WHY: every Praxis window keeps its real state (tasks, trust, fleet/brain picks,
//! galaxy tuning, board cache) in WebView2 Local Storage - which lives inside
//! `%LOCALAPPDATA%\com.praxis.os\EBWebView` and historically got WIPED by the
//! autostart/installer cache clears, and can still be lost to a hard-shutdown
//! LevelDB corruption. This mirror writes every critical key to
//! `%LOCALAPPDATA%\Praxis\state.json` on change; on window boot the frontend
//! seeds any MISSING localStorage key back from the mirror (src/shared/persist.ts)
//! before React mounts. localStorage stays the hot source of truth - the mirror
//! only restores, never overrides a present key.

use std::collections::HashMap;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

fn state_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("state.json"))
}

fn read_all() -> HashMap<String, String> {
    let Some(p) = state_path() else {
        return HashMap::new();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Persist one key. Whole-file rewrite under a lock - the map is tiny (a dozen
/// keys, a few KB) and this fires on user-action cadence, not per-frame.
#[tauri::command]
pub fn state_set(key: String, value: String) -> Result<(), String> {
    let _g = LOCK.lock().map_err(|_| "state lock poisoned".to_string())?;
    let mut all = read_all();
    all.insert(key, value);
    let p = state_path().ok_or("no praxis dir")?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// Full mirror snapshot - the boot-time restore source.
#[tauri::command]
pub fn state_all() -> Result<HashMap<String, String>, String> {
    let _g = LOCK.lock().map_err(|_| "state lock poisoned".to_string())?;
    Ok(read_all())
}
