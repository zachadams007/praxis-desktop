//! flow_runner.rs - Praxis's NATIVE orchestration engine.
//!
//! North star ([[praxis-is-the-orchestrator-north-star]]): Praxis IS the
//! orchestrator. It must run orchestration flows ITSELF - spawn, monitor, verify,
//! and retry coding sessions - with no Claude Code orchestrator session babysitting
//! it. This module is that session-level engine. The in-webview `orchestrate()`
//! loop (src/orchestrator/orchestrator.ts) is the REASONING loop (plan → judge →
//! iterate over a fast brain); the FlowRunner complements it at the SESSION level:
//! it fans out real `claude -p` / `codex exec` / `cursor-agent` processes, watches
//! each to terminal, runs a verify command, retries a failed lane once, and
//! persists crash-safe state so a flow survives an app restart.
//!
//! ── MODEL ────────────────────────────────────────────────────────────────────
//!   FLOW  = an ordered list of WAVES, run strictly in sequence.
//!   WAVE  = N LANES run in PARALLEL. The wave completes when every lane reaches a
//!           terminal state (done / failed-escalate). A wave with any escalated
//!           lane does NOT abort the flow by default (the flow's remaining waves -
//!           e.g. a report wave - still run; the escalation is recorded), matching
//!           the overnight ethos of "get all the work you can done, then report".
//!   LANE  = one headless agent process: { driver claude|codex|cursor, cwd, prompt,
//!           model?, effort?, timeout, verify? }. The lane:
//!             1. spawns via hermes_bridge::build_lane_command (SAME flags as the
//!                agent_delegate path - shared, not copied), logging to
//!                %LOCALAPPDATA%\Praxis\flows\<flowId>\<laneId>.log
//!             2. is watched to terminal by polling pid liveness + the log mtime
//!             3. on process exit, runs its VERIFY command (e.g. `npx tsc --noEmit`,
//!                `cargo check`) in the lane cwd
//!             4. if verify (or the process) FAILED, retries ONCE with the failure
//!                tail appended to the prompt; a second failure → FAILED-ESCALATE.
//!
//! ── PERSISTENCE (crash-safe resume) ──────────────────────────────────────────
//!   The whole FlowState is written to praxis_dir/flows/<flowId>.json after EVERY
//!   transition (wave advance, lane spawn, lane terminal, retry). On app start,
//!   `resume_running()` scans that dir; any flow still marked `running` whose lanes
//!   are no longer alive is re-driven from its persisted position - completed waves
//!   are skipped, the interrupted wave's not-yet-done lanes are re-spawned.
//!
//! ── SAFETY ───────────────────────────────────────────────────────────────────
//!   • HALT breaker: honored the same way orchestrate() honors it -
//!     policy::isHalted() reads localStorage `praxis.halted.v1`, mirrored to
//!     %LOCALAPPDATA%\Praxis\halted.txt by the frontend haltStore. We read that
//!     mirror before spawning any lane and between waves; a halted app spawns
//!     nothing and pauses running flows (they resume when the breaker clears).
//!   • Trust gating: flows only spawn bypass-permission processes at Trust III+
//!     (autonomy "operator"/"full"), read from %LOCALAPPDATA%\Praxis\autonomy.txt -
//!     the same file computer_use.rs gates on. Below that, a flow is REFUSED at
//!     start with a clear reason (never spawns a single lane).
//!
//! ── EVENTS ───────────────────────────────────────────────────────────────────
//!   `praxis://flow-progress` fires on every transition with the full FlowState so
//!   the cockpit can render live wave/lane status without polling.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

// ── Tunables ─────────────────────────────────────────────────────────────────

/// How often a lane-watcher polls pid liveness + verify readiness.
const LANE_POLL: Duration = Duration::from_secs(2);
/// Default per-lane wall-clock cap when a definition/lane omits one. A single
/// headless build lane routinely runs minutes; 45 min is a generous backstop
/// against a wedged process, not a target.
const DEFAULT_LANE_TIMEOUT_SECS: u64 = 45 * 60;
/// How many bytes of a lane's log tail we append to the retry prompt / carry into
/// state as the failure reason. Enough signal for the agent to self-correct,
/// bounded so state.json and the retry prompt stay small.
const FAIL_TAIL_BYTES: u64 = 4 * 1024;
/// Verify command wall-clock cap - a type/compile check, not a build.
const VERIFY_TIMEOUT_SECS: u64 = 10 * 60;

// ── Persisted state shapes (camelCase → matches src/orchestrator/flows.ts) ────

/// A lane as authored in a flow definition or an inline flow request.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSpec {
    /// Stable within a flow - used for the log filename + progress keys. Filled in
    /// from the wave/lane index when a definition omits it.
    #[serde(default)]
    pub id: String,
    pub driver: String, // "claude" | "codex" | "cursor"
    pub prompt: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Shell verify command run in `cwd` after the process exits (e.g.
    /// "npx tsc --noEmit", "cargo check"). None → the lane passes on a clean exit.
    #[serde(default)]
    pub verify: Option<String>,
    /// Per-lane timeout override (seconds). None → DEFAULT_LANE_TIMEOUT_SECS.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// One wave of parallel lanes.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveSpec {
    #[serde(default)]
    pub label: String,
    pub lanes: Vec<LaneSpec>,
}

/// A flow definition (as stored in praxis_dir/flows/definitions/*.json or sent
/// inline). `{param}` tokens in any lane prompt/cwd are substituted from `params`
/// at start - so "delegate"/"overnight" definitions are reusable templates.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDefinition {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub waves: Vec<WaveSpec>,
}

/// Live per-lane state (what the cockpit renders + what resume reads).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneState {
    pub id: String,
    pub driver: String,
    pub prompt: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub verify: Option<String>,
    pub timeout_secs: u64,
    /// "pending" | "running" | "verifying" | "retrying" | "done" | "failed-escalate"
    pub status: String,
    /// Live OS pid of the current attempt (None before spawn / after exit).
    #[serde(default)]
    pub pid: Option<u32>,
    /// 0 on the first attempt, 1 after the single retry.
    #[serde(default)]
    pub attempt: u32,
    /// Absolute path to this lane's log file.
    pub log: String,
    /// Failure tail captured when a lane escalates (for the cockpit + lessons pass).
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: u64,
}

/// Live per-wave state.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveState {
    pub label: String,
    /// "pending" | "running" | "done"
    pub status: String,
    pub lanes: Vec<LaneState>,
}

/// The whole flow - persisted after every transition, emitted on progress.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowState {
    pub flow_id: String,
    pub definition_id: String,
    pub label: String,
    /// "running" | "done" | "failed" | "halted" | "stopped"
    pub status: String,
    /// Index of the wave currently executing (or the next to run).
    pub current_wave: usize,
    pub waves: Vec<WaveState>,
    pub params: HashMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Set when the flow ends without every lane succeeding - read by the lessons
    /// pass to decide whether there's anything worth teaching Hermes.
    #[serde(default)]
    pub had_failures: bool,
    #[serde(default)]
    pub had_retries: bool,
}

// ── Registry: one live task-cancel flag per running flow ──────────────────────

/// Cancellation flags for flows this process is actively driving. `flow_stop`
/// flips one; the flow's drive loop observes it between lanes/waves and tears the
/// flow's live lane processes down. Not persisted - a restart re-derives liveness
/// from pids on disk.
static REGISTRY: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

fn registry() -> std::sync::MutexGuard<'static, Option<HashMap<String, Arc<AtomicBool>>>> {
    let mut g = REGISTRY.lock().unwrap();
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

fn register_flow(flow_id: &str) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    registry()
        .as_mut()
        .unwrap()
        .insert(flow_id.to_string(), cancel.clone());
    cancel
}

fn unregister_flow(flow_id: &str) {
    if let Some(m) = registry().as_mut() {
        m.remove(flow_id);
    }
}

// ── Paths + time ──────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn flows_dir() -> Option<PathBuf> {
    crate::praxis_dir().map(|d| d.join("flows"))
}

fn definitions_dir() -> Option<PathBuf> {
    flows_dir().map(|d| d.join("definitions"))
}

fn flow_state_path(flow_id: &str) -> Option<PathBuf> {
    flows_dir().map(|d| d.join(format!("{flow_id}.json")))
}

fn lane_log_dir(flow_id: &str) -> Option<PathBuf> {
    flows_dir().map(|d| d.join(flow_id))
}

// ── Safety gates (identical signals to orchestrate() + computer_use.rs) ────────

const AUTONOMY_LEVELS: [&str; 5] = ["observe", "suggest", "approve", "operator", "full"];

/// Trust dial as the shell sees it - read from %LOCALAPPDATA%\Praxis\autonomy.txt,
/// the SAME file computer_use.rs::effective_autonomy() reads (mirrored from the
/// frontend dial by autonomy_sync). Missing/invalid → "operator" (the shared
/// DEFAULT_AUTONOMY), so shell + frontend agree before the dial is ever touched.
fn effective_autonomy() -> String {
    let level = crate::praxis_dir()
        .map(|d| d.join("autonomy.txt"))
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if AUTONOMY_LEVELS.contains(&level.as_str()) {
        level
    } else {
        "operator".to_string()
    }
}

/// A flow is the definition of an unattended run: it spawns bypass-permission
/// agent processes that keep working long after the owner has walked away. So the
/// trust dial governs it, and the dial is the only thing that does.
///
/// This used to be one bool - `operator | full` - which is why the bottom three
/// detents were behaviourally identical: OBSERVE, "suggest" and PROPOSE all
/// collapsed into "not operator", and the dial's four positions bought two
/// outcomes. Asking `crate::autonomy` instead means a rung added there shows up
/// here without a second edit, and the reason a flow was refused names the
/// detent the owner can actually see on the dial.
fn flow_decision() -> crate::autonomy::Decision {
    crate::autonomy::unattended_decision(
        crate::autonomy::effective_level(),
        crate::autonomy::ActionClass::Actuate,
    )
}

fn trust_allows_flows() -> bool {
    flow_decision().is_allowed()
}

/// True when each step must be approved before it runs (II · PROPOSE). The flow
/// itself is permitted; every actuation inside it goes through the veto channel,
/// which is the same channel the sovereign loop uses - one approval UI, not two.
pub fn flows_require_step_approval() -> bool {
    matches!(flow_decision(), crate::autonomy::Decision::Allowed(a) if a == crate::autonomy::Approval::Step)
}

/// HALT breaker - honored the SAME way orchestrate() honors it. The frontend
/// haltStore writes localStorage `praxis.halted.v1` AND mirrors it to
/// %LOCALAPPDATA%\Praxis\halted.txt ("1"/"0") so the Rust side (no localStorage)
/// can read the live breaker. Missing file → not halted (safe default: a fresh
/// install with no breaker thrown runs normally).
fn is_halted() -> bool {
    crate::praxis_dir()
        .map(|d| d.join("halted.txt"))
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

// ── Windows pid helpers (mirror flightdeck.rs's tasklist approach) ────────────

/// True iff the given pid is a live process. Used to watch a lane to terminal and
/// to decide, on resume, whether a persisted "running" lane is actually still up.
fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let filter = format!("PID eq {pid}");
        let out = std::process::Command::new("tasklist")
            .args(["/NH", "/FO", "CSV", "/FI", &filter])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            // tasklist prints "INFO: No tasks..." (no CSV row) when the pid is gone.
            return text.lines().any(|l| l.contains(&format!("\"{pid}\"")));
        }
        false
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Force-kill a lane's process tree (image-verified via taskkill /T). Best-effort -
/// used on flow_stop and on app-shutdown teardown.
fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

// ── Log tail (failure capture) ────────────────────────────────────────────────

fn tail_bytes(path: &str, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.take(max).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

// ── Param substitution ────────────────────────────────────────────────────────

/// Replace `{key}` tokens using `params`. Unmatched tokens are left as-is (a
/// definition may intentionally carry literal braces). Cheap single-pass per key.
fn subst(template: &str, params: &HashMap<String, String>) -> String {
    let mut s = template.to_string();
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

// ── State persistence ─────────────────────────────────────────────────────────

/// Write the whole flow state atomically-ish (write to .tmp, rename) so a crash
/// mid-write never leaves a truncated state.json a resume would choke on.
fn persist(state: &FlowState) {
    let Some(path) = flow_state_path(&state.flow_id) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string_pretty(state) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json.as_bytes()).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// Persist + emit progress in one call - the single transition point so state on
/// disk and the cockpit never diverge.
fn commit(app: &AppHandle, state: &mut FlowState) {
    state.updated_at = now_ms();
    persist(state);
    let _ = app.emit("praxis://flow-progress", state.clone());
}

// ── Definition loading ────────────────────────────────────────────────────────

/// The two shipped flow definitions, embedded at compile time from
/// `resources/flow-definitions/` (via include_str! - no Tauri resource-bundling
/// config, works identically in `cargo tauri dev` and an installed release). New
/// flows are pure JSON in praxis_dir/flows/definitions/ and need NO Rust change;
/// these two are just the seeded defaults.
const SHIPPED_DEFINITIONS: [(&str, &str); 3] = [
    (
        "delegate",
        include_str!("../resources/flow-definitions/delegate.json"),
    ),
    (
        "delegate-v2",
        include_str!("../resources/flow-definitions/delegate-v2.json"),
    ),
    (
        "overnight",
        include_str!("../resources/flow-definitions/overnight.json"),
    ),
];

/// Seed the shipped definitions into praxis_dir/flows/definitions/ if absent.
/// Never OVERWRITES an existing file - the owner may have tuned a definition, and a
/// definition dropped in by hand must win. Called once at app start.
pub fn seed_definitions() {
    let Some(dir) = definitions_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    for (id, body) in SHIPPED_DEFINITIONS {
        let path = dir.join(format!("{id}.json"));
        if !path.exists() {
            let _ = fs::write(&path, body);
        }
    }
}

fn load_definition(id: &str) -> Result<FlowDefinition, String> {
    let dir = definitions_dir().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let path = dir.join(format!("{id}.json"));
    let raw = fs::read_to_string(&path).map_err(|e| {
        format!(
            "flow definition '{id}' not found at {}: {e}",
            path.display()
        )
    })?;
    serde_json::from_str(&raw).map_err(|e| format!("flow definition '{id}' is not valid JSON: {e}"))
}

/// Materialize a FlowState from a definition + params: fill lane ids, substitute
/// `{param}` tokens, and initialize every lane/wave to pending.
fn instantiate(def: &FlowDefinition, flow_id: &str, params: HashMap<String, String>) -> FlowState {
    let now = now_ms();
    let waves = def
        .waves
        .iter()
        .enumerate()
        .map(|(wi, w)| {
            let lanes = w
                .lanes
                .iter()
                .enumerate()
                .map(|(li, l)| {
                    let id = if l.id.trim().is_empty() {
                        format!("w{wi}l{li}")
                    } else {
                        l.id.clone()
                    };
                    let log = lane_log_dir(flow_id)
                        .map(|d| d.join(format!("{id}.log")).to_string_lossy().into_owned())
                        .unwrap_or_default();
                    LaneState {
                        id,
                        driver: subst(&l.driver, &params),
                        prompt: subst(&l.prompt, &params),
                        cwd: l.cwd.as_ref().map(|c| subst(c, &params)),
                        // `{token}` substitution applies here too (2026-07-10 fix - this
                        // was cloned verbatim, the only lane field subst() skipped) so a
                        // definition can carry a `"model": "{model}"` placeholder resolved
                        // from the caller's params, same as prompt/cwd/verify. Definitions
                        // that hardcode a literal model string (e.g. "opus") are unaffected
                        // - subst() leaves unmatched tokens untouched.
                        model: l.model.as_ref().map(|m| subst(m, &params)),
                        verify: l.verify.as_ref().map(|v| subst(v, &params)),
                        timeout_secs: l.timeout_secs.unwrap_or(DEFAULT_LANE_TIMEOUT_SECS),
                        status: "pending".to_string(),
                        pid: None,
                        attempt: 0,
                        log,
                        failure: None,
                        started_at: 0,
                        ended_at: 0,
                    }
                })
                .collect();
            WaveState {
                label: w.label.clone(),
                status: "pending".to_string(),
                lanes,
            }
        })
        .collect();

    FlowState {
        flow_id: flow_id.to_string(),
        definition_id: def.id.clone(),
        label: if def.label.trim().is_empty() {
            def.id.clone()
        } else {
            def.label.clone()
        },
        status: "running".to_string(),
        current_wave: 0,
        waves,
        params,
        created_at: now,
        updated_at: now,
        had_failures: false,
        had_retries: false,
    }
}

// ── The engine: drive one flow to terminal ────────────────────────────────────

/// Spawn a lane process (attempt N). Returns the pid on success. Opens/creates the
/// lane log (append so a retry keeps the prior attempt's tail above the retry).
async fn spawn_lane(lane: &mut LaneState) -> Result<u32, String> {
    if let Some(dir) = PathBuf::from(&lane.log).parent() {
        let _ = fs::create_dir_all(dir);
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&lane.log)
        .map_err(|e| format!("open lane log {}: {e}", lane.log))?;
    let mut cmd = crate::hermes_bridge::build_lane_command(
        &lane.driver,
        &lane.prompt,
        lane.cwd.as_deref(),
        lane.model.as_deref(),
        log,
    )?;
    let child = cmd
        .spawn()
        .map_err(|e| format!("spawn {} lane: {e}", lane.driver))?;
    let pid = child
        .id()
        .ok_or_else(|| "lane spawned but has no pid".to_string())?;
    // Detach: we watch by pid + log, never by this handle. Dropping it must NOT
    // kill the child, so hand it to a background reaper that just awaits exit
    // (prevents a zombie without coupling the child's life to this handle).
    tokio::spawn(async move {
        let mut child = child;
        let _ = child.wait().await;
    });
    lane.pid = Some(pid);
    lane.started_at = now_ms();
    Ok(pid)
}

/// Run a lane's verify command in its cwd. Ok(()) = passed (or no verify); Err =
/// the failure tail. Uses cmd /C on Windows so shell builtins + PATH resolution
/// (npx, cargo) work exactly as a user's shell would.
async fn run_verify(lane: &LaneState) -> Result<(), String> {
    let Some(vcmd) = lane
        .verify
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    let mut cmd = {
        #[cfg(windows)]
        {
            // tokio's Command exposes creation_flags as an inherent method (no
            // std CommandExt import needed) - CREATE_NO_WINDOW, no console flash.
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", vcmd]);
            c.creation_flags(0x0800_0000);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", vcmd]);
            c
        }
    };
    if let Some(dir) = &lane.cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("verify spawn failed: {e}"))?;
    let out = tokio::time::timeout(
        Duration::from_secs(VERIFY_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("verify '{vcmd}' timed out after {VERIFY_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("verify '{vcmd}' wait error: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let tail: String = String::from_utf8_lossy(&out.stdout)
            .lines()
            .chain(String::from_utf8_lossy(&out.stderr).lines())
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "verify '{vcmd}' failed (exit {:?}):\n{tail}",
            out.status.code()
        ))
    }
}

/// Watch one already-spawned lane to a terminal LaneState. Polls pid liveness on
/// LANE_POLL; when the process exits it runs verify; a failure (process or verify)
/// triggers ONE retry with the failure tail appended, else FAILED-ESCALATE.
/// `cancel` short-circuits (flow_stop / shutdown): the lane's process is killed and
/// the lane left mid-run for a later resume (status stays "running").
async fn watch_lane(lane: &mut LaneState, cancel: &Arc<AtomicBool>) {
    loop {
        // ── Wait for the current attempt's process to exit (or time out / cancel) ──
        let started = lane.started_at;
        let deadline = started + lane.timeout_secs * 1000;
        loop {
            if cancel.load(Ordering::Relaxed) {
                if let Some(pid) = lane.pid {
                    kill_pid_tree(pid);
                }
                return; // leave status "running" - resume re-spawns
            }
            let alive = lane.pid.map(pid_alive).unwrap_or(false);
            if !alive {
                break;
            }
            if now_ms() >= deadline {
                if let Some(pid) = lane.pid {
                    kill_pid_tree(pid);
                }
                lane.failure = Some(format!(
                    "lane timed out after {}s\n{}",
                    lane.timeout_secs,
                    tail_bytes(&lane.log, FAIL_TAIL_BYTES)
                ));
                break;
            }
            tokio::time::sleep(LANE_POLL).await;
        }
        lane.pid = None;

        // ── Verify (skipped if the process already timed out into a failure) ──
        lane.status = "verifying".to_string();
        let verify_res = if lane.failure.is_some() {
            Err(lane.failure.clone().unwrap())
        } else {
            run_verify(lane).await
        };

        match verify_res {
            Ok(()) => {
                lane.status = "done".to_string();
                lane.ended_at = now_ms();
                lane.failure = None;
                return;
            }
            Err(reason) => {
                if lane.attempt == 0 {
                    // ── Retry ONCE with the failure tail appended to the prompt ──
                    lane.attempt = 1;
                    lane.status = "retrying".to_string();
                    let tail = tail_bytes(&lane.log, FAIL_TAIL_BYTES);
                    lane.prompt = format!(
                        "{}\n\n--- PREVIOUS ATTEMPT FAILED — fix this and complete the task ---\n{}\n{}",
                        lane.prompt, reason, tail
                    );
                    lane.failure = None;
                    match spawn_lane(lane).await {
                        Ok(_) => {
                            lane.status = "running".to_string();
                            continue; // re-enter the wait loop for attempt 2
                        }
                        Err(e) => {
                            lane.status = "failed-escalate".to_string();
                            lane.failure = Some(format!("retry spawn failed: {e}"));
                            lane.ended_at = now_ms();
                            return;
                        }
                    }
                } else {
                    // Second failure → escalate. The flow keeps going (report wave
                    // still runs); the escalation is recorded for the lessons pass.
                    lane.status = "failed-escalate".to_string();
                    lane.failure = Some(reason);
                    lane.ended_at = now_ms();
                    return;
                }
            }
        }
    }
}

/// Drive an entire flow to terminal: for each wave from `current_wave`, spawn every
/// not-yet-done lane, watch them all in parallel to terminal, then advance. Honors
/// HALT (pauses between waves/before spawn) and cancel (flow_stop / shutdown).
async fn drive_flow(app: AppHandle, mut state: FlowState, cancel: Arc<AtomicBool>) {
    while state.current_wave < state.waves.len() {
        // ── HALT gate - pause (don't fail) while the breaker is thrown. A halted
        //    app spawns nothing; when the breaker clears the flow continues. ──
        while is_halted() {
            if state.status != "halted" {
                state.status = "halted".to_string();
                commit(&app, &mut state);
            }
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        if cancel.load(Ordering::Relaxed) {
            state.status = "stopped".to_string();
            commit(&app, &mut state);
            unregister_flow(&state.flow_id);
            return;
        }
        if state.status == "halted" {
            state.status = "running".to_string();
        }

        let wi = state.current_wave;
        state.waves[wi].status = "running".to_string();

        // Spawn every not-yet-done lane in this wave (resume skips done ones).
        for lane in state.waves[wi].lanes.iter_mut() {
            if lane.status == "done" || lane.status == "failed-escalate" {
                continue;
            }

            // ── II · PROPOSE - ask before EVERY step ────────────────────────
            // The detent said "Pauses for a yes before anything happens" and did
            // nothing of the kind - it was byte-identical to OBSERVE. A lane is a
            // step: one bypass-permission agent about to run unsupervised, which
            // is exactly the thing a person would want to see before it starts.
            if flows_require_step_approval() {
                let approve_app = app.clone();
                let action = format!("flow lane {}", lane.driver);
                let summary = format!(
                    "{}: {}",
                    lane.driver,
                    lane.prompt.chars().take(160).collect::<String>()
                );
                let args = serde_json::json!({
                    "flow": state.flow_id,
                    "wave": wi,
                    "driver": lane.driver,
                    "cwd": lane.cwd,
                    "model": lane.model,
                });
                let approved = tokio::task::spawn_blocking(move || {
                    crate::sovereign::request_veto(&approve_app, &action, &summary, &args)
                })
                .await
                .unwrap_or_else(|e| Err(format!("approval task panicked: {e}")));

                match approved {
                    Ok(true) => {}
                    Ok(false) => {
                        lane.status = "failed-escalate".to_string();
                        lane.failure =
                            Some("You declined this step at II · PROPOSE.".to_string());
                        lane.ended_at = now_ms();
                        continue;
                    }
                    Err(e) => {
                        // No answer (timeout, closed overlay) is not a yes.
                        lane.status = "failed-escalate".to_string();
                        lane.failure = Some(format!("step approval never arrived: {e}"));
                        lane.ended_at = now_ms();
                        continue;
                    }
                }
            }

            lane.status = "running".to_string();
            if let Err(e) = spawn_lane(lane).await {
                // Couldn't even start - escalate this lane, keep the wave going.
                lane.status = "failed-escalate".to_string();
                lane.failure = Some(e);
                lane.ended_at = now_ms();
            }
        }
        commit(&app, &mut state);

        // Watch the wave's lanes to terminal, in parallel. We take the lanes out,
        // watch them concurrently on a JoinSet (tokio, already a dep - no extra
        // crate), then put them back - Rust's borrow rules forbid holding N mutable
        // borrows into the Vec across awaits, so each watcher owns its lane. Each
        // task carries the lane's original index so we can restore stable order.
        let lanes = std::mem::take(&mut state.waves[wi].lanes);
        let mut set = tokio::task::JoinSet::new();
        for (idx, mut lane) in lanes.into_iter().enumerate() {
            let cancel_task = cancel.clone();
            set.spawn(async move {
                if lane.status == "running" {
                    watch_lane(&mut lane, &cancel_task).await;
                }
                (idx, lane)
            });
        }
        let mut collected: Vec<(usize, LaneState)> = Vec::new();
        while let Some(res) = set.join_next().await {
            if let Ok(pair) = res {
                collected.push(pair);
            }
        }
        collected.sort_by_key(|(idx, _)| *idx);
        state.waves[wi].lanes = collected.into_iter().map(|(_, lane)| lane).collect();

        // Roll up wave outcome into flow flags (for the lessons pass).
        for lane in &state.waves[wi].lanes {
            if lane.attempt > 0 {
                state.had_retries = true;
            }
            if lane.status == "failed-escalate" {
                state.had_failures = true;
            }
        }

        if cancel.load(Ordering::Relaxed) {
            // A cancel mid-wave leaves not-done lanes "running" for resume.
            state.status = "stopped".to_string();
            commit(&app, &mut state);
            unregister_flow(&state.flow_id);
            return;
        }

        state.waves[wi].status = "done".to_string();
        state.current_wave += 1;
        commit(&app, &mut state);
    }

    // ── Flow terminal ──
    state.status = if state.had_failures {
        "failed".to_string()
    } else {
        "done".to_string()
    };
    commit(&app, &mut state);
    unregister_flow(&state.flow_id);

    // ── Hermes lessons pass (one cheap call, only when there's something to learn) ──
    lessons_pass(&app, &state).await;
}

// ── Hermes self-improvement: one lessons pass per flow ─────────────────────────

/// PROPOSED HOW (flagged in the build report): on flow completion, feed the flow
/// ledger - lanes, failures, retries, durations - to the brain asking "what should
/// Praxis do differently next time," and write the answer into Hermes's shared
/// memory via hermes_teach. Capped: ONE call per flow, SKIPPED entirely when the
/// flow had zero failures and zero retries (a clean run has nothing to teach and
/// would just burn MEMORY.md's tight budget on noise - same rule the frontend
/// teachHermesFromRun uses).
async fn lessons_pass(app: &AppHandle, state: &FlowState) {
    if !state.had_failures && !state.had_retries {
        return; // clean flow - nothing new to teach
    }

    // Build a compact ledger the brain can reason over.
    let mut lines: Vec<String> = vec![format!(
        "Flow '{}' ({}) finished {} across {} wave(s).",
        state.label,
        state.definition_id,
        state.status,
        state.waves.len()
    )];
    for (wi, w) in state.waves.iter().enumerate() {
        for lane in &w.lanes {
            let dur = if lane.ended_at > lane.started_at {
                (lane.ended_at - lane.started_at) / 1000
            } else {
                0
            };
            let note = match lane.status.as_str() {
                "failed-escalate" => format!(
                    "ESCALATED after {} attempt(s): {}",
                    lane.attempt + 1,
                    lane.failure
                        .as_deref()
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect::<String>()
                ),
                "done" if lane.attempt > 0 => "recovered on retry".to_string(),
                other => other.to_string(),
            };
            lines.push(format!(
                "  w{wi} lane {} [{}{}] {}s — {}",
                lane.id,
                lane.driver,
                lane.model
                    .as_deref()
                    .map(|m| format!("/{m}"))
                    .unwrap_or_default(),
                dur,
                note
            ));
        }
    }
    let ledger = lines.join("\n");

    let prompt = format!(
        "You are Praxis reviewing one of your own native orchestration flows. Here is the flow \
         ledger (lanes, failures, retries, durations):\n\n{ledger}\n\nIn ONE or TWO sentences, \
         state the single most useful thing Praxis should do DIFFERENTLY next time to avoid the \
         failures/retries above (e.g. a better tool/model choice, a missing verify step, a \
         prompt-scoping fix). Be concrete and terse. If there's genuinely no durable lesson, \
         reply exactly: NO LESSON."
    );

    // One cheap brain call. Best-effort: brain off/slow/unavailable never matters -
    // the flow already finished; this is pure upside.
    let lesson = match crate::hermes_bridge::hermes_brain_once(prompt, None, None).await {
        Ok(text) => text.trim().to_string(),
        Err(e) => {
            crate::elog!("[flow] lessons pass brain call failed (non-fatal): {e}");
            return;
        }
    };
    if lesson.is_empty() || lesson.to_uppercase().contains("NO LESSON") {
        return;
    }

    let scoped = format!(
        "Native flow lesson ('{}' flow): {}",
        state.definition_id,
        lesson.chars().take(400).collect::<String>()
    );
    if let Err(e) = crate::hermes_bridge::hermes_teach(scoped, Some("memory".to_string())).await {
        crate::elog!("[flow] lessons pass hermes_teach failed (non-fatal): {e}");
    } else {
        let _ = app.emit("praxis://flow-lesson", state.flow_id.clone());
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// Start a flow. `definition` is either a saved definition id (loaded from
/// praxis_dir/flows/definitions/<id>.json) or an inline FlowDefinition object.
/// `params` fill `{token}` slots in lane prompts/cwds. Returns the new flowId.
///
/// Refuses (spawning NOTHING) when the trust dial is below III (operator/full) or
/// the HALT breaker is thrown - the two hard safety gates, checked before any lane.
#[tauri::command]
pub async fn flow_start(
    app: AppHandle,
    definition: Value,
    params: Option<HashMap<String, String>>,
) -> Result<String, String> {
    if let crate::autonomy::Decision::Blocked(reason) = flow_decision() {
        return Err(reason);
    }
    if is_halted() {
        return Err("HALT ALL is thrown — clear the breaker before starting a flow.".to_string());
    }

    // Resolve the definition: a JSON string id, or an inline definition object.
    let def: FlowDefinition = match &definition {
        Value::String(id) => load_definition(id)?,
        Value::Object(_) => serde_json::from_value(definition.clone())
            .map_err(|e| format!("inline flow definition invalid: {e}"))?,
        _ => {
            return Err(
                "definition must be a definition-id string or an inline flow object".to_string(),
            )
        }
    };
    if def.waves.is_empty() || def.waves.iter().all(|w| w.lanes.is_empty()) {
        return Err("flow definition has no lanes".to_string());
    }

    let params = params.unwrap_or_default();
    let flow_id = format!("flow-{}-{}", def.id, now_ms());
    let mut state = instantiate(&def, &flow_id, params);

    // Persist the running flow BEFORE spawning anything, so a crash between here
    // and the first spawn still leaves a resumable record.
    persist(&state);
    let cancel = register_flow(&flow_id);
    commit(&app, &mut state);

    // Drive it on the async runtime; the command returns immediately with the id.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        drive_flow(app2, state, cancel).await;
    });

    Ok(flow_id)
}

/// Current persisted state of one flow (for a cockpit that missed live events).
#[tauri::command]
pub fn flow_status(flow_id: String) -> Result<FlowState, String> {
    let path = flow_state_path(&flow_id).ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("flow '{flow_id}' not found: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("flow '{flow_id}' state corrupt: {e}"))
}

/// Stop a flow: signal its drive loop to cancel (kills live lane processes, marks
/// the flow "stopped"). If the flow isn't being driven by THIS process (e.g. a
/// leftover "running" record from before a restart), tear down any still-alive
/// lane pids directly and mark it stopped on disk.
#[tauri::command]
pub fn flow_stop(app: AppHandle, flow_id: String) -> Result<(), String> {
    if let Some(cancel) = registry().as_ref().and_then(|m| m.get(&flow_id).cloned()) {
        cancel.store(true, Ordering::Relaxed);
        return Ok(());
    }
    // Not actively driven - kill any lingering lane pids and mark stopped.
    let path = flow_state_path(&flow_id).ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let Ok(raw) = fs::read_to_string(&path) else {
        return Err(format!("flow '{flow_id}' not found"));
    };
    let mut state: FlowState =
        serde_json::from_str(&raw).map_err(|e| format!("flow '{flow_id}' state corrupt: {e}"))?;
    for w in &mut state.waves {
        for lane in &mut w.lanes {
            if let Some(pid) = lane.pid.take() {
                kill_pid_tree(pid);
            }
        }
    }
    state.status = "stopped".to_string();
    state.updated_at = now_ms();
    persist(&state);
    let _ = app.emit("praxis://flow-progress", state.clone());
    Ok(())
}

/// Summary of every persisted flow, newest first - the cockpit's flow list.
#[tauri::command]
pub fn flow_list() -> Vec<FlowState> {
    let Some(dir) = flows_dir() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    let mut flows: Vec<FlowState> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            let raw = fs::read_to_string(&p).ok()?;
            serde_json::from_str::<FlowState>(&raw).ok()
        })
        .collect();
    flows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    flows
}

// ── Crash-safe resume (called once at app start) ──────────────────────────────

/// On app start: any flow persisted as "running"/"halted" whose lanes are no
/// longer alive was interrupted (app crash / reboot). Re-drive it from its
/// persisted position - completed waves are skipped, the interrupted wave's
/// not-done lanes are re-spawned. A flow whose lanes are STILL alive (rare - a
/// second Praxis instance) is left alone.
///
/// Safety gates still apply: if trust dropped below III or HALT is thrown, resume
/// is deferred (the flow stays "running" on disk and is picked up on a later
/// start once the gates clear) rather than force-spawning.
pub fn resume_running(app: AppHandle) {
    // Small delay so this doesn't race the boot-time spawn flurry (hotkey retries,
    // Hermes ensure, etc.) - mirrors research_watch::spawn's initial sleep.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        if !trust_allows_flows() || is_halted() {
            crate::elog!("[flow] resume deferred (trust below III or HALT thrown)");
            return;
        }
        let Some(dir) = flows_dir() else { return };
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&p) else {
                continue;
            };
            let Ok(mut state) = serde_json::from_str::<FlowState>(&raw) else {
                continue;
            };
            if state.status != "running" && state.status != "halted" {
                continue;
            }
            // If any lane is genuinely still alive, another driver owns it - skip.
            let any_alive = state
                .waves
                .iter()
                .flat_map(|w| &w.lanes)
                .any(|l| l.pid.map(pid_alive).unwrap_or(false));
            if any_alive {
                continue;
            }
            // Reset interrupted lanes (were "running"/"verifying"/"retrying" with a
            // dead pid) back to pending so drive_flow re-spawns them cleanly.
            for w in state.waves.iter_mut() {
                for lane in w.lanes.iter_mut() {
                    if !matches!(lane.status.as_str(), "done" | "failed-escalate") {
                        lane.status = "pending".to_string();
                        lane.pid = None;
                    }
                }
            }
            state.status = "running".to_string();
            let flow_id = state.flow_id.clone();
            crate::dlog!(
                "[flow] resuming interrupted flow '{flow_id}' at wave {}",
                state.current_wave
            );
            let cancel = register_flow(&flow_id);
            let app2 = app.clone();
            persist(&state);
            tauri::async_runtime::spawn(async move {
                drive_flow(app2, state, cancel).await;
            });
        }
    });
}

/// Tear down every live lane across all flows this process is driving - called on
/// app shutdown so headless children don't orphan (mirrors quartz/hermes stop()).
pub fn stop_all() {
    let flags: Vec<Arc<AtomicBool>> = registry()
        .as_ref()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    for f in flags {
        f.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subst_replaces_known_tokens_and_leaves_others() {
        let mut p = HashMap::new();
        p.insert("goal".to_string(), "add dark mode".to_string());
        p.insert("cwd".to_string(), "C:/app".to_string());
        assert_eq!(
            subst("Build: {goal} in {cwd}", &p),
            "Build: add dark mode in C:/app"
        );
        // Unknown token left literal (a definition may want real braces).
        assert_eq!(subst("keep {this}", &p), "keep {this}");
    }

    #[test]
    fn instantiate_fills_ids_and_pends_everything() {
        let def = FlowDefinition {
            id: "t".to_string(),
            label: "Test".to_string(),
            waves: vec![WaveSpec {
                label: "build".to_string(),
                lanes: vec![LaneSpec {
                    id: String::new(),
                    driver: "claude".to_string(),
                    prompt: "do {goal}".to_string(),
                    cwd: None,
                    model: None,
                    effort: None,
                    verify: Some("cargo check".to_string()),
                    timeout_secs: None,
                }],
            }],
        };
        let mut params = HashMap::new();
        params.insert("goal".to_string(), "X".to_string());
        let st = instantiate(&def, "flow-t-1", params);
        assert_eq!(st.status, "running");
        assert_eq!(st.waves[0].lanes[0].id, "w0l0");
        assert_eq!(st.waves[0].lanes[0].prompt, "do X");
        assert_eq!(st.waves[0].lanes[0].status, "pending");
        assert_eq!(st.waves[0].lanes[0].timeout_secs, DEFAULT_LANE_TIMEOUT_SECS);
    }

    #[test]
    fn instantiate_substitutes_native_driver_and_model_together() {
        let def = FlowDefinition {
            id: "delegate-v2".to_string(),
            label: "test".to_string(),
            waves: vec![WaveSpec {
                label: "build".to_string(),
                lanes: vec![LaneSpec {
                    id: "primary".to_string(),
                    driver: "{driver}".to_string(),
                    prompt: "do {goal}".to_string(),
                    cwd: None,
                    model: Some("{model}".to_string()),
                    effort: None,
                    verify: None,
                    timeout_secs: None,
                }],
            }],
        };
        let mut params = HashMap::new();
        params.insert("goal".to_string(), "X".to_string());
        params.insert("driver".to_string(), "codex".to_string());
        params.insert("model".to_string(), "gpt-5.6-sol".to_string());
        let st = instantiate(&def, "flow-t-2", params);
        let lane = &st.waves[0].lanes[0];
        assert_eq!(lane.driver, "codex");
        assert_eq!(lane.model.as_deref(), Some("gpt-5.6-sol"));
    }

    #[test]
    fn autonomy_levels_gate_at_three() {
        // Documents the trust bar: only operator/full unlock native flows.
        assert!(matches!("operator", l if super::AUTONOMY_LEVELS.contains(&l)));
    }
}
