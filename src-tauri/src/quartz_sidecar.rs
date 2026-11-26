//! Quartz sidecar - runs the REAL Quartz dev server that renders the owner's memory vault as the
//! Memory Galaxy. The `knowledge` window points straight at it (embedded inside Praxis, not a
//! separate app), and it live-updates within ~2s when an agent writes a note (Quartz's own
//! chokidar watcher on the live vault folder).
//!
//! Owned by Tauri: started lazily on first open of the Memory Galaxy, killed on app exit.
//! Windows notes: (1) `npx` is `npx.cmd`, so we go through `cmd /C`; (2) npx spawns `node` as a
//! grandchild and Tauri/std `child.kill()` no-ops on Windows, so we tree-kill via `taskkill /T`.
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const PORT: u16 = 8181;
/// How long a spawned, still-alive Quartz may take to start listening before it counts as failed.
const STARTUP_GRACE_SECS: u64 = 360;
/// Land on the memory index page (root has no index.md → 404); it renders MEMORY + the graph.
pub const URL: &str = "http://localhost:8181/MEMORY";

struct QuartzProcess {
    child: Child,
    spawned_at: Instant,
}

struct QuartzState {
    process: Option<QuartzProcess>,
    failure: Option<String>,
}

static STATE: Mutex<QuartzState> = Mutex::new(QuartzState {
    process: None,
    failure: None,
});

fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

/// The Quartz workspace (cloned + `npm i`'d). TODO: bundle into the repo for release builds.
///
/// Lives under `~/tools`, NOT bare on the Desktop - loose Desktop files/folders get silently
/// relocated by OneDrive Desktop backup/tidying on this machine (this exact workspace was moved
/// to `Desktop\Praxis (project)\praxis-quartz` and its absence broke the Memory Galaxy for days
/// before anyone noticed - see `ensure_started()`'s warning emit below, added so it can't happen
/// silently again).
fn workspace() -> std::path::PathBuf {
    std::path::Path::new(&home())
        .join("tools")
        .join("praxis-quartz")
}

/// The LIVE memory vault - served directly so agent writes update the graph (no snapshot copy).
fn vault() -> std::path::PathBuf {
    std::path::Path::new(&home())
        .join(".claude")
        .join("projects")
        .join("C--Users-dev-Desktop-praxis")
        .join("memory")
}

/// Is the Quartz server already listening?
pub fn is_up() -> bool {
    TcpStream::connect_timeout(
        &("127.0.0.1".parse::<std::net::IpAddr>().unwrap(), PORT).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Honest lifecycle state for the Command Center. Quartz is lazy: an available
/// workspace with no process this run is idle, not stuck "starting".
pub fn status() -> (&'static str, String) {
    if is_up() {
        return ("up", "vault content server listening".to_string());
    }

    let ws = workspace();
    if !ws.exists() {
        return (
            "failed",
            format!("Quartz workspace missing at {}", ws.display()),
        );
    }

    let mut state = STATE.lock().unwrap();
    if let Some(reason) = &state.failure {
        return ("failed", reason.clone());
    }

    let Some(process) = state.process.as_mut() else {
        return (
            "idle",
            "starts when the Memory Galaxy opens".to_string(),
        );
    };

    match process.child.try_wait() {
        Ok(Some(exit)) => {
            let reason = format!("Quartz process exited with status {exit}");
            state.failure = Some(reason.clone());
            state.process = None;
            ("failed", reason)
        }
        Err(error) => {
            let reason = format!("Quartz process status check failed: {error}");
            state.failure = Some(reason.clone());
            state.process = None;
            ("failed", reason)
        }
        // A first build of the whole vault is slow: measured 2026-09-24, spawned 15:36:20 and
        // listening at 15:40:34 (~4 min for 1,589 notes). A 90 s limit called a healthy start
        // "failed" for two and a half minutes, so an alive process gets 6 minutes.
        Ok(None) if process.spawned_at.elapsed() < Duration::from_secs(STARTUP_GRACE_SECS) => (
            "starting",
            format!(
                "building the vault ({}s so far — a first build takes a few minutes)",
                process.spawned_at.elapsed().as_secs()
            ),
        ),
        Ok(None) => (
            "failed",
            format!("Quartz process is alive but not listening after {} minutes", STARTUP_GRACE_SECS / 60),
        ),
    }
}

/// Start the Quartz server if it isn't already up. Idempotent (reuses a dev server on :8181).
///
/// `app` is used to surface failures as a visible `praxis://quartz-error` event instead of only
/// an `eprintln!` - the knowledge window listens for it and shows a banner, since a silently
/// missing workspace previously meant the Memory Galaxy just fell back / blanked with no signal.
pub fn ensure_started(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if is_up() {
        return;
    }
    let mut state = STATE.lock().unwrap();
    if is_up() {
        return; // another caller won the race
    }
    if let Some(process) = state.process.as_mut() {
        match process.child.try_wait() {
            Ok(None) => return,
            Ok(Some(_)) | Err(_) => state.process = None,
        }
    }
    let ws = workspace();
    if !ws.exists() {
        let msg = format!(
            "Quartz workspace missing at {}. Memory Galaxy will fall back to the static graph. \
             Reinstall it under %USERPROFILE%\\tools\\praxis-quartz (see quartz_sidecar.rs).",
            ws.display()
        );
        state.failure = Some(msg.clone());
        crate::elog!("[quartz] {msg}");
        let _ = app.emit("praxis://quartz-error", msg);
        return;
    }
    let vault = vault();
    let mut cmd = Command::new("cmd");
    cmd.args([
        "/C",
        "npx",
        "quartz",
        "build",
        "--serve",
        "-d",
        &vault.to_string_lossy(),
        "--port",
        &PORT.to_string(),
    ])
    .current_dir(&ws);
    // No console window - opening the Memory Galaxy must never flash/park a terminal
    // (the owner's hard rule; the visible cmd window on galaxy open was exactly this spawn).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            state.process = Some(QuartzProcess {
                child,
                spawned_at: Instant::now(),
            });
            state.failure = None;
            crate::dlog!("[quartz] started pid={pid} (vault={:?})", vault);
        }
        Err(e) => {
            let msg = format!("Quartz spawn failed: {e}");
            state.failure = Some(msg.clone());
            crate::elog!("[quartz] {msg}");
            let _ = app.emit("praxis://quartz-error", msg);
        }
    }
}

/// Block until the server is listening, or `timeout`. Returns whether it's up.
pub fn wait_ready(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    is_up()
}

/// Tree-kill the server on exit (taskkill /T to also reap the node grandchild).
pub fn stop() {
    if let Some(process) = STATE.lock().unwrap().process.take() {
        let pid = process.child.id();
        let mut kill = Command::new("taskkill");
        kill.args(["/F", "/T", "/PID", &pid.to_string()]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let _ = kill.spawn();
        crate::dlog!("[quartz] stopped pid={pid}");
    }
}
