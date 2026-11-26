//! Hermes ↔ Praxis bridge - Phase 3 real orchestration backend.
//!
//! Three responsibilities:
//!
//!   1. **Dashboard sidecar** (`ensure_dashboard` / `stop`): if `127.0.0.1:9119` is not
//!      already listening, spawn `hermes dashboard --port 9119 --no-open` with
//!      `OPENROUTER_API_KEY` injected from the vault file. `--no-open` keeps this an
//!      INVISIBLE background engine - Praxis only talks to it over `/api/status` and
//!      `/api/events` (the WS observer below); it must never pop the Hermes web
//!      dashboard open in the owner's browser. If the `hermes` binary is missing, log a
//!      warning and NO-OP - the rest of the app continues normally.
//!
//!   2. **WS observer thread** (`spawn_observer`): subscribe to
//!      `ws://127.0.0.1:9119/api/events?channel=praxis`, decode JSON-RPC frames, and emit
//!      `praxis://hermes-event` Tauri events for every Hermes event frame. Reconnects with
//!      exponential backoff if the socket drops. Guarded by the shared `BridgeShutdown`
//!      `Arc<AtomicBool>` - stops cleanly on app exit.
//!
//!   3. **Tauri commands** (`hermes_brain`, `agent_delegate`): the orchestrator's THINK/PLAN
//!      call and the multi-agent delegation dispatcher. Both are `async` Tauri commands.
//!
//! Pattern copied exactly from `quartz_sidecar.rs` (sidecar) and `transcript_tailer.rs`
//! (observer thread + emit). Do not rewrite the sidecar or observer patterns.

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::Emitter;

// ── CLI resolver ─────────────────────────────────────────────────────────────

/// Resolve a CLI to an absolute path if we know where it installs, else fall back to the bare
/// name so the OS PATH lookup takes over. Never panics - worst case returns `name` unchanged.
pub(crate) fn resolve_bin(name: &str) -> String {
    let candidates: Vec<String> = match name {
        "hermes" => std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| format!(r"{p}\hermes\hermes-agent\venv\Scripts\hermes.exe"))
            .into_iter()
            .collect(),
        "claude" => std::env::var("USERPROFILE")
            .ok()
            .map(|p| format!(r"{p}\.local\bin\claude.exe"))
            .into_iter()
            .collect(),
        "codex" => {
            let mut v = vec![];
            if let Ok(p) = std::env::var("APPDATA") {
                v.push(format!(r"{p}\npm\codex.cmd"));
            }
            if let Ok(p) = std::env::var("USERPROFILE") {
                v.push(format!(r"{p}\.local\bin\codex.exe"));
            }
            v
        }
        // Cursor's headless agent CLI (`cursor-agent`, stable on Windows as of
        // 2026). The PowerShell installer (`irm cursor.com/install?win32=true`)
        // drops it in ~/.local/bin alongside claude/uv; npm-global installs land
        // in %APPDATA%\npm. NOTE: this is the AGENT CLI, NOT the IDE launcher at
        // ...\Programs\cursor\resources\app\bin\cursor(.cmd) - that opens the GUI
        // and is deliberately not a candidate here.
        "cursor-agent" => {
            let mut v = vec![];
            // Actual install home of the official Windows installer
            // (`irm cursor.com/install?win32=true | iex`), verified on this machine 2026-07-02:
            // a .cmd shim in %LOCALAPPDATA%\cursor-agent (also added to the MACHINE PATH).
            if let Ok(p) = std::env::var("LOCALAPPDATA") {
                v.push(format!(r"{p}\cursor-agent\cursor-agent.cmd"));
            }
            if let Ok(p) = std::env::var("USERPROFILE") {
                v.push(format!(r"{p}\.local\bin\cursor-agent.exe"));
                v.push(format!(r"{p}\.local\bin\cursor-agent.cmd"));
                v.push(format!(r"{p}\.local\bin\cursor-agent"));
            }
            if let Ok(p) = std::env::var("APPDATA") {
                v.push(format!(r"{p}\npm\cursor-agent.cmd"));
            }
            v
        }
        _ => vec![],
    };
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    // A FIXED ALLOWLIST GOES STALE. cursor-agent self-updates and moves its shims into
    // `<home>ersions\<version>\`, so on 2026-09-16 Praxis reported "cursor-agent CLI not
    // installed" for a CLI that was installed AND logged in - Quill said "unavailable" on
    // the board every morning because of a path we had hardcoded months earlier.
    //
    // So: look inside a versions/ directory, then fall back to PATH. Both are cheap and
    // both survive the next relocation without a code change.
    #[cfg(windows)]
    {
        if name == "cursor-agent" {
            if let Ok(home) = std::env::var("LOCALAPPDATA") {
                let versions = std::path::Path::new(&home).join("cursor-agent").join("versions");
                if let Ok(entries) = std::fs::read_dir(&versions) {
                    // Newest version directory wins (names sort lexically by date).
                    let mut dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
                    dirs.sort();
                    for dir in dirs.iter().rev() {
                        // Skip `dist-package` - a mid-flight self-update (see npm_shim_target).
                        if !version_dir_name(dir) {
                            continue;
                        }
                        for leaf in ["cursor-agent.exe", "cursor-agent.cmd"] {
                            let cand = dir.join(leaf);
                            if cand.exists() {
                                return cand.to_string_lossy().to_string();
                            }
                        }
                    }
                }
            }
        }
        // PATH fallback: `where` resolves exactly what a shell would run.
        let mut probe = std::process::Command::new("where");
        probe.arg(name);
        {
            use std::os::windows::process::CommandExt;
            probe.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Ok(out) = probe.output() {
            if out.status.success() {
                if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let hit = first.trim();
                    if !hit.is_empty() && std::path::Path::new(hit).exists() {
                        return hit.to_string();
                    }
                }
            }
        }
    }
    name.to_string()
}

/// Is the REAL Hermes brain reachable - i.e. does the `hermes` CLI exist? Praxis's planning
/// brain runs as `hermes -z <goal>` ONESHOT (see `hermes_brain` / project memory
/// "praxis-hermes-cli-oneshot-architecture"), NOT through the :9119 gateway. So the ONLY thing
/// that makes the brain genuinely "down" is a missing CLI - a gateway that isn't listening is
/// the EXPECTED steady state (the gateway sidecar only powers the bonus WS event feed) and must
/// never, on its own, raise the user-facing "Hermes degraded" banner.
///
/// `resolve_bin("hermes")` returns an absolute path when it finds the venv install, or the bare
/// name `"hermes"` as a PATH-lookup fallback. We treat an absolute resolved path that exists as
/// "present"; if it fell back to the bare name we can't cheaply prove PATH resolution here, so we
/// optimistically assume present (a real spawn failure still surfaces as a `hermes_brain` error
/// to the caller - this probe is only for the banner, and false-degrading is the bug we're fixing).
pub(crate) fn hermes_cli_available() -> bool {
    let resolved = resolve_bin("hermes");
    if resolved == "hermes" {
        // Fell back to bare name → rely on PATH at spawn time; don't false-degrade the banner.
        return true;
    }
    std::path::Path::new(&resolved).exists()
}

/// Apply `resolve_bin` to a sync `std::process::Command`, wrapping `.cmd` shims in `cmd /C`.
/// Returns the configured command ready for `.spawn()`. Always sets CREATE_NO_WINDOW on
/// Windows - every caller here launches a console-subsystem CLI (hermes, cmd shims), and
/// none of them should ever flash a terminal window.
fn make_cmd(name: &str) -> Command {
    let resolved = resolve_bin(name);
    let mut c = if resolved.ends_with(".cmd") {
        let mut c = Command::new("cmd");
        c.args(["/C", &resolved]);
        c
    } else {
        Command::new(&resolved)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Apply `resolve_bin` to a `tokio::process::Command`, wrapping `.cmd` shims in `cmd /C`.
/// Same CREATE_NO_WINDOW treatment as `make_cmd` - no console flash on Windows.
///
/// `pub(crate)` so `flow_runner.rs` builds lane subprocesses through the SAME
/// resolver + `.cmd`-shim + CREATE_NO_WINDOW machinery instead of duplicating the
/// CLI-path logic (which drifts: cursor-agent moved install dirs twice in 2026).
/// The `node <script>` a npm-installed `.cmd` shim actually runs, if we can read it.
///
/// npm's Windows shims end with a line like:
///   "%_prog%"  "%dp0%" + node_modules/<pkg>/bin/<tool>.js  %*
/// Resolving that lets us spawn node DIRECTLY and skip cmd.exe, which is the whole point
/// (see `make_async_cmd`). Returns None for any shim we don't recognise, so the caller
/// falls back to the old behaviour rather than guessing.
#[cfg(windows)]
fn npm_shim_target(shim: &str) -> Option<(String, String)> {
    let body = std::fs::read_to_string(shim).ok()?;
    let dir = std::path::Path::new(shim).parent()?.to_string_lossy().to_string();
    // Take the last quoted path ending in .js that sits under node_modules.
    let mut best: Option<String> = None;
    for line in body.lines() {
        for piece in line.split('"') {
            if piece.ends_with(".js") && piece.contains("node_modules") {
                best = Some(piece.replace("%dp0%", &dir).replace("\\\\", "\\"));
            }
        }
    }
    if let Some(script) = best {
        if std::path::Path::new(&script).exists() {
            return Some(("node".to_string(), script));
        }
    }

    // SECOND SHIM SHAPE: a self-updating CLI that ships its own node.
    //
    // cursor-agent's `.cmd` is not an npm shim - it launches PowerShell, which then runs
    // node.exe with index.js from its newest versions/ directory. Left unparsed it would
    // fall back to `cmd /C` and be truncated exactly like Codex was, so Cursor would still be
    // broken for every multi-line prompt even once the CLI is installed. Resolving the
    // versioned entry point directly also means a self-update (which relocates these
    // files, and did on 2026-09-16) needs no code change.
    let home = std::path::Path::new(shim).parent()?;
    let versions = home.join("versions");
    let mut dirs: Vec<_> = std::fs::read_dir(&versions).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    for dir in dirs.iter().rev() {
        // ONLY a released version directory (`2026.09.10-fd3934a`). The installer extracts into
        // `dist-package` and renames it at the very end, so that name means an update is
        // MID-FLIGHT or failed - and it sorts AFTER every real version, so a plain newest-first
        // scan picks exactly the broken one.
        if !version_dir_name(dir) {
            continue;
        }
        let node = dir.join("node.exe");
        let entry = dir.join("index.js");
        // node_modules must be present too: the zip extracts progressively, so node.exe and
        // index.js can both exist while the dependency tree is still landing.
        if node.exists() && entry.exists() && dir.join("node_modules").is_dir() {
            return Some((
                node.to_string_lossy().to_string(),
                entry.to_string_lossy().to_string(),
            ));
        }
    }
    None
}

/// True for a released-version directory name like `2026.09.10-fd3934a` - i.e. starts with
/// `YYYY.MM.DD`. Anything else (`dist-package`, a stray zip, a temp dir) is not a release.
#[cfg(windows)]
fn version_dir_name(dir: &std::path::Path) -> bool {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let mut parts = name.split('.');
    let (Some(y), Some(m), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    y.len() == 4
        && y.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit())
        && rest.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// How to actually launch `bin` without cmd.exe eating multi-line arguments.
///
/// Returns `(program, leading_args)`. ONE definition, because this logic was duplicated:
/// `make_async_cmd` here and `fd_spawn_session` in flightdeck.rs each had their own
/// `cmd /C` branch, so fixing one left Codex and Cursor SESSION SPAWNING still broken -
/// a spawned Codex lane wrote "Not inside a trusted directory and --skip-git-repo-check
/// was not specified" into its log while the code plainly passes that flag. Anything that
/// launches one of our CLIs must go through here.
#[cfg(windows)]
pub(crate) fn spawn_target(bin: &str) -> (String, Vec<String>) {
    if bin.ends_with(".cmd") || bin.ends_with(".bat") {
        if let Some((prog, script)) = npm_shim_target(bin) {
            return (prog, vec![script]);
        }
        crate::elog!(
            "[cli] unparseable shim {bin} - falling back to `cmd /C`, which TRUNCATES              multi-line arguments at the first newline"
        );
        return ("cmd".to_string(), vec!["/C".to_string(), bin.to_string()]);
    }
    (bin.to_string(), Vec::new())
}

#[cfg(not(windows))]
pub(crate) fn spawn_target(bin: &str) -> (String, Vec<String>) {
    (bin.to_string(), Vec::new())
}

/// Build a command for one of our CLIs.
///
/// WINDOWS `.cmd` SHIMS SILENTLY EAT MULTI-LINE ARGUMENTS.
///
/// This used to route every `.cmd` through `cmd /C`, and cmd.exe terminates the command
/// line at the first raw newline. Our prompts are multi-line (a persona preamble, a blank
/// line, the task) and the prompt is argument #2 - so everything after the first line was
/// DISCARDED, including every flag that comes after it. Reproduced on this machine
/// 2026-09-16:
///
///   single-line -> exec "…statement now." --json --skip-git-repo-check   (exit 0)
///   multi-line  -> exec "You are Vega, a named agent.                    (exit 0)
///
/// cmd reports success either way. That one defect explains the daily board meeting
/// telling the owner `Vega: unavailable (Codex refused the working folder as untrusted - it
/// needs --skip-git-repo-check)` - a flag `run_codex` already passes and that never
/// arrived - and it is why Codex and Cursor sessions could never really spawn. Claude was
/// the only agent that worked, purely because `claude.exe` is a real exe and never went
/// through cmd.exe at all.
///
/// So: resolve the real `node <script>` behind an npm shim and spawn it directly, where
/// Rust passes argv as an array and newlines are just bytes. `cmd /C` remains only as a
/// last resort for shims we cannot parse.
pub(crate) fn make_async_cmd(name: &str) -> tokio::process::Command {
    let resolved = resolve_bin(name);
    let (prog, lead) = spawn_target(&resolved);
    let mut c = tokio::process::Command::new(prog);
    for a in lead {
        c.arg(a);
    }
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

// ── Agents run as clean WORKERS, not as copies of the owner's own setup ──────────────
//
// WHY (measured 2026-09-17). Quill "capped out" at 30 minutes in runs 3, 4 and 5. It was
// not the model and not approval prompts. `cursor-agent` loads Claude Code's plugins and
// hooks from `$HOME/.claude` and Codex's MCP servers from `~/.codex` (hard-wired on in the
// CLI - Cursor's IDE has a toggle, the CLI does not). So every Quill tool call ran the owner's
// ECC `observe.sh` hook through bash, and started six MCP servers per run. On the same
// scoped polish task, identical prompt, same machine:
//
//   cursor-agent with the owner's config   composer-2.5          hung > 20 min (one edit = 119 s)
//                                     grok-4.6-low          636 s, 12 tool calls, 53 s each
//   cursor-agent as a clean worker    composer-2.5          195 s, 22 tool calls,  9 s each
//                                     grok-4.6-medium       305 s
//                                     grok-4.6-high         373 s
//
// Vega and Forge carry the same weight, just less visibly: a one-word `codex exec` took
//
// Workers get the brief Praxis writes for them - the goal, the workspace, the memory - not
// The owner's personal operating instructions, hooks, skills or MCP fleet.
//
// Scope: Praxis's own delegations and background lanes. Sessions the owner spawns by hand
// from the Flight Deck keep his full setup.

/// The home directory Quill's cursor-agent runs in: a Cursor config copy and nothing
/// else. `None` only if %LOCALAPPDATA% is unreadable (then the CLI runs as before).
fn cursor_worker_home() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let profile = std::env::var("USERPROFILE").ok()?;
    let home = std::path::PathBuf::from(local).join("Praxis").join("agent-home");
    let cfg = home.join(".cursor");
    std::fs::create_dir_all(&cfg).ok()?;
    let real = std::path::PathBuf::from(profile).join(".cursor");
    // The CLI's own settings (approval mode, permissions, sandbox, default model) come
    // along; refreshed whenever the owner's copy is newer. Nothing from ~/.claude or ~/.codex.
    for f in ["cli-config.json", "permissions.json", "sandbox.json", "agent-cli-state.json"] {
        let (src, dst) = (real.join(f), cfg.join(f));
        let newer = match (std::fs::metadata(&src).and_then(|m| m.modified()), std::fs::metadata(&dst).and_then(|m| m.modified())) {
            (Ok(s), Ok(d)) => s > d,
            (Ok(_), Err(_)) => true,
            _ => false,
        };
        if newer {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    Some(home)
}

/// Apply worker isolation to an agent CLI command (see the block comment above).
pub(crate) fn isolate_worker(tool: &str, cmd: &mut tokio::process::Command) {
    match tool {
        "claude" => {
            // No CLAUDE.md, skills, plugins, hooks or MCP; auth, model, tools and
            // permissions work normally (claude --help, 2026-09-17).
            cmd.arg("--safe-mode");
        }
        "codex" => {
            // Skip ~/.codex/config.toml (MCP servers, hooks, notify); auth still uses
            // CODEX_HOME. Keep the reasoning effort the owner configured there.
            cmd.arg("--ignore-user-config").arg("-c").arg("model_reasoning_effort=high");
        }
        "cursor" => {
            let Some(home) = cursor_worker_home() else { return };
            cmd.env("HOME", &home)
                .env("USERPROFILE", &home)
                // Config (settings, chat store) from the clean copy; DATA (agent
                // transcripts) stays in the real ~/.cursor so the Flight Deck still sees
                // Quill's runs (flightdeck.rs reads ~/.cursor/projects).
                .env("CURSOR_CONFIG_DIR", home.join(".cursor"));
            if let Ok(profile) = std::env::var("USERPROFILE") {
                let real = std::path::PathBuf::from(&profile);
                cmd.env("CURSOR_DATA_DIR", real.join(".cursor"));
                let gitconfig = real.join(".gitconfig");
                if gitconfig.exists() {
                    cmd.env("GIT_CONFIG_GLOBAL", gitconfig);
                }
            }
        }
        _ => {}
    }
}

/// The owner's rules files reach workers by paths no flag closes: cursor-agent loads every
/// `.cursor/rules` and AGENTS.md from the workspace up to the drive root, so any build
/// under `C:\Users\dev` inherits his alwaysApply operating brief, and Codex reads its
/// global AGENTS.md even with `--ignore-user-config`. Live 2026-09-17 a clean-home Quill
/// step still ended "## Read-Me … Anything else to add?". That brief is written for the
/// session THE OWNER opens; say plainly that this one is Praxis's worker, so the brief's own
/// rule excludes it - without editing the owner's configuration.
pub(crate) const WORKER_NOTE: &str = "[Praxis worker session] Praxis, Zach's orchestrator app, started this session to do one step of a job it is running. You are a worker, not the orchestrator: operating briefs or rules written for the session Zach opens himself (orchestrating, delegating, updating ORCHESTRATION-BOARD.md, writing a Read-Me section, asking \"anything else to add?\") do not apply here. Do only the task below, inside its folder. Finish the whole of it yourself — make reasonable calls instead of asking; ask nothing unless it is truly impossible without Zach (a password, a payment, a choice only he can make), and then say exactly what is blocked. Praxis checks your work, so report back SHORT: at most five lines — what you changed, and anything genuinely left undone. No long reports or verification essays.";

pub(crate) fn worker_prompt(prompt: &str) -> String {
    if prompt.starts_with("[Praxis worker session]") {
        return prompt.to_string();
    }
    format!("{WORKER_NOTE}\n\n{prompt}")
}

/// Cursor models Quill may run. `-fast` variants cost 2-6x per token.
pub(crate) const QUILL_DEFAULT_MODEL: &str = "grok-4.7-high";

pub(crate) fn quill_model_allowed(model: &str) -> bool {
    matches!(
        model,
        "composer-2.5"
            | "cursor-grok-4.6-low"
            | "cursor-grok-4.6-medium"
            | "cursor-grok-4.6-high"
            | "cursor-grok-4.6-xhigh"
            | "grok-4.7-low"
            | "grok-4.7-medium"
            | "grok-4.7-high"
            | "grok-4.7-xhigh"
    )
}

/// The model Quill actually runs: the requested one when it is on the Cursor Models pool,
/// otherwise Grok 4.7 (never the CLI default, which could be `auto`).
pub(crate) fn quill_model(requested: Option<&str>) -> String {
    match requested.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) if quill_model_allowed(m) => m.to_string(),
        Some(m) => {
            crate::elog!("[hermes] Quill model {m:?} bills Cursor's API pool or is unknown; running {QUILL_DEFAULT_MODEL} instead");
            QUILL_DEFAULT_MODEL.to_string()
        }
        None => QUILL_DEFAULT_MODEL.to_string(),
    }
}

// ── Sidecar PID (mirrors quartz_sidecar::PID exactly) ───────────────────────

static PID: Mutex<Option<u32>> = Mutex::new(None);

// ── Constants ────────────────────────────────────────────────────────────────

const HERMES_PORT: u16 = 9119;
const HERMES_HOST: &str = "127.0.0.1";
const HERMES_STATUS_URL: &str = "http://127.0.0.1:9119/api/status";
const HERMES_EVENTS_URL: &str = "ws://127.0.0.1:9119/api/events?channel=praxis";

/// Vault file that holds `OPENROUTER_API_KEY=<value>` (one key per line, `#` comments ok).
const SECRETS_PATH: &str = r"C:\Users\dev\.praxis\praxis-secrets.env";

/// How long we wait for the dashboard to become reachable before giving up on this launch.
/// The Hermes Python gateway runs tool-registry checks on startup that take ~60-90 s on Windows;
/// the TUI parent's own gateway.ready timeout (HERMES_TUI_STARTUP_TIMEOUT_MS) is set to 150 s
/// below - this value must be at least as large so Praxis doesn't give up first.
const READY_TIMEOUT_SECS: u64 = 150;

/// WS reconnect backoff: start at 1s, double each time, cap at 30s.
const WS_BACKOFF_START_MS: u64 = 1_000;
const WS_BACKOFF_MAX_MS: u64 = 30_000;

/// How long an HTTP health-probe GET may take before we call it stalled. Short on purpose: a
/// live gateway answers /api/status in milliseconds - this is only long enough to absorb a
/// slow-loopback hiccup, not a genuinely wedged asyncio loop (found live: port LISTENING but
/// the loop stalled, so both HTTP and WS hung forever with no signal - this timeout is the fix).
const HTTP_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// WS handshake timeout - bounds how long `tungstenite::connect` may block completing the
/// upgrade handshake. Without this, a port that's LISTENING-but-stalled (accepts the TCP
/// connection, never completes the HTTP Upgrade) hangs the observer thread indefinitely.
const WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Consecutive failed HTTP health probes (with the port still listening) before the watchdog
/// concludes the asyncio loop is stalled and kills + respawns the dashboard sidecar.
const WATCHDOG_FAILS_BEFORE_RESPAWN: u32 = 3;
/// Backoff between watchdog respawn attempts, so a persistently broken Hermes install doesn't
/// spin-loop killing/relaunching every probe interval.
const WATCHDOG_RESPAWN_BACKOFF: Duration = Duration::from_secs(30);
/// How long :9119 may stay CLOSED after a spawn before the watchdog concludes the gateway hung
/// at startup and kills + respawns it. Must COMFORTABLY exceed the legitimate slow boot
/// (~60-90s of tool-registry checks, TUI gateway.ready timeout 150s) plus the probe loop's
/// up-to-30s backoff granularity - 180s left only ~30s of margin, which risks tree-killing an
/// honest cold-disk/AV-slowed boot in a permanent kill/respawn loop. Found live 2026-07-02:
/// a gateway can hang at spawn with NO port and NO log line, which the stall watchdog
/// (port-open-but-unresponsive) never sees.
const SPAWN_HANG_TIMEOUT: Duration = Duration::from_secs(300);

/// `hermes_brain` subprocess timeout - a planning call returns a JSON plan quickly.
const BRAIN_TIMEOUT_SECS: u64 = 120;

/// `agent_delegate` subprocess timeout - a real `claude -p` / `codex exec` delegation
/// does substantial agent work (edits, builds, multi-step reasoning) that routinely runs
/// for minutes, so it gets a much larger window than the planning brain.
const DELEGATE_TIMEOUT_SECS: u64 = 1_800;

/// Default model for the explicitly metered OpenRouter rail. This is not a free
/// fallback: callers must select `openrouter`, and usage is recorded against that
/// provider. NVIDIA uses its own free-development rail below.
const DEFAULT_BRAIN_MODEL: &str = "moonshotai/kimi-k3";
const DEFAULT_OPENAI_BRAIN_MODEL: &str = "gpt-6-astra";
/// Model passed with `--provider openai-codex`. Hermes requires --model whenever
/// --provider is given (verified 2026-09-15), and this is the model Codex CLI itself uses.
const CODEX_BRAIN_MODEL: &str = "gpt-6-astra";

const DEFAULT_NVIDIA_BRAIN_MODEL: &str = "nvidia/nemotron-3.5-lightning-30b-a3b";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

/// Keep provider selection fail-closed. Before this parser, every provider except
/// `openai-codex` was silently routed to the paid OpenAI API branch; selecting
/// Claude, NVIDIA, or OpenRouter therefore produced an untruthful meter and an
/// unexpected bill. Provider names cross the Tauri boundary, so accept only the
/// rails Praxis intentionally exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrainProvider {
    OpenAiApi,
    OpenAiCodex,
    ClaudeCli,
    OpenRouter,
    Nvidia,
}

const DEFAULT_BRAIN_PROVIDER: &str = "openai-codex";

fn parse_brain_provider(raw: &str) -> Result<BrainProvider, String> {
    match raw {
        "openai-api" => Ok(BrainProvider::OpenAiApi),
        "openai-codex" => Ok(BrainProvider::OpenAiCodex),
        "claude-max" => Ok(BrainProvider::ClaudeCli),
        "openrouter" => Ok(BrainProvider::OpenRouter),
        "nvidia" => Ok(BrainProvider::Nvidia),
        other => Err(format!(
            "unsupported brain provider {other:?}; choose openai-api, openai-codex, claude-max, openrouter, or nvidia"
        )),
    }
}

#[cfg(test)]
mod brain_provider_tests {
    use super::{parse_brain_provider, BrainProvider, DEFAULT_BRAIN_PROVIDER};

    #[test]
    fn accepts_every_explicit_provider_rail() {
        assert_eq!(
            parse_brain_provider("openai-api"),
            Ok(BrainProvider::OpenAiApi)
        );
        assert_eq!(
            parse_brain_provider("openai-codex"),
            Ok(BrainProvider::OpenAiCodex)
        );
        assert_eq!(
            parse_brain_provider("claude-max"),
            Ok(BrainProvider::ClaudeCli)
        );
        assert_eq!(
            parse_brain_provider("openrouter"),
            Ok(BrainProvider::OpenRouter)
        );
        assert_eq!(parse_brain_provider("nvidia"), Ok(BrainProvider::Nvidia));
    }

    #[test]
    fn omitted_provider_default_is_subscription_backed() {
        assert_eq!(DEFAULT_BRAIN_PROVIDER, "openai-codex");
        assert_eq!(
            parse_brain_provider(DEFAULT_BRAIN_PROVIDER),
            Ok(BrainProvider::OpenAiCodex)
        );
    }

    #[test]
    fn rejects_unknown_provider_instead_of_rerouting_it() {
        let err = parse_brain_provider("unmetered-mystery")
            .expect_err("unknown provider must fail closed");
        assert!(err.contains("unsupported brain provider"));
    }
}

/// `brain_chat` HTTP client timeout. OpenRouter load-balances `z-ai/glm-5.3` across many
/// backend providers (Friendli, Z.AI, Novita, Baidu, AtlasCloud, Inceptron, ...) with very
/// uneven latency, and GLM 5.2 is a reasoning model that spends time on a hidden reasoning
/// pass before it emits visible content. Live testing (2026-07-02) measured completions
/// from ~0.5s to ~16s across identical requests, with occasional slower outliers - a 30s
/// timeout was clipping a real fraction of otherwise-successful replies. 60s gives headroom
/// without hanging the chat UI indefinitely.
const BRAIN_CHAT_TIMEOUT_SECS: u64 = 60;

// ── The Tauri-event payload (frontend contract - MUST NOT change field names) ─

/// Payload emitted as `praxis://hermes-event` for every Hermes WS frame.
/// Field names are snake_case (serde default) - the frontend reads them as-is.
#[derive(Clone, serde::Serialize)]
pub struct HermesEvent {
    /// `params.type` from the JSON-RPC frame (e.g. `"message.delta"`, `"tool.start"`,
    /// `"subagent.start"`, `"status.update"`, `"gateway.ready"`, `"error"` …).
    pub kind: String,
    /// `params.session_id` - which Hermes session produced this event.
    pub session_id: String,
    /// Best-effort text payload: pulled from `payload.text`, `payload.message`,
    /// `payload.result`, `payload.summary`, or `payload.kind` depending on `kind`.
    pub text: Option<String>,
    /// Populated for `tool.*` events: `payload.name`.
    pub tool_name: Option<String>,
    /// Model name if the frame carries one (`payload.model`).
    pub model: Option<String>,
    /// Populated for `subagent.*` events: `payload.subagent_id`.
    pub subagent_id: Option<String>,
    /// Populated for `subagent.*` events: `payload.parent_id`.
    pub parent_id: Option<String>,
    /// Populated for `subagent.*` events: `payload.depth` (delegation depth, 0 = root).
    pub depth: Option<u32>,
}

// ── Vault key reader ─────────────────────────────────────────────────────────

/// Read `KEY=value` from the vault `.env` file. Returns `None` if the file is
/// missing or the key isn't present. Never panics.
///
/// `pub(crate)` so other modules (e.g. `qa_eyes`) resolve the OpenRouter key through
/// the EXACT same vault scheme instead of duplicating a second reader.
pub(crate) fn read_vault_key(key: &str) -> Option<String> {
    let content = std::fs::read_to_string(SECRETS_PATH).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(val) = rest.strip_prefix('=') {
                let v = val.trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

// ── Sidecar helpers (mirrors quartz_sidecar exactly) ─────────────────────────

/// Is the Hermes dashboard actually reachable - not just TCP-open, but answering HTTP?
///
/// Live finding: the :9119 sidecar's port was LISTENING but its asyncio loop was stalled, so
/// BOTH `/api/status` and the WS upgrade hung forever with zero signal to the rest of the app.
/// A bare TCP connect (the old `is_up()`) can't detect that - it only proves the OS accepted the
/// connection, not that anything on the other end is alive. This does a real GET with a short
/// timeout so a stalled loop reads as DOWN, not UP.
pub(crate) fn openai_response_text(v: &Value) -> Option<String> {
    if let Some(s) = v.get("output_text").and_then(|x| x.as_str()) {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = v.get("output").and_then(|x| x.as_array()) {
        for item in items {
            if let Some(content) = item.get("content").and_then(|x| x.as_array()) {
                for part in content {
                    if let Some(text) = part.get("text").and_then(|x| x.as_str()) {
                        let text = text.trim();
                        if !text.is_empty() {
                            parts.push(text.to_string());
                        }
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub(crate) fn openai_usage_tokens(v: &Value) -> (u64, u64) {
    let Some(usage) = v.get("usage") else {
        return (0, 0);
    };
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    (input, output)
}

/// USD per 1M tokens, standard tier / short context.
/// Checked against OpenAI's published pricing 2026-09-15. Two things were wrong before:
///
/// EXISTS BECAUSE IT DIED TWICE, SILENTLY. `z-ai/glm-5.1` reached end-of-life
/// 2026-07-02; `meta/llama-3.3-70b-instruct` on 2026-08-26 and was found THREE WEEKS
/// LATER, on 2026-09-15, only because someone happened to exercise the no-credit
/// reroute. That id was also `SAFE_FALLBACK` in brain.ts, so every breaker-cut reroute
/// in the app had been landing on an HTTP 410 the whole time, with nothing anywhere
/// saying so. A dead free rail should be a same-day notice, not an archaeology find.
///
/// Returns `Ok(model)` when NIM serves it, `Err(reason)` when it does not. Cheap: one
/// GET of `/v1/models`, no completion, no tokens. Callers decide what to do with it -
/// this function never disables anything on its own.
pub async fn nvidia_rail_health() -> Result<String, String> {
    let model = DEFAULT_NVIDIA_BRAIN_MODEL.to_string();
    let Some(key) = read_vault_key("NVIDIA_API_KEY") else {
        return Err("no NVIDIA_API_KEY in the vault".to_string());
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("nvidia health client: {e}"))?;
    let resp = client
        .get("https://integrate.api.nvidia.com/v1/models")
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|e| format!("NIM model list unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("NIM model list returned HTTP {}", resp.status().as_u16()));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("NIM model list was not JSON: {e}"))?;
    let listed = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|x| x.as_str()))
                .any(|id| id == model)
        })
        .unwrap_or(false);
    if listed {
        Ok(model)
    } else {
        // "Listed" is not "entitled" (several NIM ids 404 per-account), but NOT listed
        // is unambiguous: the id is gone.
        Err(format!(
            "the free NVIDIA rail's model {model:?} is NO LONGER LISTED by NIM - it has              probably reached end-of-life. Pick a live id from /v1/models and update              DEFAULT_NVIDIA_BRAIN_MODEL plus SAFE_FALLBACK in src/orchestrator/brain.ts."
        ))
    }
}

const NVIDIA_HEALTH_ATTEMPTS: usize = 4;

fn nvidia_health_retryable(reason: &str) -> bool {
    reason.starts_with("NIM model list unreachable:")
}

/// Startup check: log loudly if the free rail is dead. Never blocks boot, never disables
/// anything - it exists so the failure is VISIBLE on the day it happens. Boot networking
/// can lag behind the desktop process, so transport failures get a short bounded retry;
/// definitive failures (credentials, HTTP status, or a delisted model) remain immediate.
pub fn spawn_nvidia_rail_health_check() {
    tauri::async_runtime::spawn(async {
        for attempt in 0..NVIDIA_HEALTH_ATTEMPTS {
            match nvidia_rail_health().await {
                Ok(model) => {
                    crate::dlog!("[rails] free NVIDIA rail OK ({model})");
                    return;
                }
                Err(reason)
                    if nvidia_health_retryable(&reason)
                        && attempt + 1 < NVIDIA_HEALTH_ATTEMPTS =>
                {
                    let delay = 5_u64 << attempt;
                    crate::dlog!(
                        "[rails] NVIDIA health transport unavailable at boot; retrying in {delay}s ({}/{})",
                        attempt + 1,
                        NVIDIA_HEALTH_ATTEMPTS
                    );
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                }
                Err(reason) => {
                    crate::elog!("[rails] *** FREE NVIDIA RAIL IS DOWN *** {reason}");
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod nvidia_health_tests {
    use super::*;

    #[test]
    fn only_transport_failures_are_retried_at_boot() {
        assert!(nvidia_health_retryable(
            "NIM model list unreachable: connection reset"
        ));
        assert!(!nvidia_health_retryable("no NVIDIA_API_KEY in the vault"));
        assert!(!nvidia_health_retryable("NIM model list HTTP 401"));
        assert!(!nvidia_health_retryable(
            "the free NVIDIA rail's model is NO LONGER LISTED by NIM"
        ));
        assert!(NVIDIA_HEALTH_ATTEMPTS >= 3);
    }
}

pub(crate) fn openai_price_per_m(model: &str) -> Option<(f64, f64)> {
    let m = model.to_ascii_lowercase();
    if m.starts_with("gpt-6-astra") {
        Some((10.00, 50.00))
    } else if m.starts_with("gpt-5.6-sol") {
        Some((4.00, 20.00))
    } else if m.starts_with("gpt-5.6-terra") {
        Some((2.50, 15.00))
    } else if m.starts_with("gpt-5.6-luna") {
        Some((1.00, 6.00))
    } else {
        None
    }
}

pub(crate) fn openai_cost_usd(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let (input_per_m, output_per_m) = match openai_price_per_m(model) {
        Some(p) => p,
        None => {
            crate::elog!(
                "[usage] no published price for OpenAI model {model:?} - recording $0.00;                  the ledger will UNDERCOUNT until a rate is added to openai_price_per_m"
            );
            (0.0, 0.0)
        }
    };
    (input_tokens as f64 / 1_000_000.0) * input_per_m
        + (output_tokens as f64 / 1_000_000.0) * output_per_m
}

async fn openai_responses_call(
    message: String,
    context: Option<String>,
    model: Option<String>,
    max_output_tokens: u64,
) -> Result<String, String> {
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OPENAI_BRAIN_MODEL.to_string());
    let api_key =
        read_vault_key("OPENAI_API_KEY").ok_or_else(|| "no OPENAI_API_KEY in vault".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(BRAIN_CHAT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("openai responses reqwest build: {e}"))?;
    let instructions = format!(
        "You are Praxis, Zach's personal AI operating system. Be concise, direct, and useful. \
         Use the provided context when present.{}",
        context
            .as_deref()
            .map(|c| format!(" Live context: {c}"))
            .unwrap_or_default()
    );
    let body = serde_json::json!({
        "model": model,
        "instructions": instructions,
        "input": message,
        "max_output_tokens": max_output_tokens,
        "reasoning": { "effort": "low" }
    });
    let resp = client
        .post(OPENAI_RESPONSES_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("openai responses timed out after {BRAIN_CHAT_TIMEOUT_SECS}s waiting on {model}")
            } else if e.is_connect() {
                format!("openai responses could not connect: {e}")
            } else {
                format!("openai responses request failed: {e}")
            }
        })?;

    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("openai responses returned non-JSON (HTTP {status}): {e}"))?;
    if !status.is_success() {
        let snippet: String = v.to_string().chars().take(300).collect();
        // An empty wallet is OpenAI's own verdict on this key - the one credit fact an
        // API key can actually establish. Record it so the Command Center reports what
        // was measured instead of drawing a spend bar against an invented ceiling.
        // A plain rate-limit 429 is deliberately NOT recorded (see `is_credit_refusal`).
        if crate::openai_credit::is_credit_refusal(status.as_u16(), &snippet) {
            crate::openai_credit::record_openai_credit_refusal("brain");
        }
        return Err(format!("openai responses {model} HTTP {status}: {snippet}"));
    }
    // Paid call accepted: retire any recorded refusal. Success is proof.
    crate::openai_credit::clear_openai_credit_block();
    let (input, output) = openai_usage_tokens(&v);
    crate::usage::record_usage(
        "openai",
        &model,
        input,
        output,
        openai_cost_usd(&model, input, output),
    );
    openai_response_text(&v).ok_or_else(|| format!("openai responses {model} returned no text"))
}

pub fn is_up() -> bool {
    matches!(probe_health(), HealthProbe::Ok)
}

/// Outcome of an HTTP health probe against `/api/status`.
enum HealthProbe {
    /// TCP connect failed outright - the sidecar isn't running (or crashed).
    PortClosed,
    /// TCP connected but the HTTP round-trip didn't complete within `HTTP_PROBE_TIMEOUT` -
    /// the classic "port listening, event loop stalled" failure mode.
    Stalled,
    /// Got a full HTTP response.
    Ok,
}

/// GET `/api/status` over a raw TCP stream (same technique `check_status_for_token` already
/// used) with an explicit read timeout, so a stalled asyncio loop can't hang this call forever.
fn probe_health() -> HealthProbe {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect_timeout(
        &(
            HERMES_HOST.parse::<std::net::IpAddr>().unwrap(),
            HERMES_PORT,
        )
            .into(),
        Duration::from_millis(300),
    ) else {
        return HealthProbe::PortClosed;
    };
    if stream.set_read_timeout(Some(HTTP_PROBE_TIMEOUT)).is_err() {
        return HealthProbe::Stalled;
    }
    let req = format!("GET /api/status HTTP/1.0\r\nHost: {HERMES_HOST}:{HERMES_PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return HealthProbe::Stalled;
    }
    let mut buf = [0u8; 512];
    // A single read is enough to prove the server actually responded (we don't need the full
    // body here - read_to_string would block on a slow/half-open response past our timeout on
    // some platforms; one bounded read is sufficient to distinguish "answered" from "hung").
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => HealthProbe::Ok,
        _ => HealthProbe::Stalled,
    }
}

/// Start the Hermes dashboard if it isn't already running. Idempotent.
/// If `hermes` isn't on PATH, logs a warning and returns - never panics.
/// The session token Praxis gives the dashboard it spawns (`HERMES_DASHBOARD_SESSION_TOKEN`)
/// and presents on the event socket. Hermes 0.17 refuses `/api/events` without a matching
/// `?token=` (HTTP 403) - measured 2026-09-24: every reconnect for a full day was a 403 and
/// the feed never came up. Persisted beside Praxis's other state so a sidecar left running
/// by an earlier Praxis run still shares it. Loopback-only; never logged.
fn dashboard_token() -> String {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let path = crate::praxis_dir().map(|d| d.join("hermes-dashboard-token.txt"));
            if let Some(p) = &path {
                if let Ok(t) = std::fs::read_to_string(p) {
                    let t = t.trim().to_string();
                    if t.len() >= 32 && t.chars().all(|c| c.is_ascii_alphanumeric()) {
                        return t;
                    }
                }
            }
            let t = fresh_dashboard_token();
            if let Some(p) = &path {
                let _ = std::fs::write(p, &t);
            }
            t
        })
        .clone()
}

/// 64 hex chars from the OS-seeded std hasher (no extra crate for a loopback token).
fn fresh_dashboard_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    (0..4u64)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// Dashboards started with Praxis's own launch signature (`hermes dashboard --port 9119
/// --no-open`) that this run did not spawn - a sidecar orphaned by an earlier Praxis run.
/// Its token is unknown (the socket answers 403) and its PID was forgotten, so the stall
/// watchdog could never restart it: measured 2026-09-24, a day-old orphan stalled and
/// refused every connect. Anything started by hand (other arguments) is left alone.
#[cfg(windows)]
fn orphan_praxis_dashboards() -> Vec<u32> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*hermes*dashboard --port 9119 --no-open*' } | ForEach-Object { $_.ProcessId }";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let ours = *PID.lock().unwrap();
    cmd.output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .filter(|pid| Some(*pid) != ours)
                .collect()
        })
        .unwrap_or_default()
}
#[cfg(not(windows))]
fn orphan_praxis_dashboards() -> Vec<u32> {
    vec![]
}

/// Replace an orphaned Praxis sidecar with one that carries Praxis's token. Returns whether
/// anything was replaced.
fn replace_orphan_dashboard() -> bool {
    let pids = orphan_praxis_dashboards();
    if pids.is_empty() {
        return false;
    }
    for pid in &pids {
        let mut kill = Command::new("taskkill");
        kill.args(["/F", "/T", "/PID", &pid.to_string()]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x0800_0000);
        }
        let _ = kill.output();
    }
    let start = Instant::now();
    while is_up() && start.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(300));
    }
    crate::dlog!(
        "[hermes] replaced an orphaned dashboard sidecar ({} process(es)) with one Praxis owns",
        pids.len()
    );
    ensure_dashboard();
    wait_ready(Duration::from_secs(READY_TIMEOUT_SECS));
    true
}

pub fn ensure_dashboard() {
    if is_up() {
        return;
    }
    let mut guard = PID.lock().unwrap();
    if is_up() {
        return; // another caller won the race
    }

    // Inject OPENROUTER_API_KEY from the vault so the Hermes brain can call models.
    let api_key = read_vault_key("OPENROUTER_API_KEY");
    if api_key.is_none() {
        crate::elog!(
            "[hermes] OPENROUTER_API_KEY not found in vault — dashboard will start without it"
        );
    }

    let mut cmd = make_cmd("hermes");
    // `--no-open`: Praxis only talks to this sidecar over its HTTP/WS API
    // (`/api/status`, `/api/events`) as an invisible background engine - it must
    // never pop the Hermes web dashboard open in the owner's browser. Without this
    // flag `hermes dashboard` opens a browser tab to its own UI every time this
    // spawns (every Praxis launch where :9119 wasn't already up), which is the bug
    // this fixes. See `hermes dashboard --help` for the flag.
    cmd.args(dashboard_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The Hermes TUI parent waits for a `gateway.ready` signal from the Python gateway.
        // On Windows the gateway runs slow tool-registry checks (~60-90 s of warnings) before
        // binding :9119 and emitting ready.  The default timeout is only 15 s, so the parent
        // always exits before the gateway is ready - giving the tui_gateway_crash.log
        // "timed out waiting for gateway.ready" symptom.  150 s is well past the worst case.
        .env("HERMES_TUI_STARTUP_TIMEOUT_MS", "150000")
        .env("HERMES_DASHBOARD_SESSION_TOKEN", dashboard_token());
    if let Some(key) = &api_key {
        cmd.env("OPENROUTER_API_KEY", key);
    }

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            *guard = Some(pid);
            crate::dlog!("[hermes] dashboard started pid={pid}");
        }
        Err(e) => {
            // The dashboard powers only the optional event feed. CLI availability is
            // checked separately and owns the real brain-degraded error.
            crate::dlog!("[hermes] could not spawn optional dashboard event feed: {e} — observer will retry");
        }
    }
}

/// The checked-in Hermes install ships a prebuilt dashboard. Rebuilding that UI
/// for every invisible Praxis sidecar start can take longer than the watchdog
/// lease (and, when npm stalls, never bind the port at all). Use the shipped
/// asset just like Hermes' own documented `--skip-build` path; Hermes fails
/// closed with a clear exit if the dist is actually missing.
fn dashboard_args() -> Vec<String> {
    vec![
        "dashboard".to_string(),
        "--port".to_string(),
        HERMES_PORT.to_string(),
        "--no-open".to_string(),
        "--skip-build".to_string(),
    ]
}

/// Block until the dashboard is listening, or `timeout` elapses. Returns `true` if up.
fn wait_ready(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    is_up()
}

/// Tree-kill the dashboard on app exit (mirrors quartz_sidecar::stop).
pub fn stop() {
    if let Some(pid) = PID.lock().unwrap().take() {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let _ = cmd.spawn();
        crate::dlog!("[hermes] stopped pid={pid}");
    }
}

// ── WS observer thread ───────────────────────────────────────────────────────

/// Spawn the Hermes event observer on its own OS thread.
/// `running` is the shared BridgeShutdown flag - cleared on app exit so the loop stops cleanly.
pub fn spawn_observer(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || observe_loop(app, running));
}

/// Payload emitted as `praxis://hermes-degraded`.
///
/// IMPORTANT SEMANTICS: `degraded` reflects the health of the REAL planning brain - the
/// `hermes -z` ONESHOT CLI - NOT the :9119 gateway. Praxis's brain does not run through the
/// gateway (see `hermes_cli_available` and project memory "praxis-hermes-cli-oneshot-architecture");
/// the gateway sidecar only powers the OPTIONAL WS event feed. A gateway that isn't listening is
/// the EXPECTED steady state and therefore does NOT set `degraded` - doing so was the false
/// "Hermes degraded" banner this file previously showed every launch. We only degrade when the
/// CLI itself is missing (the brain genuinely can't run). The `reason` string is written to be
/// shown to the user AS-IS by the banner consumers (StatusRail / App / RightDock), so it must
/// read as a plain-English, honest sentence - not a developer-facing port/loop diagnostic.
#[derive(Clone, serde::Serialize)]
struct HermesDegraded {
    /// True only when the real brain (the `hermes` CLI) is unavailable; false whenever it's present
    /// (regardless of gateway/WS state, which is expected to be off under the oneshot architecture).
    degraded: bool,
    /// Human-readable, user-facing reason shown as-is in the banner. When degraded, this is the
    /// honest cause (e.g. "planning brain (Hermes) unreachable - voice unaffected"). Empty on recovery.
    reason: String,
}

/// The brain health as last evaluated, so a window can ASK instead of only listening.
///
/// `praxis://hermes-degraded` is emitted on state CHANGES only - correctly, since it
/// drives toasts - which means it fires about once per process. Every window that
/// subscribes after that moment (the Command Center always does; it is opened on
/// demand) never hears it, and its chip read "engine · checking…" for the life of
/// the app. The owner's screenshot showed exactly that on a long-running session.
static LAST_BRAIN_HEALTH: std::sync::Mutex<Option<(bool, String)>> = std::sync::Mutex::new(None);

/// Brain health right now. `hermes_cli_available` is a path lookup, not a process
/// spawn, so this is cheap enough to answer on demand.
fn brain_health_now() -> (bool, String) {
    if hermes_cli_available() {
        (false, String::new())
    } else {
        (true, "planning brain (Hermes) unreachable — voice unaffected".to_string())
    }
}

#[derive(Clone, serde::Serialize)]
pub struct HermesHealthState {
    pub degraded: bool,
    pub reason: String,
}

/// Pull-side twin of `praxis://hermes-degraded`. Always answers: the last observed
/// state if the observer has run, otherwise a fresh evaluation - never "unknown",
/// because the underlying check is instant.
#[tauri::command]
pub async fn hermes_health() -> HermesHealthState {
    let cached = LAST_BRAIN_HEALTH.lock().ok().and_then(|g| g.clone());
    let (degraded, reason) = cached.unwrap_or_else(brain_health_now);
    HermesHealthState { degraded, reason }
}

fn emit_degraded(app: &tauri::AppHandle, last: &mut Option<bool>, degraded: bool, reason: &str) {
    if let Ok(mut guard) = LAST_BRAIN_HEALTH.lock() {
        *guard = Some((degraded, reason.to_string()));
    }
    // Only emit on a state CHANGE - otherwise a stalled gateway would spam an event every
    // observer-loop iteration (fine for logs, not for a UI banner/toast).
    if *last == Some(degraded) {
        return;
    }
    *last = Some(degraded);
    if degraded {
        crate::elog!("[hermes] {}", format!("DEGRADED — {reason}"));
    } else {
        crate::dlog!("[hermes] {}", "recovered");
    }
    let _ = app.emit(
        "praxis://hermes-degraded",
        HermesDegraded {
            degraded,
            reason: reason.to_string(),
        },
    );
}

/// Main observer loop: ensure the dashboard is up, then subscribe and re-subscribe forever.
/// Uses `tungstenite` (the sync crate) directly so we don't need a separate tokio runtime here -
/// `tokio-tungstenite` is async and lives in the command handlers below.
///
/// Also owns the health watchdog: if the TCP port is listening but consecutive HTTP probes fail
/// (the "loop stalled" failure mode `is_up()`/`probe_health()` now detect), kill + respawn the
/// dashboard sidecar this app spawned, with backoff so a persistently broken install doesn't
/// spin-loop. Never touches a Hermes process this app did NOT spawn (PID is only ever set by
/// `ensure_dashboard()` - see `stop()`).
fn observe_loop(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    // Report the BRAIN's health first. It is a path lookup and it is the only thing
    // the user-facing chip reports - but it used to wait behind ensure_dashboard() and
    // wait_ready(150s), for a gateway that under the oneshot architecture is EXPECTED
    // to be off. So every window read "engine · checking…" for two and a half minutes
    // after every launch before a single health fact existed.
    let mut last_degraded: Option<bool> = None;
    {
        let (degraded, reason) = brain_health_now();
        emit_degraded(&app, &mut last_degraded, degraded, &reason);
    }

    // Make sure the dashboard is up before we try to connect.
    ensure_dashboard();
    if !wait_ready(Duration::from_secs(READY_TIMEOUT_SECS)) {
        crate::dlog!("[hermes] optional dashboard event feed not reachable after {READY_TIMEOUT_SECS}s — observer will keep retrying");
    }

    let mut backoff_ms = WS_BACKOFF_START_MS;
    let mut consecutive_stall_fails: u32 = 0;
    let mut last_respawn: Option<Instant> = None;
    let mut port_closed_since: Option<Instant> = None;
    let mut forbidden: u32 = 0;
    let mut tried_orphan_replace = false;

    while running.load(Ordering::Relaxed) {
        // The USER-FACING banner is driven ONLY by the real brain path: the `hermes -z` oneshot
        // CLI. Gateway/WS state below is a developer/log concern for the bonus event feed and must
        // NEVER by itself flip the banner (that was the false-degraded bug). So decide the banner
        // here, once per iteration, purely on CLI presence.
        if hermes_cli_available() {
            emit_degraded(&app, &mut last_degraded, false, "");
        } else {
            emit_degraded(
                &app,
                &mut last_degraded,
                true,
                "planning brain (Hermes) unreachable — voice unaffected",
            );
        }

        match probe_health() {
            HealthProbe::PortClosed => {
                consecutive_stall_fails = 0; // not a "stalled loop" - sidecar just isn't running
                                             // Gateway not listening is EXPECTED under the oneshot architecture - log only, do
                                             // NOT touch the banner (the CLI check above already set honest brain health).

                // Hung-spawn watchdog: a gateway can hang at startup WITHOUT ever binding the
                // port or logging (seen live 2026-07-02, hermes.exe alive 15+ min, :9119 dead).
                // The stall watchdog above only fires when the port is OPEN, so this branch
                // needs its own: once the port has been closed well past the slowest honest
                // boot, tree-kill our own child (if any) and try a fresh spawn, with the same
                // respawn backoff as the stall path.
                let closed_since = *port_closed_since.get_or_insert_with(Instant::now);
                let can_respawn = last_respawn
                    .map(|t| t.elapsed() >= WATCHDOG_RESPAWN_BACKOFF)
                    .unwrap_or(true);
                if closed_since.elapsed() >= SPAWN_HANG_TIMEOUT && can_respawn {
                    crate::dlog!(
                        "[hermes] watchdog: port closed for {}s (spawn likely hung) — killing + respawning dashboard sidecar",
                        closed_since.elapsed().as_secs()
                    );
                    stop();
                    last_respawn = Some(Instant::now());
                    port_closed_since = Some(Instant::now());
                    ensure_dashboard();
                }

                crate::dlog!("[hermes] optional dashboard event feed not reachable — retrying in {backoff_ms}ms");
                sleep_interruptible(&running, backoff_ms);
                backoff_ms = (backoff_ms * 2).min(WS_BACKOFF_MAX_MS);
                continue;
            }
            HealthProbe::Stalled => {
                port_closed_since = None;
                consecutive_stall_fails += 1;
                // Gateway stalled affects only the WS event feed, not the oneshot brain - log,
                // don't degrade the banner (the CLI check at the top owns honest brain health).
                crate::dlog!(
                    "[hermes] health probe stalled ({consecutive_stall_fails}/{WATCHDOG_FAILS_BEFORE_RESPAWN} consecutive) — port is listening but not answering"
                );

                let can_respawn = last_respawn
                    .map(|t| t.elapsed() >= WATCHDOG_RESPAWN_BACKOFF)
                    .unwrap_or(true);
                if consecutive_stall_fails >= WATCHDOG_FAILS_BEFORE_RESPAWN && can_respawn && PID.lock().unwrap().is_none() {
                    // Not ours to `stop()` (PID forgotten across a Praxis restart) - but if it
                    // carries Praxis's launch signature it is an orphaned sidecar: replace it.
                    last_respawn = Some(Instant::now());
                    consecutive_stall_fails = 0;
                    if replace_orphan_dashboard() {
                        crate::dlog!("[hermes] watchdog: stalled orphan sidecar replaced");
                    }
                } else if consecutive_stall_fails >= WATCHDOG_FAILS_BEFORE_RESPAWN && can_respawn {
                    // Watchdog: this app's OWN sidecar (PID only ever set by ensure_dashboard())
                    // is wedged - kill + respawn it rather than let the feed stay dead forever.
                    crate::dlog!("[hermes] watchdog: {WATCHDOG_FAILS_BEFORE_RESPAWN} consecutive stalls — killing + respawning dashboard sidecar");
                    stop();
                    last_respawn = Some(Instant::now());
                    consecutive_stall_fails = 0;
                    ensure_dashboard();
                    wait_ready(Duration::from_secs(READY_TIMEOUT_SECS));
                }

                sleep_interruptible(&running, backoff_ms);
                backoff_ms = (backoff_ms * 2).min(WS_BACKOFF_MAX_MS);
                continue;
            }
            HealthProbe::Ok => {
                consecutive_stall_fails = 0;
                port_closed_since = None;
            }
        }

        // Check token requirement via HTTP before opening the WS. Fails CLOSED now: any
        // ambiguous/unreachable result is treated as "can't confirm it's safe to proceed",
        // not silently waved through (the old `unwrap_or(false)` let a broken probe proceed
        // straight to the WS connect as if everything were fine).
        // These are GATEWAY/WS-feed gating decisions only. They govern whether we open the WS for
        // the bonus event feed - they do NOT touch the user-facing banner (the CLI check at the
        // top of the loop owns that). A gateway needing auth, or an inconclusive status, means "no
        // event feed right now", not "the brain is broken".
        match check_status_for_token() {
            TokenCheck::NotRequired => {}
            TokenCheck::Required => {
                crate::dlog!("[hermes] /api/status indicates auth token required but none available — optional WS event feed unavailable (brain unaffected)");
                sleep_interruptible(&running, WS_BACKOFF_MAX_MS);
                continue;
            }
            TokenCheck::Unreachable => {
                // We just passed probe_health() == Ok, so this is a transient/parse failure,
                // not a stall - but we still don't KNOW it's safe, so don't proceed blind.
                crate::dlog!("[hermes] /api/status check inconclusive — skipping optional WS connect this pass, retrying in {backoff_ms}ms (brain unaffected)");
                sleep_interruptible(&running, backoff_ms);
                backoff_ms = (backoff_ms * 2).min(WS_BACKOFF_MAX_MS);
                continue;
            }
        }

        crate::dlog!("[hermes] connecting to {HERMES_EVENTS_URL}");

        match connect_ws_with_timeout(WS_HANDSHAKE_TIMEOUT) {
            Ok(mut ws) => {
                crate::dlog!("[hermes] WS connected");
                forbidden = 0;
                backoff_ms = WS_BACKOFF_START_MS; // reset backoff on success
                                                  // WS feed is up (bonus). Banner health is owned by the CLI check at the top of the
                                                  // loop - not re-asserted here, since the WS being up says nothing about the brain.

                loop {
                    if !running.load(Ordering::Relaxed) {
                        let _ = ws.close(None);
                        return;
                    }

                    match ws.read() {
                        Ok(tungstenite::Message::Text(text)) => {
                            if let Some(ev) = parse_frame(&text) {
                                let _ = app.emit("praxis://hermes-event", ev);
                            }
                        }
                        Ok(tungstenite::Message::Ping(data)) => {
                            // Respond to pings so the server doesn't time us out.
                            let _ = ws.send(tungstenite::Message::Pong(data));
                        }
                        Ok(tungstenite::Message::Close(_)) => {
                            crate::dlog!("[hermes] WS closed by server — will reconnect");
                            break;
                        }
                        Ok(_) => {} // binary / pong / frame fragments - ignore
                        Err(e) => {
                            crate::dlog!("[hermes] optional WS event feed read error: {e} — will reconnect");
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                // WS handshake failure = no bonus event feed, NOT a broken brain.
                let msg = e.to_string();
                if msg.contains("403") {
                    forbidden += 1;
                    // Wrong token: the dashboard on :9119 was not started with Praxis's token.
                    // If it is Praxis's own orphaned sidecar, replace it once; otherwise stop
                    // hammering it - one line, then the long backoff.
                    if !tried_orphan_replace && PID.lock().unwrap().is_none() {
                        tried_orphan_replace = true;
                        if replace_orphan_dashboard() {
                            backoff_ms = WS_BACKOFF_START_MS;
                            continue;
                        }
                    }
                    if forbidden == 1 || forbidden % 20 == 0 {
                        crate::dlog!(
                            "[hermes] event feed refused (403, token mismatch) — the dashboard on :9119 wasn't started by this Praxis; retrying every {}s (brain unaffected)",
                            WS_BACKOFF_MAX_MS / 1000
                        );
                    }
                    backoff_ms = WS_BACKOFF_MAX_MS;
                } else {
                    forbidden = 0;
                    crate::dlog!("[hermes] optional WS event feed connect error: {msg} — retrying in {backoff_ms}ms (brain unaffected — oneshot doesn't use the gateway)");
                }
            }
        }

        sleep_interruptible(&running, backoff_ms);
        backoff_ms = (backoff_ms * 2).min(WS_BACKOFF_MAX_MS);
    }
}

/// Open the Hermes WS with a bounded handshake: build the TCP stream ourselves (with connect +
/// read timeouts) instead of `tungstenite::connect`'s default, which has NO handshake timeout -
/// a port that's listening-but-stalled (accepts the TCP connect, never completes the HTTP
/// Upgrade) would otherwise hang this thread forever with no reconnect and no signal.
fn connect_ws_with_timeout(
    timeout: Duration,
) -> Result<tungstenite::WebSocket<TcpStream>, Box<dyn std::error::Error>> {
    let stream = TcpStream::connect_timeout(
        &(
            HERMES_HOST.parse::<std::net::IpAddr>().unwrap(),
            HERMES_PORT,
        )
            .into(),
        timeout,
    )?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let url = format!("{HERMES_EVENTS_URL}&token={}", dashboard_token());
    let (ws, _response) = tungstenite::client(url.as_str(), stream)?;
    // Handshake completed within the read/write timeouts above. Clear the read timeout for the
    // steady-state loop via the WebSocket's own handle to the stream (tungstenite::client took
    // ownership, so we can no longer reach the original `stream` binding) - the observer's own
    // shutdown flag + reconnect-on-error already bound how long a stuck read can block, and a
    // persistent short timeout would spuriously error out of `ws.read()` between legitimate
    // keepalive-spaced frames.
    ws.get_ref().set_read_timeout(None)?;
    ws.get_ref().set_write_timeout(None)?;
    Ok(ws)
}

/// Outcome of the `/api/status` auth-token check.
enum TokenCheck {
    /// Dashboard answered cleanly and no token is required - safe to open the WS.
    NotRequired,
    /// Dashboard answered cleanly and a token IS required (and we have none) - stay degraded.
    Required,
    /// Couldn't get a clean answer (connect/read/parse failure). Previously this fell back to
    /// `false` (proceed as if fine) - now it's a distinct, explicit "don't know" state so the
    /// caller fails CLOSED instead of silently barreling into a WS connect against a gateway
    /// we just failed to get a straight answer from.
    Unreachable,
}

/// Call `GET /api/status` and classify the auth-token requirement. Uses a raw std TcpStream GET
/// (no keep-alive) with a short read timeout so it never hangs startup.
fn check_status_for_token() -> TokenCheck {
    use std::io::{Read, Write};
    let result: Option<bool> = (|| {
        let mut stream = TcpStream::connect_timeout(
            &(HERMES_HOST.parse::<std::net::IpAddr>().ok()?, HERMES_PORT).into(),
            Duration::from_secs(2),
        )
        .ok()?;
        let req = format!("GET /api/status HTTP/1.0\r\nHost: {HERMES_HOST}:{HERMES_PORT}\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).ok()?;
        stream.set_read_timeout(Some(HTTP_PROBE_TIMEOUT)).ok()?;
        let mut buf = String::new();
        stream.read_to_string(&mut buf).ok()?;
        // Find JSON body after the blank header line.
        let body = buf.split("\r\n\r\n").nth(1).unwrap_or("").trim();
        if body.is_empty() {
            return Some(false);
        }
        let v: Value = serde_json::from_str(body).ok()?;
        // If the status response contains `"auth_required": true` we degrade.
        Some(
            v.get("auth_required")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
        )
    })();
    match result {
        Some(true) => TokenCheck::Required,
        Some(false) => TokenCheck::NotRequired,
        None => TokenCheck::Unreachable,
    }
}

/// Parse one JSON-RPC frame from the Hermes event bus into a `HermesEvent`.
/// Returns `None` for frames that aren't `method:"event"` (keepalives, acks, etc.).
fn parse_frame(text: &str) -> Option<HermesEvent> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("method").and_then(|x| x.as_str()) != Some("event") {
        return None;
    }
    let params = v.get("params")?;
    let kind = params.get("type").and_then(|x| x.as_str())?.to_string();
    let session_id = params
        .get("session_id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let payload = params.get("payload");

    // Extract `text` from the most likely payload field for each event kind.
    let text: Option<String> = payload.and_then(|p| {
        // Priority: text > message > result > summary > kind (status.update)
        p.get("text")
            .or_else(|| p.get("message"))
            .or_else(|| p.get("result"))
            .or_else(|| p.get("summary"))
            .or_else(|| p.get("kind"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    });

    let tool_name = payload
        .and_then(|p| p.get("name"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let model = payload
        .and_then(|p| p.get("model"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let subagent_id = payload
        .and_then(|p| p.get("subagent_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let parent_id = payload
        .and_then(|p| p.get("parent_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let depth = payload
        .and_then(|p| p.get("depth"))
        .and_then(|x| x.as_u64())
        .map(|d| d as u32);

    Some(HermesEvent {
        kind,
        session_id,
        text,
        tool_name,
        model,
        subagent_id,
        parent_id,
        depth,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// THINK/PLAN call: run `hermes -z <goal> --provider <provider> [--model <model>]` and
/// return trimmed stdout. Times out at BRAIN_TIMEOUT_SECS (120s). On error returns `Err(message)`.
///
/// Hermes imports `~/.codex/auth.json` automatically, so no API key injection is needed for that
/// path. Pass `"openai-api"` only for an explicit API-wallet call.
///
/// This is the orchestrator's reasoning entry point - call it from the frontend when
/// the brain needs to plan a multi-step task or synthesize an answer from context.
///
/// `fallbacks` is the rest of Praxis's brain ORDER (see `walk_brain_order`): the rails
/// to try, in order, when the chosen one is dark or fails. Omitted, only the chosen
/// rail is tried (the old behavior).
#[tauri::command]
pub async fn hermes_brain(
    app: tauri::AppHandle,
    goal: String,
    model: Option<String>,
    provider: Option<String>,
    fallbacks: Option<Vec<BrainRail>>,
) -> Result<String, String> {
    let order = brain_order(provider, model, fallbacks);
    let (result, status) = walk_brain_order(order, |rail| {
        let goal = goal.clone();
        async move {
            hermes_brain_once(goal, Some(rail.model).filter(|m| !m.is_empty()), Some(rail.provider)).await
        }
    })
    .await;
    publish_brain_rail(&app, status);
    result
}

/// One brain call on one rail - no fallback. `hermes_brain` walks the order over this.
pub(crate) async fn hermes_brain_once(
    goal: String,
    model: Option<String>,
    provider: Option<String>,
) -> Result<String, String> {
    let provider = provider.unwrap_or_else(|| DEFAULT_BRAIN_PROVIDER.to_string());
    match parse_brain_provider(&provider)? {
        BrainProvider::OpenAiApi => return openai_responses_call(goal, None, model, 1600).await,
        // Planning is answer-only: no built-in Claude tools are exposed here.
        BrainProvider::ClaudeCli => {
            return run_claude_brain(goal, model.filter(|m| !m.is_empty())).await;
        }
        // NIM is OpenAI-compatible, but not a Hermes CLI provider. Reuse the
        // explicitly selected NIM transport rather than silently spending OpenAI
        // credit. A 900-token plan is ample for the bounded orchestrator plan schema.
        BrainProvider::Nvidia => {
            return brain_chat_inner(goal, None, model, Some("nvidia".to_string()), None).await;
        }
        BrainProvider::OpenAiCodex | BrainProvider::OpenRouter => {}
    }

    let mut cmd = make_async_cmd("hermes");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if provider == "openai-codex" {
        // THE CODEX BRAIN DOES NOT GO THROUGH HERMES ANY MORE.
        //
        // It could not work: the installed `hermes` has NO Codex credentials
        // ("No Codex credentials stored. Run `hermes auth`"), and the old comment here
        // claiming it imports ~/.codex/auth.json automatically was simply not true of
        // this version. Worse, passing --provider without --model made it exit 2 with a
        // flag complaint that HID that real cause.
        //
        // Meanwhile the Codex CLI itself is already authenticated and already used by
        // this very file (`run_codex`, agent_delegate) and by codex_usage.rs. Verified
        // 2026-09-15: `codex exec -m gpt-6-astra "Reply with exactly: READY"` -> READY.
        // The archived decision agrees: "Hermes = drop as runtime, drive first-party
        // CLIs directly."
        //
        // So: same CLI, same auth, no `hermes auth`, and nothing that can rewrite
        // ~/.codex/auth.json or sign the owner's Codex CLI out.
        let chosen = model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(CODEX_BRAIN_MODEL)
            .to_string();
        // The brain thinks; agents act. A read-only sandbox, as the Claude brain runs
        // with every tool disabled: a plan or a next-step call can never itself edit
        // a file or drive the machine around Praxis's trust gate.
        return run_codex_opts(goal, None, Some(chosen), &[], true, DELEGATE_TIMEOUT_SECS).await;
    }

    {
        // Only OpenRouter reaches here now - the Codex brain returned above, via the
        // Codex CLI. OpenRouter is explicitly selected and metered. Only ever
        // pass --provider alongside a non-empty --model for the real hermes CLI - if the
        // caller handed us an empty/missing model for a provider hermes doesn't default
        // for, that's a frontend contract violation, so warn loudly instead of silently
        // shipping a combo hermes will reject with exit 2.
        let model = match model.filter(|m| !m.is_empty()) {
            Some(m) => m,
            None => {
                crate::elog!(
                    "[hermes] WARN hermes_brain: provider {provider:?} had no model — falling back to \
                     {DEFAULT_BRAIN_MODEL} (selectedBrain() should never emit this combo; check \
                     src/orchestrator/brain.ts)"
                );
                DEFAULT_BRAIN_MODEL.to_string()
            }
        };
        let api_key = read_vault_key("OPENROUTER_API_KEY");
        cmd.args(["-z", &goal, "--provider", "openrouter", "--model", &model]);
        if let Some(key) = &api_key {
            cmd.env("OPENROUTER_API_KEY", key);
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("hermes not found or failed to spawn: {e}"))?;

    let output = tokio::time::timeout(
        Duration::from_secs(BRAIN_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("hermes_brain timed out after {BRAIN_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("hermes_brain wait error: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "hermes_brain exited {:?}: {}",
            output.status.code(),
            stderr
        ))
    }
}

/// Timeout for `hermes_teach` - a memory-save turn is a single short tool call
/// (the agent reads the lesson, calls its `memory` tool once, replies "saved"),
/// so it doesn't need the full BRAIN_TIMEOUT_SECS a planning call gets, but real
/// Hermes turns on Windows cold-start slower than a bare API call - 90s gives
/// headroom without hanging the caller indefinitely on a wedged install.
const TEACH_TIMEOUT_SECS: u64 = 90;

/// Feed Praxis a durable lesson to persist in Hermes's REAL built-in memory -
/// `~/.hermes/memories/MEMORY.md` (agent notes) or `USER.md` (the owner's preferences
/// and corrections), per `target`.
///
/// This is NOT a new memory system - it rides the exact mechanism Hermes already
/// ships: `hermes -z <prompt>` instantiates a real `AIAgent` and calls
/// `run_conversation` (see `hermes_cli/oneshot.py`), which loads memory the same
/// as an interactive chat turn, exposes the built-in `memory` tool, and - per
/// `agent/background_review.py` - can fire the background self-improvement
/// review after the turn. We simply frame the oneshot prompt so the agent's own
/// judgment reliably calls `memory(action="add", target=..., content=...)`
/// instead of just answering in prose. Whether it ALSO gets picked up by the
/// background review is Hermes's own call - we don't force that.
///
/// `target` is `"user"` (the owner's preferences / corrections - USER.md) or `"memory"` (environment
/// facts / operational lessons - MEMORY.md). Defaults to `"memory"` for anything else.
///
/// Best-effort by design: callers (orchestrator run outcomes, voice captures)
/// should treat failure as non-fatal - Hermes being off, uninstalled, or slow
/// must never block the caller's real work.
#[tauri::command]
pub async fn hermes_teach(lesson: String, target: Option<String>) -> Result<String, String> {
    let target = target.unwrap_or_else(|| "memory".to_string());
    let target = if target == "user" { "user" } else { "memory" };

    // Frame as an explicit instruction rather than a plain statement, so the
    // oneshot turn reliably reaches for the `memory` tool instead of just
    // acknowledging in prose. Kept short - this is one tool call, not a task.
    let prompt = format!(
        "Use your memory tool now: call memory(action=\"add\", target=\"{target}\") to save \
         this durable lesson, phrased compactly (per your memory-writing guidance). Only skip \
         the save if this exact fact is already present. Reply with one short line confirming \
         what you saved (or that it was already known). Lesson: {lesson}"
    );

    let mut cmd = make_async_cmd("hermes");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // OpenRouter path (same default model/provider as hermes_brain) - a memory
    // save doesn't need the reasoning of a planning call, so the cheap default
    // model is intentional here too.
    let api_key = read_vault_key("OPENROUTER_API_KEY");
    cmd.args([
        "-z",
        &prompt,
        "--provider",
        "openrouter",
        "--model",
        DEFAULT_BRAIN_MODEL,
    ]);
    if let Some(key) = &api_key {
        cmd.env("OPENROUTER_API_KEY", key);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("hermes not found or failed to spawn: {e}"))?;

    let output = tokio::time::timeout(
        Duration::from_secs(TEACH_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("hermes_teach timed out after {TEACH_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("hermes_teach wait error: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "hermes_teach exited {:?}: {}",
            output.status.code(),
            stderr
        ))
    }
}

/// Conversational brain - "talk to Praxis". The selected provider is authoritative:
/// failures surface as failures instead of secretly rerouting onto a paid rail. The UI
/// can offer an explicit retry or a different provider, but usage and intent stay true.
#[tauri::command]
/// `timeout_secs` = seconds to wait on a CLI brain; omit for the interactive default.
///
/// The single 55s ceiling was tuned for ONE chat turn, but the board meeting fires seven
/// contributors through `Promise.allSettled` at once, so three `claude -p` processes cold-start
/// simultaneously. A batch caller can now ask for the room it actually needs without making an
/// interactive turn feel slow.
pub async fn brain_chat(
    app: tauri::AppHandle,
    message: String,
    context: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    timeout_secs: Option<u64>,
    fallbacks: Option<Vec<BrainRail>>,
) -> Result<String, String> {
    let order = brain_order(provider, model, fallbacks);
    let (result, status) = walk_brain_order(order, |rail| {
        let (message, context) = (message.clone(), context.clone());
        async move {
            brain_chat_inner(message, context, Some(rail.model).filter(|m| !m.is_empty()), Some(rail.provider), timeout_secs)
                .await
        }
    })
    .await;
    publish_brain_rail(&app, status);
    result
}

// ── Praxis's brain ORDER (owner request 2026-10-10) ──────────────────────────────────
//
// The frontend builds the order (it knows his breakers); this side walks it, skips a rail
// already known to be dark without paying for the call, and records which rail actually answered
// so the app can say so. Before this, a refused Claude meant every Claude-brain call failed
// outright.

/// One rail in a brain order.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BrainRail {
    pub provider: String,
    #[serde(default)]
    pub model: String,
}

/// Which rail answered the last brain call, and why the ones before it didn't.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct BrainRailStatus {
    pub requested: Option<BrainRail>,
    pub used: Option<BrainRail>,
    /// One plain sentence per rail that was skipped or failed before `used`.
    pub skipped: Vec<String>,
    pub at_ms: u64,
}

static LAST_BRAIN_RAIL: Mutex<Option<BrainRailStatus>> = Mutex::new(None);

/// The chosen rail first, then the fallbacks, without repeats.
fn brain_order(provider: Option<String>, model: Option<String>, fallbacks: Option<Vec<BrainRail>>) -> Vec<BrainRail> {
    let mut order = vec![BrainRail {
        provider: provider.unwrap_or_else(|| DEFAULT_BRAIN_PROVIDER.to_string()),
        model: model.unwrap_or_default(),
    }];
    for rail in fallbacks.unwrap_or_default() {
        if !order.contains(&rail) {
            order.push(rail);
        }
    }
    order
}

/// Why a rail cannot answer right now, known without calling it.
fn rail_known_dark(provider: &str) -> Option<String> {
    match provider {
        "claude-max" => {
            if crate::claude_usage::claude_refusal().is_some() && !crate::claude_usage::refusal_probe_in_flight() {
                return Some("The vendor is refusing Claude Code".to_string());
            }
            claude_cli_unhealthy()
        }
        "openai-codex" => crate::codex_usage::codex_quota_state().map(|q| match q.reset_text {
            Some(t) => format!("Codex is out of usage until {t}"),
            None => "Codex is out of usage".to_string(),
        }),
        "openai-api" => crate::openai_credit::blocks_paid_calls().then(|| "the OpenAI API wallet is empty".to_string()),
        _ => None,
    }
}

/// "Claude (claude-opus-5-5)" - short enough for a status line.
fn rail_label(rail: &BrainRail) -> String {
    let who = match rail.provider.as_str() {
        "claude-max" => "Claude",
        "openai-codex" => "Codex",
        "openai-api" => "OpenAI API",
        "openrouter" => "OpenRouter",
        "nvidia" => "NVIDIA",
        other => other,
    };
    if rail.model.is_empty() { who.to_string() } else { format!("{who} ({})", rail.model) }
}

/// Walk the order: skip known-dark rails, try the rest until one answers.
async fn walk_brain_order<F, Fut>(order: Vec<BrainRail>, mut call: F) -> (Result<String, String>, BrainRailStatus)
where
    F: FnMut(BrainRail) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let requested = order.first().cloned();
    let mut skipped: Vec<String> = Vec::new();
    for rail in order {
        if let Some(why) = rail_known_dark(&rail.provider) {
            skipped.push(format!("{}: {why}", rail_label(&rail)));
            continue;
        }
        match call(rail.clone()).await {
            Ok(answer) => {
                let status = BrainRailStatus { requested, used: Some(rail), skipped, at_ms: now_ms_u64() };
                return (Ok(answer), status);
            }
            Err(error) => skipped.push(format!("{}: {}", rail_label(&rail), error.chars().take(160).collect::<String>())),
        }
    }
    let error = if skipped.is_empty() { "no brain rail to try".to_string() } else { skipped.join("; ") };
    (Err(error), BrainRailStatus { requested, used: None, skipped, at_ms: now_ms_u64() })
}

fn now_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Remember and announce which rail answered (the Fleet panel's PRAXIS row shows it).
fn publish_brain_rail(app: &tauri::AppHandle, status: BrainRailStatus) {
    if status.used.as_ref() != status.requested.as_ref() && !status.skipped.is_empty() {
        crate::dlog!(
            "[brain] answered by {} - {}",
            status.used.as_ref().map(rail_label).unwrap_or_else(|| "no rail".to_string()),
            status.skipped.join("; ")
        );
    }
    let _ = app.emit("praxis://brain-rail", &status);
    if let Ok(mut last) = LAST_BRAIN_RAIL.lock() {
        *last = Some(status);
    }
}

/// The last brain call's rail, for a window that opens after it happened.
#[tauri::command]
pub fn brain_rail_status() -> Option<BrainRailStatus> {
    LAST_BRAIN_RAIL.lock().ok().and_then(|g| g.clone())
}

/// Free NVIDIA NIM model used as the last-resort brain - mirrors `SAFE_FALLBACK` in
/// `src/orchestrator/brain.ts`, which picks NIM for the same reason: no breaker, no bill.
const NO_CREDIT_NVIDIA_MODEL: &str = "nvidia/nemotron-3.5-lightning-30b-a3b";

/// Every return value NAMES the rail that answered. That is the whole point - the
/// comment on `CHAT_CLI_TIMEOUT_SECS` calls an "undisclosed paid fallback" a defect,
/// and an undisclosed *free* fallback is the same defect pointed the other way: the owner
/// would be reading a NIM answer believing it came from a frontier model. The sentence
/// leads because it is spoken aloud, so provenance has to arrive before the content.
/// Returns a BOXED future on purpose: this and `brain_chat_inner` call each other, so
/// an `async fn` pair would have an infinitely-sized future (E0733). Boxing here erases
/// the type once, at the single point of mutual recursion.
fn brain_without_credit(
    message: String,
    context: Option<String>,
    model: Option<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
    Box::pin(async move {
    let _ = model; // the paid model was refused; each reroute target picks its own

    // `codex_quota_state()` is the same self-retiring evidence the Codex rail reads, so this
    // skip disappears on its own when the window reopens.
    let codex_blocked = crate::codex_usage::codex_quota_state().is_some();
    if codex_blocked {
        crate::elog!("[brain] no-credit reroute: skipping Codex (usage limit on record)");
    }

    match if codex_blocked {
        Err("codex usage limit on record".to_string())
    } else {
        brain_chat_inner(
            message.clone(),
            context.clone(),
            None,
            Some("openai-codex".to_string()),
            None,
        )
        .await
    } {
        Ok(answer) => {
            return Ok(format!(
                "Paid OpenAI has no credit, so I used your ChatGPT subscription instead. {answer}"
            ))
        }
        Err(error) => crate::elog!("[brain] no-credit reroute: Codex subscription unavailable ({error})"),
    }

    match brain_chat_inner(
        message,
        context,
        Some(NO_CREDIT_NVIDIA_MODEL.to_string()),
        Some("nvidia".to_string()),
        None,
    )
    .await
    {
        Ok(answer) => Ok(format!(
            "Paid OpenAI has no credit and your ChatGPT subscription didn't answer, so this is free NVIDIA NIM. {answer}"
        )),
        // Both free rails are gone too. Say what is actually wrong - the wallet - rather
        // than whatever the last transport happened to complain about.
        Err(error) => Err(format!(
            "OpenAI API credit is used up and the free rails didn't answer either ({error})"
        )),
    }
    })
}

/// Inner dispatch - the actual per-provider call. Not a command; `brain_chat`
/// exposes its selected-provider result unchanged so meters never lie.
/// `pub(crate)` so `web_search` can summarize through the SAME free NVIDIA seam instead of
/// growing a second chat client.
pub(crate) async fn brain_chat_inner(
    message: String,
    context: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let provider = provider.unwrap_or_else(|| DEFAULT_BRAIN_PROVIDER.to_string());
    let provider_kind = parse_brain_provider(&provider)?;

    // A chat turn must feel instant-ish. The CLI brains (Codex via Hermes, Claude via
    // the claude CLI) cold-start slowly; cap them so a hang becomes a clear error rather
    // than an undisclosed paid fallback.
    const CHAT_CLI_TIMEOUT_SECS: u64 = 55;
    /// Ceiling on what a caller may ask for, so a bad value cannot hang a turn forever.
    const MAX_CHAT_CLI_TIMEOUT_SECS: u64 = 300;
    let cli_timeout = timeout_secs
        .unwrap_or(CHAT_CLI_TIMEOUT_SECS)
        .clamp(CHAT_CLI_TIMEOUT_SECS, MAX_CHAT_CLI_TIMEOUT_SECS);

    if provider_kind == BrainProvider::OpenAiApi {
        // An empty API wallet must not mean "Atlas has no brain".
        //
        // Skip the paid call when it is already known-refused (no point burning a
        // round-trip), but still attempt it otherwise: that attempt is what clears the
        // recorded block once credit is added, with no restart.
        if crate::openai_credit::blocks_paid_calls() {
            return brain_without_credit(message, context, model).await;
        }
        return match openai_responses_call(message.clone(), context.clone(), model.clone(), 900).await {
            Ok(answer) => Ok(answer),
            // Match on THIS error, not on "is a refusal on record" - that stays true for
            // 24 hours, so a timeout would have been rerouted and announced as a credit
            // problem it wasn't.
            Err(error) if crate::openai_credit::error_is_credit_refusal(&error) => {
                // The wallet - not this prompt - is why it failed. Reroute rather than
                // surfacing an error Atlas would read aloud.
                crate::elog!("[brain] OpenAI API refused for credit; rerouting ({error})");
                brain_without_credit(message, context, model).await
            }
            Err(error) => Err(error),
        };
    }

    // It gets the same persona and live context as the Claude path; it used to get the bare
    // message, so a Codex-answered chat didn't know it was Praxis.
    if provider_kind == BrainProvider::OpenAiCodex {
        let system = format!(
            "You are Praxis — Zach's personal AI operating system and 'second brain'. Speak in the \
             first person as Praxis: concise, warm, sharp, a touch of Jarvis. Keep replies to 1-3 \
             sentences unless asked for more. Reply with the answer only — no preamble, and do \
             not run commands or edit files.{}",
            context.as_deref().map(|c| format!(" Live context: {c}")).unwrap_or_default()
        );
        return match tokio::time::timeout(
            Duration::from_secs(cli_timeout),
            Box::pin(hermes_brain_once(
                format!("{system}\n\n{message}"),
                model.filter(|m| !m.is_empty()),
                Some("openai-codex".to_string()),
            )),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err(format!(
                "brain_chat: Codex brain didn't answer within {cli_timeout}s"
            )),
        };
    }

    // Claude CLI: no chat-completions endpoint either - route through the
    // explicit CLI selection, but with every built-in tool disabled. Deeper but
    // slower than the API providers; the frontend's
    // offline-planner fallback catches a missing/limited-model CLI error as usual.
    if provider_kind == BrainProvider::ClaudeCli {
        let system = format!(
            "You are Praxis — Zach's personal AI operating system and 'second brain'. Speak in the \
             first person as Praxis: concise, warm, sharp, a touch of Jarvis. Keep replies to 1-3 \
             sentences unless asked for more. Reply with the answer only — no preamble.{}",
            context.as_deref().map(|c| format!(" Live context: {c}")).unwrap_or_default()
        );
        let prompt = format!("{system}\n\n{message}");
        let model = model.filter(|m| !m.is_empty());
        return match tokio::time::timeout(
            Duration::from_secs(cli_timeout),
            run_claude_brain(prompt, model),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err(format!(
                "brain_chat: Claude CLI didn't answer within {cli_timeout}s"
            )),
        };
    }

    // OpenAI-compatible providers: base_url + vault key + a sensible default model.
    // NVIDIA-NIM default: THIS ID EXPIRES. Twice now a NIM model has reached end-of-life and
    // taken the whole free rail down silently:
    //   * `z-ai/glm-5.1` - EOL 2026-07-02, now 410s (and NIM serves no GLM successor). During
    //     its degradation window it returned HTTP-200 mixed-script token GARBAGE, which we
    //     shipped to the user verbatim (the "Close the command center" mojibake).
    //   * `meta/llama-3.3-70b-instruct` - EOL 2026-08-26, 410 Gone. Found on 2026-09-15, three
    //     weeks dead, while testing the no-credit reroute: it was ALSO `SAFE_FALLBACK` in
    //     brain.ts, so every breaker-cut reroute in the app had been landing on a dead model.
    // Now `nvidia/nemotron-3.5-lightning-30b-a3b` - NVIDIA's own (less mirror-EOL risk),
    // verified live 2026-09-15 on this account: coherent reply, fast enough for a voice turn.
    // A 404 "not found for account" here means listed-but-not-entitled, which is NOT the same
    // as EOL; re-probe `/v1/models` plus a real completion before swapping this again.
    let (base_url, key_name, default_model) = match provider_kind {
        BrainProvider::OpenRouter => (
            "https://openrouter.ai/api/v1",
            "OPENROUTER_API_KEY",
            DEFAULT_BRAIN_MODEL,
        ),
        BrainProvider::Nvidia => (
            "https://integrate.api.nvidia.com/v1",
            "NVIDIA_API_KEY",
            DEFAULT_NVIDIA_BRAIN_MODEL,
        ),
        _ => unreachable!("CLI/API providers return above"),
    };
    let usage_tool = if provider_kind == BrainProvider::OpenRouter {
        "openrouter"
    } else {
        "nvidia"
    };
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| default_model.to_string());
    let api_key = read_vault_key(key_name).ok_or_else(|| format!("no {key_name} in vault"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(BRAIN_CHAT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("brain_chat reqwest build: {e}"))?;

    let system = format!(
        "You are Praxis — Zach's personal AI operating system and 'second brain', visualized as a \
         living 3D neural brain. Speak in the first person as Praxis: concise, warm, sharp, a touch \
         of Jarvis. Keep replies to 1-3 sentences unless asked for more. You orchestrate AI agents \
         that build Zach's projects. Never call yourself a 'Phase-1 planner' or mention mocks.{}",
        context.map(|c| format!(" Live context: {c}")).unwrap_or_default()
    );

    // GLM-family models (glm-5.x) on OpenRouter are reasoning models: they can burn most or all
    // of `max_tokens` on a hidden `reasoning` pass and stop with finish_reason "length" before
    // emitting any visible content. OpenRouter's `reasoning.enabled: false` reliably disables
    // the reasoning pass for this model family (verified live: 0 reasoning tokens, full content,
    // finish_reason "stop") without needing a bigger token budget, so send it unconditionally on
    // this path. If a future model here ignores the flag, `chat_once`'s retry-with-bigger-budget
    // below still catches it.
    let make_body = |max_tokens: u64| {
        serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": &system },
                { "role": "user", "content": &message }
            ],
            "max_tokens": max_tokens,
            "reasoning": { "enabled": false }
        })
    };

    async fn chat_once(
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        model: &str,
        provider: &str,
        body: &Value,
    ) -> Result<Value, String> {
        let resp = client
            .post(format!("{base_url}/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| {
                // Distinguish WHY the request failed instead of collapsing everything into
                // reqwest's terse Display text - this is what the frontend surfaces to the owner,
                // so a vague message here is itself a bug. Timeout vs connect vs other all
                // have different fixes (slow model/provider vs vault/DNS/network down).
                if e.is_timeout() {
                    format!(
                        "brain_chat timed out after {BRAIN_CHAT_TIMEOUT_SECS}s waiting on {model} \
                         via {provider} — the model (or the OpenRouter backend it landed on) was \
                         too slow to answer in time"
                    )
                } else if e.is_connect() {
                    format!("brain_chat couldn't connect to {base_url}: {e}")
                } else {
                    format!("brain_chat request to {base_url} failed: {e}")
                }
            })?;

        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| {
            format!("brain_chat: {model} via {provider} returned a non-JSON response (HTTP {status}): {e}")
        })?;

        if !status.is_success() {
            let snippet: String = v.to_string().chars().take(300).collect();
            return Err(format!(
                "brain_chat: {model} via {provider} — HTTP {status}: {snippet}"
            ));
        }

        Ok(v)
    }

    let mut v = chat_once(
        &client,
        base_url,
        &api_key,
        &model,
        &provider,
        &make_body(400),
    )
    .await?;

    let has_content = |v: &Value| {
        v.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|x| x.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };

    if !has_content(&v) {
        let retry = chat_once(
            &client,
            base_url,
            &api_key,
            &model,
            &provider,
            &make_body(1200),
        )
        .await;
        if let Ok(retry_v) = retry {
            if has_content(&retry_v) {
                v = retry_v;
            }
        }
    }

    if let Some(usage) = v.get("usage") {
        let input = usage
            .get("prompt_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let output = usage
            .get("completion_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        crate::usage::record_usage(usage_tool, &model, input, output, 0.0);
    }

    let reply = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            // GLM-family reasoning models can still exhaust even a bumped budget on the
            // hardest prompts and stop with finish_reason "length" before emitting visible
            // content. Surface finish_reason so this reads as "the model ran out of room",
            // not a generic, misleading "unreachable".
            let finish_reason = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("finish_reason"))
                .and_then(|x| x.as_str())
                .unwrap_or("unknown");
            format!(
                "brain_chat: {model} via {provider} returned no content after retry (finish_reason: {finish_reason})"
            )
        })?;

    // Coherence guard: a degraded/EOL model can return HTTP-200 with mixed-script token
    // GARBAGE (the "Close the command center" mojibake). Rather than speak that verbatim,
    // surface a clean, actionable error so the frontend can fall back to its offline planner
    // and the user sees WHY, not gibberish. Conservative by design - see `looks_garbled`.
    if looks_garbled(&reply) {
        return Err(format!(
            "brain returned garbage — provider {provider}, model {model}. Reply failed the coherence check (mostly non-Latin token noise); the model may be degraded or end-of-life."
        ));
    }

    Ok(reply)
}

/// Which Unicode script bucket a character belongs to, for the coherence check. `None` for
/// non-letters and for Latin (Latin is the assistant's own script, so it's never "foreign").
/// Buckets are coarse - we only need "is this a distinct writing system" - and cover the scripts
/// that actually showed up in the mojibake plus the other common ones.
fn foreign_script(c: char) -> Option<&'static str> {
    let u = c as u32;
    match u {
        // Cyrillic (incl. supplement)
        0x0400..=0x04FF | 0x0500..=0x052F => Some("cyrillic"),
        // Greek and Coptic
        0x0370..=0x03FF => Some("greek"),
        // Arabic
        0x0600..=0x06FF | 0x0750..=0x077F => Some("arabic"),
        // Hebrew
        0x0590..=0x05FF => Some("hebrew"),
        // CJK unified ideographs (Han) + common extensions
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF => Some("cjk"),
        // Japanese kana
        0x3040..=0x309F | 0x30A0..=0x30FF => Some("kana"),
        // Korean Hangul
        0xAC00..=0xD7AF | 0x1100..=0x11FF => Some("hangul"),
        // Devanagari
        0x0900..=0x097F => Some("devanagari"),
        // Thai
        0x0E00..=0x0E7F => Some("thai"),
        _ => None,
    }
}

/// Heuristic: does a brain reply look like token GARBAGE rather than a real answer?
///
/// Praxis is an English-first assistant. A legitimate reply is Latin-script prose (a stray
/// emoji, an accented name, or ONE short foreign phrase is perfectly fine). The mojibake we
/// shipped ("freewayApprocoming… 富春… европий… Δ… ةف…") was ~90% Latin but *word-salad*, its
/// unmistakable tell being that it sprinkled MANY DIFFERENT writing systems into one short
/// reply - CJK **and** Cyrillic **and** Greek **and** Arabic at once. Real replies essentially
/// never do that, so "≥3 distinct non-Latin scripts present" is the primary, near-zero-false-
/// positive signal. U+FFFD replacement chars (a hard upstream-decode failure) are a second.
///
/// Deliberately conservative: a false POSITIVE muzzles a good reply (worse than letting one
/// slip), so the bar is set where only genuinely pathological output trips it. Ordinary English,
/// code/JSON snippets, punctuation-heavy text, and light multilingual content all pass.
fn looks_garbled(reply: &str) -> bool {
    // U+FFFD replacement chars are a hard signal of a decode failure upstream.
    if reply.chars().filter(|&c| c == '\u{FFFD}').count() >= 3 {
        return true;
    }

    // Count DISTINCT non-Latin writing systems present. Three or more different foreign scripts
    // co-occurring in one reply is the mojibake fingerprint and does not happen in real answers.
    let mut seen: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    for c in reply.chars() {
        if let Some(script) = foreign_script(c) {
            seen.insert(script);
            if seen.len() >= 3 {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod coherence_tests {
    use super::looks_garbled;

    #[test]
    fn clean_english_passes() {
        assert!(!looks_garbled(
            "I've closed the Command Center for you. Anything else you'd like me to tuck away?"
        ));
        assert!(!looks_garbled(
            "Closing the command center now. All related processes have been halted."
        ));
    }

    #[test]
    fn short_or_light_foreign_passes() {
        assert!(!looks_garbled("Done."));
        assert!(!looks_garbled("Sure — opening it now. 🚀"));
        // accented Latin is still Latin - never counts as a foreign script
        assert!(!looks_garbled("Café's on the list, boss. Zürich too."));
        // ONE legitimate foreign phrase is fine (well under the 3-script bar)
        assert!(!looks_garbled("In 日本語 that's 'konnichiwa' — hello."));
        // even TWO scripts (e.g. quoting Chinese and Russian) stay under the bar
        assert!(!looks_garbled("The words are 你好 and привет."));
    }

    #[test]
    fn code_and_symbols_pass() {
        assert!(!looks_garbled(
            "Run `const x = a && b; foo(x)!` — then check the $PATH and the (result)."
        ));
    }

    #[test]
    fn mojibake_is_flagged() {
        // The literal garbage the user hit (excerpt).
        let g = "freewayApprocomingErrorType QuickUnloadbidden freeway:\"LED ceremonies$c GalaxyNNzWE**)scripts富春(app\"√(х_ةف европий_____ über. thou **vi**hay ka43 devaos auch分析rec.angeset(gt j5ég g軍 Cometp**ro-us hacker.a ApplicationÖffdep MatchNotifierΔ<IT尽(inherited.Avark";
        assert!(looks_garbled(g));
    }

    #[test]
    fn replacement_chars_flagged() {
        assert!(looks_garbled(
            "here is the answer \u{FFFD}\u{FFFD}\u{FFFD} broken bytes"
        ));
    }
}

/// Build a headless lane subprocess for `flow_runner.rs` using the EXACT SAME
/// CLI + flags each `run_*` delegate uses - the one place those argument sets
/// live, so a flag change (e.g. codex's approval-bypass rename) updates both the
/// delegate path and the FlowRunner in lockstep instead of drifting.
///
/// Difference from `agent_delegate`: the delegate captures stdout in one blocking
/// `wait_with_output()` and parses the result; the FlowRunner instead needs a
/// LONG-LIVED child whose progress it can watch by tailing a log file and whose
/// liveness it polls by pid. So this returns a configured `tokio::process::Command`
/// with stdout+stderr already redirected into `log_file` (opened append) and stdin
/// nulled - the caller spawns it, records the pid, and polls. `advisor` is threaded
/// for claude only (same P1 cascade as the delegate); codex/cursor ignore it.
///
/// Returns `Err` only when a required CLI is missing (cursor-agent not installed) -
/// a clean, actionable failure the FlowRunner surfaces as a lane escalation.
/// `--settings` payload for EVERY headless `claude -p` Praxis runs.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// A HOOK WAS SILENTLY KILLING FORGE, SAGE AND ATLAS.
///
/// Headless `claude -p` runs the user's SessionStart hooks before it does anything
/// else - including before it checks auth. On this machine one of them,
/// `~/.claude/hooks/file_indexer.py --quiet`, never returns: timed on its own
/// 2026-09-13 it was still running at 60s, and it has no `timeout` configured. So
/// every board-meeting statement and every brain_chat turn waited on it until
/// Praxis's own 55s ceiling fired, and the board reported "Claude CLI didn't
/// answer within 55s" for three agents at once. The stream proved it: two
/// SessionStart hooks start, one responds, the call hangs.
///
/// Measured with the SAME flags otherwise: default -> hang to timeout; `disableAllHooks` ->
/// answers in 4s. `--safe-mode` works too but drops CLAUDE.md, which Forge's delegated build
/// work needs. This disables hooks and nothing else.
///
/// Hooks are the owner's session furniture - orientation, memory, indexing - built for
/// sessions HE opens. A headless agent turn has no use for them and cannot wait
/// on them.
/// ─────────────────────────────────────────────────────────────────────────────
pub(crate) const HEADLESS_CLAUDE_SETTINGS: &str = r#"{"disableAllHooks":true}"#;

pub(crate) fn build_lane_command(
    driver: &str,
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
    log_file: std::fs::File,
) -> Result<tokio::process::Command, String> {
    let err_log = log_file
        .try_clone()
        .map_err(|e| format!("clone lane log handle: {e}"))?;
    let framed = worker_prompt(prompt);
    let prompt = framed.as_str();
    let mut cmd = match driver {
        "claude" => {
            let mut c = make_async_cmd("claude");
            c.arg("-p")
                .arg(prompt)
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose")
                .arg("--strict-mcp-config")
                .arg("--settings")
                .arg(HEADLESS_CLAUDE_SETTINGS)
                .arg("--dangerously-skip-permissions");
            isolate_worker("claude", &mut c);
            if let Some(m) = model {
                c.arg("--model").arg(m);
            }
            // Advisor probing is intentionally disabled until the headless Claude
            // CLI has a verified authenticated route on this machine.
            if let Some(adv) = advisor_model() {
                if model != Some(adv.as_str()) {
                    c.arg("--advisor").arg(&adv);
                }
            }
            c
        }
        "codex" => {
            let mut c = make_async_cmd("codex");
            c.arg("exec")
                .arg(prompt)
                .arg("--json")
                .arg("--dangerously-bypass-approvals-and-sandbox")
                .arg("--skip-git-repo-check");
            isolate_worker("codex", &mut c);
            if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
                c.arg("--model").arg(m);
            }
            c
        }
        "cursor" => {
            if !cursor_agent_installed() {
                return Err("cursor-agent CLI not installed — install via \
                     irm 'https://cursor.com/install?win32=true' | iex"
                    .to_string());
            }
            let mut c = make_async_cmd("cursor-agent");
            c.arg("-p")
                .arg(prompt)
                .arg("--output-format")
                .arg("json")
                .arg("--force")
                // Same gate run_cursor needed: without it a headless lane stalls on
                // "Do you trust the contents of this directory?" and dies.
                .arg("--trust")
                .arg("--model")
                .arg(quill_model(model));
            isolate_worker("cursor", &mut c);
            c
        }
        other => {
            return Err(format!(
                "unknown lane driver {other:?}; expected claude, codex, or cursor"
            ))
        }
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_log));
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    Ok(cmd)
}

/// Multi-agent delegation: run `claude`, `codex`, or `cursor` with the given prompt
/// and return the agent's output text.
///
/// - `tool == "claude"` → `claude -p <prompt> --output-format json`; parses `result`
///   field; also logs `total_cost_usd` if present.
/// - `tool == "codex"`  → `codex exec <prompt> --json`; parses `result` or returns
///   raw stdout if the response isn't JSON.
/// - `tool == "cursor"` → `cursor-agent -p <prompt> --output-format json --force
///   [--model <model>]`; parses the `result` field. Returns a clear
///   "not installed" error when the `cursor-agent` CLI isn't on the machine
///   (the headless CLI is real and stable on Windows as of 2026, but must be
///   installed via `irm cursor.com/install?win32=true`).
///
/// `cwd` sets the working directory for the subprocess when provided.
/// `model` is passed to `claude` via `--model` and to `codex` via `--model`
/// when provided - the orchestrator's per-step routing lands here.
#[tauri::command]
pub async fn agent_delegate(
    tool: String,
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    delegation_id: Option<String>,
    visible: Option<bool>,
) -> Result<String, String> {
    // The caller's id for THIS run, so a cancelled run can stop exactly its own agent
    // (`agent_delegate_abort`). Callers that pass none are still stoppable by HALT ALL.
    let id = delegation_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let prompt = worker_prompt(&prompt);
    // No folder named: run in Praxis's scratch folder, never wherever Praxis itself was
    // started (C:\Windows\system32 under the scheduled task).
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(crate::workspace::scratch_dir);
    DELEGATION_ID
        .scope(
            id,
            SHOW_LIVE.scope(visible == Some(true), async move {
                match tool.as_str() {
                    "claude" => run_claude(prompt, cwd, model).await,
                    "codex" => run_codex(prompt, cwd, model).await,
                    "cursor" => run_cursor(prompt, cwd, model).await,
                    other => Err(format!(
                        "unknown agent tool: {other:?}; expected claude, codex, or cursor"
                    )),
                }
            }),
        )
        .await
}

// ── Live mode: the team works where the owner can watch it ─────────────────────────
//
// The owner's intent for LIVE (L6): background runs headless; live shows the agents at work
// in their own apps. The apps offer no supported way to start or attach to a session
// from outside (Claude Desktop has no session deep link; Cursor's prompt links never
// auto-run), and typing prompts into three chat boxes by computer use would make every
// build as fragile as the GUI. So the work stays on the checked headless path and is
// SHOWN: Vega's own thread opens in the Codex app (`codex://threads/<id>`, the id comes
// from the run's first event), Forge's session streams in a terminal window that follows
// its transcript, and the build folder opens in Cursor (`live_open_workspace`).

fn show_live() -> bool {
    SHOW_LIVE.try_with(|v| *v).unwrap_or(false)
}

/// What Live mode opened lately, and whether it worked - so "did Vega's thread really open
/// in the Codex app?" has an answer after the fact (`live_opened_recent`).
static LIVE_OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(crate) fn note_live_opened(what: String) {
    let (h, m) = crate::codex_usage::local_hour_minute();
    let stamp = format!("{h:02}:{m:02}");
    if let Ok(mut log) = LIVE_OPENED.lock() {
        log.push(format!("{stamp} {what}"));
        let excess = log.len().saturating_sub(12);
        log.drain(..excess);
    }
}

/// The last few things Live mode opened, newest last.
#[tauri::command]
pub async fn live_opened_recent() -> Vec<String> {
    LIVE_OPENED.lock().map(|l| l.clone()).unwrap_or_default()
}

/// `wait_with_output`, except stdout is read line by line as it arrives, so a caller can
/// act on an early line - Live mode opens Vega's thread the moment the run names it.
async fn wait_output_watching(
    mut child: tokio::process::Child,
    mut on_line: Option<Box<dyn FnMut(&str) + Send>>,
) -> std::io::Result<std::process::Output> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_end(&mut buf).await;
        }
        buf
    });
    let mut stdout = Vec::new();
    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line).await? == 0 {
                break;
            }
            if let Some(f) = on_line.as_mut() {
                f(&String::from_utf8_lossy(&line));
            }
            stdout.extend_from_slice(&line);
        }
    }
    let status = child.wait().await?;
    let stderr = err_task.await.unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

/// The thread id from `codex exec --json`'s first event, `{"type":"thread.started",...}`.
/// Only a plain id is accepted: it goes into a `codex://` link opened by the shell.
fn codex_thread_started(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "thread.started" {
        return None;
    }
    let id = v.get("thread_id")?.as_str()?;
    (!id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| id.to_string())
}

/// Live mode: open Vega's thread in the Codex app once the run names it (best effort).
fn open_codex_thread_when_named() -> Box<dyn FnMut(&str) + Send> {
    let mut opened = false;
    Box::new(move |line: &str| {
        if opened {
            return;
        }
        if let Some(id) = codex_thread_started(line) {
            opened = true;
            #[cfg(windows)]
            std::thread::spawn(move || {
                let url = format!("codex://threads/{id}");
                // Through Explorer, behind whatever the owner has in front (hybrid never steals focus).
                let before = crate::native_ops::win::foreground_window();
                match crate::desktop_ops::explorer_start(&url, "", false) {
                    Ok(()) => {
                        crate::desktop_ops::keep_focus(before, "ChatGPT", 4000);
                        note_live_opened(format!("Vega's thread in the Codex app: {url}"))
                    }
                    Err(e) => note_live_opened(format!("FAILED to open {url}: {e}")),
                }
            });
        }
    })
}

/// A random RFC 4122 version-4 id for `claude --session-id`, so Praxis knows which
/// transcript file a Live run writes before the run has written anything.
fn new_session_uuid() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut bytes = [0u8; 16];
    for (i, chunk) in bytes.chunks_mut(8).enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_usize(i);
        h.write_u32(std::process::id());
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The terminal view of a Live Forge run: follows the session transcript Claude Code
/// writes as it works and prints what Forge says and does. Read-only; closes itself when
/// the agent exits. `__SESSION__`/`__PID__` are filled in (both are checked to be plain).
const FORGE_LIVE_VIEW_PS: &str = r#"
$SessionId = '__SESSION__'; $AgentPid = __PID__; $Name = 'Forge'
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = "$Name (Claude Code) - working for Praxis"
function Alive { return [bool](Get-Process -Id $AgentPid -ErrorAction SilentlyContinue) }
function Short([string]$s, [int]$n) { $s = ($s -replace '\s+', ' ').Trim(); if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }
Write-Host "$Name is working for Praxis. This window follows the session live and closes when the step ends." -ForegroundColor Cyan
$Task = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TASK__')); if ($Task) { Write-Host ('Task: ' + (Short $Task 320)) -ForegroundColor DarkGray }
Write-Host ''
$root = Join-Path $env:USERPROFILE '.claude\projects'
$file = $null
for ($i = 0; $i -lt 600 -and -not $file; $i++) {
  $file = Get-ChildItem -Path $root -Filter "$SessionId.jsonl" -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $file) { if (-not (Alive)) { break }; Start-Sleep -Milliseconds 400 }
}
if (-not $file) { Write-Host "$Name finished before its session could be shown." -ForegroundColor Yellow; Start-Sleep -Seconds 8; exit }
$stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
$reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
$pending = ''; $quiet = 0
while ($true) {
  $chunk = $reader.ReadToEnd()
  if ($chunk) {
    $quiet = 0; $pending += $chunk
    $lines = $pending -split "`n"; $pending = $lines[-1]
    foreach ($line in $lines[0..($lines.Length - 2)]) {
      if (-not $line.Trim()) { continue }
      try { $e = $line | ConvertFrom-Json } catch { continue }
      if ($e.type -ne 'assistant') { continue }
      foreach ($c in @($e.message.content)) {
        if ($c.type -eq 'text' -and "$($c.text)".Trim()) { Write-Host ''; Write-Host ("${Name}: " + "$($c.text)".Trim()) -ForegroundColor White }
        elseif ($c.type -eq 'tool_use') {
          $in = $c.input
          $what = @($in.file_path, $in.command, $in.pattern, $in.path, $in.url, $in.description) | Where-Object { $_ } | Select-Object -First 1
          Write-Host ('  > ' + $c.name + ' ' + (Short "$what" 150)) -ForegroundColor DarkCyan
        }
      }
    }
  } else {
    if (-not (Alive)) { $quiet++; if ($quiet -gt 3) { break } }
    Start-Sleep -Milliseconds 300
  }
}
Write-Host ''
Write-Host "$Name finished this step. Praxis is checking the work - this window closes in 15 seconds." -ForegroundColor Green
Start-Sleep -Seconds 15
"#;

/// Open the terminal view of a Live Forge run (best effort: a view that fails to open
/// never touches the run itself).
fn open_forge_live_view(session_id: &str, pid: u32, prompt: &str) {
    #[cfg(windows)]
    {
        
        if !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return;
        }
        use base64::Engine;
        // The step itself, without the worker preamble every step shares.
        let task: String = prompt
            .strip_prefix(WORKER_NOTE)
            .unwrap_or(prompt)
            .trim()
            .chars()
            .take(600)
            .collect();
        let script = FORGE_LIVE_VIEW_PS
            .replace("__SESSION__", session_id)
            .replace("__PID__", &pid.to_string())
            .replace("__TASK__", &base64::engine::general_purpose::STANDARD.encode(task.as_bytes()));
        // Started by Explorer, not as Praxis's child console, and without taking focus:
        // hybrid shows the view behind whatever the owner has in front.
        let file = std::env::temp_dir().join(format!("praxis-forge-view-{session_id}.ps1"));
        let session = session_id.to_string();
        std::thread::spawn(move || {
            // UTF-8 with BOM so Windows PowerShell reads the script's text correctly.
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(script.as_bytes());
            if let Err(e) = std::fs::write(&file, bytes) {
                note_live_opened(format!("FAILED to open Forge's session view: {e}"));
                return;
            }
            let before = crate::native_ops::win::foreground_window();
            let args = format!("-NoProfile -ExecutionPolicy Bypass -File \"{}\"", file.display());
            match crate::desktop_ops::explorer_start("powershell.exe", &args, false) {
                Ok(()) => {
                    crate::desktop_ops::keep_focus(before, "Forge", 4000);
                    note_live_opened(format!("Forge's session view (session {session})"))
                }
                Err(e) => note_live_opened(format!("FAILED to open Forge's session view: {e}")),
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (session_id, pid, prompt);
}

// ── Live agent registry: HALT ALL and a cancelled run stop an agent MID-STEP ──
//
// Live 2026-09-16 HALT ALL was thrown at 23:17 while Quill (cursor-agent) was on a
// 30-minute step. HALT only refused NEW steps, so Quill kept editing the workspace
// until its timeout killed it at 23:23 - and a voice "stop" had no way to reach a
// running agent at all: aborting the JS run left the CLI process untouched. Every
// agent CLI that can act is registered here while it runs, so a stop is a real stop.

tokio::task_local! {
    static DELEGATION_ID: Option<String>;
    /// Live mode: show this run where the owner can watch it (see `agent_delegate`).
    static SHOW_LIVE: bool;
}

struct LiveAgent {
    pid: u32,
    tool: &'static str,
    delegation_id: Option<String>,
    /// Set by an abort just before the tree kill, so the run reports WHY it ended.
    stopped_by: Option<&'static str>,
}

static LIVE_AGENTS: Mutex<Vec<LiveAgent>> = Mutex::new(Vec::new());

/// Registration for one running agent CLI; dropping it (every exit path, including a
/// timeout or a dropped future) removes the entry.
struct LiveAgentGuard {
    pid: Option<u32>,
}

impl LiveAgentGuard {
    /// "HALT ALL was thrown" / "its run was cancelled" when an abort killed this agent.
    fn stopped_by(&self) -> Option<&'static str> {
        let pid = self.pid?;
        let agents = LIVE_AGENTS.lock().ok()?;
        agents.iter().find(|a| a.pid == pid).and_then(|a| a.stopped_by)
    }
}

impl Drop for LiveAgentGuard {
    fn drop(&mut self) {
        if let (Some(pid), Ok(mut agents)) = (self.pid, LIVE_AGENTS.lock()) {
            agents.retain(|a| a.pid != pid);
        }
    }
}

fn track_agent(tool: &'static str, pid: Option<u32>) -> LiveAgentGuard {
    if let (Some(pid), Ok(mut agents)) = (pid, LIVE_AGENTS.lock()) {
        let delegation_id = DELEGATION_ID.try_with(|id| id.clone()).ok().flatten();
        agents.push(LiveAgent { pid, tool, delegation_id, stopped_by: None });
    }
    LiveAgentGuard { pid }
}

/// Mark and tree-kill every live agent `select` picks. Returns the tools stopped.
fn stop_live_agents(select: impl Fn(&LiveAgent) -> bool, reason: &'static str) -> Vec<&'static str> {
    let victims: Vec<(u32, &'static str)> = match LIVE_AGENTS.lock() {
        Ok(mut agents) => agents
            .iter_mut()
            .filter(|a| a.stopped_by.is_none() && select(a))
            .map(|a| {
                a.stopped_by = Some(reason);
                (a.pid, a.tool)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    for (pid, _) in &victims {
        kill_agent_tree(Some(*pid));
    }
    victims.into_iter().map(|(_, tool)| tool).collect()
}

fn stopped_message(tools: &[&'static str]) -> String {
    if tools.is_empty() {
        "no active agent run".to_string()
    } else {
        format!("stopped {} running agent CLI{}: {}", tools.len(), if tools.len() == 1 { "" } else { "s" }, tools.join(", "))
    }
}

/// HALT ALL: stop every agent CLI Praxis is running, whoever started it.
#[tauri::command]
pub async fn agent_delegate_abort_all() -> Result<String, String> {
    Ok(stopped_message(&stop_live_agents(|_| true, "HALT ALL was thrown")))
}

/// A cancelled run stops exactly the agent it started (its `delegationId`).
#[tauri::command]
pub async fn agent_delegate_abort(delegation_id: String) -> Result<String, String> {
    let id = delegation_id.trim().to_string();
    if id.is_empty() {
        return Ok(stopped_message(&[]));
    }
    Ok(stopped_message(&stop_live_agents(
        |a| a.delegation_id.as_deref() == Some(id.as_str()),
        "its run was cancelled",
    )))
}

/// True when the `cursor-agent` headless CLI is actually installed. `resolve_bin`
/// returns an existing absolute path when found, else echoes the bare name back -
/// so a resolved value equal to the input name means "not found on disk".
fn cursor_agent_installed() -> bool {
    resolve_bin("cursor-agent") != "cursor-agent"
}

/// Run `claude -p <prompt> --output-format json [--model <model>]` in `cwd`.
///
/// Flags added for headless reliability:
/// - `--strict-mcp-config`: do NOT load the user's ~/.claude MCP server fleet (prevents
///   multi-minute cold-start caused by spawning dozens of MCP servers).
/// - `--dangerously-skip-permissions`: never wait on an approval prompt with no TTY
///   (without this the process hangs forever if a permission dialog fires).
/// ─────────────────────────────────────────────────────────────────────────────
/// ONE HANG, PAID ONCE.
///
/// `claude -p` can be unusable on this machine in two different ways: it answers
/// "Not logged in - Please run /login", or it produces nothing at all and has to be
/// killed (measured 2026-09-11: exit 124 after 151 seconds, zero bytes on both
/// streams). Either way it will not answer the next caller either.
///
/// The board meeting asks Forge, Sage and Atlas in parallel (`Promise.allSettled`
/// in boardContributors.ts), and all three route through this binary at once. So
/// one broken CLI can cost three simultaneous waits (each up to the board's
/// 240-second ceiling) and produce three vague "unavailable" rows - with no hint
/// that a single login would fix all of it. This cache still fires during board
/// meetings: the first failure is recorded here, and any contributor whose call
/// starts after that (or retries within the TTL) gets the same precise reason
/// immediately instead of waiting again.
///
/// This remembers the failure briefly and hands the same precise reason to every
/// later caller immediately. It is NOT a latch: it expires on its own, so the
/// moment the owner logs in the next call tries for real. A guard that never
/// re-validates is the defect class this codebase keeps being bitten by.
/// ─────────────────────────────────────────────────────────────────────────────
const CLI_UNHEALTHY_TTL_SECS: u64 = 120;

static CLAUDE_CLI_UNHEALTHY: std::sync::Mutex<Option<(std::time::Instant, String)>> =
    std::sync::Mutex::new(None);

/// The remembered failure, if it is still fresh.
fn claude_cli_unhealthy() -> Option<String> {
    let mut slot = CLAUDE_CLI_UNHEALTHY.lock().ok()?;
    match slot.as_ref() {
        Some((at, why)) if at.elapsed().as_secs() < CLI_UNHEALTHY_TTL_SECS => Some(why.clone()),
        Some(_) => {
            // Expired. Clear it so the next caller pays a real attempt, not a memory.
            *slot = None;
            None
        }
        None => None,
    }
}

fn note_claude_cli_unhealthy(why: &str) {
    if let Ok(mut slot) = CLAUDE_CLI_UNHEALTHY.lock() {
        *slot = Some((std::time::Instant::now(), why.to_string()));
    }
}

/// A success proves the CLI works; forget any remembered failure at once.
fn note_claude_cli_healthy() {
    if let Ok(mut slot) = CLAUDE_CLI_UNHEALTHY.lock() {
        *slot = None;
    }
}

/// Turn a raw CLI failure into something that names the fix.
///
/// Kill a timed-out agent CLI AND everything it started.
///
/// Dropping the wait future does not stop the process. `kill_on_drop` is not enough either: the
/// npm shim's `node codex.js` leaves its native `codex.exe` child alive, and Claude's tool calls
/// run in child shells. So it is a TREE kill.
fn kill_agent_tree(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.spawn() {
        Ok(_) => crate::elog!("[hermes] timed-out agent tree killed pid={pid}"),
        Err(e) => crate::elog!("[hermes] could not kill timed-out agent pid={pid}: {e}"),
    }
}

/// "resets 9pm (America/New_York)" → "9pm". The reset instant is the one fact the owner
/// needs from a usage refusal.
fn claude_reset_text(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let at = lower.find("resets")? + "resets".len();
    let tail = raw.get(at..)?.trim_start();
    let end = tail
        .find(|c: char| c == '(' || c == '.' || c == ',' || c == '"' || c == '\n' || c == '\\')
        .unwrap_or(tail.len());
    let candidate = tail.get(..end)?.trim();
    (!candidate.is_empty() && candidate.len() <= 24).then(|| candidate.to_string())
}

fn explain_claude_failure(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    // Live 2026-10-04 this read as nothing at all: Forge's rows said "no build steps" and
    // Sage/Atlas "provider unavailable".
    if crate::claude_usage::refusal_in_text(raw).is_some() {
        return CLAUDE_REFUSED_SENTENCE.to_string();
    }
    // Claude Pro's 5-hour window is SHARED with the owner's own Claude sessions. Live 2026-09-16
    // Forge finished its step, then exited 1 with "You've hit your session limit · resets 9pm"
    // inside its JSON result - reported as a bare "claude exited Some(1): {…}", so nothing
    // routed around it and the next Claude step ran into the same wall.
    if lower.contains("hit your session limit")
        || lower.contains("hit your usage limit")
        || lower.contains("hit your weekly limit")
        || lower.contains("usage limit reached")
    {
        return match claude_reset_text(raw) {
            Some(when) => format!(
                "Claude is out of usage and resets {when} - route this work to Codex or Cursor until then"
            ),
            None => "Claude is out of usage right now - route this work to Codex or Cursor until it resets".to_string(),
        };
    }
    if lower.contains("not logged in") || lower.contains("/login") || lower.contains("unauthorized")
    {
        return "the Claude CLI is not signed in - run `claude` in a terminal and `/login`"
            .to_string();
    }
    if lower.contains("timed out") || lower.contains("didn't answer") || lower.contains("timeout") {
        return "the Claude CLI did not respond - it is installed but not answering; check `claude` in a terminal"
            .to_string();
    }
    raw.to_string()
}

/// What every caller (missions, the board meeting, Atlas) says while Anthropic refuses
/// Claude Code. drivers.ts recognises "refusing Claude Code" and benches Forge.
pub(crate) const CLAUDE_REFUSED_SENTENCE: &str = "The vendor is refusing Claude Code - Forge can't run; route this work to Codex or Cursor.";

/// Pull the reset time out of Codex's usage-limit refusal.
///
/// The message ends "... or try again at 2:02 PM." - the single most useful fact
/// in it, and the one the owner asked to see on the rail.
fn codex_reset_text(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let at = lower.find("try again at")? + "try again at".len();
    let tail = raw.get(at..)?.trim_start();
    // "2:02 PM." / "2:02 PM" / "2:02 PM (in 3 hours)" - stop at the sentence end.
    let end = tail
        .find(|c: char| c == '.' || c == ',' || c == '(' || c == '\n')
        .unwrap_or(tail.len());
    let candidate = tail.get(..end)?.trim();
    // Must look like a clock time, or it is not a reset we can state.
    if !candidate.contains(':') || candidate.len() > 24 {
        return None;
    }
    Some(candidate.to_string())
}

/// Turn a raw `codex exec` failure into something that names the fix - the same
/// contract as `explain_claude_failure`, for the lane that had none.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// "UNAVAILABLE" WAS HIDING FOUR DIFFERENT, NAMEABLE STATES.
///
/// Every one of these was measured on this machine on 2026-09-12:
///
///  2. An outdated CLI: before upgrading (0.144.4 -> 0.154.0) the same command said
///     "The 'gpt-6-astra' model requires a newer version of Codex".
///  4. An untrusted directory: "Not inside a trusted directory and
///     --skip-git-repo-check was not specified." (reproduced by running outside a
///     git repo).
///
/// None of those is "unavailable", and three of the four are fixed by one specific
/// action. Recognising case 1 also persists the quota block
/// (`codex_usage::record_codex_quota_exhausted`) so the Command Center's Codex rail
/// can show the real state instead of a stale percentage.
/// ─────────────────────────────────────────────────────────────────────────────
/// The nameable states a `codex exec` failure can be in.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CodexFailure {
    /// Out of plan usage. `reset` is the wall-clock time the CLI named, verbatim.
    UsageLimit { reset: Option<String> },
    /// The installed CLI is too old for the requested model.
    OutdatedCli,
    NotSignedIn,
    UntrustedDirectory,
    NotInstalled,
    Timeout,
    /// Nothing recognised - the raw text is the best available answer.
    Unrecognised,
}

/// Pure classification: no disk writes, no side effects, so tests can exercise
/// every state without touching the owner's real `%LOCALAPPDATA%\Praxis` state.
pub(crate) fn classify_codex_failure(raw: &str) -> CodexFailure {
    let lower = raw.to_ascii_lowercase();

    // 1. Usage limit - the one state that carries a reset time worth surfacing.
    if lower.contains("usage limit")
        || lower.contains("hit your usage")
        || lower.contains("rate_limit_reached")
        || lower.contains("quota exceeded")
    {
        return CodexFailure::UsageLimit {
            reset: codex_reset_text(raw),
        };
    }
    // 2. The CLI is too old for the requested model.
    if lower.contains("requires a newer version") || lower.contains("upgrade codex") {
        return CodexFailure::OutdatedCli;
    }
    if lower.contains("not logged in")
        || lower.contains("codex login")
        || lower.contains("unauthorized")
        || lower.contains("no credentials")
    {
        return CodexFailure::NotSignedIn;
    }
    // 4. Untrusted working directory.
    if lower.contains("not inside a trusted directory") || lower.contains("skip-git-repo-check") {
        return CodexFailure::UntrustedDirectory;
    }
    if lower.contains("not found or failed to spawn") || lower.contains("enoent") {
        return CodexFailure::NotInstalled;
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return CodexFailure::Timeout;
    }
    CodexFailure::Unrecognised
}

/// The sentence the owner reads. Every recognised state names the fix or the reset.
pub(crate) fn codex_failure_message(failure: &CodexFailure, raw: &str) -> String {
    match failure {
        CodexFailure::UsageLimit { reset: Some(when) } => format!(
            "Codex is out of usage on this plan - the window reopens at {when}; \
             buy credits at https://chatgpt.com/codex/settings/usage to continue sooner"
        ),
        CodexFailure::UsageLimit { reset: None } => {
            "Codex is out of usage on this plan - buy credits at \
             https://chatgpt.com/codex/settings/usage or wait for the window to reopen"
                .to_string()
        }
        CodexFailure::OutdatedCli => {
            "the Codex CLI is too old for this model - run `npm i -g @openai/codex` \
             (0.154.0 or newer understands gpt-6-astra)"
                .to_string()
        }
        CodexFailure::NotSignedIn => {
            "the Codex CLI is not signed in - run `codex login` in a terminal".to_string()
        }
        CodexFailure::UntrustedDirectory => {
            "Codex refused the working folder as untrusted - it needs \
             `--skip-git-repo-check`, or a folder inside a git repo"
                .to_string()
        }
        CodexFailure::NotInstalled => {
            "the Codex CLI is not installed on this machine - install it with \
             `npm i -g @openai/codex`"
                .to_string()
        }
        CodexFailure::Timeout => {
            "Codex did not finish in time - it is installed and signed in but the run \
             exceeded the delegation timeout"
                .to_string()
        }
        CodexFailure::Unrecognised => raw.to_string(),
    }
}

/// Classify, record the quota state when that is what happened, and return the
/// sentence. The recording is what lets the SUPPLY rail report the real quota
/// without re-running a command that will only be refused again.
fn explain_codex_failure(raw: &str) -> String {
    let failure = classify_codex_failure(raw);
    if let CodexFailure::UsageLimit { reset } = &failure {
        crate::codex_usage::record_codex_quota_exhausted(reset.as_deref());
    }
    codex_failure_message(&failure, raw)
}

/// Pull the error message out of `codex exec --json`'s event stream on STDOUT.
///
/// Two shapes carry it (both observed in the same failed run, 2026-09-12):
///   {"type":"error","message":"…"}
///   {"type":"turn.failed","error":{"message":"…"}}
/// Returns the last one found, or `None` when the stream reports no error.
fn codex_stream_error(stdout: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = match v.get("type").and_then(|x| x.as_str()) {
            Some("error") => v.get("message").and_then(|x| x.as_str()),
            Some("turn.failed") => v
                .pointer("/error/message")
                .and_then(|x| x.as_str())
                // Older taxonomy kept the text one level up.
                .or_else(|| v.get("message").and_then(|x| x.as_str())),
            _ => None,
        };
        if let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) {
            found = Some(message.to_string());
        }
    }
    found
}

async fn run_claude(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    run_claude_with_advisor(
        prompt,
        cwd,
        model,
        advisor_model(),
        true,
        DELEGATE_TIMEOUT_SECS,
        "agent_delegate(claude)",
    )
    .await
}

/// The cheapest possible "does Claude Code answer?" - one answer-only Haiku turn. While
/// Anthropic refuses Claude Code, nothing else runs the CLI, so its token lapses and the
/// usage endpoint can no longer re-check; this is what lets the refusal clear on its own.
/// A refused call costs nothing; the first success clears the refusal (run_claude_with_advisor).
pub(crate) async fn probe_claude_cli() -> Result<String, String> {
    run_claude_brain("Reply with exactly: OK".to_string(), Some("haiku".to_string())).await
}

/// Run an answer-only Claude brain call. `--tools ""` prevents an ordinary
/// planning/chat prompt from reading files, running commands, or editing state.
async fn run_claude_brain(prompt: String, model: Option<String>) -> Result<String, String> {
    run_claude_with_advisor(
        prompt,
        None,
        model,
        advisor_model(),
        false,
        BRAIN_TIMEOUT_SECS,
        "claude brain",
    )
    .await
}

/// Advisor probing is disabled by default. A desktop Claude plan does not prove
/// headless CLI authentication or model access, so cached advisor selections are
/// intentionally ignored until a verified route and explicit enablement exist.
fn advisor_cache_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("advisor.txt"))
}

fn advisor_model() -> Option<String> {
    // A desktop Claude plan is not evidence that the headless CLI can use an
    // advisor model. Do not revive a cached Fable/Opus choice until this machine
    // has a verified CLI route and an explicit policy for enabling it.
    None
}

fn demote_advisor(_current: &str) -> Option<String> {
    let next = None;
    if let Some(p) = advisor_cache_path() {
        let _ = std::fs::write(&p, next.as_deref().unwrap_or("none"));
    }
    next
}

/// Heuristic: did this CLI failure come from the ADVISOR (flag unsupported, model
/// not accessible, invalid pairing) rather than the task itself? Only then do we
/// demote-and-retry - a genuine task failure must surface unchanged.
fn is_advisor_error(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("advisor") || s.contains("unknown option") || s.contains("unknown flag")
}

fn claude_permission_args(allow_tools: bool) -> &'static [&'static str] {
    if allow_tools {
        &["--dangerously-skip-permissions"]
    } else {
        &["--tools", ""]
    }
}

#[cfg(test)]
mod claude_permission_tests {
    use super::claude_permission_args;

    #[test]
    fn brain_calls_disable_all_tools() {
        assert_eq!(claude_permission_args(false), ["--tools", ""]);
        assert!(!claude_permission_args(false).contains(&"--dangerously-skip-permissions"));
    }

    #[test]
    fn explicit_delegation_retains_headless_permissions() {
        assert_eq!(
            claude_permission_args(true),
            ["--dangerously-skip-permissions"]
        );
    }
}

#[cfg(test)]
mod worker_isolation_tests {
    use super::{isolate_worker, quill_model, QUILL_DEFAULT_MODEL};

    fn args_of(cmd: &tokio::process::Command) -> Vec<String> {
        cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn quill_never_runs_an_api_pool_or_default_model() {
        assert_eq!(quill_model(Some("composer-2.5")), "composer-2.5");
        assert_eq!(quill_model(Some("cursor-grok-4.6-high")), "cursor-grok-4.6-high");
        assert_eq!(quill_model(Some("grok-4.7-high")), "grok-4.7-high");
        assert_eq!(quill_model(Some("grok-4.7-xhigh")), "grok-4.7-xhigh");
        // Fast variants cost 2x per token even inside the pool.
        assert_eq!(quill_model(Some("grok-4.7-high-fast")), QUILL_DEFAULT_MODEL);
        assert_eq!(QUILL_DEFAULT_MODEL, "grok-4.7-high");
        for api_pool in ["claude-opus-5-high", "claude-sonnet-5-thinking-high", "gpt-5.6-sol-high", "auto", "gemini-3.7-flash-high"] {
            assert_eq!(quill_model(Some(api_pool)), QUILL_DEFAULT_MODEL, "{api_pool} bills the API pool");
        }
        // -fast variants cost 2-6x per token; not a default Praxis may pick on its own.
        assert_eq!(quill_model(Some("composer-2.5-fast")), QUILL_DEFAULT_MODEL);
        // No model = explicit Grok 4.6, never the CLI default.
        assert_eq!(quill_model(None), QUILL_DEFAULT_MODEL);
        assert_eq!(quill_model(Some("  ")), QUILL_DEFAULT_MODEL);
    }

    #[test]
    fn every_worker_prompt_says_it_is_praxiss_worker_exactly_once() {
        let framed = super::worker_prompt("Polish the hero section.");
        assert!(framed.starts_with("[Praxis worker session]"));
        assert!(framed.ends_with("Polish the hero section."));
        assert!(framed.contains("not the orchestrator") && framed.contains("anything else to add?"));
        assert_eq!(super::worker_prompt(&framed), framed, "never framed twice");
    }

    #[test]
    fn forge_and_vega_launch_without_zachs_personal_setup() {
        let mut claude = tokio::process::Command::new("claude");
        isolate_worker("claude", &mut claude);
        assert!(args_of(&claude).contains(&"--safe-mode".to_string()));

        let mut codex = tokio::process::Command::new("codex");
        isolate_worker("codex", &mut codex);
        let a = args_of(&codex);
        assert!(a.contains(&"--ignore-user-config".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=high"));
    }

    #[test]
    fn quill_runs_from_a_clean_home_but_keeps_its_transcripts_visible() {
        let mut cursor = tokio::process::Command::new("cursor-agent");
        isolate_worker("cursor", &mut cursor);
        let envs: std::collections::HashMap<String, String> = cursor
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        let home = envs.get("HOME").expect("HOME is redirected");
        assert!(home.ends_with("agent-home"), "{home}");
        assert_eq!(envs.get("USERPROFILE"), Some(home));
        assert!(envs.get("CURSOR_CONFIG_DIR").is_some_and(|d| d.starts_with(home.as_str())));
        let data = envs.get("CURSOR_DATA_DIR").expect("data dir stays real");
        assert!(!data.starts_with(home.as_str()), "transcripts must stay in the real ~/.cursor: {data}");
    }
}

fn run_claude_with_advisor(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    advisor: Option<String>,
    allow_tools: bool,
    timeout_secs: u64,
    operation: &'static str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
    Box::pin(async move {
        // Already known broken and still fresh: answer now with the reason that
        // names the fix, instead of buying another full timeout to learn the same
        // thing. Expires on its own, so a login takes effect without a restart.
        if let Some(why) = claude_cli_unhealthy() {
            return Err(format!("{operation}: {why}"));
        }
        // While Anthropic refuses Claude Code, every call buys the same 403 (~5 s each),
        // and Atlas, Sage and the board meeting would all keep paying it. Fail at once
        // with the sentence; the refusal's own re-check probe is the one call let
        // through (claude_usage::maybe_probe_refusal), so this is not a latch.
        if crate::claude_usage::claude_refusal().is_some() && !crate::claude_usage::refusal_probe_in_flight() {
            return Err(format!("{operation}: {CLAUDE_REFUSED_SENTENCE}"));
        }
        let mut cmd = make_async_cmd("claude");
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("json")
            // Skip the user's full MCP fleet so the process starts in seconds, not minutes.
            .arg("--strict-mcp-config")
                .arg("--settings")
                .arg(HEADLESS_CLAUDE_SETTINGS)
            // Chat/planning disables tools; only explicit delegation gets write-capable tools.
            .args(claude_permission_args(allow_tools))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        isolate_worker("claude", &mut cmd);
        cmd.kill_on_drop(true);
        if let Some(m) = &model {
            cmd.arg("--model").arg(m);
        }
        if let Some(adv) = &advisor {
            // Server rule: advisor must be ≥ executor. Skip the flag when the executor
            // IS the top tier already (Fable advising Fable adds nothing but pairing risk).
            if model.as_deref() != Some(adv.as_str()) {
                cmd.arg("--advisor").arg(adv);
            }
        }
        if let Some(dir) = &cwd {
            cmd.current_dir(dir);
        }
        // Live mode: a known session id, so a terminal window can follow this run.
        let live_session = (allow_tools && show_live()).then(new_session_uuid);
        if let Some(id) = &live_session {
            cmd.arg("--session-id").arg(id);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("claude not found or failed to spawn: {e}"))?;
        let pid = child.id();
        if let (Some(id), Some(p)) = (&live_session, pid) {
            open_forge_live_view(id, p, &prompt);
        }
        // Only a tool-enabled run can act on the machine; an answer-only brain call is
        // not an agent HALT needs to reach.
        let live = allow_tools.then(|| track_agent("claude", pid));

        let output = match tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            child.wait_with_output(),
        )
        .await
        {
            Ok(result) => result.map_err(|e| format!("{operation} wait error: {e}"))?,
            Err(_) => {
                kill_agent_tree(pid);
                // A CLI that never answers will not answer the next agent either.
                let why = explain_claude_failure("timed out");
                note_claude_cli_unhealthy(&why);
                return Err(format!("{operation}: {why}"));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

        if !output.status.success() {
            if let Some(by) = live.as_ref().and_then(|g| g.stopped_by()) {
                return Err(format!("{operation} stopped: {by}"));
            }
            // This process is gone; never leave its pid registered while a retry runs.
            drop(live);
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // Advisor-caused failure → demote one tier (fable → opus → none) and retry
            // the same call once per tier. Cached, so the probe cost is paid once.
            if let Some(adv) = &advisor {
                if is_advisor_error(&stderr) {
                    let next = demote_advisor(adv);
                    crate::elog!(
                        "[hermes] advisor {adv} rejected ({}) — retrying with {:?}",
                        stderr.chars().take(120).collect::<String>(),
                        next
                    );
                    return run_claude_with_advisor(
                        prompt,
                        cwd,
                        model,
                        next,
                        allow_tools,
                        timeout_secs,
                        operation,
                    )
                    .await;
                }
            }
            // stderr is often EMPTY on a refusal - the reason goes to stdout - so
            // look at both before deciding what to tell the owner.
            let detail = if stderr.is_empty() { stdout.trim().to_string() } else { stderr.clone() };
            if let Some((code, message)) = crate::claude_usage::refusal_in_text(&detail) {
                crate::claude_usage::record_claude_refusal(code, message);
            }
            let why = explain_claude_failure(&detail);
            if why != detail {
                note_claude_cli_unhealthy(&why);
                return Err(format!("{operation}: {why}"));
            }
            return Err(format!(
                "claude exited {:?}: {}",
                output.status.code(),
                detail
            ));
        }

        // It answered. Forget any remembered failure immediately rather than making
        // the next agent wait out a TTL for a CLI that is demonstrably working.
        note_claude_cli_healthy();
        crate::claude_usage::clear_claude_refusal();

        // Parse `{ "result": "...", "total_cost_usd": ..., "usage": { input_tokens, output_tokens } }`
        // from Claude's JSON output. Record per-model token usage for the usage dashboard.
        if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
            let cost = v
                .get("total_cost_usd")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0);
            let usage = v.get("usage");
            let input = usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let output = usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let model_label = model.as_deref().unwrap_or("claude");
            crate::dlog!("[hermes] agent_delegate(claude) model={model_label} cost=${cost:.4} in={input} out={output}");
            crate::usage::record_usage("claude", model_label, input, output, cost);
            if let Some(result) = v.get("result").and_then(|x| x.as_str()) {
                return Ok(result.to_string());
            }
        }

        // Fallback: return trimmed raw stdout if JSON parse failed.
        Ok(stdout.trim().to_string())
    })
}

/// Run `codex exec <prompt> --json` in `cwd`.
///
/// `codex exec --json` emits a JSONL event stream (one JSON object per line), NOT a single
/// JSON object. Event shapes observed in ~/.codex/sessions/:
///
/// - `{ "type": "event_msg", "payload": { "type": "task_complete", "last_agent_message": "…",
///     "duration_ms": … } }` - the final result; `last_agent_message` is the answer text.
/// - `{ "type": "event_msg", "payload": { "type": "agent_message", "message": "…" } }` -
///   intermediate assistant messages (we keep the last one as a fallback result).
async fn run_codex(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    run_codex_opts(prompt, cwd, model, &[], false, DELEGATE_TIMEOUT_SECS).await
}

/// Seconds Praxis waits to LOOK at a build (a few screenshots, one judgment).
const LOOK_TIMEOUT_SECS: u64 = 240;

/// Read-only sandbox: it views images and answers - it cannot touch a file or run a command.
/// Only screenshots written in the last ten minutes count, so a failed render can't be judged on
/// an old picture.
#[tauri::command]
pub async fn praxis_look(prompt: String, images: Vec<String>, model: Option<String>) -> Result<String, String> {
    let fresh_after = std::time::SystemTime::now() - Duration::from_secs(600);
    let images: Vec<String> = images
        .into_iter()
        .filter(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .map(|t| t >= fresh_after)
                .unwrap_or(false)
        })
        .take(4)
        .collect();
    if images.is_empty() {
        return Err("no fresh screenshots to look at".to_string());
    }
    if let Some(why) = rail_known_dark("openai-codex") {
        return Err(why);
    }
    let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| CODEX_BRAIN_MODEL.to_string());
    run_codex_opts(prompt, None, Some(model), &images, true, LOOK_TIMEOUT_SECS).await
}

/// `codex exec`, with images attached (`--image`) and an optional read-only sandbox.
async fn run_codex_opts(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    images: &[String],
    read_only: bool,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut cmd = make_async_cmd("codex");
    cmd.arg("exec").arg(&prompt).arg("--json");
    if read_only {
        // Looking needs no tools: a read-only sandbox, and never an approval prompt.
        cmd.arg("--sandbox").arg("read-only").arg("-c").arg("approval_policy=\"never\"");
    } else {
        // Never block on approval prompts in headless mode.
        cmd.arg("--dangerously-bypass-approvals-and-sandbox");
    }
    // Codex refuses to run in a non-git/untrusted cwd without this (verified live
    // 2026-07-02: "Not inside a trusted directory and --skip-git-repo-check was not
    // specified"). Delegated steps may target any folder, so always pass it.
    cmd.arg("--skip-git-repo-check");
    // One `--image=<path>` per file: the flag takes several values, so a bare `-i a b`
    // would swallow whatever positional came next.
    for image in images {
        cmd.arg(format!("--image={image}"));
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    isolate_worker("codex", &mut cmd);
    // Per-step model routing from the orchestrator's plan (e.g. "gpt-5.5").
    // Omitted → the CLI's configured default (~/.codex/config.toml) applies.
    if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
        cmd.arg("--model").arg(m.trim());
    }
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    let child = cmd.spawn().map_err(|e| {
        explain_codex_failure(&format!("codex not found or failed to spawn: {e}"))
    })?;
    let pid = child.id();
    let live = track_agent("codex", pid);
    // Live mode: Vega's thread opens in the Codex app as soon as the run names it.
    let watch = show_live().then(open_codex_thread_when_named);

    let output = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        wait_output_watching(child, watch),
    )
    .await
    .map_err(|_| {
        kill_agent_tree(pid);
        explain_codex_failure(&format!(
            "agent_delegate(codex) timed out after {timeout_secs}s"
        ))
    })?
    .map_err(|e| format!("agent_delegate(codex) wait error: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

    if !output.status.success() {
        if let Some(by) = live.stopped_by() {
            return Err(format!("agent_delegate(codex) stopped: {by}"));
        }
        // ── THE REASON IS ON STDOUT; THIS USED TO REPORT STDERR ───────────────
        // Measured 2026-09-12 with these exact flags: a usage-limit refusal exits
        // **1**, writes nothing useful to stderr ("Reading additional input from
        // stdin..." - 39 bytes of noise), and puts the real message on STDOUT as
        //   {"type":"error","message":"You've hit your usage limit ... 2:02 PM."}
        //   {"type":"turn.failed","error":{"message":"..."}}
        // So the old code returned
        //   `codex exited Some(1): Reading additional input from stdin...`
        // and threw the actual answer away. That is where "unavailable" came from.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = codex_stream_error(&stdout)
            .or_else(|| (!stderr.is_empty()).then(|| stderr.clone()))
            .unwrap_or_else(|| format!("codex exited {:?} with no message", output.status.code()));
        return Err(explain_codex_failure(&detail));
    }

    // A codex run can also exit 0 having reported an error event; treat that as a
    // failure with the same classification rather than returning empty output.
    if let Some(detail) = codex_stream_error(&stdout) {
        return Err(explain_codex_failure(&detail));
    }

    // The run completed, so the account is demonstrably not quota-blocked. Retire
    // any persisted block at once instead of waiting for its reset instant.
    crate::codex_usage::clear_codex_quota_block();

    // Parse the JSONL event stream line-by-line.
    // We accumulate the last `task_complete.last_agent_message` as the canonical result,
    // with `agent_message.message` as a fallback, and extract token usage for cost tracking.
    let mut result_text: Option<String> = None;
    let mut last_agent_message: Option<String> = None;
    let mut total_tokens: Option<u64> = None;
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        // ── Current codex-cli exec stream (verified live 2026-07-02, codex 0.135+) ──
        // {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
        // {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
        // NOTE: this is a DIFFERENT taxonomy from the ~/.codex/sessions rollout files
        // (event_msg/task_complete) the fallback below parses - do not conflate them.
        match v.get("type").and_then(|x| x.as_str()) {
            Some("item.completed") => {
                if let Some(item) = v.get("item") {
                    if item.get("type").and_then(|x| x.as_str()) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
                            result_text = Some(text.to_string());
                        }
                    }
                }
                continue;
            }
            Some("turn.completed") => {
                // ACCUMULATE - a multi-turn exec emits one turn.completed per turn;
                // assignment here would keep only the last turn's usage.
                if let Some(usage) = v.get("usage") {
                    if let Some(t) = usage.get("input_tokens").and_then(|x| x.as_u64()) {
                        input_tokens += t;
                    }
                    if let Some(t) = usage.get("output_tokens").and_then(|x| x.as_u64()) {
                        output_tokens += t;
                    }
                    total_tokens = Some(input_tokens + output_tokens);
                }
                continue;
            }
            _ => {}
        }

        // ── Fallback: older event_msg taxonomy ──
        if v.get("type").and_then(|x| x.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        match payload.get("type").and_then(|x| x.as_str()) {
            Some("task_complete") => {
                // `last_agent_message` is the definitive final answer text.
                if let Some(msg) = payload.get("last_agent_message").and_then(|x| x.as_str()) {
                    result_text = Some(msg.to_string());
                }
            }
            Some("agent_message") => {
                // Intermediate assistant message - keep as fallback.
                if let Some(msg) = payload.get("message").and_then(|x| x.as_str()) {
                    last_agent_message = Some(msg.to_string());
                }
            }
            Some("token_count") => {
                // Extract token usage from info.last_token_usage.
                if let Some(usage) = payload.get("info").and_then(|i| i.get("last_token_usage")) {
                    if let Some(t) = usage.get("total_tokens").and_then(|x| x.as_u64()) {
                        total_tokens = Some(t);
                    }
                    if let Some(t) = usage.get("input_tokens").and_then(|x| x.as_u64()) {
                        input_tokens = t;
                    }
                    if let Some(t) = usage.get("output_tokens").and_then(|x| x.as_u64()) {
                        output_tokens = t;
                    }
                }
            }
            _ => {}
        }
    }

    // Record per-model token usage with a synthetic $/M-token proxy so the cost accumulator
    // keeps a consistent unit.
    if let Some(tokens) = total_tokens {
        let synthetic_cost = tokens as f64 / 1_000_000.0;
        let model_label = model
            .as_deref()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or("codex");
        crate::dlog!("[hermes] agent_delegate(codex) model={model_label} tokens={tokens} in={input_tokens} out={output_tokens} synthetic_cost=${synthetic_cost:.6}");
        crate::usage::record_usage(
            "codex",
            model_label,
            input_tokens,
            output_tokens,
            synthetic_cost,
        );
    }

    // Return the best available result text, falling back to raw stdout.
    if let Some(text) = result_text.or(last_agent_message) {
        return Ok(text);
    }

    Ok(stdout.trim().to_string())
}

/// Run `cursor-agent -p <prompt> --output-format json --force [--model <model>]` in `cwd`.
///
/// Cursor's headless agent CLI (verified against cursor.com/docs/cli/headless,
/// 2026): `-p`/`--print` = non-interactive; `--output-format json` yields a
/// single JSON object whose `result` field is the final answer; `--force`
/// (a.k.a. `--yolo`) allows file writes without a confirmation prompt (there's
/// no TTY to answer one) - the direct analogue of claude's
/// `--dangerously-skip-permissions` and codex's approval bypass.
///
/// Returns a clear "not installed" error (rather than a raw spawn failure) when the CLI isn't
/// present on the machine.
async fn run_cursor(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    if !cursor_agent_installed() {
        return Err("cursor-agent CLI not installed — the headless Cursor CLI is real (stable on Windows \
             as of 2026) but isn't on this machine. Install it with: \
             irm 'https://cursor.com/install?win32=true' | iex  (drops cursor-agent in ~/.local/bin)."
            .to_string());
    }

    let pool = crate::cursor_usage::pool_state_from(
        crate::cursor_usage::cursor_usage().await.as_ref(),
        crate::cursor_usage::api_pool_allowed(),
    );
    if !pool.note.is_empty() {
        return Err(format!(
            "Quill paused — {} (to let Quill use the API pool anyway, put the word allow in %LOCALAPPDATA%\\Praxis\\cursor-api-pool.txt)",
            pool.note.trim_start_matches("Quill sat this one out: ").trim_end_matches('.')
        ));
    }

    let mut cmd = make_async_cmd("cursor-agent");
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("json")
        // Allow file writes without a confirmation prompt (no TTY to answer).
        .arg("--force")
        // DIFFERENT gate from --force: an unfamiliar working directory otherwise prompts
        // "Do you trust the contents of this directory?", which a headless run cannot
        // answer, so the session just stalls and dies.
        .arg("--trust")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let model = Some(quill_model(model.as_deref()));
    cmd.arg("--model").arg(model.as_deref().unwrap_or(QUILL_DEFAULT_MODEL));
    isolate_worker("cursor", &mut cmd);
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("cursor-agent not found or failed to spawn: {e}"))?;
    let pid = child.id();
    let live = track_agent("cursor", pid);

    let output = tokio::time::timeout(
        Duration::from_secs(DELEGATE_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        kill_agent_tree(pid);
        format!("agent_delegate(cursor) timed out after {DELEGATE_TIMEOUT_SECS}s")
    })?
    .map_err(|e| format!("agent_delegate(cursor) wait error: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

    if !output.status.success() {
        if let Some(by) = live.stopped_by() {
            return Err(format!("agent_delegate(cursor) stopped: {by}"));
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "cursor-agent exited {:?}: {}",
            output.status.code(),
            stderr
        ));
    }

    // Parse the single JSON object: `{ "result": "…", "usage"?: { input_tokens, output_tokens }
    // }`.
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        let usage = v.get("usage");
        let input = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let output_tok = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let model_label = model
            .as_deref()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or("cursor");
        let total = input + output_tok;
        if total > 0 {
            let synthetic_cost = total as f64 / 1_000_000.0;
            crate::dlog!("[hermes] agent_delegate(cursor) model={model_label} tokens={total} in={input} out={output_tok} synthetic_cost=${synthetic_cost:.6}");
            crate::usage::record_usage("cursor", model_label, input, output_tok, synthetic_cost);
        }
        if let Some(result) = v.get("result").and_then(|x| x.as_str()) {
            return Ok(result.to_string());
        }
    }

    // Fallback: return trimmed raw stdout if JSON parse failed (e.g. a plain-text
    // reply, or a future output shape) - same graceful degrade as claude/codex.
    Ok(stdout.trim().to_string())
}

// ── Interruptible sleep (mirrors transcript_tailer exactly) ──────────────────

fn sleep_interruptible(running: &Arc<AtomicBool>, total_ms: u64) {
    let mut left = total_ms;
    while left > 0 && running.load(Ordering::Relaxed) {
        let slice = left.min(100);
        std::thread::sleep(Duration::from_millis(slice));
        left -= slice;
    }
}

#[cfg(test)]
mod dashboard_launch_tests {
    use super::*;

    #[test]
    fn invisible_dashboard_uses_the_shipped_prebuilt_ui() {
        let args = dashboard_args();
        assert_eq!(args[0], "dashboard");
        assert!(args.windows(2).any(|w| w == ["--port", "9119"]));
        assert!(args.iter().any(|arg| arg == "--no-open"));
        assert!(args.iter().any(|arg| arg == "--skip-build"));
    }
}

#[cfg(all(windows, test))]
mod shim_tests {
    use super::*;

    /// THE BUG THAT CAME BACK.
    ///
    /// `cmd /C` truncates a multi-line argument at the first newline and silently drops
    /// every flag after it. That was fixed in `make_async_cmd` - and session spawning
    /// stayed broken for another hour because `fd_spawn_session` had its OWN copy of the
    /// same branch. Two launchers, one fixed, and a Codex lane still logging
    /// "--skip-git-repo-check was not specified" about a flag passed three lines above it.
    ///
    /// So: only the CLI launcher may build a `cmd /C`. Any OTHER module that spawns one of
    /// our agent CLIs must go through `spawn_target`. This test reads the source because
    /// the property is "nobody else writes this", which no runtime assertion can express.
    ///
    /// `quartz_sidecar`, `sovereign` and `flow_runner` are allowed: they run shell one-liners
    /// and user commands, not our multi-line agent prompts.
    #[test]
    fn only_the_shared_launcher_may_build_a_cmd_shell_for_an_agent_cli() {
        const ALLOWED: [&str; 4] = [
            "hermes_bridge.rs",   // spawn_target itself - the one permitted definition
            "quartz_sidecar.rs",  // shell one-liner, no agent prompt
            "sovereign.rs",       // user shell command
            "flow_runner.rs",     // user shell command
        ];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("src dir") {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if ALLOWED.contains(&name.as_str()) {
                continue;
            }
            let body = std::fs::read_to_string(&path).unwrap_or_default();
            if body.contains("Command::new(\"cmd\")") {
                offenders.push(name);
            }
        }
        assert!(
            offenders.is_empty(),
            "these modules build their own `cmd /C`, which TRUNCATES multi-line prompts —              route them through hermes_bridge::spawn_target instead: {offenders:?}"
        );
    }

    /// A multi-line prompt through `cmd /C` loses everything after the first newline,
    /// INCLUDING the flags that follow it - which is why the board kept telling the owner to
    /// pass `--skip-git-repo-check`, a flag run_codex already passes. Spawning the shim's
    /// real `node <script>` target avoids cmd.exe entirely.
    #[test]
    fn an_npm_shim_resolves_to_its_node_script() {
        let dir = std::env::temp_dir().join("praxis-shim-test");
        let _ = std::fs::create_dir_all(dir.join("node_modules").join("pkg").join("bin"));
        let script = dir.join("node_modules").join("pkg").join("bin").join("tool.js");
        std::fs::write(&script, "// entry").expect("write script");
        let shim = dir.join("tool.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nSET dp0=%~dp0\r\n\"%_prog%\"  \"%dp0%\\node_modules\\pkg\\bin\\tool.js\" %*\r\n",
        )
        .expect("write shim");

        let got = npm_shim_target(&shim.to_string_lossy());
        let (prog, resolved) = got.expect("shim resolves");
        assert_eq!(prog, "node");
        assert!(
            std::path::Path::new(&resolved).exists(),
            "resolved script must exist on disk, got {resolved}"
        );
        assert!(resolved.ends_with("tool.js"), "got {resolved}");
    }

    /// A self-update leaves `dist-package` beside the finished versions, and it sorts AFTER
    /// every real version - so a newest-first scan picks exactly the broken copy.
    #[test]
    fn a_mid_update_dist_package_is_not_mistaken_for_a_release() {
        let base = std::env::temp_dir().join("praxis-ver-test");
        assert!(version_dir_name(&base.join("2026.09.10-fd3934a")));
        assert!(version_dir_name(&base.join("2026.1.5-abc")));
        assert!(!version_dir_name(&base.join("dist-package")));
        assert!(!version_dir_name(&base.join("tmp")));
        assert!(!version_dir_name(&base.join("versions")));
        // Sorting is what made this dangerous - prove the bad name really does sort last.
        let mut names = vec!["2026.09.10-fd3934a", "dist-package"];
        names.sort();
        assert_eq!(names.last(), Some(&"dist-package"));
    }

    /// A shim we cannot parse must return None so the caller keeps the old behaviour
    /// rather than inventing a target.
    #[test]
    fn an_unrecognised_shim_is_not_guessed_at() {
        let dir = std::env::temp_dir().join("praxis-shim-test2");
        let _ = std::fs::create_dir_all(&dir);
        let shim = dir.join("weird.cmd");
        std::fs::write(&shim, "@echo off\r\nsome-native-thing.exe %*\r\n").expect("write");
        assert!(npm_shim_target(&shim.to_string_lossy()).is_none());
    }
}

#[cfg(test)]
mod pricing_tests {
    use super::*;

    /// The top model MUST be priced.
    #[test]
    fn every_catalog_openai_model_has_a_published_price() {
        for m in ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
            assert!(openai_price_per_m(m).is_some(), "{m} has no price entry");
        }
        assert!(openai_price_per_m("some-future-model").is_none());
    }

    #[test]
    fn astra_costs_more_than_sol_and_both_are_nonzero() {
        let astra = openai_cost_usd("gpt-6-astra", 1_000_000, 1_000_000);
        let sol = openai_cost_usd("gpt-5.6-sol", 1_000_000, 1_000_000);
        assert!(astra > sol && sol > 0.0, "astra={astra} sol={sol}");
        assert_eq!(astra, 60.0);
    }
}

#[cfg(test)]
mod cli_health_tests {
    use super::*;

    #[test]
    fn a_login_failure_names_the_fix_not_a_timeout_number() {
        // This tells him what to do, which is the only part that matters when three agents are
        // dark for one reason.
        let why = explain_claude_failure("Not logged in · Please run /login");
        assert!(why.contains("not signed in"), "{why}");
        assert!(why.contains("/login"), "{why}");
    }

    #[test]
    fn a_hang_is_reported_as_not_responding() {
        let why = explain_claude_failure("timed out");
        assert!(why.contains("did not respond"), "{why}");
    }

    #[test]
    fn a_claude_pro_session_limit_names_the_reset_and_the_reroute() {
        // Captured 2026-09-16: Forge's JSON result after it had already written its files.
        let raw = r#"{"type":"result","is_error":true,"duration_api_ms":277912,"result":"You've hit your session limit · resets 9pm (America/New_York)"}"#;
        let why = explain_claude_failure(raw);
        assert!(why.contains("out of usage"), "{why}");
        assert!(why.contains("resets 9pm"), "the TS side parses 'resets <time>': {why}");
        assert!(why.contains("Codex or Cursor"), "{why}");
        assert_eq!(claude_reset_text("…limit · resets 9pm (America/New_York)").as_deref(), Some("9pm"));
        assert_eq!(claude_reset_text("no reset named here"), None);
    }

    #[test]
    fn every_delegation_timeout_kills_the_agent_tree() {
        let src = include_str!("hermes_bridge.rs");
        let body = |start: &str| {
            let at = src.find(start).expect(start);
            &src[at..at + 4000.min(src.len() - at)]
        };
        // run_codex is a thin wrapper; the spawn, timeout and tree-kill live in run_codex_opts.
        for f in ["async fn run_codex_opts(", "async fn run_cursor(", "fn run_claude_with_advisor("] {
            assert!(body(f).contains("kill_agent_tree(pid)"), "{f} must tree-kill on timeout");
            // …and every agent is registered while it runs, so HALT ALL or a cancelled
            // run can stop it mid-step and the run says why it ended.
            assert!(body(f).contains("track_agent("), "{f} must register its live agent");
            assert!(body(f).contains("stopped_by()"), "{f} must report a stop as a stop");
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_cancelled_run_kills_only_its_own_agent_and_halt_kills_the_rest() {
        // Live 2026-09-16: HALT ALL at 23:17, Quill kept editing until 23:23.
        let spawn = || {
            let mut c = tokio::process::Command::new("ping");
            c.args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null());
            c.creation_flags(0x0800_0000);
            c.spawn().expect("spawn ping")
        };
        let mut mine = spawn();
        let mut other = spawn();
        let mine_guard = DELEGATION_ID
            .scope(Some("run-mine".to_string()), async { track_agent("codex", mine.id()) })
            .await;
        let other_guard = DELEGATION_ID
            .scope(Some("run-other".to_string()), async { track_agent("cursor", other.id()) })
            .await;

        assert_eq!(agent_delegate_abort("run-nobody".into()).await.unwrap(), "no active agent run");
        let msg = agent_delegate_abort("run-mine".into()).await.unwrap();
        assert!(msg.contains("stopped 1") && msg.contains("codex"), "{msg}");
        let status = tokio::time::timeout(Duration::from_secs(20), mine.wait())
            .await
            .expect("the cancelled agent must actually die")
            .unwrap();
        assert!(!status.success());
        assert_eq!(mine_guard.stopped_by(), Some("its run was cancelled"));
        assert_eq!(other_guard.stopped_by(), None, "another run's agent is untouched");
        assert!(tokio::time::timeout(Duration::from_millis(300), other.wait()).await.is_err(), "still running");

        let msg = agent_delegate_abort_all().await.unwrap();
        assert!(msg.contains("cursor") && !msg.contains("codex"), "an already-stopped agent is not stopped twice: {msg}");
        tokio::time::timeout(Duration::from_secs(20), other.wait())
            .await
            .expect("HALT ALL must actually kill the agent")
            .unwrap();
        assert_eq!(other_guard.stopped_by(), Some("HALT ALL was thrown"));
        drop((mine_guard, other_guard));
        assert_eq!(agent_delegate_abort_all().await.unwrap(), "no active agent run", "guards deregister on drop");
    }

    #[test]
    fn an_unrecognised_failure_is_passed_through_verbatim() {
        // Never rewrite an error we do not understand - the raw text is the only
        // evidence left at that point.
        let raw = "some novel error nobody has seen";
        assert_eq!(explain_claude_failure(raw), raw);
    }

    // ── Codex failure classification ─────────────────────────────────────────
    //
    // Every string below was captured from this machine on 2026-09-12. These use
    // the PURE classifier, so none of them writes to the real state directory.

    /// Verbatim `codex exec -m gpt-6-astra` output, exit code 1, on STDOUT.
    const REAL_USAGE_LIMIT: &str = "You've hit your usage limit. Upgrade to Pro \
         (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage \
         to purchase more credits or try again at 2:02 PM.";

    #[test]
    fn the_real_usage_limit_refusal_yields_its_reset_time() {
        let failure = classify_codex_failure(REAL_USAGE_LIMIT);
        assert_eq!(
            failure,
            CodexFailure::UsageLimit {
                reset: Some("2:02 PM".to_string())
            },
            "the reset time is the most useful fact in the refusal and must survive"
        );
        let why = codex_failure_message(&failure, REAL_USAGE_LIMIT);
        assert!(why.contains("out of usage"), "{why}");
        assert!(why.contains("2:02 PM"), "{why}");
        assert!(
            !why.contains("unavailable"),
            "'unavailable' is what this replaced: {why}"
        );
    }

    #[test]
    fn a_usage_limit_without_a_reset_still_names_the_fix() {
        let failure = classify_codex_failure("You've hit your usage limit.");
        assert_eq!(failure, CodexFailure::UsageLimit { reset: None });
        let why = codex_failure_message(&failure, "You've hit your usage limit.");
        assert!(why.contains("out of usage"), "{why}");
        assert!(why.contains("settings/usage"), "{why}");
    }

    #[test]
    fn a_reset_time_is_only_taken_when_it_looks_like_a_clock() {
        // "try again later" carries no time; inventing one would be worse than none.
        assert_eq!(codex_reset_text("usage limit - try again at later"), None);
        assert_eq!(
            codex_reset_text("try again at 9:15 AM, or buy credits"),
            Some("9:15 AM".to_string())
        );
    }

    #[test]
    fn the_outdated_cli_state_is_named_not_called_unavailable() {
        // The measured pre-upgrade message (Codex CLI 0.144.4 with gpt-6-astra).
        let raw = "The 'gpt-6-astra' model requires a newer version of Codex";
        assert_eq!(classify_codex_failure(raw), CodexFailure::OutdatedCli);
        let why = codex_failure_message(&CodexFailure::OutdatedCli, raw);
        assert!(why.contains("too old"), "{why}");
        assert!(why.contains("npm i -g @openai/codex"), "{why}");
    }

    #[test]
    fn the_untrusted_directory_state_is_named() {
        // Verbatim from running `codex exec` outside a git repo, 2026-09-12.
        let raw = "Not inside a trusted directory and --skip-git-repo-check was not specified.";
        assert_eq!(
            classify_codex_failure(raw),
            CodexFailure::UntrustedDirectory
        );
        let why = codex_failure_message(&CodexFailure::UntrustedDirectory, raw);
        assert!(why.contains("untrusted"), "{why}");
    }

    #[test]
    fn the_not_signed_in_state_names_the_login_command() {
        let failure = classify_codex_failure("Not logged in. Please run codex login.");
        assert_eq!(failure, CodexFailure::NotSignedIn);
        let why = codex_failure_message(&failure, "");
        assert!(why.contains("codex login"), "{why}");
    }

    #[test]
    fn a_missing_codex_binary_is_named() {
        let raw = "codex not found or failed to spawn: program not found";
        assert_eq!(classify_codex_failure(raw), CodexFailure::NotInstalled);
    }

    #[test]
    fn an_unrecognised_codex_failure_is_passed_through_verbatim() {
        let raw = "some novel codex error nobody has seen";
        assert_eq!(classify_codex_failure(raw), CodexFailure::Unrecognised);
        assert_eq!(
            codex_failure_message(&CodexFailure::Unrecognised, raw),
            raw,
            "never rewrite an error we do not understand"
        );
    }

    #[test]
    fn a_usage_limit_is_never_misread_as_a_plain_timeout() {
        // Both words can appear in one stream; the quota state must win, because it
        // is the one with an actionable reset time.
        let raw = "You've hit your usage limit ... try again at 2:02 PM. (request timed out)";
        assert!(matches!(
            classify_codex_failure(raw),
            CodexFailure::UsageLimit { .. }
        ));
    }

    // ── The reason is on STDOUT, which used to be discarded ──────────────────

    #[test]
    fn the_error_message_is_read_out_of_the_stdout_event_stream() {
        // Byte-for-byte the STDOUT of the measured failing run (exit code 1).
        // stderr held only "Reading additional input from stdin..." - which is what
        // the old code reported instead of any of this.
        let stdout = concat!(
            r#"{"type":"thread.started","thread_id":"00000000-0000-7000-8000-00000000000d"}"#,
            "\n",
            r#"{"type":"turn.started"}"#,
            "\n",
            r#"{"type":"error","message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:02 PM."}"#,
            "\n",
            r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:02 PM."}}"#,
            "\n"
        );
        let detail = codex_stream_error(stdout).expect("the reason is right there on stdout");
        assert!(detail.contains("usage limit"), "{detail}");
        assert!(detail.contains("2:02 PM"), "{detail}");
        assert_eq!(
            classify_codex_failure(&detail),
            CodexFailure::UsageLimit {
                reset: Some("2:02 PM".to_string())
            }
        );
    }

    #[test]
    fn a_clean_stdout_stream_reports_no_error() {
        let stdout = concat!(
            r#"{"type":"thread.started","thread_id":"x"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}"#,
            "\n",
            r#"{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}"#,
            "\n"
        );
        assert_eq!(codex_stream_error(stdout), None);
    }

    #[test]
    fn the_memory_is_not_a_latch() {
        // The defect class this codebase keeps being bitten by: a guard that never
        // re-validates. A success must clear it immediately.
        note_claude_cli_unhealthy("the Claude CLI is not signed in");
        assert!(claude_cli_unhealthy().is_some());
        note_claude_cli_healthy();
        assert!(
            claude_cli_unhealthy().is_none(),
            "a working CLI must not stay marked broken"
        );
    }

    #[test]
    fn the_memory_expires_on_its_own() {
        // Even with no successful call, it must let the next caller try for real,
        // so logging in takes effect without restarting Praxis.
        assert!(CLI_UNHEALTHY_TTL_SECS > 0 && CLI_UNHEALTHY_TTL_SECS <= 300);
        note_claude_cli_healthy();
    }
}

#[cfg(test)]
mod live_mode_tests {
    use super::*;

    #[test]
    fn vegas_thread_id_comes_from_the_first_event_and_nothing_else_gets_through() {
        assert_eq!(
            codex_thread_started(r#"{"type":"thread.started","thread_id":"00000000-0000-7000-8000-00000000000e"}"#).as_deref(),
            Some("00000000-0000-7000-8000-00000000000e")
        );
        assert_eq!(codex_thread_started(r#"{"type":"turn.started"}"#), None);
        // The id is handed to the shell inside a link: anything but a plain id is refused.
        assert_eq!(codex_thread_started(r#"{"type":"thread.started","thread_id":"x & calc"}"#), None);
        assert_eq!(codex_thread_started(r#"{"type":"thread.started","thread_id":""}"#), None);
        assert_eq!(codex_thread_started("not json"), None);
    }

    #[test]
    fn a_live_session_id_is_a_fresh_version_4_uuid() {
        let a = new_session_uuid();
        let b = new_session_uuid();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'), "{a}");
        assert!(matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')), "{a}");
    }

    #[test]
    fn only_a_live_run_is_shown() {
        assert!(!show_live(), "outside a delegation nothing opens");
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert!(rt.block_on(SHOW_LIVE.scope(true, async { show_live() })));
        assert!(!rt.block_on(SHOW_LIVE.scope(false, async { show_live() })));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn watching_stdout_sees_each_line_and_keeps_the_whole_output() {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "echo first& echo second& echo oops 1>&2"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let out = wait_output_watching(
            c.spawn().unwrap(),
            Some(Box::new(move |l: &str| log.lock().unwrap().push(l.trim().to_string()))),
        )
        .await
        .unwrap();
        assert!(out.status.success());
        assert_eq!(*seen.lock().unwrap(), vec!["first".to_string(), "second".to_string()]);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("first") && text.contains("second"), "{text}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("oops"));
    }
}
